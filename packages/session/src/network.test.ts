import { assert, describe, it } from "@effect/vitest";
import { closeReason, fold, phase } from "@iirc/lifecycle";
import type { NetworkInput } from "@iirc/lifecycle";
import { maxFrameBytes } from "@iirc/protocol/frame";
import { outbound } from "@iirc/protocol/outbound";
import { Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";

import type { Entry, Ircd, NewEntry } from "./entry.ts";
import { toEvent } from "./events.ts";
import { hostNetwork, NotInSession } from "./network.ts";
import type { NetworkOptions } from "./network.ts";
import { MemoryEntries, Recorder, RecordFailed } from "./recorder.ts";
import { fakeIrcd } from "./testing.ts";
import type { FakeIrcd } from "./testing.ts";
import { Transport } from "./transport.ts";

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

type ConnectionEntry = Extract<Entry, { readonly _tag: "Connection" }>;

const address: Ircd = { host: "irc.test", port: 6697, tls: true };

const input: NetworkInput = {
  channels: ["#one", "#two"],
  nick: "iirc",
  realname: "I IRC",
  username: "user",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (text: string) => encoder.encode(text);
const decode = (bytes: Uint8Array) => decoder.decode(bytes);

const entries = MemoryEntries.use(({ entries }) => entries);

const linesOf = (log: readonly Entry[]) =>
  log.filter((entry): entry is LineEntry => entry._tag === "Line");

const connectionsOf = (log: readonly Entry[], phase: ConnectionEntry["phase"]) =>
  log.filter(
    (entry): entry is ConnectionEntry => entry._tag === "Connection" && entry.phase === phase
  );

const texts = (log: readonly Entry[], direction: LineEntry["direction"]) =>
  linesOf(log)
    .filter((line) => line.direction === direction)
    .map(({ bytes }) => decode(bytes));

const wire = (ircd: FakeIrcd) =>
  ircd.written.pipe(Effect.map((written) => written.map((bytes) => decode(bytes))));

// Every fake socket and the memory Recorder finish within a few scheduler turns, so
// this runs the host until it has nothing left to do without moving the clock.
const settled = Effect.repeat(Effect.yieldNow, { times: 200 });
const held = Effect.repeat(Effect.yieldNow, { times: 20 });

const safe = (command: string, params: readonly string[]) => {
  const built = outbound(command, params);

  if (built._tag === "Rejected") {
    throw new Error(built.reason);
  }

  return built.line;
};

const host = (ircd: FakeIrcd, options?: Partial<Pick<NetworkOptions, "history" | "input">>) =>
  hostNetwork({ history: [], id: "libera", input, ircd: address, ...options }).pipe(
    Effect.provideService(Transport, ircd.transport),
    Effect.tap(() => settled)
  );

const inSession = Effect.fnUntraced(function* (ircd: FakeIrcd) {
  const hosted = yield* host(ircd);

  yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
  yield* settled;

  return hosted;
});

// Wraps the shared store, so a test can watch or break what `record` does. `within`
// runs and only then does the wrapper fail, because that is what a failed COMMIT does.
interface RecorderProbe {
  readonly after?: () => void;
  readonly afterWithin?: () => void;
  /** Runs between `within` and a COMMIT that `failsAfterWithin` is about to fail. */
  readonly beforeFailing?: Effect.Effect<void>;
  readonly before?: (entries: readonly NewEntry[]) => void;
  readonly failsAfterWithin?: (entries: readonly NewEntry[]) => boolean;
  readonly duringRecord?: (entries: readonly NewEntry[]) => Effect.Effect<void>;
}

const probed = (probe: RecorderProbe) =>
  Layer.effect(
    Recorder,
    Recorder.pipe(
      Effect.map((recorder) =>
        Recorder.of({
          record: (entries, within) =>
            Effect.gen(function* () {
              probe.before?.(entries);
              yield* probe.duringRecord?.(entries) ?? Effect.void;

              if (probe.failsAfterWithin?.(entries) === true) {
                within(
                  entries.map((entry, index): Entry => ({ ...entry, at: 0, sequence: index }))
                );

                yield* probe.beforeFailing ?? Effect.void;

                return yield* new RecordFailed({ cause: "commit failed" });
              }

              const result = yield* recorder.record(entries, (recorded) => {
                const stepped = within(recorded);

                probe.afterWithin?.();

                return stepped;
              });

              probe.after?.();

              return result;
            }),
        })
      )
    )
  ).pipe(Layer.provideMerge(Recorder.memoryReadable));

const isClosed = (entry: NewEntry) => entry._tag === "Connection" && entry.phase === "closed";

const isLineWith = (text: string) => (entry: NewEntry) =>
  entry._tag === "Line" && decode(entry.bytes) === text;

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

const statusFolded = (log: readonly Entry[]) => {
  const snapshot = fold(
    log.flatMap((entry) => toEvent(entry) ?? []),
    input
  );

  return { closeReason: closeReason(snapshot), phase: phase(snapshot) };
};

describe("hostNetwork registering", () => {
  it.effect("sends `NICK` and `USER`, reaches a Session on `001`, and joins in order", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      assert.deepStrictEqual(yield* wire(ircd), ["NICK iirc\r\n", "USER user 0 * :I IRC\r\n"]);
      assert.strictEqual((yield* hosted.status).phase, "registering");

      yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
      yield* settled;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.deepStrictEqual((yield* wire(ircd)).slice(2), ["JOIN #one\r\n", "JOIN #two\r\n"]);

      const outboundLines = linesOf(yield* entries).filter(
        ({ direction }) => direction === "outbound"
      );

      assert.deepStrictEqual(
        outboundLines.map(({ cause }) => cause),
        ["registration", "registration", "autojoin", "autojoin"]
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
      assert.strictEqual(attempt?.connection, undefined);
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
      yield* TestClock.adjust("1 hour");

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
      yield* settled;

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
      yield* settled;

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
      yield* settled;

      // The `PING`'s commit, then the `PONG`'s, then the `PONG` on the wire.
      assert.deepStrictEqual(events, ["within", "committed", "within", "committed", "written"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes nothing for a Line whose commit failed, though `within` ran", () => {
    const layer = probed({
      failsAfterWithin: (recording) => recording.some(isLineWith("PING :1")),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const before = yield* wire(ircd);

      yield* ircd.read("PING :1\r\n");
      yield* settled;

      assert.deepStrictEqual(yield* wire(ircd), before);
      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "the Log could not record this Connection",
        phase: "closed",
      });
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(layer));
  });

  it.effect("publishes nothing from a commit that has not landed", () => {
    const layer = probed({
      beforeFailing: Effect.sleep("1 second"),
      failsAfterWithin: (recording) => recording.some(isLineWith(":ircd 001 iirc :Welcome")),
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
      yield* settled;

      assert.strictEqual((yield* hosted.status).phase, "registering");

      yield* TestClock.adjust("1 second");
      yield* settled;

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
      yield* settled;

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
      yield* settled;

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
      yield* settled;

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
      yield* settled;

      assert.lengthOf(
        (yield* entries).filter(({ _tag }) => _tag === "Deadline"),
        0
      );
      assert.strictEqual((yield* hosted.status).phase, "registering");

      yield* TestClock.adjust("1 millis");
      yield* settled;

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
      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "registration timed out",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("does not fire once `001` has arrived", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* TestClock.adjust("1 hour");
      yield* settled;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.lengthOf(
        (yield* entries).filter(({ _tag }) => _tag === "Deadline"),
        0
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("fires at once for a deadline that passed while the host was busy", () => {
    const layer = probed({
      // The clock moves past the deadline during the `NICK` that follows OPENED.
      duringRecord: (recording) =>
        recording.some(isLineWith("NICK iirc")) ? TestClock.adjust("61 seconds") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd);

      const log = yield* entries;
      const fired = log.find(({ _tag }) => _tag === "Deadline");

      assert.strictEqual(fired?.at, 61_000);
      assert.lengthOf(connectionsOf(log, "closed"), 1);
    }).pipe(Effect.provide(layer));
  });
});

describe("hostNetwork as a fold", () => {
  it.effect("ends with the status a fold over everything recorded gives", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("PING :1\r\n:a!b@c PRIVMSG #one :hello\r\n");
      yield* settled;

      assert.deepStrictEqual(yield* hosted.status, statusFolded(yield* entries));

      yield* ircd.read("ERROR :Closing Link\r\n");
      yield* settled;

      const status = yield* hosted.status;

      assert.deepStrictEqual(status, { closeReason: "Closing Link", phase: "closed" });
      assert.deepStrictEqual(status, statusFolded(yield* entries));
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("resumes a run that crashed in a Session with a new `attempt`", () =>
    Effect.gen(function* () {
      const crashed = yield* fakeIrcd();

      yield* Effect.scoped(inSession(crashed));

      const history = yield* entries;
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { history });
      const log = yield* entries;
      const attempts = connectionsOf(log, "attempt");

      assert.lengthOf(attempts, 2);
      assert.strictEqual(attempts[1]?.sequence, history.length + 1);
      assert.strictEqual(connectionsOf(log, "opened")[1]?.connection, history.length + 1);
      assert.strictEqual((yield* hosted.status).phase, "registering");
      assert.deepStrictEqual(yield* wire(ircd), ["NICK iirc\r\n", "USER user 0 * :I IRC\r\n"]);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("does not fire a deadline from history at the new Connection", () =>
    Effect.gen(function* () {
      const crashed = yield* fakeIrcd();

      yield* Effect.scoped(host(crashed));

      const history = yield* entries;

      yield* TestClock.adjust("1 hour");

      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { history });

      yield* settled;

      assert.lengthOf(
        (yield* entries).filter(({ _tag }) => _tag === "Deadline"),
        0
      );
      assert.strictEqual((yield* hosted.status).phase, "registering");

      // The new Connection has its own 60 seconds, counted from its own `opened`.
      yield* TestClock.adjust("60 seconds");
      yield* settled;

      const fired = (yield* entries).find(({ _tag }) => _tag === "Deadline");

      assert.strictEqual(fired?.at, 3_660_000);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("starts cleanly from history that ended in a close", () =>
    Effect.gen(function* () {
      const earlier = yield* fakeIrcd();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* inSession(earlier);
          yield* earlier.hangUp;
          yield* settled;
        })
      );

      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { history: yield* entries });

      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: undefined,
        phase: "registering",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );
});

describe("hostNetwork closing", () => {
  it.effect("records one `closed`, with the first reason, when two closes arrive at once", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("ERROR :first\r\nERROR :second\r\n");
      yield* settled;

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
      yield* settled;

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
      yield* settled;

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
      yield* ircd.hangUp;
      yield* settled;

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
      yield* settled;

      assert.deepStrictEqual(yield* endedHost.status, {
        closeReason: "the Ircd closed the Connection",
        phase: "closed",
      });
      assert.isTrue(yield* ended.released);

      const broken = yield* fakeIrcd();
      const brokenHost = yield* inSession(broken);

      yield* broken.breakRead;
      yield* settled;

      assert.deepStrictEqual(yield* brokenHost.status, {
        closeReason: "read failed: reset",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes after a write that never finishes, at exactly 10 seconds", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("hang");
      yield* ircd.read("PING :1\r\n");
      yield* TestClock.adjust("9999 millis");
      yield* settled;

      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* TestClock.adjust("1 millis");
      yield* settled;

      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "write timed out",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes after `send` has a write fail, and tells the caller", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.setWrites("fail");

      const exit = yield* Effect.exit(hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test"));

      yield* settled;

      assert.deepStrictEqual(exit, Exit.fail(new NotInSession({ phase: "closed" })));
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
      assert.deepStrictEqual(yield* hosted.status, { closeReason: "refused", phase: "closed" });
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
      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "could not read: 1006",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes with a reason when a Line cannot be built, without writing it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const hosted = yield* host(ircd, {
        input: { ...input, channels: ["#fine", "#bad\r\nQUIT"] },
      });

      yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
      yield* settled;

      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "could not send a JOIN Line: InvalidParameter",
        phase: "closed",
      });
      assert.notInclude((yield* wire(ircd)).join(""), "QUIT");
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

      yield* settled;

      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "the host stopped",
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );
});

describe("hostNetwork `send`", () => {
  it.effect("records a Line with its cause, then writes it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* hosted.send(safe("PRIVMSG", ["#one", "hello there"]), "key:frontend");

      const [line] = linesOf(yield* entries).slice(-1);

      assert.strictEqual(line?.cause, "key:frontend");
      assert.strictEqual(decode(line?.bytes ?? new Uint8Array()), "PRIVMSG #one :hello there");
      assert.strictEqual((yield* wire(ircd)).at(-1), "PRIVMSG #one :hello there\r\n");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("keeps Log order equal to wire order across concurrent `send`s and Commands", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
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
      yield* settled;

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
      yield* settled;

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

      yield* settled;

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* wire(ircd), before);
      assert.strictEqual((yield* hosted.status).phase, "closed");
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
          hosted.send(safe("PRIVMSG", ["#one", "hi"]), "test"),
          Effect.andThen(Effect.yieldNow, ircd.hangUp),
        ],
        { concurrency: "unbounded" }
      );
      yield* settled;

      const log = yield* entries;

      assert.lengthOf(connectionsOf(log, "closed"), 1);
      assert.strictEqual(log.at(-1)?._tag, "Connection");
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
      yield* settled;

      const { frames, rest } = framesOf(stream);
      const recorded = linesOf((yield* entries).slice(before));

      assert.lengthOf(rest, 0);
      assert.deepStrictEqual(
        recorded.map(({ bytes }) => [...bytes]),
        frames.map((frame) => [...frame])
      );
      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* ircd.read("PING :still here\r\n");
      yield* settled;

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
      yield* settled;

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
      yield* settled;

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
      yield* settled;

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
      yield* settled;

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
      yield* settled;

      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("keeps a Session up through a `PING` whose `PONG` could not be built", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);
      const before = (yield* wire(ircd)).length;

      yield* ircd.read(`PING :${"p".repeat(600)}\r\n`);
      yield* settled;

      assert.strictEqual((yield* hosted.status).phase, "session");
      assert.lengthOf(yield* wire(ircd), before);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("records a partial frame at close as a final `cut` Line, before `closed`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* inSession(ircd);
      yield* ircd.read("PING :1\r\nPRIVMSG #one :half a li");
      yield* settled;

      const before = (yield* wire(ircd)).length;

      yield* ircd.hangUp;
      yield* settled;

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
      yield* settled;

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
      yield* settled;

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
      yield* settled;

      assert.deepStrictEqual(texts((yield* entries).slice(before), "inbound"), ["", ""]);
      assert.strictEqual((yield* hosted.status).phase, "session");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );
});

describe("hostNetwork when something inside it fails", () => {
  // The machine walks `channels` as it enters a Session, so this makes a real
  // transition throw, with no test-only path through the host.
  const throwing: NetworkInput = {
    ...input,
    channels: Object.defineProperty<string[]>([], Symbol.iterator, {
      value: () => {
        throw new Error("the transition threw");
      },
    }),
  };

  it.effect("commits the Entries of a throwing transition and closes with a reason", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { input: throwing });

      yield* ircd.read("NOTICE * :before\r\n:ircd 001 iirc :Welcome\r\nNOTICE * :after\r\n");
      yield* settled;

      const log = yield* entries;
      const [closed] = connectionsOf(log, "closed");
      const welcome = linesOf(log).find(({ bytes }) => decode(bytes).includes(" 001 "));

      assert.deepStrictEqual(texts(log, "inbound"), [
        "NOTICE * :before",
        ":ircd 001 iirc :Welcome",
        "NOTICE * :after",
      ]);
      assert.strictEqual(closed?.reason, `the machine threw on Entry ${welcome?.sequence}`);
      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: closed?.reason,
        phase: "closed",
      });
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("resumes past an Entry that throws, rather than dying on the replay", () =>
    Effect.gen(function* () {
      const earlier = yield* fakeIrcd();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* host(earlier, { input: throwing });
          yield* earlier.read(":ircd 001 iirc :Welcome\r\n");
          yield* settled;
        })
      );

      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd, { history: yield* entries, input: throwing });

      assert.strictEqual((yield* hosted.status).phase, "registering");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("closes when the reader dies", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.dieOnRead;
      yield* settled;

      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "the reader died",
        phase: "closed",
      });
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 1);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("stops and says so when the Recorder itself dies", () => {
    const layer = probed({
      duringRecord: (recording) =>
        recording.some(isLineWith("PING :1")) ? Effect.die("the store broke") : Effect.void,
    });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* inSession(ircd);

      yield* ircd.read("PING :1\r\n");
      yield* settled;

      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "the host stopped",
        phase: "closed",
      });
      assert.isTrue(yield* ircd.released);
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
      yield* settled;
      yield* TestClock.adjust("1 hour");
      yield* settled;

      assert.strictEqual(closes, 1);
      assert.lengthOf(connectionsOf(yield* entries, "closed"), 0);
      assert.deepStrictEqual(yield* hosted.status, {
        closeReason:
          "the Ircd closed the Connection, and the Log could not record this Connection's close",
        phase: "closed",
      });
      assert.isTrue(yield* ircd.released);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a Log that refuses even the `attempt`", () => {
    const layer = probed({ failsAfterWithin: () => true });

    return Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* host(ircd);

      assert.deepStrictEqual(yield* hosted.status, {
        closeReason: "the Log could not record this Connection",
        phase: "closed",
      });
      assert.lengthOf(yield* entries, 0);
    }).pipe(Effect.provide(layer));
  });
});
