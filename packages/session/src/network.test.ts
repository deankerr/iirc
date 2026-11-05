import { assert, describe, it } from "@effect/vitest";
import { closeReason, phase, start, step } from "@iirc/lifecycle";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { maxFrameBytes } from "@iirc/protocol/frame";
import { Cause, Clock, Effect, Exit } from "effect";
import { TestClock } from "effect/testing";

import type { Entry, NewEntry } from "./entry.ts";
import { toEvent } from "./events.ts";
import {
  address,
  brief,
  connectionsOf,
  deadlinesNamed,
  decode,
  droppedIn,
  encode,
  entries,
  held,
  host,
  inSession,
  input,
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
import { NotInSession, WriteFailed } from "./network.ts";
import { Recorder, RecordFailed } from "./recorder.ts";
import { attemptInput, fakeIrcd } from "./testing.ts";
import type { FakeIrcd } from "./testing.ts";

// A small deterministic generator, so that a failure can be replayed.
const randomBytes = (length: number, seed: number) => {
  let state = seed;

  return Uint8Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

    return Math.floor(state / 65_536) % 256;
  });
};

// What a frame boundary leaves of a byte stream, worked out without `takeFrames`.
const framesOf = (bytes: Uint8Array) => {
  const frames: Uint8Array[] = [];
  let start = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      const end = bytes[index - 1] === 0x0d && index > start ? index - 1 : index;

      frames.push(bytes.subarray(start, end));
      start = index + 1;
    }
  }

  return { frames, rest: bytes.subarray(start) };
};

// Each `attempt` brings the input its Connection ran with, a throwing Tuning included, so
// this does what the host does: a transition that throws leaves the machine as it was.
const statusFolded = (log: readonly Entry[]) => {
  let snapshot = start(input);

  for (const event of log.flatMap((entry) => toEvent(entry) ?? [])) {
    try {
      snapshot = step(snapshot, event).next;
    } catch {
      // The host closes the Connection, and the machine hears of that from the Log.
    }
  }

  return { closeReason: closeReason(snapshot), phase: phase(snapshot) };
};

// Fails a commit the first time it matches, as a Log that has a moment's trouble does.
const once = (matches: (entries: readonly NewEntry[]) => boolean) => {
  let failed = false;

  return (entries: readonly NewEntry[]) => {
    const fails = !failed && matches(entries);

    failed ||= fails;

    return fails;
  };
};

describe("hostNetwork registering", () => {
  it.effect("sends `NICK` and `USER`, reaches a Session on `001`, and joins after the burst", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      assert.deepStrictEqual(yield* wire(ircd), ["NICK iirc\r\n", "USER user 0 * :I IRC\r\n"]);
      assert.strictEqual((yield* hosted.status).phase, "registering");

      yield* ircd.read(":ircd 001 iirc :Welcome\r\n:ircd 422 iirc :No MOTD\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.lengthOf(yield* wire(ircd), 2);

      yield* TestClock.adjust("1 second");
      yield* manyTurns;

      assert.deepStrictEqual((yield* wire(ircd)).slice(2), ["JOIN #one,#two\r\n"]);

      const outboundLines = linesOf(yield* entries).filter(
        ({ direction }) => direction === "outbound"
      );

      assert.deepStrictEqual(
        outboundLines.map(({ cause }) => cause),
        ["registration", "registration", "rejoin"]
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records `attempt` then `opened`, and every later Entry under `attempt`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);

      const log = yield* entries;
      const [attempt] = connectionsOf(log, "attempt");
      const [opened] = connectionsOf(log, "opened");

      assert.strictEqual(attempt?.sequence, 1);
      assert.deepStrictEqual(attempt?.nicks.slice(0, 2), ["iirc", "iirc_"]);
      assert.strictEqual(opened?.sequence, 2);
      assert.strictEqual(opened?.connection, 1);

      for (const { connection } of linesOf(log)) {
        assert.strictEqual(connection, 1);
      }
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("takes `at` from the recorded Entry, so a later clock changes nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");

      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);
      yield* TestClock.adjust("5 seconds");

      const log = yield* entries;

      assert.deepStrictEqual([...new Set(log.map(({ at }) => at))], [5000]);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );
});

describe("hostNetwork recording before acting", () => {
  it.effect("answers `PING` with a `PONG` caused by it, recorded after it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);
      yield* ircd.read("PING :token one\r\n");
      yield* manyTurns;

      const lines = linesOf(yield* entries);
      const ping = lines.find(({ bytes }) => decode(bytes) === "PING :token one");
      const pong = lines.find(({ bytes }) => decode(bytes) === "PONG :token one");

      assert.strictEqual(pong?.cause, "ping-reply");
      assert.strictEqual(pong?.direction, "outbound");
      assert.isTrue((ping?.sequence ?? Infinity) < (pong?.sequence ?? 0));
      assert.strictEqual((yield* wire(ircd)).at(-1), "PONG :token one\r\n");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("answers `PING` before registration too (LIVE-1)", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd);
      yield* ircd.read("PING :early\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* wire(ircd)).at(-1), "PONG early\r\n");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records exactly what it writes, less the line ending", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);

      const log = yield* entries;

      assert.deepStrictEqual(
        texts(log, "outbound").map((text) => `${text}\r\n`),
        yield* wire(ircd)
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("runs no Command until `record` has returned", () => {
    const events: string[] = [];

    const layer = probed({
      after: () => {
        events.push("committed");
      },
      afterWithin: () => {
        events.push("within");
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd({
        onWrite: () => {
          events.push("written");
        },
      });

      yield* inSession(ircd);
      events.length = 0;

      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      // The `PING`'s commit, then the `PONG`'s, then the `PONG` on the wire.
      assert.deepStrictEqual(events, ["within", "committed", "within", "committed", "written"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes nothing for a Line whose commit failed, though `within` ran", () => {
    const layer = probed({
      failsAfterWithin: once((recording) => recording.some(isLineWith("PING :1"))),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const before = yield* wire(ircd);

      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(yield* wire(ircd), before);
      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "the Log could not record this Connection",
        phase: "closed",
      });
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
      assert.isTrue(yield* ircd.released);

      // The Line was read, so it is recorded before the close all the same (LOG-4).
      assert.include(texts(yield* entries, "inbound"), "PING :1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("publishes nothing from a commit that has not landed", () => {
    const layer = probed({
      beforeFailing: Effect.sleep("1 second"),
      failsAfterWithin: once((recording) => recording.some(isLineWith(":ircd 001 iirc :Welcome"))),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "registering");

      yield* TestClock.adjust("1 second");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not write a Line it could not record, and closes", () => {
    const layer = probed({
      failsAfterWithin: (recording) => recording.some(isLineWith("PONG 1")),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      assert.notInclude(yield* wire(ircd), "PONG 1\r\n");
      assert.strictEqual((yield* hosted.status).phase, "closed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("commits two Lines from one read in one `record`, however they were chunked", () => {
    const records: (readonly NewEntry[])[] = [];

    const layer = probed({
      before: (recording) => {
        records.push(recording);
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);
      records.length = 0;

      yield* ircd.read("PING :1\r\nPI", "NG :2\r\n");
      yield* manyTurns;

      const inbound = records.filter((recording) =>
        recording.some((entry) => entry._tag === "Line" && entry.direction === "inbound")
      );

      assert.lengthOf(inbound, 1);
      assert.lengthOf(inbound[0] ?? [], 2);
      assert.deepStrictEqual((yield* wire(ircd)).slice(-2), ["PONG 1\r\n", "PONG 2\r\n"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("commits a read that completes no frame with no `record`", () => {
    let records = 0;

    const layer = probed({
      before: () => {
        records += 1;
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);

      const before = records;

      yield* ircd.read("PING :no line ending yet");
      yield* manyTurns;

      assert.strictEqual(records, before);
    }).pipe(Effect.provide(layer));
  });
});

describe("hostNetwork deadlines", () => {
  it.effect("fires registration at exactly 60 seconds, as a Deadline Entry and then a close", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* TestClock.adjust("59999 millis");
      yield* manyTurns;

      assert.lengthOf(deadlinesNamed(yield* entries, "registration"), 0);
      assert.strictEqual((yield* hosted.status).phase, "registering");

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;
      const fired = log.find(({ _tag }) => _tag === "Deadline");
      const [closed] = connectionsOf(log, "closed");

      assert.deepStrictEqual(fired, {
        _tag: "Deadline",
        at: 60_000,
        name: "registration",
        network: "libera",
        sequence: fired?.sequence ?? 0,
      });
      assert.strictEqual(closed?.reason, "registration timed out");
      assert.isTrue((fired?.sequence ?? Infinity) < (closed?.sequence ?? 0));
      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "registration timed out",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("does not fire once `001` has arrived", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* TestClock.adjust("80 seconds");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.lengthOf(deadlinesNamed(yield* entries, "registration"), 0);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("fires at once for a deadline that passed while the host was busy", () => {
    const layer = probed({
      // The clock moves past the deadline while the loop is busy committing this.
      duringRecord: (recording) =>
        recording.some(isLineWith("NOTICE * :slow")) ? TestClock.adjust("61 seconds") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd);
      yield* ircd.read("NOTICE * :slow\r\n");
      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;
      const fired = log.find(({ _tag }) => _tag === "Deadline");

      assert.strictEqual(fired?.at, 61_000);
      assert.lengthOf(connectionsOf(log, "closed"), 1);
    }).pipe(Effect.provide(layer));
  });
});

// Big enough that only a few fit under the bound on what is read and not yet recorded.
const floodLine = `flood ${"x".repeat(8000)}\r\n`;
const slowLine = `slow ${"x".repeat(8000)}\r\n`;

const startsWith = (text: string) => (entry: NewEntry) =>
  entry._tag === "Line" && decode(entry.bytes).startsWith(text);

const isFlood = startsWith("flood ");
const isSlow = startsWith("slow ");

describe("hostNetwork under a flood while registering", () => {
  it.effect("fires the deadline though reads never stop, and ends in bounded time", () => {
    const layer = probed({
      // Each read costs a second, so the inbox never empties, as a real flood would.
      duringRecord: (recording) =>
        recording.some(isFlood) ? TestClock.adjust("1 second") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd);
      yield* Effect.forEach(Array.from({ length: 200 }), () => ircd.read(floodLine), {
        discard: true,
      });
      yield* manyTurns;

      const log = yield* entries;
      const fired = log.find(({ _tag }) => _tag === "Deadline");
      const [closed] = connectionsOf(log, "closed");

      // Only the reads already held, each of which was in time, can go ahead of it, and
      // what is held is bounded in bytes (LOG-4).
      assert.isAtMost(fired?.at ?? Infinity, 80_000);
      assert.strictEqual(closed?.reason, "registration timed out");
      assert.isAtMost(closed?.at ?? Infinity, (fired?.at ?? 0) + 6000);
      assert.isAbove(yield* ircd.unread, 0);
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets a `001` read in time beat the deadline, though it is taken after it", () => {
    const layer = probed({
      // The clock passes the deadline while the read ahead of the `001` commits.
      duringRecord: (recording) =>
        recording.some(isLineWith("NOTICE * :slow")) ? TestClock.adjust("2 seconds") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* TestClock.adjust("59 seconds");
      yield* manyTurns;

      yield* ircd.read("NOTICE * :slow\r\n");
      yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
      yield* manyTurns;

      assert.lengthOf(deadlinesNamed(yield* entries, "registration"), 0);
      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(Effect.provide(layer));
  });
});

describe("hostNetwork as a fold", () => {
  it.effect("ends with the status a fold over everything recorded gives", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("PING :1\r\n:a!b@c PRIVMSG #one :hello\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(brief(yield* hosted.status), statusFolded(yield* entries));

      yield* ircd.read("ERROR :Closing Link\r\n");
      yield* ircd.hangUp;
      yield* manyTurns;

      const status = brief(yield* hosted.status);

      assert.deepStrictEqual(status, { closeReason: "Closing Link", phase: "closed" });
      assert.deepStrictEqual(status, statusFolded(yield* entries));
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("starts a new `attempt` after a run that crashed in a Session", () =>
    Effect.gen(function* () {
      const { record } = yield* Recorder;
      const connection = { connection: 1, ircd: address, network: "libera" };

      yield* record(
        [
          {
            _tag: "Connection",
            ircd: address,
            network: "libera",
            nicks: ["iirc"],
            ...attemptInput,
            phase: "attempt",
          },
          { ...connection, _tag: "Connection", phase: "opened" },
          {
            _tag: "Line",
            bytes: encode(":ircd 001 iirc :Welcome"),
            connection: 1,
            direction: "inbound",
            network: "libera",
          },
        ],
        () => {}
      );

      const earlier = yield* entries;
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      // A killed Connection is a failure like any other, so it waits its delay (LIVE-4).
      assert.lengthOf(connectionsOf(yield* entries, "attempt"), 1);
      assert.strictEqual((yield* hosted.status).consecutiveFailures, 0);

      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      const log = yield* entries;
      const attempts = connectionsOf(log, "attempt");

      assert.lengthOf(attempts, 2);
      assert.strictEqual(attempts[1]?.sequence, earlier.length + 1);
      assert.strictEqual((yield* hosted.status).phase, "registering");
      assert.deepStrictEqual(yield* wire(ircd), ["NICK iirc\r\n", "USER user 0 * :I IRC\r\n"]);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );
});

describe("hostNetwork closing", () => {
  it.effect("records one `closed`, with the first reason, when two closes arrive at once", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("ERROR :first\r\nERROR :second\r\n");
      yield* ircd.hangUp;
      yield* manyTurns;

      const closed = connectionsOf(yield* entries, "closed");

      assert.lengthOf(closed, 1);
      assert.strictEqual(closed[0]?.reason, "first");
      assert.strictEqual((yield* hosted.status).closeReason, "first");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("writes nothing after a close in the same read", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);

      const before = (yield* wire(ircd)).length;

      yield* ircd.read("ERROR :gone\r\nPING :1\r\n");
      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;

      assert.strictEqual((yield* wire(ircd)).length, before);
      assert.notInclude(texts(log, "outbound"), "PONG 1");
      assert.strictEqual(log.at(-1)?._tag, "Connection");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records one `closed` when a read end races a failed write from `send`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("fail");

      yield* Effect.all(
        [ircd.hangUp, Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test"))],
        { concurrency: "unbounded" }
      );
      yield* manyTurns;

      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
      assert.strictEqual((yield* hosted.status).phase, "closed");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records one `closed` when a read end races a failed Command", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("fail");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;

      const closed = connectionsOf(yield* entries, "closed");

      assert.lengthOf(closed, 1);
      assert.strictEqual(closed[0]?.reason, "write failed: broken pipe");
      assert.strictEqual((yield* hosted.status).closeReason, closed[0]?.reason);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes on a read end, on a read error, and releases the socket", () =>
    Effect.gen(function* () {
      const ended = yield* fakeIrcd();
      const endedHost = yield* inSession(ended);

      yield* ended.hangUp;
      yield* manyTurns;

      assert.deepStrictEqual(brief(yield* endedHost.status), {
        closeReason: "the Ircd closed the Connection",
        phase: "closed",
      });
      assert.isTrue(yield* ended.released);

      const broken = yield* fakeIrcd();
      const brokenHost = yield* host(broken, { id: "another" });

      yield* broken.read(":ircd 001 iirc :Welcome\r\n");
      yield* manyTurns;

      yield* broken.breakRead;
      yield* manyTurns;

      assert.deepStrictEqual(brief(yield* brokenHost.status), {
        closeReason: "read failed: reset",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("gives up on a write that never finishes at exactly 10 seconds (CONN-1)", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("hang");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;
      yield* TestClock.adjust("9999 millis");
      yield* manyTurns;

      // The loop never waits on a write, so it is still reading.
      yield* ircd.read("NOTICE * :read while stalled\r\n");
      yield* manyTurns;

      assert.include(texts(yield* entries, "inbound"), "NOTICE * :read while stalled");
      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closing");

      yield* ircd.hangUp;
      yield* manyTurns;

      const [closed] = connectionsOf(yield* entries, "closed");

      assert.strictEqual(closed?.reason, "write timed out");
      assert.strictEqual(closed?.at, 10_000);
      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "write timed out",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("takes the write limit from Tuning (CONN-1)", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* host(ircd, {
        tuning: { ...defaultTuning, writeTimeoutMillis: 3000 },
      });

      yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
      yield* manyTurns;
      yield* ircd.setWrites("hang");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;
      yield* TestClock.adjust("2999 millis");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closing");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes after `send` has a write fail, and tells the caller", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("fail");

      const exit = yield* Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test"));

      yield* manyTurns;

      assert.deepStrictEqual(
        exit,
        Exit.fail(new WriteFailed({ reason: "write failed: broken pipe" }))
      );

      yield* ircd.hangUp;
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "closed");
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records `attempt` then `closed` when connecting fails", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const hosted = yield* host(ircd);
      const log = yield* entries;

      assert.deepStrictEqual(
        log.map((entry) => (entry._tag === "Connection" ? entry.phase : entry._tag)),
        ["attempt", "closed"]
      );
      assert.strictEqual(connectionsOf(log, "closed")[0]?.connection, 1);
      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "refused",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records a socket that connected but cannot be read as a failed attempt", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ unreadable: true });
      const hosted = yield* host(ircd);

      assert.deepStrictEqual(
        (yield* entries).map((entry) => (entry._tag === "Connection" ? entry.phase : entry._tag)),
        ["attempt", "closed"]
      );
      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "could not read: 1006",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records a Line that cannot be built as Dropped, and stays connected", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* host(ircd, {
        identity: { ...options.identity, realname: "bad\r\nQUIT" },
      });

      assert.deepStrictEqual(yield* wire(ircd), ["NICK iirc\r\n"]);
      assert.strictEqual((yield* hosted.status).phase, "registering");

      const [dropped] = droppedIn(yield* entries);

      assert.strictEqual(dropped?.cause, "registration");
      assert.strictEqual(dropped?.reason, "InvalidParameter");
      assert.include(decode(dropped?.bytes ?? new Uint8Array()), "USER user 0 *");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("releases the socket when the Scope closes", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* Effect.scoped(inSession(ircd));

      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("stops reporting a Session once the Scope has closed", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* Effect.scoped(inSession(ircd));

      yield* manyTurns;

      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "leaving",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );
});

describe("hostNetwork draining a close", () => {
  // Every cause of a close that is not a write failing, each from a live Connection.
  const causes = [
    {
      name: "an `ERROR` Line",
      provoke: (ircd: FakeIrcd) => ircd.read("ERROR :Closing Link\r\n"),
      reason: "Closing Link",
      setup: inSession,
    },
    {
      name: "the registration deadline",
      provoke: () => TestClock.adjust("60 seconds"),
      reason: "registration timed out",
      setup: host,
    },
    {
      name: "an `ERROR` while registering",
      provoke: (ircd: FakeIrcd) => ircd.read("ERROR :You are banned\r\n"),
      reason: "You are banned",
      setup: host,
    },
    {
      name: "a machine that threw",
      provoke: (ircd: FakeIrcd) => ircd.read(":ircd 001 iirc :Welcome\r\n"),
      reason: "the machine threw on Entry",
      setup: (ircd: FakeIrcd) => host(ircd, { tuning: throwing }),
    },
  ];

  for (const { name, provoke, reason, setup } of causes) {
    it.effect(`records all the Ircd sends after ${name}, and acts on none of it`, () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const hosted = yield* setup(ircd);

        yield* provoke(ircd);
        yield* manyTurns;

        const before = (yield* wire(ircd)).length;

        assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);
        assert.deepStrictEqual(
          yield* Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test")),
          Exit.fail(new NotInSession({ phase: "closing" }))
        );

        yield* ircd.read("PING :after\r\n", ":a!b@c PRIVMSG #one :after\r\n");
        yield* manyTurns;
        yield* TestClock.adjust("4999 millis");
        yield* manyTurns;

        assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);

        yield* ircd.read("half a li");
        yield* ircd.hangUp;
        yield* manyTurns;

        const log = yield* entries;
        const [closed] = connectionsOf(log, "closed");

        assert.includeMembers(texts(log, "inbound"), [
          "PING :after",
          ":a!b@c PRIVMSG #one :after",
          "half a li",
        ]);
        assert.notInclude(texts(log, "outbound"), "PONG after");
        assert.lengthOf(yield* wire(ircd), before);
        assert.include(closed?.reason, reason);
        assert.strictEqual(log.at(-1), closed);
        assert.deepStrictEqual(brief(yield* hosted.status), statusFolded(log));
        assert.isTrue(yield* ircd.released);
      }).pipe(Effect.provide(Recorder.memoryReadable))
    );

    it.effect(`closes 5 seconds after ${name}, when the Ircd does not hang up`, () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();

        yield* setup(ircd);
        yield* provoke(ircd);
        yield* manyTurns;

        const provoked = yield* Clock.currentTimeMillis;

        yield* TestClock.adjust("4999 millis");
        yield* manyTurns;

        assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);
        assert.isFalse(yield* ircd.released);

        yield* TestClock.adjust("1 millis");
        yield* manyTurns;

        const [closed] = connectionsOf(yield* entries, "closed");

        assert.include(closed?.reason, reason);
        assert.strictEqual(closed?.at, provoked + 5000);
        assert.isTrue(yield* ircd.released);
      }).pipe(Effect.provide(Recorder.memoryReadable))
    );
  }

  it.effect("does not let a flood after a close hold the Connection open past the limit", () => {
    const layer = probed({
      duringRecord: (recording) =>
        recording.some(isLineWith("flood")) ? TestClock.adjust("1 second") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);
      yield* ircd.read("ERROR :Closing Link\r\n");
      yield* manyTurns;
      yield* Effect.forEach(Array.from({ length: 100 }), () => ircd.read("flood\r\n"), {
        discard: true,
      });
      yield* manyTurns;

      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
      assert.isTrue(yield* ircd.released);
      assert.isAbove(yield* ircd.unread, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("closes at once when the Log goes during a drain, with the first reason", () => {
    const layer = probed({
      failsAfterWithin: once((recording) => recording.some(isLineWith("NOTICE * :unrecordable"))),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("ERROR :Closing Link\r\n");
      yield* manyTurns;
      yield* ircd.read("NOTICE * :unrecordable\r\n");
      yield* manyTurns;

      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
      assert.strictEqual((yield* hosted.status).closeReason, "Closing Link");
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(layer));
  });
});

describe("hostNetwork after a failed write", () => {
  it.effect("records every read that follows, acts on none, and takes the Ircd's words", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("fail");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      // Writes work again, so only the host's own decision can keep these off the wire.
      yield* ircd.setWrites("accept");

      const before = (yield* wire(ircd)).length;

      yield* ircd.read("PING :2\r\n:a!b@c PRIVMSG #one :after\r\nERROR :a later reason\r\n");
      yield* manyTurns;

      assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);

      yield* ircd.read("half a li");
      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;

      assert.includeMembers(texts(log, "inbound"), [
        "PING :2",
        ":a!b@c PRIVMSG #one :after",
        "ERROR :a later reason",
        "half a li",
      ]);
      assert.notInclude(texts(log, "outbound"), "PONG 2");
      assert.lengthOf(yield* wire(ircd), before);
      // The host's reason stood until the Ircd said why, in words of its own (LIVE-5).
      assert.strictEqual(connectionsOf(log, "closed")[0]?.reason, "a later reason");
      assert.strictEqual(log.at(-1)?._tag, "Connection");
      assert.deepStrictEqual(brief(yield* hosted.status), statusFolded(log));
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("refuses a `send` at once, and status stops claiming a Session", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const line = safe("PRIVMSG", ["#one", "hi"]);

      yield* ircd.setWrites("fail");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      // The Log heard nothing of this, so only the fold still reads as a Session.
      assert.strictEqual(statusFolded(yield* entries).phase, "session");
      assert.strictEqual((yield* hosted.status).phase, "closing");
      assert.deepStrictEqual(
        yield* Effect.exit(hosted.send(line, "test")),
        Exit.fail(new NotInSession({ phase: "closing" }))
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes at the limit when the read side never ends", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("fail");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;
      yield* TestClock.adjust("4999 millis");
      yield* manyTurns;

      assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      const [closed] = connectionsOf(yield* entries, "closed");

      assert.strictEqual(closed?.reason, "write failed: broken pipe");
      assert.strictEqual(closed?.at, 5000);
      assert.deepStrictEqual(brief(yield* hosted.status), statusFolded(yield* entries));
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("does not let a flood hold a dead Connection open past the limit", () => {
    const layer = probed({
      // Each read takes a second to record, so the limit passes with reads still queued.
      duringRecord: (recording) =>
        recording.some(isLineWith("flood")) ? TestClock.adjust("1 second") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);
      yield* ircd.setWrites("fail");
      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      yield* Effect.forEach(Array.from({ length: 100 }), () => ircd.read("flood\r\n"), {
        discard: true,
      });
      yield* manyTurns;

      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
      assert.isTrue(yield* ircd.released);
      assert.isAbove(yield* ircd.unread, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("wakes a loop parked on a quiet Connection when `send` is what failed", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("fail");
      yield* Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test"));
      yield* manyTurns;
      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      const [closed] = connectionsOf(yield* entries, "closed");

      assert.strictEqual(closed?.reason, "write failed: broken pipe");
      assert.strictEqual(closed?.at, 5000);
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes at once when a write fails because the Log did", () => {
    const layer = probed({
      failsAfterWithin: (recording) => recording.some(isLineWith("PRIVMSG #one hi")),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test"));
      yield* manyTurns;

      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(layer));
  });
});

describe("hostNetwork under a flood", () => {
  it.effect("leaves reads in the kernel while it cannot keep up", () => {
    const layer = probed({
      duringRecord: (recording) =>
        recording.some(isSlow) ? Effect.sleep("1 second") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const flood = 100;

      yield* Effect.forEach(Array.from({ length: flood }), () => ircd.read(slowLine), {
        discard: true,
      });
      yield* manyTurns;

      // One in the commit, what fits under the bound on what is read and not recorded, and
      // one in the reader's hand. Nothing else (LOG-4).
      assert.isAbove(yield* ircd.unread, flood - 20);
      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* TestClock.adjust(`${flood} seconds`);
      yield* manyTurns;

      assert.strictEqual(yield* ircd.unread, 0);
      assert.lengthOf(
        texts(yield* entries, "inbound").filter((text) => text.startsWith("slow")),
        flood
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("hostNetwork `send`", () => {
  it.effect("records a Line with its cause, then writes it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      const sent = yield* hosted.send(safe("PRIVMSG", ["#one", "hello there"]), "key:frontend");
      const [line] = linesOf(yield* entries).slice(-1);

      assert.deepStrictEqual(sent, { _tag: "Written", sequence: line?.sequence ?? 0 });
      assert.strictEqual(line?.cause, "key:frontend");
      assert.strictEqual(decode(line?.bytes ?? new Uint8Array()), "PRIVMSG #one :hello there");
      assert.strictEqual((yield* wire(ircd)).at(-1), "PRIVMSG #one :hello there\r\n");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("keeps Log order equal to wire order across concurrent `send`s and Commands", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* host(ircd, {
        tuning: { ...defaultTuning, floodBurst: 100 },
      });

      yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
      yield* manyTurns;

      const before = (yield* wire(ircd)).length;

      yield* ircd.setWrites("jitter");

      yield* Effect.all(
        [
          Effect.forEach(
            Array.from({ length: 40 }, (_, index) => index),
            (index) => hosted.send(safe("PRIVMSG", ["#one", `${index}`]), "test"),
            { concurrency: "unbounded" }
          ),
          ircd.read("PING :a\r\nPING :b\r\n"),
        ],
        { concurrency: "unbounded" }
      );
      yield* manyTurns;

      const written = (yield* wire(ircd)).slice(before).map((text) => text.slice(0, -2));
      const recorded = texts(yield* entries, "outbound").slice(before);

      assert.lengthOf(written, 42);
      assert.deepStrictEqual(recorded, written);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("fails outside a Session, naming the Phase, and records nothing", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);
      const line = safe("PRIVMSG", ["#one", "hi"]);
      const before = (yield* entries).length;

      assert.deepStrictEqual(
        yield* Effect.exit(hosted.send(line, "test")),
        Exit.fail(new NotInSession({ phase: "registering" }))
      );
      assert.lengthOf(yield* entries, before);

      yield* ircd.hangUp;
      yield* manyTurns;

      assert.deepStrictEqual(
        yield* Effect.exit(hosted.send(line, "test")),
        Exit.fail(new NotInSession({ phase: "closed" }))
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("fails with `RecordFailed`, writes nothing, and closes", () => {
    const layer = probed({
      failsAfterWithin: (recording) => recording.some(isLineWith("PRIVMSG #one hi")),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const before = yield* wire(ircd);

      const exit = yield* Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test"));

      yield* manyTurns;

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* wire(ircd), before);
      assert.strictEqual((yield* hosted.status).phase, "closed");
      assert.strictEqual(
        Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof RecordFailed,
        true
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a close behind a `send` already recording, so `closed` comes last", () => {
    const layer = probed({
      // Holds `send` between taking the lock and landing its Line.
      duringRecord: (recording) =>
        recording.some(isLineWith("PRIVMSG #one hi")) ? held : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* Effect.all(
        [
          Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test")),
          Effect.andThen(Effect.yieldNow, ircd.hangUp),
        ],
        { concurrency: "unbounded" }
      );
      yield* manyTurns;

      const log = yield* entries;

      assert.lengthOf(connectionsOf(log, "closed"), 1);
      assert.strictEqual(log.at(-1)?._tag, "Connection");
      assert.include(texts(log, "outbound"), "PRIVMSG #one hi");
    }).pipe(Effect.provide(layer));
  });
});

describe("hostNetwork with hostile input", () => {
  it.effect("keeps the Session up through bad bytes, and records them byte-exact", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const before = (yield* entries).length;
      const random = randomBytes(1024, 2026);
      const nuls = new Uint8Array(64);
      const stream = new Uint8Array(random.length + nuls.length + 2);

      stream.set(random);
      stream.set(nuls, random.length);
      stream.set(encode("\r\n"), random.length + nuls.length);

      yield* ircd.read(stream);
      yield* manyTurns;

      const { frames, rest } = framesOf(stream);
      const recorded = linesOf((yield* entries).slice(before));

      assert.lengthOf(rest, 0);
      assert.deepStrictEqual(
        recorded.map(({ bytes }) => [...bytes]),
        frames.map((frame) => [...frame])
      );
      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* ircd.read("PING :still here\r\n");
      yield* manyTurns;

      assert.strictEqual((yield* wire(ircd)).at(-1), "PONG :still here\r\n");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("cuts and marks a line over the limit that ends in the same read", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const before = (yield* entries).length;
      const line = "x".repeat(maxFrameBytes * 2 + 5);

      yield* ircd.read(`${line}\r\nPING :next\r\n`);
      yield* manyTurns;

      const recorded = linesOf((yield* entries).slice(before));

      assert.deepStrictEqual(
        recorded.map(({ cut }) => cut),
        [true, true, true, undefined, undefined]
      );
      assert.deepStrictEqual(
        recorded.map(({ bytes }) => bytes.length),
        [maxFrameBytes, maxFrameBytes, 5, "PING :next".length, "PONG next".length]
      );
      assert.strictEqual(
        recorded
          .slice(0, 3)
          .map(({ bytes }) => decode(bytes))
          .join(""),
        line
      );
      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("marks every piece of a line over the limit that spans reads", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);

      const before = (yield* entries).length;

      yield* ircd.read("y".repeat(maxFrameBytes + 3));
      yield* ircd.read("tail\r\n");
      yield* ircd.read("whole\r\n");
      yield* manyTurns;

      const recorded = linesOf((yield* entries).slice(before));

      assert.deepStrictEqual(
        recorded.map(({ bytes, cut }) => [bytes.length, cut]),
        [
          [maxFrameBytes, true],
          [7, true],
          [5, undefined],
        ]
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("leaves a line of exactly the limit alone", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);

      const before = (yield* entries).length;

      yield* ircd.read(`${"z".repeat(maxFrameBytes)}\r\n`);
      yield* manyTurns;

      const recorded = linesOf((yield* entries).slice(before));

      assert.deepStrictEqual(
        recorded.map(({ bytes, cut }) => [bytes.length, cut]),
        [[maxFrameBytes, undefined]]
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("leaves a line of exactly the limit alone when its line ending is split", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);

      const before = (yield* entries).length;

      yield* ircd.read(`${"z".repeat(maxFrameBytes)}\r`);
      yield* ircd.read("\n");
      yield* manyTurns;

      const recorded = linesOf((yield* entries).slice(before));

      assert.deepStrictEqual(
        recorded.map(({ bytes, cut }) => [bytes.length, cut]),
        [[maxFrameBytes, undefined]]
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("does not obey the tail of a cut line, even one that reads as `ERROR`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read(`${"x".repeat(maxFrameBytes)}ERROR :gotcha\r\n`);
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("keeps a Session up through a `PING` whose `PONG` could not be built", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const before = (yield* wire(ircd)).length;

      yield* ircd.read(`PING :${"p".repeat(600)}\r\n`);
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.lengthOf(yield* wire(ircd), before);

      const [dropped] = droppedIn(yield* entries);

      assert.strictEqual(dropped?.cause, "ping-reply");
      assert.strictEqual(dropped?.reason, "TooLong");
      assert.strictEqual(decode(dropped?.bytes ?? new Uint8Array()), `PONG ${"p".repeat(600)}`);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records a partial frame at close as a final `cut` Line, before `closed`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);
      yield* ircd.read("PING :1\r\nPRIVMSG #one :half a li");
      yield* manyTurns;

      const before = (yield* wire(ircd)).length;

      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;
      const [partial] = linesOf(log).slice(-1);

      assert.strictEqual(decode(partial?.bytes ?? new Uint8Array()), "PRIVMSG #one :half a li");
      assert.isTrue(partial?.cut);
      assert.strictEqual(partial?.direction, "inbound");
      assert.strictEqual(log.at(-2)?.sequence, partial?.sequence);
      assert.strictEqual(log.at(-1)?._tag, "Connection");
      assert.lengthOf(yield* wire(ircd), before);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records a partial frame however the Connection ended", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("half a li");
      yield* ircd.setWrites("fail");
      yield* Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test"));
      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      const [partial] = linesOf(yield* entries).slice(-1);

      assert.strictEqual(decode(partial?.bytes ?? new Uint8Array()), "half a li");
      assert.isTrue(partial?.cut);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records what was read before a close, though it is no longer acted on", () => {
    const layer = probed({
      // Holds the loop in the commit, so that the next read reaches the inbox first.
      duringRecord: (recording) => (recording.some(isLineWith("ERROR :gone")) ? held : Effect.void),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);

      const before = (yield* wire(ircd)).length;

      yield* ircd.read("ERROR :gone\r\n");
      yield* ircd.read("PING :1\r\n", "half a li");
      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;

      assert.includeMembers(texts(log, "inbound"), ["PING :1", "half a li"]);
      assert.strictEqual(log.at(-1)?._tag, "Connection");
      assert.lengthOf(connectionsOf(log, "closed"), 1);
      assert.lengthOf(yield* wire(ircd), before);
    }).pipe(Effect.provide(layer));
  });

  it.effect("handles a pull with an empty chunk and a line of nothing", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const before = (yield* entries).length;

      yield* ircd.read(new Uint8Array(), "\r\n\n");
      yield* manyTurns;

      assert.deepStrictEqual(texts((yield* entries).slice(before), "inbound"), ["", ""]);
      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );
});

describe("hostNetwork when something inside it fails", () => {
  it.effect("commits the Entries of a throwing transition and closes with a reason", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { tuning: throwing });

      yield* ircd.read("NOTICE * :before\r\n:ircd 001 iirc :Welcome\r\nNOTICE * :after\r\n");
      yield* ircd.hangUp;
      yield* manyTurns;

      const log = yield* entries;
      const [closed] = connectionsOf(log, "closed");
      const welcome = linesOf(log).find(({ bytes }) => decode(bytes).includes(" 001 "));

      assert.deepStrictEqual(texts(log, "inbound"), [
        "NOTICE * :before",
        ":ircd 001 iirc :Welcome",
        "NOTICE * :after",
      ]);
      // What was thrown is kept, so the Log says why (HOST-1).
      assert.strictEqual(
        closed?.reason,
        `the machine threw on Entry ${welcome?.sequence}: Error: the transition threw`
      );
      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: closed?.reason,
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes when the reader dies", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.dieOnRead;
      yield* manyTurns;

      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "the reader died: the reader broke",
        phase: "closed",
      });
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records a close, and tries again, when the Recorder dies once", () => {
    const layer = probed({
      duringRecord: (recording) =>
        recording.some(isLineWith("PING :1")) ? Effect.die("the store broke") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("PING :1\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "the host failed: the store broke",
        phase: "closed",
      });
      assert.isTrue(yield* ircd.released);

      yield* TestClock.adjust("5 seconds");
      yield* manyTurns;

      assert.lengthOf(yield* ircd.dials, 2);
      assert.strictEqual((yield* hosted.status).phase, "registering");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays honest and stops when the `closed` Entry cannot be recorded", () => {
    let closes = 0;

    const layer = probed({
      failsAfterWithin: (recording) => {
        const closing = recording.some(isClosed);

        closes += closing ? 1 : 0;

        return closing;
      },
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.hangUp;
      yield* manyTurns;

      assert.strictEqual(closes, 1);
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);
      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason:
          "the Ircd closed the Connection, and the Log could not record this Connection's close",
        phase: "closed",
      });
      assert.isDefined((yield* hosted.status).logFault);
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a Log that refuses even the `attempt`", () => {
    const layer = probed({ failsAfterWithin: () => true });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      assert.deepStrictEqual(brief(yield* hosted.status), {
        closeReason: "the Log could not record this Connection",
        phase: "closed",
      });
      assert.lengthOf(yield* entries, 0);
      assert.lengthOf(yield* ircd.dials, 0);
    }).pipe(Effect.provide(layer));
  });
});
