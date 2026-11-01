import { connect as connectNet, isIP } from "node:net";
import type { Socket as NetSocket } from "node:net";
import { connect as connectTls } from "node:tls";

import { BunSocket } from "@effect/platform-bun";
import { Array as Arr, Context, Data, Duration, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { Socket } from "effect/socket";

import type { Ircd } from "./entry.ts";

// CONN-1.
const openTimeout = Duration.seconds(15);

// What a WebSocket calls a close with no close frame, and Effect's sockets borrow.
const abnormalClose = 1006;

/** A Connection could not be opened. `reason` is fit for a `closed` Entry. */
export class ConnectFailed extends Data.TaggedError("ConnectFailed")<{
  readonly cause: unknown;
  readonly reason: string;
}> {}

/**
 * Words for a socket failure. Its own message says only that an error occurred, and
 * the cause is what says which one.
 * @param error - The failure.
 * @returns Text fit for a `closed` Entry.
 */
export const describeSocketError = ({ message, reason }: Socket.SocketError): string =>
  "cause" in reason && reason.cause instanceof Error ? reason.cause.message : message;

const connectFailed = ({ host, port }: Ircd, cause: Socket.SocketError) =>
  new ConnectFailed({
    cause,
    reason: `could not connect to ${host}:${port}: ${describeSocketError(cause)}`,
  });

const openFailed = (kind: Socket.SocketOpenError["kind"], cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ cause, kind }) });

// SNI carries names only, and Node refuses an IP address there. Omitting it still
// verifies, because the identity check falls back to `host`.
const dial = ({ host, port, tls }: Ircd) =>
  Effect.callback<NetSocket, Socket.SocketError>((resume) => {
    const stream = tls
      ? connectTls({
          host,
          port,
          rejectUnauthorized: true,
          ...(isIP(host) === 0 && { servername: host }),
        })
      : connectNet({ host, port });

    stream.once(tls ? "secureConnect" : "connect", () => {
      resume(Effect.succeed(stream));
    });

    // Stays for the life of the stream, which throws an `error` nothing listens for.
    stream.on("error", (cause) => {
      resume(Effect.fail(openFailed("Unknown", cause)));
    });

    return Effect.sync(() => {
      stream.destroy();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: openTimeout,
      orElse: () => Effect.fail(openFailed("Timeout", new Error("Connection timed out"))),
    })
  );

const socketGone = () =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: abnormalClose }) });

// `destroySoon` waits for `finish`, which a stream still holding bytes for an Ircd that
// has stopped reading never reaches, and it would stay open with them for good.
const release = (stream: NetSocket) =>
  Effect.sync(() => {
    if (stream.writableLength > 0) {
      stream.destroy();
    } else {
      stream.destroySoon();
    }
  });

// Mends two things `fromDuplex` does to a stream that has ended. A write that starts
// after the close waits for a `drain` that can never come, though one already waiting
// is failed by the close. So a write races the close, and has to, because the stream
// can close between looking at it and writing to it. And a reset discards what the
// stream read but nobody has pulled yet, which here are Lines the Ircd really did
// deliver (LOG-4).
const mended = (stream: NetSocket, { pull, ...reader }: Socket.Reader, writer: Socket.Writer) => {
  const closes = Effect.callback<never, Socket.SocketError>((resume) => {
    const onClose = () => {
      resume(Effect.fail(socketGone()));
    };

    if (stream.destroyed) {
      onClose();
    }

    stream.once("close", onClose);

    return Effect.sync(() => {
      stream.off("close", onClose);
    });
  });

  // Not writing at all to a stream that has ended, which would turn it into an error.
  const whileOpen = (write: Effect.Effect<void, Socket.SocketError>) =>
    Effect.suspend(() =>
      stream.writable ? Effect.raceFirst(write, closes) : Effect.fail(socketGone())
    );

  return Socket.make({
    reader: Effect.succeed({
      ...reader,
      pull: pull.pipe(
        Effect.catch((error) => {
          const unpulled: unknown = stream.read();

          return unpulled instanceof Uint8Array
            ? Effect.succeed(Arr.of(unpulled))
            : Effect.fail(error);
        })
      ),
    }),
    writer: Effect.succeed({
      write: (chunk) => whileOpen(writer.write(chunk)),
      writeAll: (chunks) => whileOpen(writer.writeAll(chunks)),
    }),
  });
};

/**
 * Opens Connections to Ircds. It dials here, where a failure can be a `ConnectFailed`,
 * and keeps hold of the stream, because a Socket says nothing about whether its stream
 * is still there. A write to one that has gone fails at once, with a close.
 */
export class Transport extends Context.Service<
  Transport,
  {
    readonly connect: (ircd: Ircd) => Effect.Effect<Socket.Socket, ConnectFailed, Scope.Scope>;
  }
>()("@iirc/session/Transport") {
  /** TCP or TLS through BunSocket, verifying certificates and sending SNI. */
  static readonly layer: Layer.Layer<Transport> = Layer.succeed(this, {
    connect: Effect.fn("Transport.connect")(function* (ircd: Ircd) {
      const failedOn = (cause: Socket.SocketError) => connectFailed(ircd, cause);
      const stream = yield* Effect.mapError(dial(ircd), failedOn);

      yield* Effect.addFinalizer(() => release(stream));

      const socket = yield* BunSocket.fromDuplex(Effect.succeed(stream));
      const reader = yield* Effect.mapError(socket.reader, failedOn);

      return mended(stream, reader, yield* socket.writer);
    }),
  });
}
