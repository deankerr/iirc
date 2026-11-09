import { isIP } from "node:net";
import { getCACertificates } from "node:tls";

/**
 * The production Transport: TCP and TLS on Bun, through Effect's sockets.
 *
 * It is built on `@effect/platform-bun`'s `BunSocket`, which is Effect's Node socket over
 * Bun's `node:net` and `node:tls`, as ADR 0005 asks. Effect covers every need here:
 * connecting, a TLS upgrade with SNI, trust anchors and hostname verification, reads that
 * wait for a pull, so the kernel holds back a peer we are not reading, and writes that
 * wait for `drain`. `Bun.connect` is not needed.
 *
 * @packageDocumentation
 */
import * as BunSocket from "@effect/platform-bun/BunSocket";
import type { CloseReason, IrcdAddress } from "@iirc/client";
import { maxReceivedBytes, Transport } from "@iirc/runtime/transport";
import type { Link, LinkEvent, TransportService } from "@iirc/runtime/transport";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect";
import type { Duration } from "effect";
import * as Socket from "effect/socket/Socket";

import { makeFramer } from "./framer.ts";

/** Where a dial actually goes: a host name or address, and a port. */
export interface Destination {
  readonly host: string;
  readonly port: number;
}

/** How the Bun Transport dials. Production leaves every option at its default. */
export interface BunTransportOptions {
  /**
   * How long reaching the Ircd may take, from the start of the dial to an open TCP
   * Connection, including {@link BunTransportOptions.route} and resolving the name.
   * Defaults to 30 seconds.
   */
  readonly connectTimeout?: Duration.Input;
  /** How long the TLS handshake may take once TCP is open. Defaults to 30 seconds. */
  readonly handshakeTimeout?: Duration.Input;
  /**
   * How long one `send` may wait for the socket to take its bytes, which it does only
   * when the far end has stopped reading. Defaults to 60 seconds.
   */
  readonly writeTimeout?: Duration.Input;
  /**
   * Where to connect for an address. SNI and the certificate are still checked against
   * the address's own host, so this redirects a dial without weakening TLS. Defaults to
   * the address itself, resolved by the system.
   */
  readonly route?: (address: IrcdAddress) => Effect.Effect<Destination>;
  /**
   * Certificate authorities to trust, as PEM, on top of the system roots. Defaults to
   * none. A test trusts its own self-signed certificate this way.
   */
  readonly trust?: readonly string[];
}

const encoder = new TextEncoder();

// The socket is never given an encoding, so its chunks are bytes. A string is encoded
// rather than trusted away, since the type allows one.
const asBytes = (chunks: readonly (Uint8Array | string)[]) =>
  chunks.map((chunk) => (chunk instanceof Uint8Array ? chunk : encoder.encode(chunk)));

/**
 * The system's trust store, or Bun's bundled Mozilla roots where the system has none,
 * such as a bare container.
 * @returns The roots, as PEM.
 */
const systemRoots = () => {
  const system = getCACertificates("system");

  return system.length > 0 ? system : getCACertificates("default");
};

/** A system error names its cause by a code, such as `ECONNRESET`. */
const Coded = Schema.Struct({ code: Schema.String });
const isCoded = Schema.is(Coded);

const codeOf = (cause: unknown) => (isCoded(cause) ? cause.code : "");

/**
 * Why reaching the Ircd failed, from the error's code and never from its wording. A
 * name that does not resolve, a network that cannot be reached, and anything unknown
 * are all `Unreachable`.
 * @param cause - What the socket failed with.
 * @returns How the dial ended.
 */
const openReason = (cause: unknown): CloseReason => {
  const code = codeOf(cause);

  if (code === "ECONNREFUSED") {
    return "Refused";
  }

  if (code === "ETIMEDOUT") {
    return "TimedOut";
  }

  if (code === "ECONNRESET") {
    return "Reset";
  }

  return "Unreachable";
};

/**
 * Why a Connection ended, from the kind of socket error and its code.
 * @param error - What the socket failed with.
 * @returns How the Connection ended.
 */
const reasonOf = (error: Socket.SocketError): CloseReason => {
  const { reason } = error;

  switch (reason._tag) {
    case "SocketOpenError": {
      return reason.kind === "Timeout" ? "TimedOut" : openReason(reason.cause);
    }

    case "SocketUpgradeError": {
      return "Tls";
    }

    case "SocketCloseError": {
      return reason.code === 1000 ? "Ended" : "Reset";
    }

    case "SocketReadError":
    case "SocketWriteError": {
      return codeOf(reason.cause) === "ETIMEDOUT" ? "TimedOut" : "Reset";
    }

    default: {
      return "Reset";
    }
  }
};

const timedOut = new Socket.SocketError({
  reason: new Socket.SocketOpenError({ cause: undefined, kind: "Timeout" }),
});

/** An open Connection's two halves. */
interface Open {
  readonly _tag: "Open";
  readonly pull: Effect.Effect<readonly Uint8Array[], Socket.SocketError>;
  readonly writer: Socket.Writer;
}

/** How the dial settled: open, or ended first. `undefined` is a closed Scope. */
type Settled = Open | { readonly _tag: "Ended"; readonly reason: CloseReason | undefined };

const opened: LinkEvent = { _tag: "Opened" };

const closed = (reason: CloseReason): LinkEvent => ({ _tag: "Closed", reason });

const received = (bytes: Uint8Array): LinkEvent => ({ _tag: "Received", bytes });

/**
 * Makes the Transport.
 * @param options - How to dial. Production leaves them at their defaults.
 * @returns A Transport over TCP and TLS.
 */
export const makeBunTransport = (options: BunTransportOptions = {}): TransportService => {
  const connectTimeout = options.connectTimeout ?? "30 seconds";
  const handshakeTimeout = options.handshakeTimeout ?? "30 seconds";
  const writeTimeout = options.writeTimeout ?? "60 seconds";
  const route = options.route ?? ((address) => Effect.succeed(address));
  // Read once per Transport rather than once per dial.
  const roots = [...systemRoots(), ...(options.trust ?? [])];

  const tlsOptions = (host: string): Socket.TlsUpgradeOptions => ({
    ca: roots,
    rejectUnauthorized: true,
    // SNI may not carry an address (RFC 6066), so an address is verified without it.
    ...(isIP(host) === 0 && { servername: host }),
  });

  const dial = (address: IrcdAddress): Effect.Effect<Link, never, Scope.Scope> =>
    Effect.gen(function* () {
      // The Connection's resources live in their own Scope, so it can end before the dial's.
      const connection = yield* Scope.fork(yield* Scope.Scope);
      const settled = yield* Deferred.make<Settled>();
      const ended = yield* Deferred.make<CloseReason | undefined>();

      // Ends the Connection once: the first reason wins, and the socket is destroyed at
      // once rather than waiting to flush, which a peer that never reads would never let
      // happen. Bytes the kernel already holds are still delivered.
      const finish = (reason: CloseReason | undefined) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!(yield* Deferred.succeed(ended, reason))) {
              return;
            }

            const now = yield* Deferred.succeed(settled, { _tag: "Ended", reason }).pipe(
              Effect.andThen(Deferred.await(settled))
            );

            if (now._tag === "Open") {
              yield* Effect.ignore(now.writer.write(new Socket.CloseEvent(1000)));
            }

            yield* Scope.close(connection, Exit.void);
          })
        );

      const reach = Effect.gen(function* () {
        const destination = yield* route(address);

        const socket = yield* BunSocket.makeNet({
          host: destination.host,
          port: destination.port,
        });

        const reader = yield* Scope.provide(socket.reader, connection);

        return { reader, socket };
      }).pipe(
        Effect.timeoutOrElse({ duration: connectTimeout, orElse: () => Effect.fail(timedOut) })
      );

      const connect = Effect.gen(function* () {
        const { reader, socket } = yield* reach;

        if (address.tls) {
          yield* reader.upgrade(tlsOptions(address.host)).pipe(
            Effect.timeoutOrElse({
              duration: handshakeTimeout,
              orElse: () => Effect.fail(timedOut),
            })
          );
        }

        const writer = yield* Scope.provide(socket.writer, connection);

        yield* Deferred.succeed(settled, {
          _tag: "Open",
          pull: reader.pull.pipe(Effect.map(asBytes)),
          writer,
        });
      }).pipe(Effect.catch((error) => finish(reasonOf(error))));

      const connecting = yield* Effect.forkScoped(connect);

      yield* Effect.addFinalizer(() => finish(undefined));

      const step = (open: Open, framer: ReturnType<typeof makeFramer>) =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(ended)) {
            const reason = yield* Deferred.await(ended);

            return [reason === undefined ? [] : [closed(reason)], Option.none()] as const;
          }

          const lines = yield* Effect.raceFirst(
            open.pull.pipe(
              Effect.map((chunks) => chunks.flatMap((chunk) => framer.push(chunk))),
              Effect.catch((error) => Effect.as(finish(reasonOf(error)), []))
            ),
            Effect.as(Deferred.await(ended), [])
          );

          return [lines.map(received), Option.some(undefined)] as const;
        });

      const events = Stream.unwrap(
        Effect.map(Deferred.await(settled), (first): Stream.Stream<LinkEvent> => {
          if (first._tag === "Ended") {
            return first.reason === undefined ? Stream.empty : Stream.make(closed(first.reason));
          }

          const framer = makeFramer(maxReceivedBytes);

          return Stream.concat(
            Stream.make(opened),
            Stream.paginate(undefined, () => step(first, framer))
          );
        })
      );

      const send = (bytes: Uint8Array) =>
        Effect.gen(function* () {
          if (!(yield* Deferred.isDone(settled)) || (yield* Deferred.isDone(ended))) {
            return;
          }

          const open = yield* Deferred.await(settled);

          if (open._tag !== "Open") {
            return;
          }

          yield* Effect.raceFirst(
            open.writer.write(bytes).pipe(
              Effect.asVoid,
              Effect.timeoutOrElse({
                duration: writeTimeout,
                orElse: () => finish("TimedOut"),
              }),
              Effect.catch((error) => finish(reasonOf(error)))
            ),
            Effect.asVoid(Deferred.await(ended))
          );
        });

      const hangup = Effect.uninterruptible(
        Effect.andThen(finish("HungUp"), Fiber.interrupt(connecting))
      );

      return { events, hangup, send } satisfies Link;
    });

  return { dial };
};

/**
 * The Transport port, over TCP and TLS on Bun.
 * @param options - How to dial. Production leaves them at their defaults.
 * @returns A Layer that provides the Transport.
 */
export const layer = (options: BunTransportOptions = {}) =>
  Layer.succeed(Transport, makeBunTransport(options));
