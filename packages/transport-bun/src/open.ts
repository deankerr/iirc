import * as Net from "node:net";
import type { Duplex } from "node:stream";
import * as Tls from "node:tls";

/**
 * Opens the socket under one Connection: TCP, and TLS on top when the address asks for it.
 *
 * Effect's `Reader.upgrade` would do the TLS step, but it takes only `servername` as the
 * identity, and SNI may not carry an IP (RFC 6066). Without a `servername`, an IP is then
 * checked against whatever the socket reached, which after a `route` is not the address
 * that was dialled. So this opens TLS with `node:tls` itself, passing the dialled host as
 * `host` and checking the certificate against it in `checkServerIdentity`, apart from SNI.
 * Effect's `fromDuplex` takes the open socket from there, so reads, writes, and
 * backpressure are still Effect's.
 *
 * @packageDocumentation
 */
import type { IrcdAddress } from "@iirc/client";
import type { ClientCertificate } from "@iirc/runtime/transport";
import { Deferred, Effect, Redacted } from "effect";
import type { Scope, Duration } from "effect";
import { constVoid } from "effect/Function";
import * as Socket from "effect/socket/Socket";

/** Where a dial actually goes: a host name or address, and a port. */
export interface Destination {
  readonly host: string;
  readonly port: number;
}

/** What opening a socket needs. */
export interface Opening {
  readonly address: IrcdAddress;
  readonly route: (address: IrcdAddress) => Effect.Effect<Destination>;
  readonly connectTimeout: Duration.Input;
  readonly handshakeTimeout: Duration.Input;
  /** The roots to verify against, as PEM. */
  readonly roots: readonly string[];
  /** The client certificate to present on a TLS dial, if there is one. */
  readonly certificate?: ClientCertificate | undefined;
}

/** What TLS is given of a client certificate, which is the only place its values are unwrapped. */
interface Presented {
  readonly cert: string;
  readonly key: string;
}

/**
 * Unwraps a client certificate for TLS, once `node:tls` accepts it. One it rejects, such
 * as a key that is not the certificate's, is warned of by the Credential's name alone
 * and left out, so the Connection dials without it.
 * @param certificate - The certificate, if there is one.
 * @returns What to give TLS, which is nothing without a usable certificate.
 */
const presentable = (
  certificate: ClientCertificate | undefined
): Effect.Effect<Partial<Presented>> => {
  if (certificate === undefined) {
    return Effect.succeed({});
  }

  // Checked apart from the dial, which would fail the whole Connection instead. What
  // `node:tls` says is dropped, since it may quote the PEM.
  return Effect.try({
    catch: () => ({ credential: certificate.credential }),
    try: (): Partial<Presented> => {
      const presented = {
        cert: Redacted.value(certificate.certificate),
        key: Redacted.value(certificate.key),
      };

      Tls.createSecureContext(presented);

      return presented;
    },
  }).pipe(
    Effect.catch((error) =>
      Effect.as(Effect.logWarning("The client certificate could not be used", error), {})
    )
  );
};

/** The error a timer ends a dial with. */
const timedOut = new Socket.SocketError({
  reason: new Socket.SocketOpenError({ cause: undefined, kind: "Timeout" }),
});

const connectFailed = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ cause, kind: "Unknown" }) });

const handshakeFailed = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketUpgradeError({ cause }) });

/**
 * Makes a socket that lives as long as the Scope, and waits for the event that means it
 * is ready. The listeners are attached in the same step that makes the socket, since on
 * loopback the event can come before the fiber runs again. The socket always keeps an
 * `error` listener, so an error no one is waiting for cannot crash the process. Making the
 * socket can throw at once, such as for a port out of range, and that fails the dial too.
 * @param make - Makes the socket.
 * @param ready - The event that means it is ready.
 * @param failed - Makes the error for an error or a close before then.
 * @returns The ready socket, destroyed when the Scope closes.
 */
const start = <A extends Duplex>(
  make: () => A,
  ready: string,
  failed: (cause: unknown) => Socket.SocketError
) =>
  Effect.gen(function* () {
    const outcome = yield* Deferred.make<A, Socket.SocketError>();

    yield* Effect.acquireRelease(
      Effect.try({
        catch: failed,
        try: () => {
          const socket = make();

          socket.on("error", constVoid);
          socket.once(ready, () => Deferred.doneUnsafe(outcome, Effect.succeed(socket)));
          socket.once("error", (cause: unknown) =>
            Deferred.doneUnsafe(outcome, Effect.fail(failed(cause)))
          );
          socket.once("close", () =>
            Deferred.doneUnsafe(outcome, Effect.fail(failed(new Error(`closed before ${ready}`))))
          );

          return socket;
        },
      }),
      (socket) =>
        Effect.sync(() => {
          socket.destroy();
        })
    );

    return yield* Deferred.await(outcome);
  });

/**
 * Opens the socket for one dial, plain or TLS. Reaching the Ircd and the handshake each
 * have their own timer, and every failure is a `SocketError`: `SocketOpenError` before TCP
 * is open, and `SocketUpgradeError` during TLS.
 * @param opening - What to dial, and how.
 * @returns The open socket, destroyed when the Scope closes.
 */
export const openSocket = (
  opening: Opening
): Effect.Effect<Duplex, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const { address } = opening;

    const raw = yield* Effect.gen(function* () {
      const destination = yield* opening.route(address);

      return yield* start(
        () => Net.createConnection({ host: destination.host, port: destination.port }),
        "connect",
        connectFailed
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: opening.connectTimeout,
        orElse: () => Effect.fail(timedOut),
      })
    );

    if (!address.tls) {
      return raw;
    }

    const presented = yield* presentable(opening.certificate);

    return yield* start(
      () =>
        Tls.connect({
          ca: [...opening.roots],
          ...presented,
          // The identity to verify, which may be an IP that SNI cannot carry.
          checkServerIdentity: (_, certificate) =>
            Tls.checkServerIdentity(address.host, certificate),
          host: address.host,
          rejectUnauthorized: true,
          socket: raw,
          ...(Net.isIP(address.host) === 0 && { servername: address.host }),
        }),
      "secureConnect",
      handshakeFailed
    ).pipe(
      Effect.timeoutOrElse({
        duration: opening.handshakeTimeout,
        orElse: () => Effect.fail(timedOut),
      })
    );
  });
