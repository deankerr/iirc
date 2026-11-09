import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as Net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Tls from "node:tls";

/**
 * The far end of the Bun Transport for tests: a `TestIrcd` played by real loopback
 * listeners, plain or TLS, with a self-signed certificate made for the run.
 *
 * Each dial is routed through the Transport's `route` option. The route waits until the
 * test opens or refuses the call: opening it starts a listener for that call alone and
 * routes the dial there, and refusing it routes the dial to a port with nothing on it, so
 * the Transport meets a real refusal. Over TLS the certificate is for `irc.test`, which the
 * laws dial, and only the harness trusts it.
 *
 * `TestCall.open` returns once the Link has reported `Opened`, as the in-memory adapter's
 * does, so the harness reads each Link's events as they come and passes them on in order.
 *
 * @packageDocumentation
 */
import type { CloseReason, IrcdAddress } from "@iirc/client";
import type { TestCall, TestIrcd, TransportHarness } from "@iirc/runtime/testing";
import type { Link, LinkEvent, TransportService } from "@iirc/runtime/transport";
import { Deferred, Effect, Queue, Schema, Scope, Stream } from "effect";
import type { Cause } from "effect";
import { constVoid } from "effect/Function";

import { makeBunTransport } from "../transport.ts";
import type { BunTransportOptions, Destination } from "../transport.ts";

/** A key and a self-signed certificate, as PEM. */
export interface Certificate {
  readonly key: string;
  readonly cert: string;
}

/**
 * Makes a self-signed certificate for one name with `openssl`, valid for a day.
 * @param name - The name the certificate is for.
 * @param altName - Its subject alternative name, a DNS name unless said otherwise.
 * @returns Its key and certificate.
 */
export const makeCertificate = (name: string, altName = `DNS:${name}`): Certificate => {
  const directory = mkdtempSync(path.join(tmpdir(), "iirc-transport-bun-"));

  try {
    const key = path.join(directory, "key.pem");
    const cert = path.join(directory, "cert.pem");

    const made = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=${altName}`,
      "-keyout",
      key,
      "-out",
      cert,
    ]);

    if (made.exitCode !== 0) {
      throw new Error(`openssl failed: ${made.stderr.toString()}`);
    }

    return { cert: readFileSync(cert, "utf-8"), key: readFileSync(key, "utf-8") };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

/** A listening server, plain or TLS. */
type Server = Net.Server | Tls.Server;

const loopback = "127.0.0.1";

/** What a listening server's address gives: its port, among other things. */
const Listening = Schema.Struct({ port: Schema.Int });

/**
 * Starts a listener on a free loopback port, closed with the Scope along with every
 * Connection it accepted.
 * @param certificate - Speaks TLS with this certificate, or plain TCP without one.
 * @param accepted - Called with each accepted socket, after any TLS handshake.
 * @param connected - Called with each TCP Connection as it is accepted, before any TLS.
 * @returns The port it listens on.
 */
export const listen = (
  certificate: Certificate | undefined,
  accepted: (socket: Net.Socket) => void,
  connected: (raw: Net.Socket) => void = constVoid
): Effect.Effect<number, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{ server: Server; sockets: Set<Net.Socket> }>((resume) => {
      const sockets = new Set<Net.Socket>();

      const track = (socket: Net.Socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        // A test's far end may be torn down while the Transport still writes to it.
        socket.on("error", constVoid);
      };

      const onSocket = (socket: Net.Socket) => {
        track(socket);
        accepted(socket);
      };

      const server =
        certificate === undefined
          ? Net.createServer(onSocket)
          : Tls.createServer({ cert: certificate.cert, key: certificate.key }, onSocket);

      server.on("connection", (raw: Net.Socket) => {
        track(raw);
        connected(raw);
      });
      // A failed handshake is the test's point, not the listener's failure.
      server.on("tlsClientError", constVoid);
      server.listen(0, loopback, () => {
        resume(Effect.succeed({ server, sockets }));
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<Server>((resume) => {
        for (const socket of sockets) {
          socket.destroy();
        }

        server.close(() => {
          resume(Effect.succeed(server));
        });
      })
  ).pipe(Effect.map(({ server }) => Schema.decodeUnknownSync(Listening)(server.address()).port));

/**
 * A loopback port with nothing listening on it, so a dial there is refused.
 * @returns The port.
 */
export const refusingPort = Effect.scoped(listen(undefined, constVoid));

/**
 * Splits what the Transport sent into Lines, each with its line ending.
 * @returns A function that takes each read and gives the Lines it finished.
 */
const heardLines = () => {
  let pending = Buffer.alloc(0);

  return (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const lines: Uint8Array[] = [];
    let end = pending.indexOf(0x0a);

    while (end !== -1) {
      lines.push(new Uint8Array(pending.subarray(0, end + 1)));
      pending = pending.subarray(end + 1);
      end = pending.indexOf(0x0a);
    }

    return lines;
  };
};

const misuse = (what: string) => Effect.die(new Error(`TestCall: ${what}`));

/**
 * Where to route a dial the test refused, for each reason a refusal can be played as.
 * @param reason - How the test refused the call.
 * @returns A destination that fails that way.
 */
const refusedTo = (reason: CloseReason): Effect.Effect<Destination> => {
  if (reason === "Refused") {
    return refusingPort.pipe(Effect.map((port) => ({ host: loopback, port })));
  }

  if (reason === "Unreachable") {
    // `.invalid` never resolves (RFC 6761), and the system answers that without asking.
    return Effect.succeed({ host: "nowhere.invalid", port: 6667 });
  }

  return misuse(`close ${reason} before open, which a loopback Ircd cannot play`);
};

/**
 * Ends an accepted Connection from the far end, as a reason can be played after open.
 * @param far - The far end's socket.
 * @param reason - How to end it.
 * @returns An Effect that ends it.
 */
const hangUpFar = (far: Net.Socket, reason: CloseReason): Effect.Effect<void> => {
  if (reason === "Ended") {
    return Effect.sync(() => {
      far.end();
    });
  }

  if (reason === "Reset") {
    return Effect.sync(() => {
      far.resetAndDestroy();
    });
  }

  return misuse(`close ${reason} after open, which a loopback Ircd cannot play`);
};

/** How the harness dials and listens. */
export interface LoopbackOptions {
  /** Speak TLS with this certificate, trusted by the Transport, or plain TCP without one. */
  readonly certificate?: Certificate;
  /** The Transport's own options, other than `route` and `trust`, which the harness sets. */
  readonly transport?: Omit<BunTransportOptions, "route" | "trust">;
}

/**
 * The Bun Transport and a `TestIrcd` on loopback, for the port's laws. Without a
 * certificate, every dial is made over plain TCP whatever its address says.
 * @param options - TLS or not, and the Transport's timers.
 * @returns The harness, torn down with the Scope.
 */
export const makeLoopbackHarness = (
  options: LoopbackOptions = {}
): Effect.Effect<TransportHarness, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { certificate } = options;
    const scope = yield* Scope.Scope;
    const calls = yield* Queue.unbounded<TestCall>();
    const routes = yield* Queue.unbounded<Deferred.Deferred<Destination>>();

    const inner = makeBunTransport({
      ...options.transport,
      route: () => Effect.flatMap(Queue.take(routes), Deferred.await),
      trust: certificate === undefined ? [] : [certificate.cert],
    });

    const dial = (address: IrcdAddress) =>
      Effect.gen(function* () {
        const destination = yield* Deferred.make<Destination>();
        const opened = yield* Deferred.make<undefined>();
        const socket = yield* Deferred.make<Net.Socket>();
        // The TCP Connection under any TLS, which the call ends even when the Transport
        // hung up before the far end's handshake finished.
        const raw = yield* Deferred.make<Net.Socket>();
        const heard = yield* Queue.unbounded<Uint8Array>();
        const relayed = yield* Queue.unbounded<LinkEvent, Cause.Done>();

        yield* Queue.offer(routes, destination);

        const link = yield* inner.dial(
          certificate === undefined ? { ...address, tls: false } : address
        );

        yield* Effect.forkScoped(
          Stream.runForEach(link.events, (event) =>
            Effect.andThen(
              Queue.offer(relayed, event),
              event._tag === "Opened" ? Deferred.succeed(opened, undefined) : Effect.void
            )
          ).pipe(Effect.andThen(Queue.end(relayed)))
        );

        const split = heardLines();

        const accepted = (far: Net.Socket) => {
          far.on("data", (chunk: Buffer) => {
            for (const line of split(chunk)) {
              Queue.offerUnsafe(heard, line);
            }
          });
          Deferred.doneUnsafe(socket, Effect.succeed(far));
        };

        const open = Effect.gen(function* () {
          if (yield* Deferred.isDone(destination)) {
            return yield* misuse("open twice, or after close");
          }

          const port = yield* Scope.provide(
            listen(certificate, accepted, (tcp) => Deferred.doneUnsafe(raw, Effect.succeed(tcp))),
            scope
          );

          yield* Deferred.succeed(destination, { host: loopback, port });

          return yield* Deferred.await(opened);
        });

        const close = (reason: CloseReason) =>
          Effect.gen(function* () {
            if (!(yield* Deferred.isDone(destination))) {
              return yield* Effect.asVoid(Deferred.succeed(destination, yield* refusedTo(reason)));
            }

            const far = yield* Deferred.await((yield* Deferred.isDone(socket)) ? socket : raw);

            return yield* hangUpFar(far, reason);
          });

        yield* Queue.offer(calls, {
          address,
          close,
          heard: Queue.take(heard),
          open,
          say: (bytes) =>
            Effect.flatMap(Deferred.await(socket), (far) =>
              Effect.sync(() => {
                far.write(Buffer.concat([bytes, Buffer.from("\r\n")]));
              })
            ),
        });

        return { ...link, events: Stream.fromQueue(relayed) } satisfies Link;
      });

    const transport: TransportService = { dial };
    const ircd: TestIrcd = { accept: Queue.take(calls) };

    return { ircd, transport };
  });
