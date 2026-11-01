import { createSecureContext, createServer } from "node:tls";

import { assert, describe, it } from "@effect/vitest";
import type { NetworkInput } from "@iirc/lifecycle";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { hostNetwork } from "./network.ts";
import { MemoryEntries, Recorder } from "./recorder.ts";
import { eventually, scriptedIrcd, welcoming } from "./testing.ts";
import { ConnectFailed, Transport } from "./transport.ts";

const input: NetworkInput = {
  channels: ["#one"],
  nick: "iirc",
  realname: "I IRC",
  username: "user",
};

// A throwaway self-signed pair for `localhost`, trusted by nothing.
const testKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgqqySDirHmkqA7A5m
qFWW+wn2UYh5XNSWf5+7Z/DrGa2hRANCAARoMGtdKcLTbIkfww1YyXgmEbx0pTqc
bqLbcOqTMxVYb60xhmY3KRyKl3aaJ/ouo9zJsudZGTkKQb6y6W1R5Tcn
-----END PRIVATE KEY-----`;

const testCert = `-----BEGIN CERTIFICATE-----
MIIBlDCCATugAwIBAgIURTBhrPkqBAUkFFqmhybbWasR0QkwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwMTAzMDMxMloYDzIxMjYxMDA4
MDMwMzEyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARoMGtdKcLTbIkfww1YyXgmEbx0pTqcbqLbcOqTMxVYb60xhmY3KRyK
l3aaJ/ouo9zJsudZGTkKQb6y6W1R5Tcno2kwZzAdBgNVHQ4EFgQUSGfC5YdNl+b0
KZ5lL1ssBiE6BsAwHwYDVR0jBBgwFoAUSGfC5YdNl+b0KZ5lL1ssBiE6BsAwDwYD
VR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwID
RwAwRAIgHdq/QLrUFU1fh0QowGpVrjc331XYBv6pLPf8rkCDWWsCIAlyaR5T6prF
pR8qyUD5/SiRQHlTvm0vOrmahOJamYi1
-----END CERTIFICATE-----`;

const hostOn = (port: number) =>
  hostNetwork({
    history: [],
    id: "local",
    input,
    ircd: { host: "127.0.0.1", port, tls: false },
  });

const closedPort = Effect.scoped(
  Effect.map(
    scriptedIrcd(() => []),
    ({ port }) => port
  )
);

const connect = (host: string, port: number, tls: boolean) =>
  Transport.use(({ connect }) => connect({ host, port, tls }));

// Records the name each client hello asks for, and shows the certificate either way.
const tlsListener = Effect.gen(function* () {
  const port = yield* closedPort;
  const names: string[] = [];

  const server = createServer({
    SNICallback: (name, done) => {
      names.push(name);
      done(null, createSecureContext({ cert: testCert, key: testKey }));
    },
    cert: testCert,
    key: testKey,
  });

  server.on("tlsClientError", () => {
    // The client hanging up on an untrusted certificate is the point.
  });

  yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(port, "localhost", () => {
        resume(Effect.succeed(port));
      });
    }),
    () =>
      Effect.sync(() => {
        server.close();
      })
  );

  return { names, port };
});

describe("Transport.layer over a real port", () => {
  it.live("carries a whole registration, `PING` included, and a hang-up", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("iirc"));
      const hosted = yield* hostOn(ircd.port);

      yield* eventually(ircd.received, (received) => received.includes("JOIN #one"));

      assert.deepStrictEqual(yield* ircd.received, [
        "NICK iirc",
        "USER user 0 * :I IRC",
        "JOIN #one",
      ]);
      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.strictEqual(yield* ircd.accepted, 1);

      yield* ircd.push("PING :over-tcp");
      yield* eventually(ircd.received, (received) => received.includes("PONG over-tcp"));
      yield* ircd.hangUp;

      const status = yield* eventually(hosted.status, ({ phase }) => phase === "closed");

      // `terminate` resets the Connection, so this is the error path, not a clean end.
      assert.include(status.closeReason, "ECONNRESET");

      const entries = yield* MemoryEntries.use(({ entries }) => entries);

      assert.strictEqual(entries.filter(({ _tag }) => _tag === "Connection").length, 3);
    }).pipe(Effect.provide([Recorder.memoryReadable, Transport.layer]))
  );

  it.live("records a refused Connection as `attempt` then `closed`", () =>
    Effect.gen(function* () {
      const port = yield* closedPort;
      const hosted = yield* hostOn(port);

      const status = yield* eventually(hosted.status, ({ phase }) => phase === "closed");
      const entries = yield* MemoryEntries.use(({ entries }) => entries);

      assert.lengthOf(entries, 2);
      assert.include(status.closeReason, `could not connect to 127.0.0.1:${port}`);
      assert.notInclude(status.closeReason, "An error occurred");
    }).pipe(Effect.provide([Recorder.memoryReadable, Transport.layer]))
  );

  it.live("sends SNI and refuses a certificate it cannot verify (CONN-1)", () =>
    Effect.gen(function* () {
      const { names, port } = yield* tlsListener;
      const exit = yield* Effect.exit(Effect.scoped(connect("localhost", port, true)));

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(names, ["localhost"]);

      const failure = yield* Effect.flip(Effect.scoped(connect("localhost", port, true)));

      assert.instanceOf(failure, ConnectFailed);
      assert.include(failure.reason, "self signed");
    }).pipe(Effect.provide(Transport.layer))
  );

  it.effect("gives up on a handshake after exactly 15 seconds (CONN-1)", () =>
    Effect.gen(function* () {
      const silent = yield* scriptedIrcd(() => []);

      const fiber = yield* Effect.forkChild(Effect.scoped(connect("127.0.0.1", silent.port, true)));

      yield* TestClock.adjust("14999 millis");

      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 millis");

      const failure = yield* Effect.flip(Fiber.join(fiber));

      assert.include(failure.reason, "timed out");
    }).pipe(Effect.provide(Transport.layer))
  );
});
