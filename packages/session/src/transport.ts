import { isIP } from "node:net";

import { BunSocket } from "@effect/platform-bun";
import { Context, Data, Duration, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { Socket } from "effect/socket";

import type { Ircd } from "./entry.ts";

// CONN-1.
const openTimeout = Duration.seconds(15);

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

// SNI carries names only, and Node refuses an IP address there. Omitting it still
// verifies, because the identity check falls back to `host`.
const socketFor = ({ host, port, tls }: Ircd) =>
  tls
    ? BunSocket.makeTls({
        host,
        openTimeout,
        port,
        rejectUnauthorized: true,
        ...(isIP(host) === 0 && { servername: host }),
      })
    : BunSocket.makeNet({ host, openTimeout, port });

/**
 * Opens Connections to Ircds. Acquiring a Socket's reader is what dials it, so
 * `connect` acquires it here, where a failure can be a `ConnectFailed`, and the
 * Socket it returns hands back that same reader rather than dialling again.
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
      const socket = yield* socketFor(ircd);

      const reader = yield* socket.reader.pipe(
        Effect.mapError((cause) => connectFailed(ircd, cause))
      );

      return Socket.make({ reader: Effect.succeed(reader), writer: socket.writer });
    }),
  });
}
