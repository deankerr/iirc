import { assert, describe, it } from "@effect/vitest";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { Clock, Deferred, Effect, Exit, Fiber, Redacted, Ref, References, Scope } from "effect";
import { TestClock } from "effect/testing";

import type { Entry, Ircd, NewEntry } from "./entry.ts";
import {
  bareHost,
  brief,
  connectionsOf,
  deadlinesNamed,
  decode,
  droppedIn,
  encode,
  entries,
  host,
  inSession,
  isClosed,
  isLineWith,
  linesOf,
  options,
  probed,
  safe,
  manyTurns,
  texts,
  throwing,
  wire,
} from "./network.fixture.ts";
import type { Overrides } from "./network.fixture.ts";
import { LaneFull, LineDropped, NotInSession } from "./network.ts";
import type { NetworkHost } from "./network.ts";
import { Recorder, RecordFailed } from "./recorder.ts";
import type { WantedChannel } from "./standing.ts";
import { attemptInput, fakeIrcd } from "./testing.ts";
import type { FakeIrcd } from "./testing.ts";

const memory = Effect.provide(Recorder.memoryReadable);

const first: Ircd = { host: "first.test", port: 6697, tls: true };
const second: Ircd = { host: "second.test", port: 6697, tls: true };
const third: Ircd = { host: "third.test", port: 6697, tls: true };

const welcome = ":ircd 001 iirc :Welcome\r\n";
const noMotd = ":ircd 422 iirc :No MOTD\r\n";

// A Session with its burst over, and nothing to join unless a test asks.
const afterSettle = (tuning = defaultTuning) =>
  Effect.andThen(TestClock.adjust(`${tuning.rejoinSettleMillis} millis`), manyTurns);

const burstOver = Effect.fnUntraced(function* (ircd: FakeIrcd, overrides?: Overrides) {
  const hosted = yield* host(ircd, { channels: [], ...overrides });

  yield* ircd.read(`${welcome}${noMotd}`);
  yield* manyTurns;

  // Rejoining waits this long after the burst, for `JOIN`s a Network replays (LIVE-7).
  if ((overrides?.channels ?? []).length > 0) {
    yield* afterSettle(overrides?.tuning);
  }

  return hosted;
});

const line = safe("PRIVMSG", ["#one", "hi"]);

const taken = (line: string) =>
  line.startsWith("NICK ") ? [":ircd 433 * x :Nickname in use"] : [];

// Each a read of 4 KB, so that a few fill the bound on what is read and not recorded.
const pings = (from: number, count: number) =>
  Array.from(
    { length: count },
    (_unused, index) => `PING ${from + index} :${"x".repeat(4000)}\r\n`
  );

const wanted = (...names: readonly string[]) => names.map((name) => ({ name }));
const joined = (name: string) => `:iirc!~u@host JOIN ${name}\r\n`;

// A commit and the loop read Standing too, so what a plan costs is told against the same
// Session wanting nothing at all.
const readsWhileQuiet = (channels: readonly WantedChannel[]) => {
  let reads = 0;

  const layer = probed({
    onStanding: () => {
      reads += 1;
    },
  });

  return Effect.gen(function* () {
    const ircd = yield* fakeIrcd();

    yield* burstOver(ircd, { channels });

    // `burstOver` only waits out the settle for a Session that wants a Channel.
    if (channels.length === 0) {
      yield* afterSettle();
    }

    const before = reads;

    for (let tick = 0; tick < 5; tick += 1) {
      yield* TestClock.adjust("80 seconds");
      yield* ircd.read("NOTICE * :keeps it alive\r\n");
      yield* manyTurns;
    }

    return reads - before;
  }).pipe(Effect.provide(layer), Effect.scoped);
};

// Makes a real transition throw on an `attempt`, without changing what is recorded.
const poisoned = (entry: Entry) =>
  entry._tag === "Connection" && entry.phase === "attempt"
    ? Object.defineProperty({ ...entry }, "nicks", {
        enumerable: false,
        get: () => {
          throw new Error("the transition threw");
        },
      })
    : entry;

// A read of 1024 `PING`s, as a real flood arrives.
const pingRead = (from: number) =>
  Array.from({ length: 1024 }, (_unused, index) => `PING ${from + index}\r\n`).join("");

const closings = (log: readonly Entry[]) =>
  connectionsOf(log, "closing").map(({ chosen, reason }) => ({ chosen, reason }));

// Closes a Scope from a fiber of its own, because a close can wait on the clock.
const stopInBackground = Effect.fnUntraced(function* (ircd: FakeIrcd, overrides?: Overrides) {
  const running = yield* Deferred.make<NetworkHost>();
  const stop = yield* Deferred.make<undefined>();

  const fiber = yield* Effect.scoped(
    Effect.gen(function* () {
      const hosted = yield* bareHost(ircd, { channels: [], ...overrides });

      yield* ircd.read(`${welcome}${noMotd}`);
      yield* manyTurns;
      yield* Deferred.succeed(running, hosted);
      yield* Deferred.await(stop);
    })
  ).pipe(Effect.forkChild);

  const hosted = yield* Deferred.await(running);

  return { fiber, hosted, stop: Deferred.succeed(stop, undefined) };
});

const textsOn = (ircd: FakeIrcd, connection: number) =>
  ircd.writtenOn(connection).pipe(Effect.map((written) => written.map((bytes) => decode(bytes))));

const now = Clock.currentTimeMillis;

// Moves to one millisecond short of the next `attempt`, proves nothing dials, and then
// moves that last millisecond. Gives the delay it waited.
const waitOutBackoff = Effect.fnUntraced(function* (hosted: NetworkHost, ircd: FakeIrcd) {
  const started = yield* now;
  const { nextAttemptAt } = yield* hosted.status;
  const dials = (yield* ircd.dials).length;
  const delay = (nextAttemptAt ?? 0) - started;

  yield* TestClock.adjust(`${delay - 1} millis`);
  yield* manyTurns;

  assert.lengthOf(yield* ircd.dials, dials);

  yield* TestClock.adjust("1 millis");
  yield* manyTurns;

  assert.lengthOf(yield* ircd.dials, dials + 1);

  return delay;
});

describe("LIVE-4: reconnecting", () => {
  it.effect("LIVE-4: waits out each delay exactly, doubling, inside the jitter bounds", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const hosted = yield* host(ircd);

      for (const delay of [5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
        const waited = yield* waitOutBackoff(hosted, ircd);

        assert.isAtLeast(waited, delay / 2);
        assert.isAtMost(waited, delay);
      }

      assert.strictEqual((yield* hosted.status).consecutiveFailures, 9);
    }).pipe(memory)
  );

  it.effect("LIVE-4: reconnects after a close, on a new Connection, as a new Session", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.hangUp;
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closed");
      assert.isDefined((yield* hosted.status).nextAttemptAt);

      yield* waitOutBackoff(hosted, ircd);

      assert.strictEqual((yield* hosted.status).phase, "registering");
      assert.isUndefined((yield* hosted.status).self);
      assert.isUndefined((yield* hosted.status).nextAttemptAt);
      assert.deepStrictEqual(yield* textsOn(ircd, 1), [
        "NICK iirc\r\n",
        "USER user 0 * :I IRC\r\n",
      ]);

      yield* ircd.read(welcome);
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.lengthOf(connectionsOf(yield* entries, "attempt"), 2);
    }).pipe(memory)
  );

  it.effect("LIVE-4: rotates through the Ircds, and round again", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const hosted = yield* host(ircd, { ircds: [first, second, third] });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        yield* waitOutBackoff(hosted, ircd);
      }

      assert.deepStrictEqual(
        (yield* ircd.dials).map(({ host: name }) => name),
        ["first.test", "second.test", "third.test", "first.test"]
      );
      assert.deepStrictEqual(
        connectionsOf(yield* entries, "attempt").map(({ ircd: used }) => used.host),
        ["first.test", "second.test", "third.test", "first.test"]
      );
    }).pipe(memory)
  );

  it.effect("LIVE-4: a crash loop cannot outrun its backoff across hosts on one Recorder", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });

      // Each host dies at once, as a service manager restarting a crash would have it.
      const crash = Effect.scoped(bareHost(ircd));

      for (let restart = 0; restart < 20; restart += 1) {
        yield* crash;
      }

      assert.lengthOf(yield* ircd.dials, 1);

      const hosted = yield* host(ircd);
      const { consecutiveFailures, nextAttemptAt } = yield* hosted.status;

      assert.strictEqual(consecutiveFailures, 1);

      yield* TestClock.adjust(`${(nextAttemptAt ?? 0) - (yield* now)} millis`);
      yield* manyTurns;

      assert.lengthOf(yield* ircd.dials, 2);
      assert.strictEqual((yield* hosted.status).consecutiveFailures, 2);

      const delay = ((yield* hosted.status).nextAttemptAt ?? 0) - (yield* now);

      assert.isAtLeast(delay, 5000);
      assert.isAtMost(delay, 10_000);
    }).pipe(memory)
  );

  it.effect(
    "LIVE-4: a Session that lasted still waits the first delay after an unexpected close",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const hosted = yield* burstOver(ircd);

        for (let minute = 0; minute < 5; minute += 1) {
          yield* TestClock.adjust("1 minute");
          yield* ircd.read("NOTICE * :still here\r\n");
          yield* manyTurns;
        }

        yield* ircd.hangUp;
        yield* manyTurns;

        const delay = yield* waitOutBackoff(hosted, ircd);

        assert.isAtLeast(delay, 2500);
        assert.isAtMost(delay, 5000);
        assert.strictEqual((yield* hosted.status).consecutiveFailures, 0);
      }).pipe(memory)
  );

  it.effect("LIVE-4: a close that followed `closing` retries at once on the next host", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* Effect.scoped(
        Effect.andThen(bareHost(ircd), Effect.andThen(ircd.read(welcome), manyTurns))
      );
      yield* host(ircd);

      assert.lengthOf(yield* ircd.dials, 2);
    }).pipe(memory)
  );

  it.effect("LIVE-4: a Connection a killed host left open needs nothing special", () =>
    Effect.gen(function* () {
      const { record } = yield* Recorder;

      yield* record(
        [
          {
            _tag: "Connection",
            ircd: first,
            network: "libera",
            nicks: ["iirc"],
            phase: "attempt",
            ...attemptInput,
          },
          { _tag: "Connection", connection: 1, ircd: first, network: "libera", phase: "opened" },
        ],
        () => {}
      );

      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);
      const started = yield* now;
      const { consecutiveFailures, nextAttemptAt } = yield* hosted.status;

      assert.strictEqual(consecutiveFailures, 0);
      assert.isAbove(nextAttemptAt ?? 0, started);
      assert.lengthOf(yield* ircd.dials, 0);

      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      assert.lengthOf(yield* ircd.dials, 1);
    }).pipe(memory)
  );
});

describe("LIVE-5: a Network that turns us away", () => {
  it.effect("LIVE-5: its ERROR is why it closed, and it backs off like any failure", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* ircd.read("ERROR :You are banned, and that is that\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closing");

      yield* ircd.hangUp;
      yield* manyTurns;

      const [closed] = connectionsOf(yield* entries, "closed");

      assert.isUndefined(closed?.refused);
      assert.strictEqual(closed?.reason, "You are banned, and that is that");
      assert.strictEqual((yield* hosted.status).closeReason, "You are banned, and that is that");
      assert.isAtMost(yield* waitOutBackoff(hosted, ircd), defaultTuning.reconnectInitialMillis);
    }).pipe(memory)
  );

  it.effect("LIVE-5: a numeric alone closes nothing, and the Ircd's close is the reason", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* ircd.read(":ircd 465 * :Banned\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "registering");

      yield* ircd.hangUp;
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).closeReason, "the Ircd closed the Connection");
      assert.isAtMost(yield* waitOutBackoff(hosted, ircd), defaultTuning.reconnectInitialMillis);
    }).pipe(memory)
  );
});

describe("CONN-4: nicks", () => {
  it.effect("CONN-4: records the candidates and works through them on `433`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd, {
        identity: { ...options.identity, alternates: ["other"] },
      });
      yield* ircd.read(":ircd 433 * iirc :In use\r\n");
      yield* manyTurns;
      yield* ircd.read(":ircd 433 * other :In use\r\n");
      yield* manyTurns;

      const [attempt] = connectionsOf(yield* entries, "attempt");

      assert.deepStrictEqual(attempt?.nicks.slice(0, 3), ["iirc", "other", "iirc_"]);
      assert.deepStrictEqual((yield* wire(ircd)).slice(1), [
        "USER user 0 * :I IRC\r\n",
        "NICK other\r\n",
        "NICK iirc_\r\n",
      ]);
    }).pipe(memory)
  );

  it.effect("CONN-4: sends an alternate as configured, however long", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd, {
        identity: { ...options.identity, alternates: ["averyverylongalternate"] },
      });
      yield* ircd.read(":ircd 433 * iirc :In use\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* textsOn(ircd, 0)).at(-1), "NICK averyverylongalternate\r\n");
    }).pipe(memory)
  );

  it.effect("CONN-4: a list that runs out closes, says why, and backs off", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ respond: taken });
      const hosted = yield* host(ircd);

      yield* ircd.hangUp;
      yield* manyTurns;

      const status = yield* hosted.status;
      const [attempt] = connectionsOf(yield* entries, "attempt");

      assert.strictEqual(
        status.closeReason,
        `ran out of nicks after ${attempt?.nicks.length}: Nickname in use`
      );
      assert.strictEqual(status.consecutiveFailures, 1);

      yield* waitOutBackoff(hosted, ircd);
    }).pipe(memory)
  );
});

describe("LIVE-2: liveness", () => {
  const noLagChecks = { ...defaultTuning, lagCheckMillis: 86_400_000 };

  it.effect("LIVE-2: declares a silent Connection dead at exactly 90 seconds", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);
      const heard = yield* now;

      yield* ircd.read("half a li");
      yield* TestClock.adjust("89999 millis");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      const log = yield* entries;
      const [closed] = connectionsOf(log, "closed");

      // The Ircd never hung up, so nothing but the deadline ended this, and at once.
      assert.lengthOf(deadlinesNamed(log, "silence"), 1);
      assert.strictEqual(closed?.at, heard + 90_000);
      assert.strictEqual(closed?.reason, "heard nothing for 90 seconds");
      assert.isTrue(linesOf(log).some(({ cut }) => cut === true));
      assert.isTrue(yield* ircd.released);
      assert.strictEqual((yield* hosted.status).phase, "closed");
    }).pipe(memory)
  );

  it.effect("LIVE-2: and then reconnects", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      yield* TestClock.adjust("90 seconds");
      yield* manyTurns;
      yield* waitOutBackoff(hosted, ircd);
    }).pipe(memory)
  );

  it.effect("LIVE-2: a busy Connection never dies, however long it runs", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      for (let tick = 0; tick < 60; tick += 1) {
        yield* TestClock.adjust("89 seconds");
        yield* ircd.read(":a!b@c PRIVMSG #one :still talking\r\n");
        yield* manyTurns;
      }

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.lengthOf(deadlinesNamed(yield* entries, "silence"), 0);
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);
    }).pipe(memory)
  );

  it.effect("LIVE-2: an unparseable Line proves it is alive too", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      yield* TestClock.adjust("89 seconds");
      yield* ircd.read("\r\n");
      yield* manyTurns;
      yield* TestClock.adjust("89 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(memory)
  );

  it.effect("LIVE-2: a jump past the deadline does not beat a read already on its way", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: noLagChecks });

      // The stall: the timer runs first, and the reader only gets its turn after that,
      // which is the order an event loop waking from a suspend does them in.
      yield* Effect.all(
        [
          TestClock.adjust("90 seconds"),
          Effect.andThen(
            Effect.repeat(Effect.yieldNow, { times: 12 }),
            ircd.read("NOTICE * :was here all along\r\n")
          ),
        ],
        { concurrency: "unbounded" }
      );
      yield* manyTurns;

      assert.lengthOf(deadlinesNamed(yield* entries, "silence"), 0);
      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.include(texts(yield* entries, "inbound"), "NOTICE * :was here all along");
    }).pipe(memory)
  );

  it.effect("LIVE-2: a read from after the deadline disproves the silence too", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<undefined>();

      const layer = probed({
        // Holds the loop in this commit while the clock jumps and the next read lands.
        duringRecord: (recording) =>
          recording.some(isLineWith("NOTICE * :held"))
            ? Effect.asVoid(Deferred.await(held))
            : Effect.void,
      });

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const hosted = yield* burstOver(ircd);

        yield* ircd.read("NOTICE * :held\r\n");
        yield* manyTurns;
        yield* TestClock.adjust("10 minutes");
        yield* ircd.read("NOTICE * :late\r\n");
        yield* manyTurns;
        yield* Deferred.succeed(held, undefined);
        yield* manyTurns;

        assert.lengthOf(deadlinesNamed(yield* entries, "silence"), 0);
        assert.strictEqual((yield* hosted.status).phase, "session");
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect("LIVE-2: with nothing to read, a jump past the deadline closes", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: noLagChecks });

      yield* TestClock.adjust("90 seconds");
      yield* manyTurns;

      assert.lengthOf(deadlinesNamed(yield* entries, "silence"), 1);
      assert.strictEqual((yield* hosted.status).closeReason, "heard nothing for 90 seconds");
    }).pipe(memory)
  );
});

describe("deadlines and what was read", () => {
  const heldBack = Effect.fnUntraced(function* () {
    const release = yield* Deferred.make<undefined>();

    const layer = probed({
      duringRecord: (recording) =>
        recording.some(isLineWith("NOTICE * :held"))
          ? Effect.asVoid(Deferred.await(release))
          : Effect.void,
    });

    return { layer, release: Deferred.succeed(release, undefined) };
  });

  it.effect("a Read stamped exactly at a deadline does not go ahead of it", () =>
    Effect.gen(function* () {
      const { layer, release } = yield* heldBack();

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const hosted = yield* host(ircd);

        yield* ircd.read("NOTICE * :held\r\n");
        yield* manyTurns;
        yield* TestClock.adjust("60 seconds");
        yield* ircd.read(welcome);
        yield* manyTurns;
        yield* release;
        yield* manyTurns;

        assert.lengthOf(deadlinesNamed(yield* entries, "registration"), 1);
        assert.strictEqual((yield* hosted.status).phase, "closing");
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect("LOG-8: a clock set back cannot turn a late Read into endless Deadline Entries", () =>
    Effect.gen(function* () {
      const { layer, release } = yield* heldBack();

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const hosted = yield* host(ircd);

        yield* ircd.read("NOTICE * :held\r\n");
        yield* manyTurns;
        yield* TestClock.adjust("61 seconds");
        yield* ircd.read("NOTICE * :late\r\n");
        yield* manyTurns;
        yield* TestClock.setTime(1000);
        yield* release;
        yield* manyTurns;

        const log = yield* entries;

        assert.lengthOf(deadlinesNamed(log, "registration"), 0);
        assert.include(texts(log, "inbound"), "NOTICE * :late");
        assert.strictEqual((yield* hosted.status).phase, "registering");
      }).pipe(Effect.provide(layer));
    })
  );
});

describe("LIVE-3: lag", () => {
  it.effect("LIVE-3: checks every 60 seconds and derives the round trip", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      yield* TestClock.adjust("60 seconds");
      yield* manyTurns;

      const check = (yield* wire(ircd)).at(-1) ?? "";

      assert.match(check, /^PING lag-\d+\r\n$/u);

      yield* TestClock.adjust("250 millis");
      yield* ircd.read(`:ircd PONG ircd :${check.slice(5, -2)}\r\n`);
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).lagMillis, 250);
    }).pipe(memory)
  );

  it.effect("LIVE-3: fires on time while flooded, because a later read cannot hold it off", () => {
    const layer = probed({
      duringRecord: (recording) =>
        recording.some(isLineWith("flood")) ? TestClock.adjust("1 second") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      yield* Effect.forEach(Array.from({ length: 80 }), () => ircd.read("flood\r\n"), {
        discard: true,
      });
      yield* manyTurns;

      const log = yield* entries;
      const [fired] = deadlinesNamed(log, "lag-check");

      assert.isDefined(fired);
      assert.isAtMost(fired?.at ?? Infinity, 60_000 + 20_000);
      assert.lengthOf(deadlinesNamed(log, "silence"), 0);
      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.isTrue(texts(log, "outbound").some((text) => text.startsWith("PING lag-")));
    }).pipe(Effect.provide(layer));
  });
});

describe("SEND-1 to SEND-3: lanes", () => {
  const tightFlood = { ...defaultTuning, floodBurst: 1, floodIntervalMillis: 2000 };

  it.effect("SEND-2: a burst of 5, then one Line every 2 seconds, on the clock", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);
      const before = (yield* wire(ircd)).length;

      for (let index = 0; index < 7; index += 1) {
        yield* Effect.forkChild(hosted.send(safe("PRIVMSG", ["#one", `${index}`]), "test"));
      }

      yield* manyTurns;

      assert.lengthOf((yield* wire(ircd)).slice(before), 5);
      assert.strictEqual((yield* hosted.status).lanes.interactive, 2);

      yield* TestClock.adjust("1999 millis");
      yield* manyTurns;

      assert.lengthOf((yield* wire(ircd)).slice(before), 5);

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      assert.lengthOf((yield* wire(ircd)).slice(before), 6);

      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;

      assert.deepStrictEqual(
        (yield* wire(ircd)).slice(before),
        Array.from({ length: 7 }, (_unused, index) => `PRIVMSG #one ${index}\r\n`)
      );
    }).pipe(memory)
  );

  it.effect("SEND-1: control skips the flood wait, and strict priority holds under flood", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: tightFlood });
      const before = (yield* wire(ircd)).length;

      yield* Effect.forkChild(hosted.send(safe("PRIVMSG", ["#one", "takes the token"]), "test"));
      yield* Effect.forkChild(hosted.send(safe("PRIVMSG", ["#one", "waits"]), "test"));
      yield* manyTurns;

      // No time passes here, so the bucket has nothing to give.
      yield* ircd.read("PING :first\r\nPING :second\r\n");
      yield* manyTurns;

      assert.deepStrictEqual((yield* wire(ircd)).slice(before), [
        "PRIVMSG #one :takes the token\r\n",
        "PONG first\r\n",
        "PONG second\r\n",
      ]);

      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* wire(ircd)).at(-1), "PRIVMSG #one waits\r\n");
    }).pipe(memory)
  );

  it.effect("SEND-1: interactive goes ahead of background, which waits its turn", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* host(ircd, {
        channels: [{ name: "#later" }],
        tuning: tightFlood,
      });

      yield* ircd.read(welcome);
      yield* manyTurns;

      const before = (yield* wire(ircd)).length;

      yield* Effect.forkChild(hosted.send(safe("PRIVMSG", ["#one", "one"]), "test"));
      yield* Effect.forkChild(hosted.send(safe("PRIVMSG", ["#one", "two"]), "test"));
      yield* manyTurns;
      yield* ircd.read(noMotd);
      yield* manyTurns;
      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;
      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;

      assert.deepStrictEqual((yield* wire(ircd)).slice(before), [
        "PRIVMSG #one one\r\n",
        "PRIVMSG #one two\r\n",
        "JOIN #later\r\n",
      ]);
    }).pipe(memory)
  );

  it.effect("SEND-3: a full lane refuses at once, and the Lines already there still leave", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: { ...tightFlood, laneLimit: 2 } });

      yield* ircd.setWrites("hang");

      yield* Effect.forkChild(hosted.send(line, "in the write"));
      yield* manyTurns;
      yield* Effect.forkChild(hosted.send(line, "queued"));
      yield* Effect.forkChild(hosted.send(line, "queued"));
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).lanes.interactive, 2);
      assert.deepStrictEqual(
        yield* Effect.exit(hosted.send(line, "refused")),
        Exit.fail(new LaneFull({ lane: "interactive" }))
      );
      assert.strictEqual((yield* hosted.status).lanes.interactive, 2);
    }).pipe(memory)
  );

  it.effect("API-9: a slow queue gives a typed answer, and the Line stays queued", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* burstOver(ircd, {
        tuning: { ...tightFlood, floodIntervalMillis: 60_000 },
      });

      yield* hosted.send(line, "spends the token");

      const waiting = yield* Effect.forkChild(hosted.send(safe("PRIVMSG", ["#one", "late"]), "t"));

      yield* manyTurns;
      yield* TestClock.adjust("9999 millis");
      yield* manyTurns;

      assert.isUndefined(waiting.pollUnsafe());

      yield* TestClock.adjust("1 millis");

      assert.deepStrictEqual(yield* Fiber.join(waiting), { _tag: "StillQueued" });
      assert.strictEqual((yield* hosted.status).lanes.interactive, 1);

      yield* TestClock.adjust("50 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).lanes.interactive, 0);
      assert.include(yield* wire(ircd), "PRIVMSG #one late\r\n");
    }).pipe(memory)
  );

  it.effect("API-9: a caller walking away neither cancels the Line nor wedges the pump", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: tightFlood });

      yield* hosted.send(line, "spends the token");

      const gone = yield* Effect.forkChild(hosted.send(safe("PRIVMSG", ["#one", "kept"]), "t"));

      yield* manyTurns;
      yield* Fiber.interrupt(gone);
      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* wire(ircd)).at(-1), "PRIVMSG #one kept\r\n");

      yield* TestClock.adjust("2 seconds");

      const sent = yield* hosted.send(safe("PRIVMSG", ["#one", "next"]), "t");

      assert.strictEqual(sent._tag, "Written");
    }).pipe(memory)
  );

  it.effect("API-10: with no Session a send fails at once and nothing is held for later", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const hosted = yield* host(ircd);
      const before = (yield* entries).length;

      assert.deepStrictEqual(
        yield* Effect.exit(hosted.send(line, "test")),
        Exit.fail(new NotInSession({ phase: "closed" }))
      );
      assert.lengthOf(yield* entries, before);

      yield* ircd.setDials("accept");
      yield* waitOutBackoff(hosted, ircd);
      yield* ircd.read(welcome);
      yield* manyTurns;

      assert.notInclude((yield* wire(ircd)).join(""), "PRIVMSG");
    }).pipe(memory)
  );

  it.effect("SEND-4: queued Lines become Dropped in the same commit as `closed`", () => {
    const commits: (readonly NewEntry[])[] = [];

    const layer = probed({
      before: (recording) => {
        commits.push(recording);
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: tightFlood });

      yield* hosted.send(line, "spends the token");

      const waiting = yield* Effect.forkChild(
        Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "waiting"]), "key:one"))
      );

      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;

      const closing = commits.find((recording) => recording.some(isClosed));
      const reason = "the Connection closed: the Ircd closed the Connection";

      assert.deepStrictEqual(
        closing?.map(({ _tag }) => _tag),
        ["Dropped", "Connection"]
      );

      const [dropped] = droppedIn(yield* entries);

      assert.strictEqual(dropped?.cause, "key:one");
      assert.strictEqual(dropped?.reason, reason);
      assert.strictEqual(decode(dropped?.bytes ?? new Uint8Array()), "PRIVMSG #one waiting");
      assert.deepStrictEqual(yield* Fiber.join(waiting), Exit.fail(new LineDropped({ reason })));

      // Nothing outlives its Connection.
      yield* waitOutBackoff(hosted, ircd);
      yield* ircd.read(`${welcome}${noMotd}`);
      yield* TestClock.adjust("1 minute");
      yield* manyTurns;

      assert.notInclude((yield* wire(ircd)).join(""), "PRIVMSG #one waiting");
    }).pipe(Effect.provide(layer));
  });

  it.effect("LIVE-11: a close stops the lanes at once, and what waits there stays unsent", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: tightFlood });

      yield* hosted.send(line, "spends the token");
      yield* Effect.forkChild(Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "stay"]), "t")));
      yield* manyTurns;
      yield* ircd.read("ERROR :Closing Link\r\n");
      yield* manyTurns;
      yield* TestClock.adjust("3 seconds");
      yield* manyTurns;

      assert.notInclude((yield* wire(ircd)).join(""), "stay");
    }).pipe(memory)
  );

  it.effect("HOST-1: a read parked behind a full inbox goes down with the Connection", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<undefined>();

      const layer = probed({
        duringRecord: (recording) =>
          recording.some(isLineWith("NOTICE * :held"))
            ? Effect.asVoid(Deferred.await(release))
            : Effect.void,
      });

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const flood = 40;

        yield* burstOver(ircd);
        yield* ircd.read("ERROR :Closing Link\r\n");
        yield* manyTurns;
        yield* ircd.read("NOTICE * :held\r\n");
        yield* manyTurns;

        for (let index = 0; index < flood; index += 1) {
          yield* ircd.read(`NOTICE * :${index}\r\n`);
        }

        yield* manyTurns;

        // The loop is held in a commit, the inbox is full, and the reader waits with one
        // more in its hand when the limit passes.
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.succeed(release, undefined);
        yield* manyTurns;

        const recorded = texts(yield* entries, "inbound").filter((text) =>
          /^NOTICE \* :\d+$/u.test(text)
        );

        assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
        assert.strictEqual(recorded.length + (yield* ircd.unread), flood);
        assert.isAbove(recorded.length, 0);
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect("HOST-1: no read is lost to the limit on a close, however full the inbox", () => {
    const layer = probed({
      duringRecord: (recording) =>
        recording.some(isLineWith("flood")) ? TestClock.adjust("1 second") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const flood = 100;

      yield* burstOver(ircd);
      yield* ircd.read("ERROR :Closing Link\r\n");
      yield* manyTurns;

      yield* Effect.forEach(Array.from({ length: flood }), () => ircd.read("flood\r\n"), {
        discard: true,
      });
      yield* manyTurns;

      const recorded = texts(yield* entries, "inbound").filter((text) => text === "flood");

      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
      assert.strictEqual(recorded.length + (yield* ircd.unread), flood);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LOG-4: nothing is recorded on a Connection after its `closed` Entry", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      yield* ircd.setWrites("hang");
      yield* Effect.forkChild(Effect.exit(hosted.send(line, "stalled")));
      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;
      const closed = connectionsOf(log, "closed");

      assert.lengthOf(closed, 1);
      assert.strictEqual(log.at(-1), closed[0]);
    }).pipe(memory)
  );
});

describe("the control lane and a stalled socket", () => {
  const small = { ...defaultTuning, controlLaneLimit: 2 };

  it.effect("backs a `PING` flood up into the kernel, and the write limit ends it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: small });

      yield* ircd.setWrites("hang");

      for (const ping of pings(0, 40)) {
        yield* ircd.read(ping);
      }

      yield* manyTurns;

      // The pump holds one, the lane two, and the loop waits with the next. A handful more
      // sit in the inbox and the reader's hand, and the rest are still in the kernel.
      assert.strictEqual((yield* hosted.status).lanes.control, 2);
      assert.isAbove(yield* ircd.unread, 15);
      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* TestClock.adjust("10 seconds");
      yield* manyTurns;

      // The loop is free, and reads what is left, drops what it cannot send, and closes.
      assert.strictEqual((yield* hosted.status).phase, "closing");
      assert.strictEqual(yield* ircd.unread, 0);

      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;
      const [closed] = connectionsOf(log, "closed");

      assert.strictEqual(closed?.reason, "write timed out");
      assert.strictEqual(closed?.at, 10_000);
      assert.lengthOf(
        texts(log, "inbound").filter((text) => text.startsWith("PING")),
        40
      );

      const answered = texts(log, "outbound").filter((text) => text.startsWith("PONG"));

      // Every `PING` has its `PONG` on the wire or Dropped, and the one whose write never
      // finished has both, its Dropped Entry saying why (LOG-2).
      const dropped = droppedIn(log).filter(({ cause }) => cause === "ping-reply");

      assert.lengthOf(answered, 1);
      assert.lengthOf(dropped, 40);
      const unfinished = dropped.filter(({ reason }) => reason === "write timed out");

      assert.lengthOf(unfinished, 1);
      assert.strictEqual(decode(unfinished[0]?.bytes ?? encode("")), answered[0]);
    }).pipe(memory)
  );

  it.effect("a stop gets a loop parked on a full lane moving, and ends at its limit", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { fiber, hosted, stop } = yield* stopInBackground(ircd, { tuning: small });

      yield* ircd.setWrites("hang");

      for (const ping of pings(0, 40)) {
        yield* ircd.read(ping);
      }

      yield* manyTurns;

      const parked = yield* ircd.unread;

      assert.isAbove(parked, 15);

      yield* stop;
      yield* manyTurns;

      assert.isBelow(yield* ircd.unread, parked);
      assert.strictEqual((yield* hosted.status).phase, "closing");
      assert.deepStrictEqual(connectionsOf(yield* entries, "closed"), []);

      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      const log = yield* entries;

      assert.strictEqual(connectionsOf(log, "closed")[0]?.at, 2000);
      assert.isTrue(yield* ircd.released);
      assert.strictEqual(log.at(-1)?._tag, "Connection");
    }).pipe(memory)
  );

  it.effect("`QUIT` still gets a place in a control lane a flood has filled", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { fiber, hosted, stop } = yield* stopInBackground(ircd, { tuning: small });

      yield* ircd.setWrites("hang");

      for (const ping of pings(0, 4)) {
        yield* ircd.read(ping);
      }

      yield* manyTurns;
      yield* stop;
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).lanes.control, 3);

      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      // The write ahead of it never finished, so it could not leave, and the Log says so.
      const quit = droppedIn(yield* entries).find(({ cause }) => cause === "quit");

      assert.strictEqual(decode(quit?.bytes ?? encode("")), "QUIT leaving");
    }).pipe(memory)
  );
});

describe("LOG-4: commits", () => {
  it.effect("LOG-4: at most 1024 Lines to a transaction, each committed and then acted on", () => {
    const commits: (readonly NewEntry[])[] = [];

    const layer = probed({
      before: (recording) => {
        commits.push(recording);
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);
      const lines = Array.from({ length: 3000 }, (_unused, index) => `NOTICE * :${index}`);

      commits.length = 0;

      yield* ircd.read(`${lines.join("\r\n")}\r\nPING :after\r\n`);
      yield* manyTurns;

      const inbound = commits.filter((recording) => recording.every(({ _tag }) => _tag === "Line"));

      assert.deepStrictEqual(
        inbound.map((recording) => recording.length).slice(0, 3),
        [1024, 1024, 953]
      );
      assert.strictEqual((yield* wire(ircd)).at(-1), "PONG after\r\n");
      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.deepStrictEqual(texts(yield* entries, "inbound").slice(2, -1), lines);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LOG-4: the Lines left at a close keep to the same limit", () => {
    const commits: (readonly NewEntry[])[] = [];

    const layer = probed({
      before: (recording) => {
        commits.push(recording);
      },
      duringRecord: (recording) =>
        recording.some(isLineWith("NOTICE * :hold")) ? Effect.never : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd);
      yield* ircd.read("ERROR :bye\r\n");
      yield* manyTurns;
      commits.length = 0;

      yield* ircd.read(`${Array.from({ length: 2000 }, () => "NOTICE * :x").join("\r\n")}\r\n`);
      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;

      for (const recording of commits) {
        assert.isAtMost(recording.length, 1024);
      }
    }).pipe(Effect.provide(layer));
  });

  // With the budget raised, nothing but the host's own yield lets anything else run.
  it.effect("LOG-4: a reader keeps moving through a flood of bare newlines", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);
      const reads = yield* Ref.make(0);
      const batches = 20;

      const reader = yield* Effect.forkChild(
        hosted.status.pipe(
          Effect.andThen(Ref.update(reads, (count) => count + 1)),
          Effect.andThen(Effect.yieldNow),
          Effect.forever({ disableYield: true })
        )
      );

      const before = (yield* entries).length;

      yield* ircd.read("\n".repeat(1024 * batches));

      let seen = yield* Ref.get(reads);
      let during = 0;

      while ((yield* entries).length < before + 1024 * batches) {
        yield* Effect.yieldNow;

        const count = yield* Ref.get(reads);

        during += count > seen ? 1 : 0;
        seen = count;
      }

      yield* Fiber.interrupt(reader);

      // Empty frames are Lines too (HOST-1), so a flood of them costs a commit like any.
      assert.isAtLeast(during, batches - 2);
      assert.lengthOf(yield* entries, before + 1024 * batches);
      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 10_000_000), memory)
  );
});

describe("LIVE-7, LIVE-8: the reconciler", () => {
  it.effect("LIVE-7, CRED-4: joins after the burst, keyed Channels first, as `rejoin`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd, {
        channels: [{ name: "#plain" }, { key: "key.keyed", name: "#keyed" }],
        secrets: new Map([["key.keyed", Redacted.make("sesame")]]),
      });
      yield* ircd.read(welcome);
      yield* manyTurns;

      assert.lengthOf(yield* wire(ircd), 2);

      yield* ircd.read(noMotd);
      yield* manyTurns;
      yield* afterSettle();

      assert.strictEqual((yield* wire(ircd)).at(-1), "JOIN #keyed,#plain sesame\r\n");

      const join = linesOf(yield* entries).find(({ cause }) => cause === "rejoin");

      assert.isDefined(join);
      assert.strictEqual(decode(join.bytes), "JOIN #keyed,#plain <redacted>");
      assert.deepStrictEqual(join.redacted, ["key.keyed"]);
    }).pipe(memory)
  );

  it.effect("CONN-7: a burst with no end of MOTD is over 10 seconds after `001`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd, { channels: wanted("#one") });
      yield* ircd.read(welcome);
      yield* manyTurns;
      yield* TestClock.adjust("9999 millis");
      yield* manyTurns;

      assert.lengthOf(yield* wire(ircd), 2);

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;
      yield* afterSettle();

      assert.strictEqual((yield* wire(ircd)).at(-1), "JOIN #one\r\n");
    }).pipe(memory)
  );

  it.effect("LIVE-7: a Network that kept us attached is not rejoined", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { channels: wanted("#kept", "#new") });

      yield* ircd.read(welcome);
      yield* ircd.read(joined("#kept"));
      yield* ircd.read(noMotd);
      yield* manyTurns;
      yield* afterSettle();

      assert.strictEqual((yield* wire(ircd)).at(-1), "JOIN #new\r\n");
      assert.deepStrictEqual((yield* hosted.status).joined, ["#kept"]);
    }).pipe(memory)
  );

  // Ergo replays an always-on client's Channels in flushes of their own after `376`.
  for (const replayMillis of [0, 1, 5, 50, 999]) {
    it.effect(
      `LIVE-7: waits for \`JOIN\`s a Network replays ${replayMillis} ms after the burst`,
      () =>
        Effect.gen(function* () {
          const ircd = yield* fakeIrcd();

          yield* host(ircd, { channels: wanted("#kept", "#also") });
          yield* ircd.read(welcome);
          yield* ircd.read(":ircd 376 iirc :End of MOTD\r\n");
          yield* manyTurns;
          yield* TestClock.adjust(`${replayMillis} millis`);
          yield* ircd.read(joined("#kept"));
          yield* manyTurns;
          yield* ircd.read(joined("#also"));
          yield* manyTurns;
          yield* TestClock.adjust("1 second");
          yield* manyTurns;

          assert.notInclude((yield* wire(ircd)).join(""), "JOIN");
        }).pipe(memory)
    );
  }

  it.effect("LIVE-7: the wait is Tuning's, and a replay later than it is too late", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const tuning = { ...defaultTuning, rejoinSettleMillis: 300 };

      yield* host(ircd, { channels: wanted("#kept"), tuning });
      yield* ircd.read(`${welcome}${noMotd}`);
      yield* manyTurns;
      yield* TestClock.adjust("299 millis");
      yield* manyTurns;

      assert.notInclude((yield* wire(ircd)).join(""), "JOIN");

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      assert.strictEqual((yield* wire(ircd)).at(-1), "JOIN #kept\r\n");
    }).pipe(memory)
  );

  it.effect("LIVE-7: retries a `471` with backoff, and shows it in status", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* burstOver(ircd, {
        channels: wanted("#full"),
      });

      const joins = Effect.map(
        wire(ircd),
        (written) => written.filter((text) => text.startsWith("JOIN")).length
      );

      yield* ircd.read(":ircd 471 iirc #full :Cannot join channel (+l)\r\n");
      yield* manyTurns;

      assert.strictEqual(yield* joins, 1);
      assert.deepStrictEqual(
        (yield* hosted.status).joinFailures.map(({ channel, numeric, text }) => [
          channel,
          numeric,
          text,
        ]),
        [["#full", "471", "Cannot join channel (+l)"]]
      );

      yield* TestClock.adjust("59999 millis");
      yield* ircd.read("NOTICE * :keeps it alive\r\n");
      yield* manyTurns;

      assert.strictEqual(yield* joins, 1);

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      assert.strictEqual(yield* joins, 2);

      yield* ircd.read(":ircd 471 iirc #full :Cannot join channel (+l)\r\n");
      yield* TestClock.adjust("89 seconds");
      yield* ircd.read("NOTICE * :keeps it alive\r\n");
      yield* manyTurns;

      assert.strictEqual(yield* joins, 2);

      yield* TestClock.adjust("31 seconds");
      yield* manyTurns;

      assert.strictEqual(yield* joins, 3);

      yield* ircd.read(joined("#full"));
      yield* manyTurns;

      assert.lengthOf((yield* hosted.status).joinFailures, 0);
    }).pipe(memory)
  );

  it.effect("LIVE-7: does not retry a `475`, and tries again on a later Connection", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { channels: wanted("#locked") });

      yield* ircd.read(":ircd 475 iirc #locked :Cannot join channel (+k)\r\n");
      yield* manyTurns;

      for (let tick = 0; tick < 10; tick += 1) {
        yield* TestClock.adjust("80 seconds");
        yield* ircd.read("NOTICE * :keeps it alive\r\n");
        yield* manyTurns;
      }

      assert.strictEqual((yield* wire(ircd)).filter((text) => text.startsWith("JOIN")).length, 1);
      assert.strictEqual((yield* hosted.status).joinFailures[0]?.numeric, "475");

      yield* ircd.hangUp;
      yield* manyTurns;
      yield* waitOutBackoff(hosted, ircd);
      yield* ircd.read(`${welcome}${noMotd}`);
      yield* manyTurns;
      yield* afterSettle();

      assert.strictEqual((yield* textsOn(ircd, 1)).at(-1), "JOIN #locked\r\n");
    }).pipe(memory)
  );

  it.effect("LIVE-7: `403` shows in status and does not retry forever as unanswered", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { channels: wanted("#gone") });

      yield* ircd.read(":ircd 403 iirc #gone :No such channel\r\n");
      yield* manyTurns;
      yield* TestClock.adjust("80 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).joinFailures[0]?.numeric, "403");
      assert.strictEqual((yield* wire(ircd)).filter((text) => text.startsWith("JOIN")).length, 1);
    }).pipe(memory)
  );

  it.effect("LIVE-7: a Channel no Line can carry shows in status and is never tried", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* burstOver(ircd, {
        channels: [{ name: "#fine" }, { name: "#bad\r\nQUIT" }, { name: "#a b" }],
      });

      yield* manyTurns;

      assert.strictEqual((yield* wire(ircd)).at(-1), "JOIN #fine\r\n");
      assert.deepStrictEqual(
        (yield* hosted.status).rejectedChannels.map(({ channel, reason }) => [
          channel.name,
          reason,
        ]),
        [
          ["#bad\r\nQUIT", "InvalidChannel"],
          ["#a b", "InvalidChannel"],
        ]
      );
      assert.notInclude((yield* wire(ircd)).join(""), "QUIT");
    }).pipe(memory)
  );

  it.effect("LIVE-7: sends each plan once, however long its Line waits in the lane", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* host(ircd, {
        channels: [{ name: "#one" }, { name: "#two", rejoinOnKick: true }],
        tuning: { ...defaultTuning, floodBurst: 1 },
      });

      yield* ircd.read(welcome);
      yield* manyTurns;
      yield* hosted.send(line, "spends the token");
      yield* ircd.read(noMotd);
      yield* manyTurns;

      // Self moved while the `JOIN` waits for a token, which has the reconciler look again.
      yield* ircd.read(":iirc!~u@host JOIN #other\r\n");
      yield* ircd.read(":iirc!~u@host PART #other\r\n");
      yield* manyTurns;
      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;

      assert.lengthOf(
        (yield* wire(ircd)).filter((text) => text.startsWith("JOIN")),
        1
      );
    }).pipe(memory)
  );

  it.effect("LIVE-7: a reconciler with nowhere to send goes quiet instead of spinning", () => {
    let reads = 0;

    const layer = probed({
      onStanding: () => {
        reads += 1;
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd, { channels: wanted("#one") });
      yield* ircd.read(joined("#one"));
      yield* ircd.setWrites("fail");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      const before = reads;

      // Self is out of the Channel, so a plan is due, and the lanes will take nothing.
      yield* ircd.read(":iirc!~u@host PART #one\r\n");
      yield* manyTurns;

      assert.isAtMost(reads - before, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LIVE-7: a Channel no Line can carry costs no plans at all", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* readsWhileQuiet([{ name: "#bad name" }]),
        yield* readsWhileQuiet([])
      );
    })
  );

  it.effect("HOST-1: a reconciler that dies closes the Connection, and is retried", () => {
    let dies = false;

    const layer = probed({
      onStanding: () => {
        if (dies) {
          dies = false;
          throw new Error("the store broke");
        }
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { channels: wanted("#one") });

      yield* ircd.read(`${welcome}${noMotd}`);
      yield* manyTurns;

      // Armed once the burst is recorded, so the first to read Standing is the reconciler,
      // waking from its settle.
      dies = true;

      yield* afterSettle();

      assert.strictEqual(
        (yield* hosted.status).closeReason,
        "the host failed: Error: the store broke"
      );

      yield* waitOutBackoff(hosted, ircd);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LIVE-7: does not lose a plan to a lane with no room for it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const channels = Array.from({ length: 200 }, (_unused, index) => ({
        name: `#a-rather-long-channel-name-to-make-many-lines-${index}`,
      }));

      yield* burstOver(ircd, {
        channels,
        tuning: { ...defaultTuning, floodBurst: 1, laneLimit: 1 },
      });

      for (let tick = 0; tick < 30; tick += 1) {
        yield* TestClock.adjust("2 seconds");
        yield* manyTurns;
      }

      const sent = (yield* wire(ircd)).join("");

      for (const { name } of channels) {
        assert.include(sent, name);
      }
    }).pipe(memory)
  );

  // A `PRIVMSG` moves nothing a plan reads, and someone else's `JOIN` does, so the second
  // flood costs one plan a Line more than the first and nothing else does.
  it.effect("LIVE-7: does not plan again for every Line of a flood", () => {
    let reads = 0;

    const layer = probed({
      onStanding: () => {
        reads += 1;
      },
    });

    const flood = (ircd: FakeIrcd, line: (index: number) => string) =>
      Effect.gen(function* () {
        const before = reads;

        for (let index = 0; index < 200; index += 1) {
          yield* ircd.read(line(index));
          yield* manyTurns;
        }

        return reads - before;
      });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd, { channels: wanted("#one") });
      yield* ircd.read(joined("#one"));
      yield* manyTurns;

      const said = yield* flood(ircd, (index) => `:a!b@c PRIVMSG #one :${index}\r\n`);
      const joining = yield* flood(ircd, () => ":a!b@c JOIN #one\r\n");

      assert.strictEqual(joining - said, 200);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LIVE-8: a kick wins over autojoin, in this Session and the next", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { channels: wanted("#one") });

      const joins = (connection: number) =>
        Effect.map(
          textsOn(ircd, connection),
          (written) => written.filter((text) => text.startsWith("JOIN")).length
        );

      yield* ircd.read(joined("#one"));
      yield* ircd.read(":op!u@h KICK #one iirc :out\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(
        (yield* hosted.status).kicked.map(({ channel }) => channel),
        ["#one"]
      );

      yield* TestClock.adjust("80 seconds");
      yield* manyTurns;

      assert.strictEqual(yield* joins(0), 1);

      yield* ircd.hangUp;
      yield* manyTurns;
      yield* waitOutBackoff(hosted, ircd);
      yield* ircd.read(`${welcome}${noMotd}`);
      yield* manyTurns;

      assert.strictEqual(yield* joins(1), 0);
      assert.lengthOf((yield* hosted.status).kicked, 1);
    }).pipe(memory)
  );

  it.effect(
    "KNOW-3: a `CASEMAPPING` that splits a Channel from the one wanted wakes autojoin",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();

        const joins = Effect.map(textsOn(ircd, 0), (written) =>
          written.filter((text) => text === "JOIN #x{1}\r\n")
        );

        yield* burstOver(ircd, { channels: wanted("#x{1}") });
        yield* ircd.read(joined("#x[1]"));
        yield* manyTurns;
        yield* TestClock.adjust("80 seconds");
        yield* manyTurns;

        // Under `rfc1459`, the default, the Ircd's spelling is the Channel wanted.
        assert.lengthOf(yield* joins, 1);

        yield* ircd.read(":ircd 005 iirc CASEMAPPING=ascii :are supported\r\n");
        yield* manyTurns;

        assert.lengthOf(yield* joins, 2);
      }).pipe(memory)
  );

  it.effect("LIVE-8: rejoin-on-kick waits 10 seconds, whenever the kick lands", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd, { channels: [{ name: "#one", rejoinOnKick: true }] });
      yield* ircd.read(joined("#one"));
      yield* manyTurns;

      // The plan had nothing left, so this is what brings the reconciler back.
      yield* ircd.read(":op!u@h KICK #one iirc :out\r\n");
      yield* manyTurns;

      const joins = Effect.map(
        wire(ircd),
        (written) => written.filter((text) => text.startsWith("JOIN")).length
      );

      yield* TestClock.adjust("9999 millis");
      yield* manyTurns;

      assert.strictEqual(yield* joins, 1);

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      assert.strictEqual(yield* joins, 2);
    }).pipe(memory)
  );

  it.effect("LIVE-8: an `INVITE` is recorded and never followed", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd);
      yield* ircd.read(":op!u@h INVITE iirc #somewhere\r\n");
      yield* manyTurns;

      assert.include(texts(yield* entries, "inbound"), ":op!u@h INVITE iirc #somewhere");
      assert.notInclude((yield* wire(ircd)).join(""), "JOIN");
    }).pipe(memory)
  );

  it.effect("LIVE-7: nothing is planned once the Connection has closed", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd, { channels: wanted("#one") });
      yield* ircd.hangUp;
      yield* manyTurns;

      const before = (yield* entries).length;

      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;

      assert.lengthOf(yield* entries, before);
    }).pipe(memory)
  );
});

describe("LIVE-9, LIVE-11: stopping", () => {
  it.effect("LIVE-9: records `closing`, says `QUIT`, records `closed`, and stays gone", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { fiber, hosted, stop } = yield* stopInBackground(ircd, { quitReason: "off to bed" });

      yield* stop;
      yield* Fiber.join(fiber);

      const log = yield* entries;
      const [closing] = connectionsOf(log, "closing");
      const [closed] = connectionsOf(log, "closed");
      const quit = linesOf(log).find(({ bytes }) => decode(bytes).startsWith("QUIT"));

      assert.strictEqual(closing?.reason, "off to bed");
      assert.strictEqual((yield* wire(ircd)).at(-1), "QUIT :off to bed\r\n");
      assert.strictEqual(quit?.cause, "quit");
      assert.isBelow(closing?.sequence ?? Infinity, quit?.sequence ?? 0);
      assert.isBelow(quit?.sequence ?? Infinity, closed?.sequence ?? 0);
      assert.strictEqual(closed?.reason, "off to bed");
      assert.isTrue(yield* ircd.released);

      const status = yield* hosted.status;

      assert.strictEqual(status.phase, "closed");
      assert.isUndefined(status.nextAttemptAt);

      yield* TestClock.adjust("1 hour");
      yield* manyTurns;

      assert.lengthOf(yield* ircd.dials, 1);
    }).pipe(memory)
  );

  it.effect("LIVE-9: queued Lines become Dropped, and only `QUIT` leaves", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const { fiber, hosted, stop } = yield* stopInBackground(ircd, {
        tuning: { ...defaultTuning, floodBurst: 1 },
      });

      yield* hosted.send(line, "spends the token");

      const waiting = yield* Effect.forkChild(Effect.exit(hosted.send(line, "key:later")));

      yield* manyTurns;
      yield* stop;
      yield* Fiber.join(fiber);

      const log = yield* entries;
      const [dropped] = droppedIn(log);
      const [closed] = connectionsOf(log, "closed");

      assert.strictEqual(dropped?.cause, "key:later");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(waiting)));
      assert.isBelow(dropped?.sequence ?? Infinity, closed?.sequence ?? 0);
      assert.deepStrictEqual((yield* wire(ircd)).slice(-2), [
        "PRIVMSG #one hi\r\n",
        "QUIT leaving\r\n",
      ]);
    }).pipe(memory)
  );

  it.effect("LIVE-11: refuses sends from the moment it stops", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { hosted, stop } = yield* stopInBackground(ircd);

      yield* ircd.setWrites("hang");
      yield* stop;
      yield* manyTurns;

      const exit = yield* Effect.exit(hosted.send(line, "too late"));

      assert.deepStrictEqual(exit, Exit.fail(new NotInSession({ phase: "closing" })));
      assert.strictEqual((yield* hosted.status).phase, "closing");
    }).pipe(memory)
  );

  it.effect("LIVE-9: gives the Ircd until `quitWaitMillis` to hang up, and no longer", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ ignoresQuit: true });
      const { fiber, hosted, stop } = yield* stopInBackground(ircd);
      const stopAt = yield* now;

      yield* stop;
      yield* manyTurns;

      assert.strictEqual((yield* wire(ircd)).at(-1), "QUIT leaving\r\n");

      yield* ircd.read("ERROR :Closing Link\r\n");
      yield* TestClock.adjust("1999 millis");
      yield* manyTurns;

      assert.isUndefined(fiber.pollUnsafe());
      assert.include(texts(yield* entries, "inbound"), "ERROR :Closing Link");

      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);

      assert.strictEqual(connectionsOf(yield* entries, "closed")[0]?.at, stopAt + 2000);
      assert.strictEqual((yield* hosted.status).phase, "closed");
    }).pipe(memory)
  );

  it.effect("LIVE-9: finishes at the limit with a stalled socket, and tells the Log", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { fiber, hosted, stop } = yield* stopInBackground(ircd);

      yield* ircd.setWrites("hang");

      const stopAt = yield* now;

      yield* stop;
      yield* manyTurns;

      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1999 millis");
      yield* manyTurns;

      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);

      const log = yield* entries;
      const [closed] = connectionsOf(log, "closed");

      assert.strictEqual(closed?.at, stopAt + 2000);
      assert.strictEqual(log.at(-1), closed);
      assert.isTrue(yield* ircd.released);
      assert.strictEqual((yield* hosted.status).phase, "closed");
    }).pipe(memory)
  );

  it.effect("LIVE-9: finishes at once with the Log down, and lets go of the socket", () => {
    let down = false;

    const layer = probed({ failsAfterWithin: () => down });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { fiber, hosted, stop } = yield* stopInBackground(ircd);

      down = true;

      yield* stop;
      yield* Fiber.join(fiber);

      assert.isTrue(yield* ircd.released);
      assert.notInclude((yield* wire(ircd)).join(""), "QUIT");
      assert.strictEqual((yield* hosted.status).phase, "closed");
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LIVE-9: a Recorder that never returns cannot hold a stop past its limit", () => {
    let stuck = false;

    const layer = probed({
      duringRecord: () => (stuck ? Effect.never : Effect.void),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { fiber, hosted, stop } = yield* stopInBackground(ircd);

      stuck = true;

      yield* stop;
      yield* manyTurns;

      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(fiber);
      yield* manyTurns;

      // The loop has been let go of, so the socket goes with it.
      assert.strictEqual((yield* hosted.status).phase, "closed");
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LIVE-9: stopping during a backoff returns at once and records nothing", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });

      yield* Effect.scoped(bareHost(ircd));

      const log = yield* entries;

      assert.deepStrictEqual(
        log.map((entry) => (entry._tag === "Connection" ? entry.phase : entry._tag)),
        ["attempt", "closed"]
      );

      yield* Effect.scoped(bareHost(ircd));

      assert.lengthOf(yield* entries, log.length);
      assert.lengthOf(yield* ircd.dials, 1);
    }).pipe(memory)
  );

  it.effect("LIVE-9: stopping during a dial cancels it, with no `QUIT` and an honest Log", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* ircd.setDials("hang");
      yield* Effect.scoped(bareHost(ircd));

      const log = yield* entries;

      assert.deepStrictEqual(
        log.map((entry) => (entry._tag === "Connection" ? entry.phase : entry._tag)),
        ["attempt", "closing", "closed"]
      );
      assert.strictEqual(yield* ircd.cancelled, 1);
      assert.lengthOf(yield* wire(ircd), 0);

      // Closing was the Daemon's choice, so the next host need not wait.
      yield* ircd.setDials("accept");
      yield* host(ircd);

      assert.lengthOf(yield* ircd.dials, 2);
    }).pipe(memory)
  );

  it.effect("LIVE-9: a Scope that runs its finalizers side by side still gets its `QUIT`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const scope = yield* Scope.make("parallel");

      yield* burstOver(ircd).pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);

      assert.strictEqual((yield* wire(ircd)).at(-1), "QUIT leaving\r\n");
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
    }).pipe(memory)
  );

  it.effect("LIVE-9: a stop during a drain only shortens it, keeping the first reason", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { fiber, hosted, stop } = yield* stopInBackground(ircd);

      yield* ircd.read("ERROR :bye\r\n");
      yield* manyTurns;
      yield* stop;
      yield* manyTurns;
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      const log = yield* entries;

      // The `ERROR` is what closed it, which the Daemon did not choose (LOG-2).
      assert.deepStrictEqual(
        connectionsOf(log, "closing").map(({ chosen, reason }) => [chosen, reason]),
        [[false, "bye"]]
      );
      assert.strictEqual(connectionsOf(log, "closed")[0]?.reason, "bye");
      assert.notInclude((yield* wire(ircd)).join(""), "QUIT");
      assert.strictEqual((yield* hosted.status).closeReason, "bye");
    }).pipe(memory)
  );
});

describe("status", () => {
  it.effect("OBS-4: reads everything from one place, derived from the Log and the lanes", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* burstOver(ircd, {
        channels: [{ name: "#in" }, { name: "#out" }, { name: "#bad name" }],
      });

      yield* ircd.read(":iirc!~u@host JOIN #in\r\n");
      yield* ircd.read(":ircd 473 iirc #out :Invite only\r\n");
      yield* ircd.read(":iirc!~u@host JOIN #kicked\r\n");
      yield* ircd.read(":op!u@h KICK #kicked iirc :out\r\n");
      yield* manyTurns;

      const status = yield* hosted.status;

      assert.deepStrictEqual(brief(status), { closeReason: undefined, phase: "session" });
      assert.strictEqual(status.self, "iirc");
      assert.deepStrictEqual(status.joined, ["#in"]);
      assert.strictEqual(status.joinFailures[0]?.channel, "#out");
      assert.strictEqual(status.kicked[0]?.channel, "#kicked");
      assert.strictEqual(status.rejectedChannels[0]?.channel.name, "#bad name");
      assert.deepStrictEqual(status.lanes, { background: 0, control: 0, interactive: 0 });
      assert.isUndefined(status.logFault);
      assert.isUndefined(status.nextAttemptAt);
      assert.strictEqual(status.consecutiveFailures, 0);
    }).pipe(memory)
  );

  it.effect("the time it gives for the next attempt is the time the loop waits for", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const hosted = yield* host(ircd);

      yield* waitOutBackoff(hosted, ircd);
      yield* waitOutBackoff(hosted, ircd);
    }).pipe(memory)
  );

  it.effect("reads `closing` from the moment a stop is asked for, however busy the loop", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<undefined>();

      const layer = probed({
        duringRecord: (recording) =>
          recording.some(isLineWith("NOTICE * :held"))
            ? Effect.asVoid(Deferred.await(release))
            : Effect.void,
      });

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const { fiber, hosted, stop } = yield* stopInBackground(ircd);

        yield* ircd.read("NOTICE * :held\r\n");
        yield* manyTurns;
        yield* stop;
        yield* manyTurns;

        assert.strictEqual((yield* hosted.status).phase, "closing");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect("reads `closing` while a close waits for a Line that is being recorded", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<undefined>();

      const layer = probed({
        duringRecord: (recording) =>
          recording.some(isLineWith("PRIVMSG #one hi"))
            ? Effect.asVoid(Deferred.await(release))
            : Effect.void,
      });

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const hosted = yield* burstOver(ircd);

        yield* Effect.forkChild(Effect.exit(hosted.send(line, "held")));
        yield* manyTurns;
        yield* ircd.hangUp;
        yield* manyTurns;

        assert.strictEqual((yield* hosted.status).phase, "closing");

        yield* Deferred.succeed(release, undefined);
        yield* manyTurns;

        assert.strictEqual((yield* hosted.status).phase, "closed");
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect("reads `closing` for a close the machine has not heard of, before any Session", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* ircd.setWrites("fail");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closing");
    }).pipe(memory)
  );

  it.effect("never reads `session` while a Line cannot be sent", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      yield* ircd.setWrites("fail");
      yield* Effect.exit(hosted.send(line, "test"));

      assert.strictEqual((yield* hosted.status).phase, "closing");
    }).pipe(memory)
  );
});

describe("LOG-9: the Log failing", () => {
  it.effect("LOG-9: dials nothing during a fault, shows it, and resumes on its own", () => {
    let down = true;

    const layer = probed({ failsAfterWithin: () => down });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      assert.lengthOf(yield* ircd.dials, 0);
      assert.strictEqual((yield* hosted.status).logFault?.failures, 1);

      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).logFault?.failures, 2);

      yield* TestClock.adjust("10 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).logFault?.failures, 3);
      assert.lengthOf(yield* ircd.dials, 0);
      assert.lengthOf(yield* entries, 0);

      down = false;

      yield* TestClock.adjust("20 seconds");
      yield* manyTurns;

      assert.lengthOf(yield* ircd.dials, 1);
      assert.isUndefined((yield* hosted.status).logFault);
      assert.strictEqual((yield* hosted.status).phase, "registering");
    }).pipe(Effect.provide(layer));
  });

  it.effect("LOG-9: a fault during a Session closes it, and nothing dials until it clears", () => {
    let down = false;

    const layer = probed({ failsAfterWithin: () => down });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      down = true;

      yield* ircd.read("NOTICE * :unrecordable\r\n");
      yield* manyTurns;

      assert.isTrue(yield* ircd.released);
      assert.strictEqual((yield* hosted.status).phase, "closed");
      assert.isDefined((yield* hosted.status).logFault);

      const closedConnections = (yield* ircd.dials).length;

      yield* TestClock.adjust("2 minutes");
      yield* manyTurns;

      assert.lengthOf(yield* ircd.dials, closedConnections);

      // The fault is why there is no Session, so that is what a send is told (LOG-9).
      assert.deepStrictEqual(
        yield* Effect.exit(hosted.send(line, "test")),
        Exit.fail(new RecordFailed({ cause: "the Log could not record this Connection" }))
      );

      down = false;

      yield* TestClock.adjust("45 seconds");
      yield* manyTurns;

      assert.lengthOf(yield* ircd.dials, closedConnections + 1);
      assert.isUndefined((yield* hosted.status).logFault);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LOG-9: a Line the Log would not take is not written, and fails its send", () => {
    const layer = probed({
      failsAfterWithin: (recording) => recording.some(isLineWith("PRIVMSG #one hi")),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      const exit = yield* Effect.exit(hosted.send(line, "test"));

      assert.isTrue(Exit.isFailure(exit));
      assert.notInclude((yield* wire(ircd)).join(""), "PRIVMSG");

      yield* manyTurns;

      assert.strictEqual(
        (yield* hosted.status).closeReason,
        "the Log could not record this Connection"
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("LOG-9: a Recorder that always dies cannot spin, and never reaches a dial", () => {
    let records = 0;

    const layer = probed({
      duringRecord: () => {
        records += 1;

        return Effect.die("the store broke");
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* manyTurns;

      assert.strictEqual(records, 1);
      assert.isDefined((yield* hosted.status).logFault);
      assert.strictEqual((yield* hosted.status).phase, "closed");

      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      assert.strictEqual(records, 2);
      assert.lengthOf(yield* ircd.dials, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("HOST-1: a host cannot stay dead", () => {
  it.effect("HOST-1: a machine throw is recorded as a close, and retried", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { tuning: throwing });

      yield* ircd.read(welcome);
      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;

      const [closed] = connectionsOf(yield* entries, "closed");

      assert.include(closed?.reason, "the machine threw on Entry");
      assert.strictEqual((yield* hosted.status).phase, "closed");

      yield* waitOutBackoff(hosted, ircd);

      assert.strictEqual((yield* hosted.status).phase, "registering");
    }).pipe(memory)
  );

  it.effect("HOST-1: a machine throw on the `attempt` itself never dials", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      assert.lengthOf(yield* ircd.dials, 0);
      assert.include((yield* hosted.status).closeReason, "the machine threw on Entry 1");
      assert.deepStrictEqual(
        (yield* entries).map((entry) => (entry._tag === "Connection" ? entry.phase : entry._tag)),
        ["attempt", "closing", "closed"]
      );
    }).pipe(Effect.provide(probed({ rewrite: poisoned })))
  );

  it.effect("HOST-1: a dial that dies is a close like any other", () =>
    Effect.gen(function* () {
      const hosted = yield* host({ transport: { connect: () => Effect.die("it broke") } });

      assert.strictEqual((yield* hosted.status).closeReason, "the dial died: it broke");

      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      assert.lengthOf(connectionsOf(yield* entries, "attempt"), 2);
    }).pipe(memory)
  );

  it.effect("HOST-1: no sequence of bytes closes a Session", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { channels: [{ name: "#one" }] });

      const hostile = [
        ":x 433 iirc iirc :in use\r\n",
        "FAIL * :nope\r\n",
        ":x 464 iirc :nope\r\n",
        "NICK\r\n",
        ":iirc NICK\r\n",
        "\0\0\0\r\n",
        `${"@".repeat(9000)}\r\n`,
        ":iirc!u@h KICK\r\n",
        "PING\r\n",
      ];

      yield* Effect.forEach(hostile, (text) => ircd.read(text), { discard: true });
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.strictEqual((yield* wire(ircd)).at(-1), "PONG\r\n");
    }).pipe(memory)
  );

  it.effect("LIVE-1: a bare `PING` gets a bare `PONG`, recorded with its cause", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd);
      yield* ircd.read("PING\r\n");
      yield* manyTurns;

      const [reply] = linesOf(yield* entries).slice(-1);

      assert.strictEqual(decode(reply?.bytes ?? encode("")), "PONG");
      assert.strictEqual(reply?.cause, "ping-reply");
    }).pipe(memory)
  );

  it.effect("HOST-1: a `PING` flood of oversize tokens costs Entries, and never a Session", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      for (let index = 0; index < 50; index += 1) {
        yield* ircd.read(`PING :${"p".repeat(600)}\r\n`);
      }

      yield* manyTurns;

      assert.lengthOf(droppedIn(yield* entries), 50);
      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(memory)
  );
});

describe("the fake Ircd", () => {
  it.effect("keeps each Connection's bytes to itself", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      yield* ircd.hangUp;
      yield* manyTurns;
      yield* waitOutBackoff(hosted, ircd);
      yield* ircd.read(welcome);
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.lengthOf(yield* ircd.writtenOn(0), 2);
      assert.lengthOf(yield* ircd.writtenOn(1), 2);
    }).pipe(memory)
  );
});

describe("LOG-4, LIVE-11: a stop under a flood", () => {
  it.effect("LOG-4: reads no further ahead of the Log than its bound in bytes", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<undefined>();

      const layer = probed({
        duringRecord: (recording) =>
          recording.some(isLineWith("NOTICE * :held"))
            ? Effect.asVoid(Deferred.await(release))
            : Effect.void,
      });

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const reads = 40;

        yield* burstOver(ircd);
        yield* ircd.read("NOTICE * :held\r\n");
        yield* manyTurns;

        for (let index = 0; index < reads; index += 1) {
          yield* ircd.read(`NOTICE * :${index} ${"x".repeat(4000)}\r\n`);
        }

        yield* manyTurns;

        // 16 KB, and the read that crossed it: five of these, and the rest in the kernel.
        assert.strictEqual(reads - (yield* ircd.unread), 5);

        yield* Deferred.succeed(release, undefined);
        yield* manyTurns;

        assert.strictEqual(yield* ircd.unread, 0);
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect(
    "LOG-4: records everything it read before `closed`, and answers nothing after the stop",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd({ ignoresQuit: true });
        const { fiber, stop } = yield* stopInBackground(ircd);
        const flood = 30;

        for (let read = 0; read < flood; read += 1) {
          yield* ircd.read(pingRead(read * 1024));
        }

        yield* stop;
        yield* manyTurns;
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(fiber);

        const log = yield* entries;
        const pings = texts(log, "inbound").filter((text) => text.startsWith("PING"));
        const [closing] = connectionsOf(log, "closing");
        const [closed] = connectionsOf(log, "closed");
        const unreadLines = (yield* ircd.unread) * 1024;

        assert.strictEqual(pings.length + unreadLines, flood * 1024);
        assert.isTrue(closing?.chosen);
        assert.strictEqual(log.at(-1), closed);

        // Nothing read after the stop was answered, and what was asked and not sent says so.
        const answered = linesOf(log).filter(
          ({ cause, sequence }) => cause === "ping-reply" && sequence > (closing?.sequence ?? 0)
        );

        assert.lengthOf(answered, 0);
      }).pipe(memory)
  );

  it.effect("LIVE-9: notices a stop between the batches of one read", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<undefined>();

      const layer = probed({
        duringRecord: (recording) =>
          recording.some(isLineWith("PING 0"))
            ? Effect.asVoid(Deferred.await(release))
            : Effect.void,
      });

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd({ ignoresQuit: true });
        const { fiber, stop } = yield* stopInBackground(ircd);

        // One read, of five batches, and the stop comes while the first is committing.
        yield* ircd.read([0, 1, 2, 3, 4].map((part) => pingRead(part * 1024)).join(""));
        yield* manyTurns;
        yield* stop;
        yield* Deferred.succeed(release, undefined);
        yield* manyTurns;
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(fiber);

        const log = yield* entries;
        const [closing] = connectionsOf(log, "closing");
        const lastPing = linesOf(log).findLast(({ bytes }) => decode(bytes).startsWith("PING"));

        assert.isBelow(closing?.sequence ?? Infinity, lastPing?.sequence ?? 0);
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect(
    "LIVE-11: what can no longer be sent is Dropped in the close's commit, not one by one",
    () => {
      const commits: (readonly NewEntry[])[] = [];

      const layer = probed({
        before: (recording) => {
          commits.push(recording);
        },
      });

      return Effect.gen(function* () {
        const ircd = yield* fakeIrcd({ ignoresQuit: true });

        const { fiber, stop } = yield* stopInBackground(ircd, {
          tuning: { ...defaultTuning, controlLaneLimit: 2 },
        });

        yield* ircd.setWrites("hang");
        yield* ircd.read(pingRead(0));
        yield* manyTurns;
        commits.length = 0;

        yield* stop;
        yield* manyTurns;
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(fiber);

        const dropping = commits.filter((recording) =>
          recording.some(({ _tag }) => _tag === "Dropped")
        );

        assert.lengthOf(dropping, 1);
        assert.isTrue(dropping[0]?.some(isClosed));
        assert.isAbove(droppedIn(yield* entries).length, 1000);
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect("LOG-2: a stop that runs out of time still ends the Log with `closed`", () => {
    let slow = false;

    const layer = probed({
      duringRecord: () => (slow ? TestClock.adjust("200 millis") : Effect.void),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ ignoresQuit: true });
      const { fiber, hosted, stop } = yield* stopInBackground(ircd);

      slow = true;

      // Reads of 8192 Lines, so that one is eight commits, and what is read and not yet
      // recorded when the limit passes would take longer than is left to record.
      for (let read = 0; read < 20; read += 1) {
        yield* ircd.read(
          Array.from({ length: 8 }, (_unused, part) => pingRead((read * 8 + part) * 1024)).join("")
        );
      }

      yield* stop;

      // Each commit costs 200 ms here, so the stop's own limit passes long before the
      // reads run out, and only being hurried ends it.
      for (let tick = 0; tick < 40 && fiber.pollUnsafe() === undefined; tick += 1) {
        yield* manyTurns;
        yield* TestClock.adjust("100 millis");
      }

      yield* Fiber.join(fiber);

      const log = yield* entries;

      assert.strictEqual(log.at(-1)?._tag, "Connection");
      assert.lengthOf(connectionsOf(log, "closed"), 1);
      assert.strictEqual((yield* hosted.status).phase, "closed");
    }).pipe(Effect.provide(layer));
  });
});

describe("LOG-2: closing, and the Ircd's own words", () => {
  it.effect("LIVE-5: an ERROR after the registration deadline gives its words", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* TestClock.adjust("60 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closing");

      yield* ircd.read("ERROR :Closing Link: registration timed out, says the Ircd\r\n");
      yield* ircd.hangUp;
      yield* manyTurns;

      const [closed] = connectionsOf(yield* entries, "closed");

      assert.strictEqual(closed?.reason, "Closing Link: registration timed out, says the Ircd");
    }).pipe(memory)
  );

  it.effect("LIVE-5: a stop during a close it did not choose still takes the Ircd's words", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const running = yield* Deferred.make<NetworkHost>();
      const stop = yield* Deferred.make<undefined>();

      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Deferred.succeed(running, yield* bareHost(ircd));
          yield* Deferred.await(stop);
        })
      ).pipe(Effect.forkChild);

      const hosted = yield* Deferred.await(running);

      yield* TestClock.adjust("60 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closing");

      yield* Deferred.succeed(stop, undefined);
      yield* manyTurns;
      yield* ircd.read("ERROR :the real Ircd reason\r\n");
      yield* ircd.hangUp;
      yield* Fiber.join(fiber);

      const log = yield* entries;
      const [closing] = connectionsOf(log, "closing");
      const [closed] = connectionsOf(log, "closed");

      assert.isFalse(closing?.chosen);
      assert.strictEqual(closed?.reason, "the real Ircd reason");
    }).pipe(memory)
  );

  it.effect("LIVE-9: a leave the Daemon chose keeps its reason, though the Ircd answers it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({
        respond: (line) => (line.startsWith("QUIT") ? ["ERROR :Closing Link: (Quit: off)"] : []),
      });

      const { fiber, stop } = yield* stopInBackground(ircd, { quitReason: "off to bed" });

      yield* stop;
      yield* Fiber.join(fiber);

      const log = yield* entries;
      const [closed] = connectionsOf(log, "closed");

      assert.include(texts(log, "inbound"), "ERROR :Closing Link: (Quit: off)");
      assert.strictEqual(closed?.reason, "off to bed");
    }).pipe(memory)
  );

  it.effect("LOG-2: a ban at accept gives its words, though a failed write started the close", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* ircd.setWrites("fail");

      const hosted = yield* host(ircd);

      yield* ircd.read("ERROR :You are banned from this server (test)\r\n");
      yield* ircd.hangUp;
      yield* manyTurns;

      const [closed] = connectionsOf(yield* entries, "closed");

      assert.strictEqual(closed?.reason, "You are banned from this server (test)");
      assert.strictEqual(
        (yield* hosted.status).closeReason,
        "You are banned from this server (test)"
      );
      assert.isAtMost(yield* waitOutBackoff(hosted, ircd), defaultTuning.reconnectInitialMillis);
    }).pipe(memory)
  );

  it.effect("LOG-2: an ERROR among the Lines a close records still outranks its reason", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<undefined>();

      const layer = probed({
        duringRecord: (recording) =>
          recording.some(isLineWith("NOTICE * :held"))
            ? Effect.asVoid(Deferred.await(release))
            : Effect.void,
      });

      return yield* Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const hosted = yield* host(ircd);

        yield* ircd.setWrites("fail");
        yield* ircd.read("PING :1\r\n");
        yield* manyTurns;
        yield* ircd.read("NOTICE * :held\r\n");
        yield* manyTurns;
        yield* ircd.read("ERROR :You are banned\r\n");
        yield* manyTurns;

        // The drain's limit passes while the loop is held, so the `ERROR` is one of the
        // Lines the close itself records.
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.succeed(release, undefined);
        yield* manyTurns;

        const [closed] = connectionsOf(yield* entries, "closed");

        assert.strictEqual(closed?.reason, "You are banned");
        assert.strictEqual((yield* hosted.status).closeReason, "You are banned");
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect(
    "LOG-2: a failed write is a local close, recorded as one the Daemon did not choose",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();

        yield* burstOver(ircd);
        yield* ircd.setWrites("fail");
        yield* ircd.read("PING :1\r\n");
        yield* manyTurns;

        assert.deepStrictEqual(closings(yield* entries), [
          { chosen: false, reason: "write failed: broken pipe" },
        ]);
      }).pipe(memory)
  );

  it.effect("LOG-2: silence and the machine's own closes are local too", () =>
    Effect.gen(function* () {
      const silent = yield* fakeIrcd();

      yield* burstOver(silent);
      yield* TestClock.adjust("90 seconds");
      yield* manyTurns;

      assert.deepStrictEqual(closings(yield* entries), [
        { chosen: false, reason: "heard nothing for 90 seconds" },
      ]);
    }).pipe(memory)
  );

  it.effect("LOG-2: an Ircd hanging up is no decision of the Daemon's, so no `closing`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd);
      yield* ircd.hangUp;
      yield* manyTurns;

      assert.deepStrictEqual(closings(yield* entries), []);
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
    }).pipe(memory)
  );

  it.effect("LOG-2: only a chosen leave avoids counting as a failure", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      yield* ircd.setWrites("fail");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).consecutiveFailures, 1);

      const delay = yield* waitOutBackoff(hosted, ircd);

      assert.isAtLeast(delay, 2500);
    }).pipe(memory)
  );
});

describe("LOG-2, LOG-9: a Connection the Log could not close", () => {
  it.effect("LOG-2: gets its `closed` once appends succeed, before the next `attempt`", () => {
    let down = false;

    const layer = probed({ failsAfterWithin: () => down });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd, { tuning: { ...defaultTuning, floodBurst: 1 } });

      yield* hosted.send(line, "spends the token");

      const waiting = yield* Effect.forkChild(Effect.exit(hosted.send(line, "key:later")));

      yield* manyTurns;

      down = true;

      yield* ircd.read("NOTICE * :unrecordable\r\n");
      yield* manyTurns;

      const endedAt = yield* Clock.currentTimeMillis;

      // The Log never heard of the close, so it cannot say the Line was Dropped either.
      assert.deepStrictEqual(
        yield* Fiber.join(waiting),
        Exit.fail(new RecordFailed({ cause: "the Log could not record this Connection" }))
      );
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);

      down = false;

      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      const log = yield* entries;
      const [closed] = connectionsOf(log, "closed");
      const attempts = connectionsOf(log, "attempt");

      assert.strictEqual(closed?.reason, "the Log could not record this Connection");
      assert.isBelow(closed?.sequence ?? Infinity, attempts[1]?.sequence ?? 0);
      assert.include(texts(log, "inbound"), "NOTICE * :unrecordable");
      assert.strictEqual(droppedIn(log).at(-1)?.cause, "key:later");

      const standing = yield* Recorder.use(({ standing: of }) => of("libera"));

      assert.strictEqual(standing.gap?.reason, "the Log could not record this Connection");

      // LIVE-10: recorded 5 seconds late, it says when the Connection ended, and the Gap
      // starts there, while its place in order is still its sequence (LOG-8).
      assert.strictEqual(closed?.endedAt, endedAt);
      assert.isAtLeast(closed?.at ?? 0, endedAt + 5000);
      assert.strictEqual(standing.gap?.at, endedAt);
      assert.strictEqual(standing.gap?.sequence, closed?.sequence);
    }).pipe(Effect.provide(layer));
  });

  it.effect("LOG-9: one outage counts once, however many appends fail during it", () => {
    let down = false;

    const layer = probed({ failsAfterWithin: () => down });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* burstOver(ircd);

      down = true;

      yield* ircd.read("NOTICE * :one\r\nPING :1\r\n");
      yield* manyTurns;
      yield* ircd.read("NOTICE * :two\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).logFault?.failures, 1);
    }).pipe(Effect.provide(layer));
  });
});

describe("LOG-8: a clock set back", () => {
  it.effect("LOG-8: cannot make a backoff longer than its own delay from now", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const tuning = { ...defaultTuning, reconnectInitialMillis: 100, reconnectMaxMillis: 100 };

      // The Log's times run three days ahead of the clock now.
      yield* TestClock.setTime(3 * 86_400_000);
      yield* Effect.scoped(bareHost(ircd, { tuning }));
      yield* TestClock.setTime(0);

      const hosted = yield* host(ircd, { tuning });

      assert.isAtMost(((yield* hosted.status).nextAttemptAt ?? Infinity) - (yield* now), 100);

      yield* TestClock.adjust("100 millis");
      yield* manyTurns;

      assert.lengthOf(yield* ircd.dials, 2);
    }).pipe(memory)
  );
});
