import { connect as connectNet, isIP } from "node:net";
import type { Socket as NetSocket } from "node:net";
import { connect as connectTls } from "node:tls";

import type { Tuning } from "@iirc/lifecycle/tuning";
import { Array as Arr, Context, Data, Duration, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { constVoid } from "effect/Function";
import { Socket } from "effect/socket";

import type { Ircd } from "./entry.ts";

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
const dial = (
  { host, port, tls }: Ircd,
  connectTimeoutMillis: number,
  onStream: (stream: NetSocket) => void
) =>
  Effect.callback<NetSocket, Socket.SocketError>((resume) => {
    const stream = tls
      ? connectTls({
          host,
          port,
          rejectUnauthorized: true,
          ...(isIP(host) === 0 && { servername: host }),
        })
      : connectNet({ host, port });

    onStream(stream);

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
      duration: Duration.millis(connectTimeoutMillis),
      orElse: () => Effect.fail(openFailed("Timeout", new Error("Connection timed out"))),
    })
  );

const writeFailed = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) });

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

// LOG-4: the most one read takes. What the stream holds beyond it has not been read, and
// waits with the rest of a flood, so a host can bound what it has read and not recorded.
const readAtMost = 16 * 1024;

// A Socket over the stream, reading and writing it directly. A read takes what is there,
// up to `readAtMost`, and waits for more only when nothing is. Whatever the stream still
// holds when it ends or resets is read first, because those are Lines the Ircd really did
// deliver (LOG-4). A write is done once the kernel has the bytes, and races the close,
// because a write that starts as the stream closes would otherwise wait for good.
const streamSocket = (stream: NetSocket) => {
  // Why the stream can give nothing more, once it has said so.
  let ending: Socket.SocketError | undefined;

  stream.once("end", () => {
    ending ??= new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) });
  });
  stream.on("error", (cause) => {
    ending ??= new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) });
  });
  stream.once("close", () => {
    ending ??= socketGone();
  });

  const pull = Effect.callback<Arr.NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>(
    (resume) => {
      const events = ["readable", "end", "error", "close"];
      // The listener and its removal each need the other, so it is held here.
      const watching = { onEvent: constVoid };

      const stop = () => {
        for (const event of events) {
          stream.off(event, watching.onEvent);
        }
      };

      watching.onEvent = () => {
        const held = stream.readableLength;
        const chunk: unknown = held > 0 ? stream.read(Math.min(held, readAtMost)) : null;

        if (chunk instanceof Uint8Array) {
          stop();
          resume(Effect.succeed(Arr.of(chunk)));
        } else if (ending !== undefined || stream.destroyed) {
          stop();
          resume(Effect.fail(ending ?? socketGone()));
        }
      };

      for (const event of events) {
        stream.on(event, watching.onEvent);
      }

      watching.onEvent();

      return Effect.sync(stop);
    }
  );

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

  // The stream calls back once the bytes have left its own buffer for the kernel. `write`
  // returning, or `drain`, only says that buffer had room, and a close throws it away
  // (LOG-2).
  const handedOver = (chunk: Uint8Array | string | Socket.CloseEvent) =>
    Socket.isCloseEvent(chunk)
      ? Effect.sync(() => {
          stream.end();
        })
      : Effect.asVoid(
          Effect.callback<number, Socket.SocketError>((resume) => {
            stream.write(chunk, (error) => {
              resume(
                error === null || error === undefined
                  ? Effect.succeed(chunk.length)
                  : Effect.fail(writeFailed(error))
              );
            });
          })
        );

  return Socket.make({
    reader: Effect.succeed({ pull, upgrade: Socket.SocketUpgradeError.unsupported }),
    writer: Effect.succeed({
      write: (chunk) => whileOpen(handedOver(chunk)),
      writeAll: (chunks) => whileOpen(Effect.forEach(chunks, handedOver, { discard: true })),
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
    readonly connect: (
      ircd: Ircd,
      limits: Pick<Tuning, "connectTimeoutMillis">
    ) => Effect.Effect<Socket.Socket, ConnectFailed, Scope.Scope>;
  }
>()("@iirc/session/Transport") {
  /** TCP or TLS through Node's streams, verifying certificates and sending SNI. */
  static readonly layer: Layer.Layer<Transport> = Layer.succeed(this, {
    connect: Effect.fn("Transport.connect")(function* (
      ircd: Ircd,
      { connectTimeoutMillis }: Pick<Tuning, "connectTimeoutMillis">
    ) {
      const failedOn = (cause: Socket.SocketError) => connectFailed(ircd, cause);
      let dialing: NetSocket | undefined;

      // In place before the dial, because a close can cancel one at any moment, and a
      // stream that connected just as that happened would otherwise have no owner.
      yield* Effect.addFinalizer(() => (dialing === undefined ? Effect.void : release(dialing)));

      const stream = yield* Effect.mapError(
        dial(ircd, connectTimeoutMillis, (opening) => {
          dialing = opening;
        }),
        failedOn
      );

      return streamSocket(stream);
    }),
  });
}
