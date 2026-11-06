import { readdirSync, statSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import type { Entry, NewEntry } from "@iirc/session/entry";
import { toEvent } from "@iirc/session/events";
import { Recorder, RecordFailed } from "@iirc/session/recorder";
import { connectionView, foldStandings, noStanding, noStandings } from "@iirc/session/standing";
import { attemptInput } from "@iirc/session/testing";
import {
  Array as Arr,
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  pipe,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { openDatabase } from "./database.ts";
import { holdDataDirectory } from "./lock.ts";
import { DataDirectoryLocked, Log } from "./log.ts";
import type { LoggedMessage } from "./log.ts";
import { makeStore } from "./store.ts";

const encoder = new TextEncoder();
const ircd = { host: "irc.example", port: 6697, tls: true };
const childScript = `${import.meta.dirname}/recording-child.ts`;
const diskFullScript = `${import.meta.dirname}/disk-full.fixture.ts`;

const attempt = (network = "libera", nicks: readonly string[] = ["alice", "alice_"]): NewEntry => ({
  _tag: "Connection",
  ircd,
  network,
  nicks,
  ...attemptInput,
  phase: "attempt",
});

const inbound = (text: string, network = "libera"): NewEntry => ({
  _tag: "Line",
  bytes: encoder.encode(text),
  connection: 1,
  direction: "inbound",
  network,
});

const cutInbound = (text: string): NewEntry => ({
  _tag: "Line",
  bytes: encoder.encode(text),
  connection: 1,
  cut: true,
  direction: "inbound",
  network: "libera",
});

const sent = (text: string, cause: string, network = "libera"): NewEntry => ({
  _tag: "Line",
  bytes: encoder.encode(text),
  cause,
  connection: 1,
  direction: "outbound",
  network,
});

const outbound = (text: string, network = "libera") => sent(text, "test", network);

const deadline = (name: string): NewEntry => ({ _tag: "Deadline", name, network: "libera" });

const opened = (connection: number, network = "libera"): NewEntry => ({
  _tag: "Connection",
  connection,
  ircd,
  network,
  phase: "opened",
});

const closing = (
  connection: number,
  reason: string,
  network = "libera",
  chosen = true
): NewEntry => ({
  _tag: "Connection",
  chosen,
  connection,
  ircd,
  network,
  phase: "closing",
  reason,
});

const closed = (connection: number, reason: string, network = "libera"): NewEntry => ({
  _tag: "Connection",
  connection,
  ircd,
  network,
  phase: "closed",
  reason,
});

const refused = (connection: number, reason: string, network = "libera"): NewEntry => ({
  _tag: "Connection",
  connection,
  ircd,
  network,
  phase: "closed",
  reason,
  refused: true,
});

const dropped = (text: string): NewEntry => ({
  _tag: "Dropped",
  bytes: encoder.encode(text),
  cause: "api",
  connection: 1,
  network: "libera",
  reason: "the Connection ended",
});

const daemon = (phase: "started" | "stopped"): NewEntry => ({
  _tag: "Daemon",
  phase,
  version: "0.0.0",
});

const welcome = (nick = "alice", network = "libera") =>
  inbound(`:ircd 001 ${nick} :Welcome`, network);

const everyFifth = (index: number) => index % 5 === 0;

const numbers = (length: number) => Arr.range(1, length);

const record = (entries: Arr.NonEmptyReadonlyArray<NewEntry>) =>
  Recorder.use(({ record }) => record(entries, (recorded) => recorded));

const everything = { after: 0, limit: 100_000 };

const allEntries = Log.use(({ entries }) => entries(everything));
const allMessages = Log.use(({ messages }) => messages(everything));
const allGaps = Log.use(({ gaps }) => gaps(everything));
const standing = (network = "libera") => Recorder.use(({ standing }) => standing(network));
const sequences = allEntries.pipe(Effect.map((entries) => entries.map(({ sequence }) => sequence)));

// Reads a Message down to the fields a fold decides, for comparing with what's expected.
const said = ({ kind, network, sender, target, text }: LoggedMessage) =>
  `${network} ${kind} ${sender} -> ${target}: ${text}`;

const allSaid = allMessages.pipe(Effect.map((messages) => messages.map(said)));

// Who a new outbound Line turns out to be from, which is the only way to see Self.
const currentSelf = (network = "libera") =>
  Effect.gen(function* () {
    const [recorded] = yield* record([outbound("PRIVMSG #probe :who am I?", network)]);
    const messages = yield* allMessages;

    return messages.find(({ sequence }) => sequence === recorded?.sequence)?.sender;
  });

const inTempDirectory = <A, E, R>(test: (dataDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    // Not `/tmp`, because that is tmpfs on fserv, where fsync means nothing.
    return yield* test(
      yield* fileSystem.makeTempDirectoryScoped({ directory: "/var/tmp", prefix: "iirc-log-" })
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const withLog = <A, E>(test: Effect.Effect<A, E, Log | Recorder>) =>
  inTempDirectory((dataDir) => test.pipe(Effect.provide(Log.layer({ dataDir }))));

// Runs a statement on a second connection, as a fault injector or a vandal would.
const execute = (dataDir: string, statement: string) =>
  Effect.gen(function* () {
    const sql = yield* openDatabase(dataDir);

    yield* sql.unsafe(statement);
  }).pipe(Effect.scoped);

// A fixture touching everything the fold cares about, and the Messages it should give.
const mixed: Arr.NonEmptyReadonlyArray<NewEntry> = [
  { _tag: "Daemon", phase: "started", version: "0.0.0" },
  attempt(),
  inbound(":ircd NOTICE * :Looking up your hostname"),
  outbound("PRIVMSG #iirc :too early, no Self yet"),
  { _tag: "Connection", connection: 2, ircd, network: "libera", phase: "opened" },
  inbound(":ircd 001 alice :Welcome"),
  outbound("PRIVMSG #iirc :hello"),
  inbound(":bob!u@h PRIVMSG #iirc :hi alice"),
  inbound(":bob!u@h NOTICE alice :psst"),
  inbound("PRIVMSG #iirc :no source, so no sender"),
  outbound("NICK alicia"),
  outbound("PRIVMSG #iirc :the Ircd has not agreed yet"),
  inbound(":alice!u@h NICK :alicia"),
  outbound(":mallory!u@h NOTICE bob :renamed"),
  inbound(""),
  inbound(":only-a-source"),
  {
    _tag: "Line",
    bytes: new Uint8Array([0xff, 0xfe, 0, 0x80]),
    connection: 2,
    direction: "inbound",
    network: "libera",
  },
  attempt("oftc"),
  opened(18, "oftc"),
  inbound(":ircd 001 ally :Welcome", "oftc"),
  outbound("PRIVMSG #other :on another Network", "oftc"),
  deadline("burst"),
  { _tag: "Connection", connection: 2, ircd, network: "libera", phase: "closed", reason: "gone" },
  attempt(),
  outbound("PRIVMSG #iirc :a reconnect forgets Self"),
  opened(24),
  inbound(":ircd 001 alice_ :Welcome"),
  outbound("PRIVMSG #iirc :back"),
  outbound("PRIVMSG #other :still ally", "oftc"),
];

const mixedSaid = [
  "libera NOTICE ircd -> *: Looking up your hostname",
  "libera PRIVMSG alice -> #iirc: hello",
  "libera PRIVMSG bob -> #iirc: hi alice",
  "libera NOTICE bob -> alice: psst",
  "libera PRIVMSG alice -> #iirc: the Ircd has not agreed yet",
  "libera NOTICE alicia -> bob: renamed",
  "oftc PRIVMSG ally -> #other: on another Network",
  "libera PRIVMSG alice_ -> #iirc: back",
  "oftc PRIVMSG ally -> #other: still ally",
];

// LOG-7: the Change an `admin` key's redaction records.
const redaction = (sequence: number): Extract<NewEntry, { readonly _tag: "Change" }> => ({
  _tag: "Change",
  by: "owner",
  change: { _tag: "EntryRedacted", sequence },
});

const redact = (sequence: number) =>
  Log.use(({ redact: emptied }) => emptied(sequence, redaction(sequence), (change) => change));

// The sequence of the Line or Dropped Entry whose bytes are this text.
const sequenceOf = (entries: readonly Entry[], text: string) =>
  entries.find(
    (entry) =>
      (entry._tag === "Line" || entry._tag === "Dropped") &&
      new TextDecoder().decode(entry.bytes) === text
  )?.sequence ?? 0;

const opening = (dataDir: string) => Effect.scoped(Layer.build(Log.layer({ dataDir })));

const attempted = (network = "libera") =>
  Effect.map(record([attempt(network)]), ([entry]) => entry.sequence);

// Kills, refusals, kicks, reconnects, and a clean stop, on two Networks, in many commits.
const eventful = Effect.gen(function* () {
  yield* record([daemon("started")]);

  const first = yield* attempted();

  yield* record([
    opened(first),
    welcome(),
    inbound(":ircd 005 alice NICKLEN=16 :are supported"),
    inbound(":alice!u@h JOIN #iirc"),
    inbound(":alice!u@h JOIN #rust"),
    outbound("PRIVMSG #iirc :hello"),
  ]);

  const other = yield* attempted("oftc");

  yield* record([
    opened(other, "oftc"),
    welcome("ally", "oftc"),
    inbound(":a!u@h JOIN #o", "oftc"),
  ]);
  yield* TestClock.adjust("1 minute");
  yield* record([sent("PING lag-1", "lag-check")]);
  yield* TestClock.adjust("40 millis");
  yield* record([inbound(":ircd PONG ircd :lag-1"), inbound(":mod!u@h KICK #rust alice :out")]);
  yield* TestClock.adjust("1 minute");

  // Killed: no `closed`, on either Network.
  yield* record([outbound("PRIVMSG #iirc :the last thing Self said")]);
  yield* TestClock.adjust("1 minute");
  yield* record([daemon("started")]);

  const refusedAttempt = yield* attempted();

  yield* record([opened(refusedAttempt), inbound("ERROR :You are banned")]);
  yield* record([refused(refusedAttempt, "You are banned")]);
  yield* TestClock.adjust("30 minutes");

  const second = yield* attempted();

  yield* record([opened(second), welcome("alice_"), sent("JOIN #iirc,#rust", "rejoin")]);
  yield* record([inbound(":ircd 475 alice_ #iirc :Bad key"), dropped("PRIVMSG #iirc :too late")]);
  yield* TestClock.adjust("6 minutes");
  yield* record([closing(second, "iirc stopping"), closed(second, "iirc stopping")]);

  const another = yield* attempted("oftc");

  yield* record([opened(another, "oftc"), welcome("ally_", "oftc"), daemon("stopped")]);
});

// Everything a rebuild must reproduce, in one value to compare.
const derived = Effect.gen(function* () {
  return {
    gaps: yield* allGaps,
    libera: yield* standing("libera"),
    messages: yield* allMessages,
    oftc: yield* standing("oftc"),
  };
});

describe("the durable Log", () => {
  describe("opening", () => {
    it.effect("creates its directory and database when missing", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const nested = `${dataDir}/not/yet/here`;

          yield* record([deadline("a")]).pipe(Effect.provide(Log.layer({ dataDir: nested })));

          const fileSystem = yield* FileSystem.FileSystem;

          assert.isTrue(yield* fileSystem.exists(`${nested}/iirc.sqlite`));
        })
      )
    );

    it.effect("fails with StorageFailed when its directory cannot exist", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          yield* fileSystem.writeFileString(`${dataDir}/a-file`, "");

          const failure = yield* Effect.flip(opening(`${dataDir}/a-file/log`));

          assert.strictEqual(failure._tag, "StorageFailed");
        })
      )
    );

    it.effect("LOG-4: writes durably, reading back what it asked SQLite for", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const sql = yield* openDatabase(dataDir);

          const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
          const [synchronous] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
          const [busy] = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`;

          assert.strictEqual(journal?.journal_mode, "wal");
          assert.strictEqual(synchronous?.synchronous, 2);
          assert.isAtMost(busy?.timeout ?? Infinity, 100);
        })
      )
    );

    it.effect("starts empty", () =>
      withLog(
        Effect.gen(function* () {
          assert.strictEqual(yield* Log.use(({ head }) => head), 0);
          assert.deepStrictEqual(yield* allEntries, []);
          assert.deepStrictEqual(yield* allMessages, []);
          assert.deepStrictEqual(yield* allGaps, []);
          assert.strictEqual(yield* standing(), noStanding);
        })
      )
    );
  });

  describe("recording", () => {
    it.effect("LOG-1: numbers Entries from 1 with no gaps, across calls", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([deadline("a"), deadline("b")]);
          yield* record([deadline("c")]);

          assert.deepStrictEqual(yield* sequences, [1, 2, 3]);
          assert.strictEqual(yield* Log.use(({ head }) => head), 3);
        })
      )
    );

    it.effect("LOG-8: takes `at` from the Clock, one time for one batch", () =>
      withLog(
        Effect.gen(function* () {
          yield* TestClock.adjust("5 seconds");
          yield* record([deadline("a"), inbound(":bob!u@h PRIVMSG #iirc :hi")]);
          yield* TestClock.adjust("1 second");
          yield* record([deadline("b")]);

          const entries = yield* allEntries;
          const messages = yield* allMessages;

          assert.deepStrictEqual(
            entries.map(({ at }) => at),
            [5000, 5000, 6000]
          );
          assert.strictEqual(messages[0]?.at, 5000);
        })
      )
    );

    it.effect("runs `within` on the numbered Entries and returns its result", () =>
      withLog(
        Effect.gen(function* () {
          const seen = yield* Recorder.use(({ record }) =>
            record([deadline("a"), deadline("b")], (recorded) =>
              recorded.map(({ sequence }) => sequence)
            )
          );

          assert.deepStrictEqual(seen, [1, 2]);
        })
      )
    );

    it.effect("rolls back and dies when `within` throws, consuming no sequence", () =>
      withLog(
        Effect.gen(function* () {
          const failure = new Error("machine threw");

          yield* record([deadline("a")]);

          const exit = yield* Recorder.use(({ record }) =>
            record([deadline("b"), inbound(":bob!u@h PRIVMSG #iirc :gone")], () => {
              throw failure;
            })
          ).pipe(Effect.exit);

          assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
          assert.deepStrictEqual(yield* sequences, [1]);
          assert.deepStrictEqual(yield* allMessages, []);

          const [next] = yield* record([deadline("c")]);

          assert.strictEqual(next?.sequence, 2);
        })
      )
    );

    it.effect("LOG-4: commits a batch whole, so a batch is contiguous", () =>
      withLog(
        Effect.gen(function* () {
          const batch = pipe(
            numbers(5000),
            Arr.map((index) => inbound(`:a!u@h PRIVMSG #iirc :${index}`))
          );

          yield* record(batch);

          assert.deepStrictEqual(yield* sequences, numbers(5000));
          assert.strictEqual((yield* allMessages).length, 5000);
        })
      )
    );

    it.effect("LOG-4: stays correct at the host's cap of 1024 Lines to a transaction", () =>
      withLog(
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* record([opened(connection), welcome()]);

          const before = yield* Log.use(({ head }) => head);

          const batch = pipe(
            numbers(1024),
            Arr.map((index) =>
              index % 2 === 0
                ? inbound(`:a!u@h PRIVMSG #iirc :${index}`)
                : inbound(`:alice!u@h JOIN #c${index}`)
            )
          );

          yield* record(batch);

          const { entries } = yield* Log;
          const held = yield* standing();
          const stored = yield* entries(everything);

          assert.strictEqual(yield* Log.use(({ head }) => head), before + 1024);
          assert.strictEqual((yield* allMessages).length, 512);
          assert.strictEqual(held.irc.channels.size, 512);
          assert.deepStrictEqual(held, foldStandings(noStandings, stored).get("libera"));
        })
      )
    );

    it.effect("stays gapless and whole under many concurrent Fibers, some failing", () =>
      withLog(
        Effect.gen(function* () {
          const writers = numbers(300);

          const exits = yield* Effect.forEach(
            writers,
            (writer) =>
              Recorder.use(({ record }) =>
                record(
                  [deadline(`${writer}`), deadline(`${writer}`), deadline(`${writer}`)],
                  () => {
                    if (everyFifth(writer)) {
                      throw new Error("machine threw");
                    }
                  }
                )
              ).pipe(Effect.exit),
            { concurrency: "unbounded" }
          );

          const survivors = writers.filter((writer) => !everyFifth(writer));
          const entries = yield* allEntries;
          const names = entries.map((entry) => (entry._tag === "Deadline" ? entry.name : ""));

          assert.strictEqual(exits.filter(Exit.isSuccess).length, survivors.length);
          assert.deepStrictEqual(
            entries.map(({ sequence }) => sequence),
            numbers(survivors.length * 3)
          );

          for (let index = 0; index < names.length; index += 3) {
            assert.strictEqual(names[index], names[index + 1]);
            assert.strictEqual(names[index], names[index + 2]);
          }

          assert.sameMembers(
            names.filter((_, index) => index % 3 === 0),
            survivors.map(String)
          );
        })
      )
    );

    it.effect("folds each writer from the last commit, when transactions yield mid-way", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([attempt(), opened(1), inbound(":ircd 001 n0 :Welcome")]);

          // Long enough to outlast a Fiber's turn, so the writers really do overlap.
          const padding = numbers(500).map((index) => deadline(`${index}`));

          yield* Effect.forEach(
            numbers(10),
            (index) => record(Arr.append(padding, inbound(`:n${index - 1}!u@h NICK :n${index}`))),
            { concurrency: "unbounded" }
          );

          assert.strictEqual(yield* currentSelf(), "n10");
        })
      )
    );

    it.effect("commits what `within` saw, even if interrupted while it ran", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([attempt(), opened(1), inbound(":ircd 001 alice :Welcome")]);

          const fiber = yield* Effect.gen(function* () {
            const running = yield* Effect.fiber;
            const { record } = yield* Recorder;

            yield* record([inbound(":alice!u@h NICK :alicia")], () => {
              running.interruptUnsafe();
            });
          }).pipe(Effect.forkChild);

          const exit = yield* Fiber.await(fiber);

          assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
          assert.strictEqual(yield* Log.use(({ head }) => head), 4);
          assert.strictEqual(yield* currentSelf(), "alicia");
        })
      )
    );

    it.effect("leaves the Log and the fold as they were when COMMIT itself fails", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const sql = yield* openDatabase(dataDir);
          const { messages, record, standing } = yield* makeStore(sql);

          yield* record([attempt(), opened(1), inbound(":ircd 001 alice :Welcome")], Array.isArray);

          const before = yield* standing("libera");

          // SQLite checks a deferred foreign key at COMMIT, and nothing sooner can fail.
          yield* sql`PRAGMA foreign_keys = ON`;
          yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`;
          yield* sql`CREATE TABLE child (id REFERENCES parent DEFERRABLE INITIALLY DEFERRED)`;
          yield* sql`
            CREATE TRIGGER orphan AFTER INSERT ON entries BEGIN
              INSERT INTO child VALUES (1);
            END
          `;

          const seen: number[] = [];

          const failure = yield* Effect.flip(
            record([inbound(":alice!u@h NICK :alicia")], (recorded) => {
              seen.push(...recorded.map(({ sequence }) => sequence));
            })
          );

          assert.instanceOf(failure, RecordFailed);
          assert.deepStrictEqual(seen, [4]);
          assert.strictEqual(yield* standing("libera"), before);

          yield* sql`DROP TRIGGER orphan`;

          const next = yield* record([outbound("PRIVMSG #iirc :still me")], (recorded) => recorded);
          const [message] = yield* messages(everything);

          assert.strictEqual(next[0]?.sequence, 4);
          assert.strictEqual(message?.sender, "alice");
        })
      )
    );

    it.effect("keeps the fold and the Log agreed when Fibers are interrupted", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([attempt(), opened(1), inbound(":ircd 001 n0 :Welcome")]);

          const fibers = yield* Effect.forEach(numbers(100), (index) =>
            record([inbound(`:n${index - 1}!u@h NICK :n${index}`)]).pipe(Effect.forkChild)
          );

          yield* Effect.yieldNow;
          yield* Effect.forEach(
            fibers.filter((_, index) => index % 2 === 1),
            Fiber.interrupt,
            { concurrency: "unbounded" }
          );
          yield* Fiber.awaitAll(fibers);

          // Whichever renames survived, Self is whatever the Log says it is.
          const live = yield* currentSelf();

          yield* Log.use(({ rebuild }) => rebuild);

          assert.strictEqual(yield* currentSelf(), live);
          assert.deepStrictEqual(yield* sequences, numbers((yield* sequences).length));
        })
      )
    );

    it.effect("reports a storage failure as RecordFailed, then carries on", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* record([attempt(), opened(1), inbound(":ircd 001 alice :Welcome")]);

          yield* execute(
            dataDir,
            "CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END"
          );

          // The Entries go in first, and the derived row refuses, so all of it must undo.
          const failure = yield* Effect.flip(
            record([inbound(":alice!u@h NICK :alicia"), inbound(":b!u@h PRIVMSG #iirc :hi")])
          );

          assert.instanceOf(failure, RecordFailed);
          assert.deepStrictEqual(yield* sequences, [1, 2, 3]);

          yield* execute(dataDir, "DROP TRIGGER refuse");

          assert.strictEqual(yield* currentSelf(), "alice");
          assert.deepStrictEqual(yield* sequences, [1, 2, 3, 4]);
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );
  });

  describe("reading", () => {
    it.effect("LOG-3: returns exactly what was recorded, in every field", () =>
      withLog(
        Effect.gen(function* () {
          const frame = new Uint8Array([9, 0, 0xff, 0xfe, 0, 0x80, 10, 13, 9]);

          const entries: Arr.NonEmptyReadonlyArray<NewEntry> = [
            {
              _tag: "Line",
              bytes: frame.subarray(1, 8),
              connection: 1,
              direction: "inbound",
              network: "libera",
            },
            {
              _tag: "Line",
              bytes: new Uint8Array(0),
              cause: "",
              connection: 1,
              cut: false,
              direction: "outbound",
              network: "libera",
            },
            {
              _tag: "Line",
              bytes: new Uint8Array(8704).fill(0x41),
              cause: "ping-reply",
              connection: 1,
              cut: true,
              direction: "outbound",
              network: "libera",
            },
            attempt(),
            {
              _tag: "Connection",
              connection: 4,
              ircd: { host: "::1", port: 6667, tls: false },
              network: "libera",
              phase: "closed",
              reason: "",
            },
            {
              _tag: "Connection",
              connection: 4,
              ircd,
              network: "libera",
              phase: "closed",
              reason: "banned",
              refused: true,
            },
            { _tag: "Connection", connection: 4, ircd, network: "libera", phase: "closed" },
            opened(4),
            closing(4, "iirc stopping"),
            closing(4, "write timed out", "libera", false),
            attempt("libera", []),
            attempt("libera", ["caf\u00E9", "a,b", 'quo"te']),
            {
              _tag: "Dropped",
              bytes: new Uint8Array([0xff, 0, 0x80]),
              cause: "rejoin",
              connection: 4,
              network: "libera",
              reason: "the Connection ended",
            },
            deadline("burst"),
            { _tag: "Daemon", phase: "stopped", version: "1.2.3" },
          ];

          yield* TestClock.adjust("7 seconds");
          yield* record(entries);

          const expected = entries.map((entry, index): Entry => ({
            ...entry,
            at: 7000,
            sequence: index + 1,
          }));

          const read = yield* allEntries;

          assert.deepStrictEqual(read, expected);

          // `deepStrictEqual` would pass a Buffer off as these, or a `null` as absent.
          for (const entry of read) {
            assert.notInclude(Object.values(entry), null);

            if (entry._tag === "Line" || entry._tag === "Dropped") {
              assert.strictEqual(Object.getPrototypeOf(entry.bytes), Uint8Array.prototype);
            }
          }
        })
      )
    );

    it.effect("pages by cursor, ascending, at most `limit`", () =>
      withLog(
        Effect.gen(function* () {
          yield* record(
            pipe(
              numbers(5),
              Arr.map((index) => inbound(`:a!u@h PRIVMSG #iirc :${index}`))
            )
          );

          const { entries, messages } = yield* Log;
          const page = yield* entries({ after: 1, limit: 2 });
          const said = yield* messages({ after: 3, limit: 10 });

          assert.deepStrictEqual(
            page.map(({ sequence }) => sequence),
            [2, 3]
          );
          assert.deepStrictEqual(
            said.map(({ sequence }) => sequence),
            [4, 5]
          );
          assert.deepStrictEqual(yield* entries({ after: 5, limit: 10 }), []);
        })
      )
    );
  });

  describe("deriving Messages", () => {
    it.effect("MSG-1: keeps every field of a Message", () =>
      withLog(
        Effect.gen(function* () {
          yield* TestClock.adjust("3 seconds");
          yield* record([inbound(":bob!u@h NOTICE #iirc :careful")]);

          assert.deepStrictEqual(yield* allMessages, [
            {
              at: 3000,
              kind: "NOTICE",
              network: "libera",
              sender: "bob",
              sequence: 1,
              target: "#iirc",
              text: "careful",
            },
          ]);
        })
      )
    );

    it.effect("MSG-1: derives inbound and outbound Messages in Log order", () =>
      withLog(
        Effect.gen(function* () {
          yield* record(mixed);

          assert.deepStrictEqual(yield* allSaid, mixedSaid);
        })
      )
    );

    it.effect("gives the same Messages one Entry at a time as in one batch", () =>
      withLog(
        Effect.gen(function* () {
          yield* Effect.forEach(mixed, (entry) => record([entry]), { discard: true });

          assert.deepStrictEqual(yield* allSaid, mixedSaid);
        })
      )
    );

    it.effect("keeps an unparseable Line as an Entry", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([inbound(""), inbound(":only-a-source")]);

          assert.deepStrictEqual(yield* sequences, [1, 2]);
          assert.deepStrictEqual(yield* allMessages, []);
        })
      )
    );

    it.effect("SEND-4: a Dropped Line was never sent, so it is no Message", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([attempt(), opened(1), welcome(), dropped("PRIVMSG #iirc :never sent")]);

          assert.deepStrictEqual(yield* allMessages, []);

          yield* Log.use(({ rebuild }) => rebuild);

          assert.deepStrictEqual(yield* allMessages, []);
        })
      )
    );

    it.effect("leaves the fold unchanged by a record that rolls back", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([attempt(), opened(1), inbound(":ircd 001 alice :Welcome")]);

          const batches: readonly Arr.NonEmptyReadonlyArray<NewEntry>[] = [
            [inbound(":alice!u@h NICK :alicia")],
            [attempt()],
          ];

          for (const entries of batches) {
            yield* Recorder.use(({ record }) =>
              record(entries, () => {
                throw new Error("machine threw");
              })
            ).pipe(Effect.exit);
          }

          assert.strictEqual(yield* currentSelf(), "alice");
        })
      )
    );

    it.effect("HOST-2: a cut Line says nothing, and agrees with the machine", () =>
      withLog(
        Effect.gen(function* () {
          const fragments = [
            cutInbound(":mallory!u@h PRIVMSG #iirc :a fragment of something longer"),
            cutInbound(":ircd 001 mallory :Welcome"),
            cutInbound(":alice!u@h NICK :mallory"),
          ] as const;

          const recorded = yield* record([
            attempt(),
            opened(1),
            inbound(":ircd 001 alice :Welcome"),
            ...fragments,
          ]);

          assert.deepStrictEqual(yield* allSaid, []);
          assert.strictEqual(yield* currentSelf(), "alice");

          // Its bytes stay in the Log, whatever the fold makes of them.
          const stored = yield* allEntries;

          assert.deepStrictEqual(stored.slice(0, recorded.length), [...recorded]);
          assert.deepStrictEqual(recorded.slice(-fragments.length).map(toEvent), [
            { at: 0, type: "HEARD" },
            { at: 0, type: "HEARD" },
            { at: 0, type: "HEARD" },
          ]);

          yield* Log.use(({ rebuild }) => rebuild);

          assert.lengthOf(yield* allSaid, 1);
          assert.strictEqual(yield* currentSelf(), "alice");
        })
      )
    );

    it.effect("RUN-3: a restart picks up Self and the sequence from Entries alone", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* record(mixed).pipe(Effect.provide(Log.layer({ dataDir })));

          yield* Effect.gen(function* () {
            assert.strictEqual(yield* currentSelf(), "alice_");
            assert.strictEqual(yield* currentSelf("oftc"), "ally");
            assert.strictEqual(yield* Log.use(({ head }) => head), mixed.length + 2);
          }).pipe(Effect.provide(Log.layer({ dataDir })));
        })
      )
    );
  });

  describe("keeping Standing", () => {
    it.effect("keeps one per Network, and agrees with folding the Entries", () =>
      withLog(
        Effect.gen(function* () {
          yield* eventful;

          const stored = yield* allEntries;
          const folded = foldStandings(noStandings, stored);

          assert.deepStrictEqual(yield* standing(), folded.get("libera"));
          assert.deepStrictEqual(yield* standing("oftc"), folded.get("oftc"));
          assert.strictEqual(yield* standing("never heard of"), noStanding);
        })
      )
    );

    it.effect("publishes nothing from a record that rolls back", () =>
      withLog(
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* record([opened(connection), welcome()]);

          const before = yield* standing();

          const exit = yield* Recorder.use(({ record }) =>
            record([closed(connection, "gone"), attempt()], () => {
              throw new Error("machine threw");
            })
          ).pipe(Effect.exit);

          assert.isTrue(Exit.isFailure(exit));
          assert.strictEqual(yield* standing(), before);
          assert.deepStrictEqual(yield* allGaps, []);
        })
      )
    );

    it.effect("LOG-9: a storage failure leaves Standing as it was, then carries on", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* record([opened(connection), welcome()]);

          const before = yield* standing();

          yield* execute(
            dataDir,
            "CREATE TRIGGER refuse BEFORE INSERT ON gaps BEGIN SELECT RAISE(ABORT, 'no'); END"
          );

          // The Entry goes in first, and the Gap refuses, so all of it must undo.
          const failure = yield* Effect.flip(record([closed(connection, "gone")]));

          assert.instanceOf(failure, RecordFailed);
          assert.strictEqual(yield* standing(), before);
          assert.strictEqual(yield* Log.use(({ head }) => head), 3);

          yield* execute(dataDir, "DROP TRIGGER refuse");
          yield* record([closed(connection, "gone")]);

          const [gap] = yield* allGaps;

          assert.strictEqual(gap?.sequence, 4);
          assert.isUndefined((yield* standing()).connection);
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );

    it.effect("LOG-9: recovers from another writer holding the lock, with no restart", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* record([opened(connection), welcome()]);

          const before = yield* standing();
          const other = yield* openDatabase(dataDir);

          yield* other.unsafe("BEGIN IMMEDIATE");

          const failures = yield* Effect.forEach([1, 2, 3], () =>
            Effect.flip(record([outbound("PRIVMSG #iirc :held up")]))
          );

          for (const failure of failures) {
            assert.instanceOf(failure, RecordFailed);
          }

          assert.strictEqual(yield* standing(), before);

          yield* other.unsafe("ROLLBACK");

          const [recorded] = yield* record([outbound("PRIVMSG #iirc :through")]);

          assert.strictEqual(recorded.sequence, 4);
          assert.strictEqual((yield* allMessages)[0]?.sender, "alice");
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );

    it.effect("LOG-9: recovers from a full disk, with no restart", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const sql = yield* openDatabase(dataDir);
          const { record: write, standing: read } = yield* makeStore(sql);

          yield* write([attempt(), opened(1), welcome()], Array.isArray);

          const before = yield* read("libera");

          const [pages] = yield* sql<{ page_count: number }>`PRAGMA page_count`;

          yield* sql.unsafe(`PRAGMA max_page_count = ${pages?.page_count ?? 0}`);

          const large = pipe(
            numbers(2000),
            Arr.map((index) => inbound(`:alice!u@h JOIN #${"x".repeat(1000)}${index}`))
          );

          const failure = yield* Effect.flip(write(large, Array.isArray));

          assert.instanceOf(failure, RecordFailed);
          assert.match(Bun.inspect(failure.cause, { depth: 6 }), /full/iu);
          assert.strictEqual(yield* read("libera"), before);

          yield* sql.unsafe("PRAGMA max_page_count = 1073741823");

          const recorded = yield* write(large, (entries) => entries.length);

          assert.strictEqual(recorded, 2000);
          assert.strictEqual((yield* read("libera")).irc.channels.size, 1024);
        })
      )
    );

    it.effect("RUN-3: a restart carries on from Entries alone, with backoff intact", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const { before, entries } = yield* Effect.gen(function* () {
            yield* eventful;

            return { before: yield* derived, entries: yield* allEntries };
          }).pipe(Effect.provide(Log.layer({ dataDir })));

          const after = yield* derived.pipe(Effect.provide(Log.layer({ dataDir })));

          assert.deepStrictEqual(after, before);
          assert.deepStrictEqual(after.libera, foldStandings(noStandings, entries).get("libera"));
        })
      )
    );

    it.effect("LOG-2: agrees with the machine that a cut Line proves only life", () =>
      withLog(
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* record([opened(connection)]);
          yield* TestClock.adjust("1 second");
          yield* record([cutInbound(":ircd 001 mallory :Welcome")]);

          const held = yield* standing();

          assert.deepStrictEqual(held.connection?.last, { at: 1000, sequence: 3 });
          assert.strictEqual(connectionView(held)?.registration._tag, "Registering");
          assert.isUndefined(held.irc.self?.nick);
        })
      )
    );
  });

  describe("deriving Gaps", () => {
    it.effect("LIVE-10: writes a Gap with the Entries, and ends it with the next 001", () =>
      withLog(
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* TestClock.adjust("1 minute");
          yield* record([opened(connection), welcome()]);
          yield* TestClock.adjust("1 minute");
          yield* record([closed(connection, "Connection reset by peer")]);

          assert.deepStrictEqual(yield* allGaps, [
            {
              at: 120_000,
              network: "libera",
              reason: "Connection reset by peer",
              sequence: 4,
            },
          ]);

          yield* TestClock.adjust("1 minute");

          const next = yield* attempted();

          yield* record([opened(next), welcome()]);

          assert.deepStrictEqual(yield* allGaps, [
            {
              at: 120_000,
              ended: { at: 180_000, sequence: 7 },
              network: "libera",
              reason: "Connection reset by peer",
              sequence: 4,
            },
          ]);
        })
      )
    );

    it.effect("LIVE-10: a close recorded late starts its Gap when the Connection ended", () =>
      withLog(
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* TestClock.adjust("1 minute");
          yield* record([opened(connection), welcome()]);
          yield* TestClock.adjust("1 minute");

          // The Log was down for 6.5 seconds, and the close is recorded once it is back.
          const endedAt = 120_000;

          yield* TestClock.adjust("6500 millis");

          const [late] = yield* record([
            {
              _tag: "Connection",
              connection,
              endedAt,
              ircd,
              network: "libera",
              phase: "closed",
              reason: "the Log was down",
            },
          ]);

          assert.deepStrictEqual(
            (yield* allEntries).at(-1),
            late,
            "it reads back as it was recorded"
          );
          assert.strictEqual(late.at, 126_500);
          assert.deepStrictEqual(yield* allGaps, [
            { at: endedAt, network: "libera", reason: "the Log was down", sequence: 4 },
          ]);
        })
      )
    );

    it.effect("LIVE-10: a Gap can begin and end in one commit", () =>
      withLog(
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* record([opened(connection), welcome()]);

          // The second `attempt` would be sequence 5, whatever this batch is.
          yield* record([closed(connection, "gone"), attempt(), opened(5), welcome()]);

          assert.deepStrictEqual(yield* allGaps, [
            {
              at: 0,
              ended: { at: 0, sequence: 7 },
              network: "libera",
              reason: "gone",
              sequence: 4,
            },
          ]);
        })
      )
    );

    it.effect("LIVE-10: pages by cursor, optionally for one Network", () =>
      withLog(
        Effect.gen(function* () {
          yield* eventful;

          const { gaps } = yield* Log;
          const all = yield* gaps(everything);

          assert.deepStrictEqual(
            all.map(({ network, reason }) => [network, reason]),
            [
              ["oftc", "the Daemon was killed"],
              ["libera", "the Daemon was killed"],
              ["libera", "iirc stopping"],
              ["oftc", "the Daemon stopped"],
            ]
          );

          assert.deepStrictEqual(yield* gaps({ after: 0, limit: 1 }), all.slice(0, 1));
          assert.deepStrictEqual(
            yield* gaps({ after: all[0]?.sequence ?? 0, limit: 1 }),
            all.slice(1, 2)
          );
          assert.deepStrictEqual(
            (yield* gaps({ ...everything, network: "oftc" })).map(({ reason }) => reason),
            ["the Daemon was killed", "the Daemon stopped"]
          );
          assert.deepStrictEqual(yield* gaps({ ...everything, network: "nowhere" }), []);
          assert.deepStrictEqual(yield* gaps({ after: Number.MAX_SAFE_INTEGER, limit: 10 }), []);
        })
      )
    );

    it.effect("LIVE-10: says when a Gap began and that it ended, across a kill", () =>
      withLog(
        Effect.gen(function* () {
          yield* eventful;

          const entries = yield* allEntries;
          const gaps = yield* allGaps;
          const killed = gaps.find(({ network }) => network === "libera");
          const self = "PRIVMSG #iirc :the last thing Self said";

          // The killed Session's last Entry is its last Line, not the restart.
          const last = entries.find(
            (entry) => entry._tag === "Line" && new TextDecoder().decode(entry.bytes) === self
          );

          assert.strictEqual(killed?.sequence, last?.sequence);
          assert.strictEqual(killed?.at, last?.at);
          assert.isDefined(killed?.ended);
        })
      )
    );

    it.effect("LIVE-10: an open Gap reads back with no end", () =>
      withLog(
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* record([opened(connection), welcome(), closed(connection, "gone")]);

          const [gap] = yield* allGaps;

          assert.isDefined(gap);
          assert.notProperty(gap, "ended");
        })
      )
    );
  });

  describe("restarting", () => {
    for (const vandalism of ["DELETE FROM gaps", "DROP TABLE gaps"]) {
      it.effect(`LOG-10: a restart after \`${vandalism}\` gives identical results`, () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const before = yield* Effect.andThen(eventful, derived).pipe(
              Effect.provide(Log.layer({ dataDir }))
            );

            yield* execute(dataDir, vandalism);

            const after = yield* derived.pipe(Effect.provide(Log.layer({ dataDir })));

            assert.lengthOf(before.gaps, 4);
            assert.deepStrictEqual(after, before);
          })
        )
      );
    }

    it.effect("LOG-10: drops a Gap that Entries do not support", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const before = yield* Effect.andThen(eventful, allGaps).pipe(
            Effect.provide(Log.layer({ dataDir }))
          );

          yield* execute(dataDir, "INSERT INTO gaps VALUES (9999, 0, 'libera', 'forged', NULL)");

          const after = yield* allGaps.pipe(Effect.provide(Log.layer({ dataDir })));

          assert.deepStrictEqual(after, before);
        })
      )
    );

    for (const vandalism of ["DELETE FROM messages", "DROP TABLE messages"]) {
      it.effect(`LOG-10: a restart after \`${vandalism}\` gives identical Messages`, () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const before = yield* Effect.andThen(record(mixed), allMessages).pipe(
              Effect.provide(Log.layer({ dataDir }))
            );

            yield* execute(dataDir, vandalism);

            yield* Effect.gen(function* () {
              assert.deepStrictEqual(yield* allMessages, before);
              assert.deepStrictEqual(yield* allSaid, mixedSaid);

              // The same pass leaves the fold ready for what comes next.
              assert.strictEqual(yield* currentSelf(), "alice_");
              assert.strictEqual(yield* currentSelf("oftc"), "ally");
            }).pipe(Effect.provide(Log.layer({ dataDir })));
          })
        )
      );
    }

    it.effect("LOG-10: drops a row that Entries do not support", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const before = yield* Effect.andThen(record(mixed), allMessages).pipe(
            Effect.provide(Log.layer({ dataDir }))
          );

          yield* execute(
            dataDir,
            "INSERT INTO messages VALUES (9999, 0, 'PRIVMSG', 'libera', 'x', '#x', 'forged')"
          );

          const after = yield* allMessages.pipe(Effect.provide(Log.layer({ dataDir })));

          assert.deepStrictEqual(after, before);
        })
      )
    );

    it.effect("refuses to open, keeping the old rows, when it cannot rebuild", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const before = yield* Effect.andThen(record(mixed), allMessages).pipe(
            Effect.provide(Log.layer({ dataDir }))
          );

          yield* execute(
            dataDir,
            "CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END"
          );

          const failure = yield* Effect.flip(opening(dataDir));

          assert.strictEqual(failure._tag, "StorageFailed");

          yield* execute(dataDir, "DROP TRIGGER refuse");

          assert.deepStrictEqual(
            yield* allMessages.pipe(Effect.provide(Log.layer({ dataDir }))),
            before
          );
        })
      )
    );
  });

  describe("rebuilding", () => {
    it.effect("LOG-10: derives identical Messages from Entries alone", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* record(mixed);

          const before = yield* allMessages;

          yield* Log.use(({ rebuild }) => rebuild);

          assert.deepStrictEqual(yield* allMessages, before);

          // A rebuild that kept the old rows would pass the check above.
          yield* execute(dataDir, "DELETE FROM messages");
          assert.deepStrictEqual(yield* allMessages, []);

          yield* Log.use(({ rebuild }) => rebuild);

          assert.deepStrictEqual(yield* allMessages, before);
          assert.deepStrictEqual(yield* allSaid, mixedSaid);
          assert.strictEqual(yield* currentSelf(), "alice_");
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );

    it.effect("LOG-10: live and rebuilt tables match after kills, refusals, and kicks", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* eventful;

          const live = yield* derived;

          // A fixture that derives nothing would pass everything below.
          assert.lengthOf(live.gaps, 4);
          assert.deepStrictEqual([...live.libera.kicked.keys()], ["#rust"]);
          assert.isUndefined(live.libera.lagMillis);
          assert.deepStrictEqual(
            live.libera.recent.map(({ reason }) => reason),
            ["the Daemon was killed", "You are banned", "iirc stopping"]
          );
          assert.strictEqual(live.libera.recent.length, 3);
          assert.strictEqual(live.libera.joinFailures.get("#iirc")?.numeric, "475");
          assert.lengthOf(live.messages, 2);

          yield* Log.use(({ rebuild }) => rebuild);

          assert.deepStrictEqual(yield* derived, live);

          // A rebuild that kept the old rows would pass the check above.
          yield* execute(dataDir, "DELETE FROM gaps");
          yield* execute(dataDir, "DELETE FROM messages");
          assert.deepStrictEqual(yield* allGaps, []);

          yield* Log.use(({ rebuild }) => rebuild);

          assert.deepStrictEqual(yield* derived, live);
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );

    it.effect("LOG-10: a close an earlier Daemon marked refused rebuilds as any close", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const connection = yield* attempted();

          yield* TestClock.adjust("1 second");
          yield* record([refused(connection, "You are banned")]);

          const live = yield* standing();

          yield* Log.use(({ rebuild }) => rebuild);

          const rebuilt = yield* standing();

          assert.deepStrictEqual(rebuilt, live);
          assert.strictEqual(rebuilt.recent.at(-1)?.reason, "You are banned");
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );

    // A rebuild pages by 1000. Self, a kill, and a Gap all carry state across a boundary.
    for (const boundary of [997, 998, 999, 1000, 1001, 1002]) {
      it.effect(`LOG-10: a page ending at Entry ${boundary} changes nothing`, () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const padding = numbers(boundary - 4).map((index) => deadline(`${index}`));

            yield* record(Arr.prepend(padding, attempt()));
            yield* record([opened(1), welcome()]);
            yield* record([outbound("PRIVMSG #iirc :Self came from the page before")]);
            yield* record([outbound("PRIVMSG #iirc :and still does")]);
            yield* record([daemon("started")]);

            const again = yield* attempted();

            yield* record([opened(again), welcome("alice_")]);
            yield* record([outbound("PRIVMSG #iirc :back")]);

            const live = yield* derived;

            assert.deepStrictEqual(
              live.messages.map(({ sender }) => sender),
              ["alice", "alice", "alice_"]
            );
            assert.lengthOf(live.gaps, 1);
            assert.isDefined(live.gaps[0]?.ended);

            yield* execute(dataDir, "DELETE FROM messages");
            yield* execute(dataDir, "DELETE FROM gaps");
            yield* Log.use(({ rebuild }) => rebuild);

            assert.deepStrictEqual(yield* derived, live);
          }).pipe(Effect.provide(Log.layer({ dataDir })))
        )
      );
    }

    it.effect("pages through more Entries than one page holds", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const self = [attempt(), opened(1), inbound(":ircd 001 alice :Welcome")];

          const chatter = numbers(2498).map((index) =>
            index % 2 === 0
              ? outbound(`PRIVMSG #iirc :${index}`)
              : inbound(`:bob!u@h PRIVMSG #iirc :${index}`)
          );

          yield* record(Arr.append([...self, ...chatter], inbound(":alice!u@h NICK :alicia")));

          const before = yield* allMessages;

          yield* execute(dataDir, "DELETE FROM messages");
          yield* Log.use(({ rebuild }) => rebuild);

          assert.strictEqual(before.length, 2498);
          assert.deepStrictEqual(yield* allMessages, before);
          assert.strictEqual(yield* currentSelf(), "alicia");
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );

    for (const count of [1, 127, 128, 129, 256, 257, 999, 1000, 1001]) {
      it.effect(`LOG-10: rebuilds ${count} Messages, row for row`, () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const chatter = numbers(count).map((index) =>
              inbound(`:bob!u@h PRIVMSG #iirc :${index} it's "quoted" \u{1F980}`)
            );

            yield* record([attempt(), opened(1), inbound(":ircd 001 alice :Welcome"), ...chatter]);

            const before = yield* allMessages;

            yield* execute(dataDir, "DELETE FROM messages");
            yield* Log.use(({ rebuild }) => rebuild);

            assert.lengthOf(before, count);
            assert.deepStrictEqual(yield* allMessages, before);
          }).pipe(Effect.provide(Log.layer({ dataDir })))
        )
      );
    }

    it.effect("rolls back whole, keeping the old rows, when it fails", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* record(mixed);

          const before = yield* allMessages;

          yield* execute(
            dataDir,
            "CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END"
          );

          const held = yield* standing();
          const failure = yield* Effect.flip(Log.use(({ rebuild }) => rebuild));

          assert.strictEqual(failure._tag, "StorageFailed");
          assert.deepStrictEqual(yield* allMessages, before);
          assert.strictEqual(yield* standing(), held);
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );
  });

  describe("locking", () => {
    it.live("RUN-4: refuses a second Layer at once, and frees the lock on close", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const failure = yield* Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            const refused = yield* Effect.flip(opening(dataDir));

            // Its lock waits for nothing (`busy_timeout = 0`), so a refusal that waited at
            // all would be waiting on the other Layer, which holds the lock until the end
            // of this test. A refusal that merely took long is not what is asserted, so
            // the bound is only a busy machine's margin.
            assert.isBelow((yield* Clock.currentTimeMillis) - started, 2000);

            return refused;
          }).pipe(Effect.provide(Log.layer({ dataDir })));

          assert.deepStrictEqual(failure, new DataDirectoryLocked({ dataDir }));

          yield* opening(dataDir);
        })
      )
    );

    it.live("RUN-4: takes the lock without writing, so a full disk cannot refuse it", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* holdDataDirectory(dataDir);

          // A rollback journal beside it would be a write, which a full disk refuses.
          assert.deepStrictEqual(readdirSync(dataDir), ["iirc.lock"]);
          assert.strictEqual(statSync(`${dataDir}/iirc.lock`).size, 0);
          assert.deepStrictEqual(
            yield* Effect.flip(Effect.scoped(holdDataDirectory(dataDir))),
            new DataDirectoryLocked({ dataDir })
          );
        }).pipe(Effect.scoped)
      )
    );

    // A tmpfs of its own needs a user namespace, which some machines refuse.
    const canMount = Bun.spawnSync(["unshare", "-rm", "true"]).exitCode === 0;

    it.live.skipIf(!canMount)(
      "RUN-4, LOG-9: on a full disk, takes the lock and says the disk is full",
      () =>
        inTempDirectory((dataDir) =>
          Effect.promise(async () => {
            const fill = [
              'mount -t tmpfs -o size=1m tmpfs "$1"',
              'head -c 2000000 /dev/zero > "$1/filler" 2>/dev/null',
              'exec "$2" "$3" "$1"',
            ].join("; ");

            const child = Bun.spawn(
              ["unshare", "-rm", "sh", "-c", fill, "sh", dataDir, process.execPath, diskFullScript],
              { stderr: "inherit", stdout: "pipe" }
            );

            const said = await new Response(child.stdout).text();

            await child.exited;

            // The lock writes nothing, so what refuses is the Log, which needs room.
            assert.deepStrictEqual(JSON.parse(said), {
              reason: `the disk holding ${dataDir} is full`,
              tag: "StorageFailed",
            });
          })
        ),
      { timeout: 20_000 }
    );

    it.effect("RUN-4: keeps the lock through a refused open", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* Effect.flip(opening(dataDir));

          const failure = yield* Effect.flip(opening(dataDir));

          assert.deepStrictEqual(failure, new DataDirectoryLocked({ dataDir }));
        }).pipe(Effect.provide(Log.layer({ dataDir })))
      )
    );
  });

  describe("being killed", () => {
    const killTimeout = 30_000;
    const commitsBeforeKilling = 200;

    // Runs a child that records until killed, and returns every commit it reported.
    const recordUntilKilled = <E>(dataDir: string, whileRunning: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const reported: number[] = [];
        const running = yield* Deferred.make<undefined>();

        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [childScript, dataDir], { stderr: "inherit" })
        );

        const reader = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            reported.push(Number(line));

            return reported.length === commitsBeforeKilling
              ? Deferred.succeed(running, undefined)
              : Effect.void;
          }),
          Effect.forkScoped
        );

        // The reader ends first only if the child died by itself.
        yield* Effect.raceFirst(Deferred.await(running), Fiber.join(reader));
        yield* whileRunning;
        yield* child.kill({ killSignal: "SIGKILL" });
        yield* Fiber.join(reader);

        return reported;
      });

    it.live(
      "RUN-4: another process is refused, until the holder is killed",
      () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const whileHeld = Effect.gen(function* () {
              const failure = yield* Effect.flip(opening(dataDir));

              assert.deepStrictEqual(failure, new DataDirectoryLocked({ dataDir }));
            });

            yield* recordUntilKilled(dataDir, whileHeld);
            yield* opening(dataDir);
          })
        ),
      { timeout: killTimeout }
    );

    it.live(
      "PROOF-4: every commit a killed process reported survives, gapless",
      () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const reported = yield* recordUntilKilled(dataDir, Effect.void);

            yield* Effect.gen(function* () {
              const reopened = yield* Log.use(({ head }) => head);

              assert.isAtLeast(reported.length, commitsBeforeKilling);
              assert.isAtLeast(reopened, reported.at(-1) ?? Infinity);
              assert.deepStrictEqual(yield* sequences, numbers(reopened));

              // Three Entries to start, then whole batches of three, each saying three things.
              const batches = (reopened - 3) / 3;
              const before = yield* allMessages;

              assert.isTrue(Number.isInteger(batches));
              assert.strictEqual(before.length, batches * 3);

              // The next record continues the sequence and knows who Self is.
              assert.strictEqual(yield* currentSelf(), "alice");
              assert.strictEqual(yield* Log.use(({ head }) => head), reopened + 1);

              const after = yield* allMessages;

              yield* Log.use(({ rebuild }) => rebuild);

              assert.deepStrictEqual(after.slice(0, -1), before);
              assert.deepStrictEqual(yield* allMessages, after);
            }).pipe(Effect.provide(Log.layer({ dataDir })));
          })
        ),
      { timeout: killTimeout }
    );
  });
});

const pinnedIrcd = {
  host: "irc.example",
  pin: "sha256/FxXjXNs8hR4SHHqcjzGZqxYuzW1CBgkCpw1biac9fO0=",
  port: 6697,
  tls: true,
};

const tls = {
  cipher: "TLS_AES_128_GCM_SHA256",
  pin: pinnedIrcd.pin,
  protocol: "TLSv1.3",
  verifiedBy: "pin",
} as const;

// Changes holding every kind of JSON, with and without a Network, among a Connection that
// was pinned and secured.
const configured: Arr.NonEmptyReadonlyArray<NewEntry> = [
  { _tag: "Change", by: "local", change: { keys: { create: "phone" } } },
  { _tag: "Change", by: "phone", change: null, network: "libera" },
  {
    _tag: "Change",
    by: "phone",
    change: [1, -2.5, "café", true, false, null, { nested: ["a", { deeper: {} }] }],
    network: "libera",
  },
  { _tag: "Change", by: "agent", change: 'quo"te\nand a newline', network: "libera" },
  {
    _tag: "Connection",
    ircd: pinnedIrcd,
    loginLines: 2,
    network: "libera",
    nicks: ["alice"],
    phase: "attempt",
    realname: 'caf\u00E9 "quoted"',
    services: ["NickServ", "Q"],
    tuning: { ...attemptInput.tuning, burstMillis: 0, silenceMillis: 123_456 },
    username: "alice",
  },
  { _tag: "Connection", connection: 5, ircd: pinnedIrcd, network: "libera", phase: "opened", tls },
  { _tag: "Change", by: "phone", change: 0, network: "libera" },
  welcome(),
  inbound(":bob!u@h PRIVMSG #iirc :still here"),
];

describe("the durable Log and Configuration", () => {
  it.effect(
    "LOG-3: returns Changes, an `attempt`'s input, a pin, and TLS details as recorded",
    () =>
      withLog(
        Effect.gen(function* () {
          yield* TestClock.adjust("3 seconds");
          yield* record(configured);

          const read = yield* allEntries;

          assert.deepStrictEqual(
            read,
            configured.map((entry, index): Entry => ({ ...entry, at: 3000, sequence: index + 1 }))
          );

          // `deepStrictEqual` would pass a `null` off as absent, but a `null` Change is JSON.
          const changes = read.flatMap((entry) => (entry._tag === "Change" ? [entry] : []));

          assert.notProperty(changes[0], "network");
          assert.property(changes[1], "change");
          assert.isNull(changes[1]?.change);
        })
      )
  );

  it.effect("LOG-6: a Line and a Dropped Entry keep the names of the Credentials taken out", () =>
    withLog(
      Effect.gen(function* () {
        const redacted: Arr.NonEmptyReadonlyArray<NewEntry> = [
          {
            _tag: "Line",
            bytes: encoder.encode("PASS <redacted>"),
            cause: "registration",
            connection: 1,
            direction: "outbound",
            network: "libera",
            redacted: ["pass"],
          },
          {
            _tag: "Dropped",
            bytes: encoder.encode("JOIN #a,#b <redacted>,<redacted>"),
            cause: "rejoin",
            connection: 1,
            network: "libera",
            reason: "the Connection closed",
            redacted: ["key.a", "key.b"],
          },
          inbound(":bob!u@h PRIVMSG #iirc :nothing secret"),
        ];

        yield* TestClock.adjust("3 seconds");
        yield* record(redacted);

        const read = yield* allEntries;

        assert.deepStrictEqual(
          read,
          redacted.map((entry, index): Entry => ({ ...entry, at: 3000, sequence: index + 1 }))
        );
        assert.notProperty(read[2], "redacted");
      })
    )
  );

  it.effect("LOG-2: a Change derives nothing, and Standing agrees with the fold", () =>
    withLog(
      Effect.gen(function* () {
        yield* record(configured);

        const entries = yield* allEntries;
        const withoutChanges = entries.filter(({ _tag }) => _tag !== "Change");
        const folded = foldStandings(noStandings, withoutChanges).get("libera") ?? noStanding;
        const held = yield* standing();

        assert.deepStrictEqual(yield* allSaid, ["libera PRIVMSG bob -> #iirc: still here"]);
        assert.deepStrictEqual(connectionView(held), connectionView(folded));
        assert.strictEqual(held.irc.self?.nick, "alice");
        assert.deepStrictEqual(entries.filter(({ _tag }) => _tag === "Change").map(toEvent), [
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
      })
    )
  );

  describe("redaction (LOG-7)", () => {
    it.effect(
      "LOG-7: empties a Line's and a Dropped Entry's bytes, marks each with its Change, and derives the tables again",
      () =>
        withLog(
          Effect.gen(function* () {
            const connection = yield* attempted();

            yield* record([
              opened(connection),
              welcome(),
              inbound(":bob!u@h PRIVMSG alice :my password is hunter2"),
              inbound(":bob!u@h PRIVMSG alice :oops"),
              dropped("PRIVMSG bob :hunter2 again"),
            ]);

            const before = yield* allEntries;
            const line = sequenceOf(before, ":bob!u@h PRIVMSG alice :my password is hunter2");
            const unsent = sequenceOf(before, "PRIVMSG bob :hunter2 again");
            const first = yield* redact(line);
            const second = yield* redact(unsent);
            const after = yield* allEntries;

            assert.deepInclude(
              after.find(({ sequence }) => sequence === line),
              { bytes: new Uint8Array(), redactedBy: first.sequence }
            );
            assert.deepInclude(
              after.find(({ sequence }) => sequence === unsent),
              { bytes: new Uint8Array(), redactedBy: second.sequence }
            );
            assert.deepStrictEqual(first, { ...redaction(line), at: first.at, sequence: line + 3 });
            assert.deepStrictEqual(after.at(-1), second);
            assert.deepStrictEqual(yield* allSaid, ["libera PRIVMSG bob -> alice: oops"]);

            // What it derived again is what a rebuild derives.
            const derivedNow = yield* derived;

            yield* Log.use(({ rebuild }) => rebuild);

            assert.deepStrictEqual(yield* derived, derivedNow);
          })
        )
    );

    it.effect(
      "LOG-7: refuses an unknown sequence, any other kind, and a second redaction, recording nothing",
      () =>
        withLog(
          Effect.gen(function* () {
            const connection = yield* attempted();

            yield* record([opened(connection), inbound(":bob!u@h PRIVMSG alice :hi")]);

            const line = sequenceOf(yield* allEntries, ":bob!u@h PRIVMSG alice :hi");
            const { sequence: change } = yield* redact(line);
            const head = yield* Log.use(({ head: newest }) => newest);

            assert.deepInclude(yield* Effect.flip(redact(head + 5)), {
              _tag: "EntryNotFound",
              sequence: head + 5,
            });
            assert.deepInclude(yield* Effect.flip(redact(connection)), {
              _tag: "EntryNotRedactable",
              kind: "Connection",
            });
            assert.deepInclude(yield* Effect.flip(redact(change)), {
              _tag: "EntryNotRedactable",
              kind: "Change",
            });
            assert.deepInclude(yield* Effect.flip(redact(line)), {
              _tag: "EntryAlreadyRedacted",
              change,
            });
            assert.strictEqual(yield* Log.use(({ head: newest }) => newest), head);
          })
        )
    );

    it.effect(
      "LOG-10: rows appended after a redaction are the rows a rebuild derives, though the host keeps what it knew",
      () =>
        withLog(
          Effect.gen(function* () {
            const connection = yield* attempted();

            yield* record([
              opened(connection),
              welcome(),
              inbound(":alice!u@h NICK :alicia"),
              outbound("PRIVMSG #iirc :before the redaction"),
            ]);

            yield* redact(sequenceOf(yield* allEntries, ":alice!u@h NICK :alicia"));
            yield* record([
              outbound("PRIVMSG #iirc :after the redaction"),
              inbound(":bob!u@h PRIVMSG #iirc :and an inbound one"),
            ]);

            const live = { gaps: yield* allGaps, messages: yield* allMessages };

            // Without its NICK Self is still alice, as a start would have it.
            assert.deepStrictEqual(
              live.messages.map(({ sender, text }) => `${sender}: ${text}`),
              [
                "alice: before the redaction",
                "alice: after the redaction",
                "bob: and an inbound one",
              ]
            );
            // The host knows Self by the nick the Ircd gave it.
            assert.strictEqual((yield* standing()).irc.self?.nick, "alicia");

            yield* Log.use(({ rebuild }) => rebuild);

            assert.deepStrictEqual({ gaps: yield* allGaps, messages: yield* allMessages }, live);
          })
        )
    );

    it.effect(
      "LOG-7: Standing keeps what the live host knew, and a restart replays a redacted Line as one that says nothing",
      () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const live = yield* Effect.gen(function* () {
              const connection = yield* attempted();

              yield* record([
                opened(connection),
                welcome(),
                inbound(":alice!u@h JOIN #rust"),
                inbound(":mod!u@h KICK #rust alice :your key is hunter2"),
              ]);

              const kick = sequenceOf(
                yield* allEntries,
                ":mod!u@h KICK #rust alice :your key is hunter2"
              );

              yield* redact(kick);

              return {
                gaps: yield* allGaps,
                kicked: [...(yield* standing()).kicked.keys()],
                messages: yield* allMessages,
              };
            }).pipe(Effect.provide(Log.layer({ dataDir })));

            const restarted = yield* Effect.gen(function* () {
              return {
                gaps: yield* allGaps,
                kicked: [...(yield* standing()).kicked.keys()],
                messages: yield* allMessages,
              };
            }).pipe(Effect.provide(Log.layer({ dataDir })));

            // The kick held Self out until the restart, and is forgotten after it.
            assert.deepStrictEqual(live.kicked, ["#rust"]);
            assert.deepStrictEqual(restarted.kicked, []);
            assert.deepStrictEqual(restarted.messages, live.messages);
            assert.deepStrictEqual(restarted.gaps, live.gaps);
          })
        )
    );
  });

  it.effect("LOG-10: a rebuild and a restart leave Changes and TLS details intact", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const before = yield* Effect.gen(function* () {
          yield* eventful;
          yield* record(configured);
          yield* Log.use(({ rebuild }) => rebuild);

          return { derived: yield* derived, entries: yield* allEntries };
        }).pipe(Effect.provide(Log.layer({ dataDir })));

        yield* execute(dataDir, "DELETE FROM messages");

        const after = yield* Effect.gen(function* () {
          return { derived: yield* derived, entries: yield* allEntries };
        }).pipe(Effect.provide(Log.layer({ dataDir })));

        assert.isAbove(before.entries.filter(({ _tag }) => _tag === "Change").length, 4);
        assert.deepStrictEqual(after, before);
      })
    )
  );
});
