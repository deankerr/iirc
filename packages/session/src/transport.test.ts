import { createServer as createPlainServer } from "node:net";
import {
  createSecureContext,
  createServer,
  getCACertificates,
  setDefaultCACertificates,
} from "node:tls";

import { assert, describe, it } from "@effect/vitest";
import type { NetworkInput } from "@iirc/lifecycle";
import { privmsg } from "@iirc/protocol/outbound";
import { Deferred, Effect, Exit, Fiber, Layer, Ref, References } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";

import type { Entry, NewEntry } from "./entry.ts";
import { hostNetwork, NotInSession } from "./network.ts";
import { MemoryEntries, Recorder } from "./recorder.ts";
import {
  eventually,
  listenOn,
  scriptedIrcd,
  testAuthority,
  testWire,
  welcoming,
} from "./testing.ts";
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

const decoder = new TextDecoder();

// Other software on this machine dials 127.0.0.1, and nothing dials this.
const quietAddress = "127.78.0.1";

// A real wait, for a test whose clock is a `TestClock`.
const realMillis = (millis: number) =>
  Effect.promise(async () => {
    await Bun.sleep(millis);
  });

const untilReally = <A>(check: Effect.Effect<A>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    let value = yield* check;

    while (!done(value)) {
      yield* realMillis(5);
      value = yield* check;
    }

    return value;
  });

// Trusts one more authority for as long as the scope lasts, without anything in
// `Transport` being there for tests to reach.
const trusting = (ca: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const defaults = getCACertificates("default");

      setDefaultCACertificates([...defaults, ca]);

      return defaults;
    }),
    (defaults) =>
      Effect.sync(() => {
        setDefaultCACertificates(defaults);
      })
  );

// A TLS Ircd on `quietAddress`, certified for that, and a wire to it.
const trustedTlsIrcd = (respond: (line: string) => readonly string[]) =>
  Effect.gen(function* () {
    const authority = yield* testAuthority("iirc test CA");

    yield* trusting(authority.ca);

    const ircd = yield* scriptedIrcd(respond, {
      hostname: quietAddress,
      tls: authority.issue(`IP:${quietAddress}`),
    });

    return { ircd, wire: yield* testWire(ircd.port, quietAddress) };
  });

const hostOn = (port: number) =>
  hostNetwork({
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

// The real socket, but with one write failing as a broken pipe would.
const writesFailOn = (text: string) =>
  Layer.effect(
    Transport,
    Effect.gen(function* () {
      const real = yield* Transport;

      return Transport.of({
        connect: Effect.fnUntraced(function* (ircd) {
          const { reader, writer } = yield* real.connect(ircd);
          const open = yield* writer;

          const write: Socket.Writer["write"] = (chunk) =>
            chunk instanceof Uint8Array && decoder.decode(chunk) === `${text}\r\n`
              ? Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketWriteError({ cause: new Error("broken pipe") }),
                  })
                )
              : open.write(chunk);

          return Socket.make({ reader, writer: Effect.succeed({ ...open, write }) });
        }),
      });
    })
  ).pipe(Layer.provide(Transport.layer));

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

type Ircd = Effect.Success<ReturnType<typeof scriptedIrcd>>;

const outboundLine = (text: string) => {
  const built = privmsg("#one", text);

  if (built._tag === "Rejected") {
    throw new Error(built.reason);
  }

  return built.line;
};

const lineTexts = (entries: readonly Entry[], direction: "inbound" | "outbound") =>
  entries.flatMap((entry) =>
    entry._tag === "Line" && entry.direction === direction ? [decoder.decode(entry.bytes)] : []
  );

const closedReason = (entries: readonly Entry[]) =>
  entries.flatMap((entry) =>
    entry._tag === "Connection" && entry.phase === "closed" ? [entry.reason] : []
  );

const carries = (text: string) => (entry: NewEntry) =>
  entry._tag === "Line" && decoder.decode(entry.bytes) === text;

// Holds the commit of a Line, as a slow disk would, so the socket can move on without
// the loop. Whatever is read meanwhile can only wait in the inbox and the stream.
const holdingCommitOf = (text: string, hold: Effect.Effect<void>) =>
  Layer.effect(
    Recorder,
    Recorder.pipe(
      Effect.map(({ record }) =>
        Recorder.of({
          record: (entries, within) =>
            Effect.andThen(
              entries.some(carries(text)) ? hold : Effect.void,
              record(entries, within)
            ),
        })
      )
    )
  ).pipe(Layer.provideMerge(Recorder.memoryReadable));

const allEntries = MemoryEntries.use(({ entries }) => entries);

const until = (hosted: Effect.Success<ReturnType<typeof hostOn>>) =>
  eventually(allEntries, (entries) => closedReason(entries).length > 0).pipe(
    Effect.tap(() => hosted.status)
  );

// Far more than a socket buffer holds, and more than the inbox does in one read.
const burstLines = Array.from(
  { length: 30_000 },
  (_, index) => `:a!b@c PRIVMSG #one :${index} ${"x".repeat(60)}`
);

describe("Transport.layer when a Connection dies under a burst", () => {
  it.live("records all of it, and closes fast, when the `PONG` finds the socket closed", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("iirc"));
      const hosted = yield* hostOn(ircd.port);

      yield* eventually(ircd.received, (received) => received.includes("JOIN #one"));
      yield* ircd.push(burstLines.join("\r\n"));
      yield* ircd.push("PING :last");
      yield* ircd.finish;

      const entries = yield* until(hosted);

      assert.deepStrictEqual(lineTexts(entries, "inbound"), [
        ":ircd 001 iirc :Welcome",
        ":iirc!~u@host JOIN #one",
        ...burstLines,
        "PING :last",
      ]);
      assert.include(lineTexts(entries, "outbound"), "PONG last");
      assert.deepStrictEqual(closedReason(entries), ["the Ircd closed the Connection"]);
    }).pipe(
      // Long enough for the Ircd's close to arrive, so the `PONG` is written after it.
      Effect.provide([holdingCommitOf("PING :last", Effect.sleep("200 millis")), Transport.layer])
    )
  );

  it.live("reads to the end of a real socket after a write fails halfway through", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("iirc"));
      const hosted = yield* hostOn(ircd.port);

      yield* eventually(ircd.received, (received) => received.includes("JOIN #one"));
      yield* ircd.push("PING :first");
      yield* ircd.push(burstLines.join("\r\n"));
      yield* ircd.finish;

      const entries = yield* until(hosted);

      assert.deepStrictEqual(lineTexts(entries, "inbound"), [
        ":ircd 001 iirc :Welcome",
        ":iirc!~u@host JOIN #one",
        "PING :first",
        ...burstLines,
      ]);
      assert.deepStrictEqual(closedReason(entries), ["write failed: broken pipe"]);
    }).pipe(Effect.provide([Recorder.memoryReadable, writesFailOn("PONG first")]))
  );

  it.live("keeps what the socket already held when the Ircd resets it", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<undefined>();
      const lines = Array.from({ length: 40 }, (_, index) => `NOTICE * :${index}`);

      return yield* Effect.gen(function* () {
        const ircd = yield* scriptedIrcd(welcoming("iirc"));
        const hosted = yield* hostOn(ircd.port);

        yield* eventually(ircd.received, (received) => received.includes("JOIN #one"));

        // One at a time, so they are separate reads, and the inbox fills behind the hold.
        yield* Effect.forEach(
          lines,
          (line) => Effect.andThen(ircd.push(line), Effect.sleep("5 millis")),
          { discard: true }
        );
        yield* ircd.hangUp;
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(release, undefined);

        const entries = yield* until(hosted);

        assert.deepStrictEqual(lineTexts(entries, "inbound").slice(2), lines);
        assert.include(closedReason(entries)[0], "ECONNRESET");
      }).pipe(
        Effect.provide([
          holdingCommitOf("NOTICE * :0", Effect.asVoid(Deferred.await(release))),
          Transport.layer,
        ])
      );
    })
  );
});

describe("Transport.layer when a close starts locally", () => {
  it.live("records all of a burst that follows `ERROR`, up to the Ircd hanging up", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("iirc"));
      const hosted = yield* hostOn(ircd.port);

      yield* eventually(ircd.received, (received) => received.includes("JOIN #one"));
      yield* ircd.push("ERROR :Closing Link");
      yield* ircd.push(burstLines.join("\r\n"));
      yield* ircd.finish;

      const entries = yield* until(hosted);

      assert.deepStrictEqual(lineTexts(entries, "inbound"), [
        ":ircd 001 iirc :Welcome",
        ":iirc!~u@host JOIN #one",
        "ERROR :Closing Link",
        ...burstLines,
      ]);
      assert.deepStrictEqual(closedReason(entries), ["Closing Link"]);
    }).pipe(Effect.provide([Recorder.memoryReadable, Transport.layer]))
  );

  it.live(
    "hangs up 5 seconds after `ERROR` on an Ircd that does not",
    () =>
      Effect.gen(function* () {
        const ircd = yield* scriptedIrcd(welcoming("iirc"), { hostname: quietAddress });

        const hosted = yield* hostNetwork({
          id: "local",
          input,
          ircd: { host: quietAddress, port: ircd.port, tls: false },
        });

        yield* eventually(ircd.received, (received) => received.includes("JOIN #one"));
        yield* ircd.push("ERROR :Closing Link");

        const started = Date.now();

        yield* eventually(ircd.closed, (closed) => closed === 1, "8 seconds");

        const waited = Date.now() - started;

        assert.isAtLeast(waited, 4900);
        assert.isBelow(waited, 7000);
        assert.deepStrictEqual(yield* hosted.status, {
          closeReason: "Closing Link",
          phase: "closed",
        });
      }).pipe(Effect.provide([Recorder.memoryReadable, Transport.layer])),
    { timeout: 10_000 }
  );
});

describe("Transport.layer against a stream that is going", () => {
  const megabytes = 1024 * 1024;

  // Far more than the kernels on both sides hold, so most of it stays in the stream.
  const tooMuch = 64 * megabytes;
  const whatKernelsHold = 16 * megabytes;

  const plainWire = Effect.flatMap(
    scriptedIrcd(() => [], { hostname: quietAddress }),
    ({ port }) => testWire(port, quietAddress)
  );

  for (const tls of [false, true]) {
    it.effect(`lets go of a stream a stalled Ircd will never finish (tls: ${tls})`, () =>
      Effect.gen(function* () {
        const wire = yield* tls
          ? Effect.map(
              trustedTlsIrcd(() => []),
              ({ wire: toTls }) => toTls
            )
          : plainWire;

        yield* Effect.gen(function* () {
          const socket = yield* connect(quietAddress, wire.port, tls);
          const writer = yield* socket.writer;

          yield* realMillis(50);
          yield* wire.stall;

          const writing = yield* Effect.forkChild(writer.write(new Uint8Array(tooMuch)));

          yield* realMillis(300);

          // Backpressure: the write waits for an Ircd that is not reading.
          assert.isUndefined(writing.pollUnsafe());

          yield* Fiber.interrupt(writing);
        }).pipe(Effect.scoped);

        // The stream has been told to close, so the rest of the wire is what the kernel
        // already held. A stream that stayed would now send every last byte.
        yield* wire.resume;
        yield* wire.untilGone;

        assert.isBelow(yield* wire.delivered, whatKernelsHold);
      }).pipe(Effect.provide(Transport.layer))
    );
  }

  it.effect("holds a stalled TLS write for exactly 10 seconds, then closes (CONN-1)", () =>
    Effect.gen(function* () {
      const { ircd, wire } = yield* trustedTlsIrcd(welcoming("iirc"));

      const hosted = yield* hostNetwork({
        id: "local",
        input,
        ircd: { host: quietAddress, port: wire.port, tls: true },
      });

      yield* untilReally(ircd.received, (received) => received.includes("JOIN #one"));
      yield* wire.stall;

      const sent = yield* Ref.make(0);
      const line = outboundLine("x".repeat(400));

      // Until the stream stops taking Lines, which is the wire's kernel buffers full.
      const sending = yield* hosted
        .send(line, "test")
        .pipe(
          Effect.andThen(Ref.update(sent, (count) => count + 1)),
          Effect.forever,
          Effect.exit,
          Effect.forkChild
        );

      let settled = -1;

      while (settled !== (yield* Ref.get(sent))) {
        settled = yield* Ref.get(sent);
        yield* realMillis(200);
      }

      assert.isAbove(settled, 1000);
      assert.isUndefined(sending.pollUnsafe());
      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* TestClock.adjust("9999 millis");
      yield* realMillis(50);

      assert.isUndefined(sending.pollUnsafe());

      yield* TestClock.adjust("1 millis");

      const ended = yield* Fiber.join(sending);

      assert.deepStrictEqual(ended, Exit.fail(new NotInSession({ phase: "closed" })));

      // The write has gone, so this is the drain's limit, and then the stream goes too.
      yield* TestClock.adjust("5 seconds");
      yield* untilReally(hosted.status, ({ phase }) => phase === "closed");
      yield* wire.resume;
      yield* wire.untilGone;

      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "write timed out",
        phase: "closed",
      });
      assert.lengthOf(closedReason(yield* allEntries), 1);
    }).pipe(Effect.provide([Recorder.memoryReadable, Transport.layer]))
  );

  // With this few operations between yields the fiber stops between looking at the stream
  // and writing to it, as it does at any point now and then, and the reset lands there.
  // A write on a closed stream waits for a `drain` that can never come.
  it.live("fails a write the moment the stream closes, wherever the close lands", () =>
    Effect.gen(function* () {
      const rounds = 300;
      const operations = 3;
      const line = new TextEncoder().encode("PRIVMSG #one :hi\r\n");

      const server = createPlainServer((peer) => {
        let armed = false;

        peer.on("error", () => {
          // This whole test is resets.
        });
        peer.on("data", () => {
          if (!armed) {
            armed = true;
            setTimeout(() => {
              peer.resetAndDestroy();
            }, Math.random() * 3);
          }
        });
      });

      const port = yield* listenOn(server, quietAddress);

      const round = Effect.gen(function* () {
        const socket = yield* connect(quietAddress, port, false);
        const writer = yield* socket.writer;

        return yield* writer.write(line).pipe(
          Effect.timeoutOrElse({
            duration: "500 millis",
            orElse: () => Effect.die("a write outlived its stream"),
          }),
          Effect.andThen(Effect.yieldNow),
          Effect.forever,
          Effect.flip
        );
      }).pipe(Effect.scoped, Effect.provideService(References.MaxOpsBeforeYield, operations));

      yield* Effect.forEach(Array.from({ length: rounds }), () => round, { discard: true });
    }).pipe(Effect.provide(Transport.layer))
  );

  const numberedLines = Array.from({ length: 400_000 }, (_, index) =>
    String(index).padStart(8, "0")
  );

  const numbered = Buffer.from(numberedLines.join("\r\n"));

  // What a stream holds when nobody pulled it, and then whatever the kernel kept. After
  // a reset it can only be less than was sent, but any of it out of place is a bug.
  const assertPrefixAfterReset = (host: string, port: number, tls: boolean, push: Ircd) =>
    Effect.gen(function* () {
      const socket = yield* connect(host, port, tls);
      const pull = yield* Socket.readerBytes(socket);

      yield* push.push(numberedLines.join("\r\n"));
      yield* Effect.sleep("150 millis");
      yield* push.hangUp;
      yield* Effect.sleep("50 millis");

      const chunks: Uint8Array[] = [];
      let pulls = 0;
      let ending = yield* Effect.exit(pull);

      while (Exit.isSuccess(ending)) {
        pulls += 1;
        chunks.push(...ending.value);
        assert.isBelow(pulls, 100_000, "a pull after a reset must end, not spin");
        ending = yield* Effect.exit(pull);
      }

      const got = Buffer.concat(chunks);

      assert.isAbove(got.length, 0);
      assert.isTrue(got.equals(numbered.subarray(0, got.length)), "lost or repeated bytes");
    }).pipe(Effect.scoped);

  it.live("keeps a TCP stream's bytes in order through a reset, and then ends", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(() => [], { hostname: quietAddress });

      yield* assertPrefixAfterReset(quietAddress, ircd.port, false, ircd);
    }).pipe(Effect.provide(Transport.layer))
  );

  it.live("keeps a TLS stream's bytes in order through a reset, and then ends", () =>
    Effect.gen(function* () {
      const authority = yield* testAuthority("iirc test CA");

      yield* trusting(authority.ca);

      const ircd = yield* scriptedIrcd(() => [], {
        hostname: quietAddress,
        tls: authority.issue(`IP:${quietAddress}`),
      });

      yield* assertPrefixAfterReset(quietAddress, ircd.port, true, ircd);
    }).pipe(Effect.provide(Transport.layer))
  );
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
      const silent = yield* scriptedIrcd(() => [], { hostname: quietAddress });

      const fiber = yield* Effect.forkChild(
        Effect.scoped(connect(quietAddress, silent.port, true))
      );

      yield* untilReally(silent.accepted, (accepted) => accepted === 1);
      yield* TestClock.adjust("14999 millis");

      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 millis");

      const failure = yield* Effect.flip(Fiber.join(fiber));

      assert.include(failure.reason, "timed out");

      // The handshake is abandoned, and not left running with nobody to tell.
      yield* untilReally(silent.closed, (closed) => closed === 1);
    }).pipe(Effect.provide(Transport.layer))
  );
});
