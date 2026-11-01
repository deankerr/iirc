import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import type { Entry, NewEntry } from "@iirc/session/entry";
import { toEvent } from "@iirc/session/events";
import { Recorder, RecordFailed } from "@iirc/session/recorder";
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
import { DataDirectoryLocked, Log } from "./log.ts";
import type { LoggedMessage } from "./log.ts";
import { makeStore } from "./store.ts";

const encoder = new TextEncoder();
const ircd = { host: "irc.example", port: 6697, tls: true };
const childScript = `${import.meta.dirname}/recording-child.ts`;

const attempt = (network = "libera"): NewEntry => ({
  _tag: "Connection",
  ircd,
  network,
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

const outbound = (text: string, network = "libera"): NewEntry => ({
  _tag: "Line",
  bytes: encoder.encode(text),
  cause: "test",
  connection: 1,
  direction: "outbound",
  network,
});

const deadline = (name: string): NewEntry => ({ _tag: "Deadline", name, network: "libera" });

const everyFifth = (index: number) => index % 5 === 0;

const numbers = (length: number) => Arr.range(1, length);

const record = (entries: Arr.NonEmptyReadonlyArray<NewEntry>) =>
  Recorder.use(({ record }) => record(entries, (recorded) => recorded));

const everything = { after: 0, limit: 100_000 };

const allEntries = Log.use(({ entries }) => entries(everything));
const allMessages = Log.use(({ messages }) => messages(everything));
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
  inbound(":ircd 001 ally :Welcome", "oftc"),
  outbound("PRIVMSG #other :on another Network", "oftc"),
  deadline("burst"),
  { _tag: "Connection", connection: 2, ircd, network: "libera", phase: "closed", reason: "gone" },
  attempt(),
  outbound("PRIVMSG #iirc :a reconnect forgets Self"),
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

const opening = (dataDir: string) => Effect.scoped(Layer.build(Log.layer({ dataDir })));

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
          yield* record([attempt(), inbound(":ircd 001 n0 :Welcome")]);

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
          yield* record([attempt(), inbound(":ircd 001 alice :Welcome")]);

          const fiber = yield* Effect.gen(function* () {
            const running = yield* Effect.fiber;
            const { record } = yield* Recorder;

            yield* record([inbound(":alice!u@h NICK :alicia")], () => {
              running.interruptUnsafe();
            });
          }).pipe(Effect.forkChild);

          const exit = yield* Fiber.await(fiber);

          assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
          assert.strictEqual(yield* Log.use(({ head }) => head), 3);
          assert.strictEqual(yield* currentSelf(), "alicia");
        })
      )
    );

    it.effect("leaves the Log and the fold as they were when COMMIT itself fails", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const sql = yield* openDatabase(dataDir);
          const { messages, record } = yield* makeStore(sql);

          yield* record([attempt(), inbound(":ircd 001 alice :Welcome")], Array.isArray);

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
          assert.deepStrictEqual(seen, [3]);

          yield* sql`DROP TRIGGER orphan`;

          const next = yield* record([outbound("PRIVMSG #iirc :still me")], (recorded) => recorded);
          const [message] = yield* messages(everything);

          assert.strictEqual(next[0]?.sequence, 3);
          assert.strictEqual(message?.sender, "alice");
        })
      )
    );

    it.effect("keeps the fold and the Log agreed when Fibers are interrupted", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([attempt(), inbound(":ircd 001 n0 :Welcome")]);

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
          yield* record([attempt(), inbound(":ircd 001 alice :Welcome")]);

          yield* execute(
            dataDir,
            "CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END"
          );

          // The Entries go in first, and the derived row refuses, so all of it must undo.
          const failure = yield* Effect.flip(
            record([inbound(":alice!u@h NICK :alicia"), inbound(":b!u@h PRIVMSG #iirc :hi")])
          );

          assert.instanceOf(failure, RecordFailed);
          assert.deepStrictEqual(yield* sequences, [1, 2]);

          yield* execute(dataDir, "DROP TRIGGER refuse");

          assert.strictEqual(yield* currentSelf(), "alice");
          assert.deepStrictEqual(yield* sequences, [1, 2, 3]);
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

            if (entry._tag === "Line") {
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

    it.effect("leaves the fold unchanged by a record that rolls back", () =>
      withLog(
        Effect.gen(function* () {
          yield* record([attempt(), inbound(":ircd 001 alice :Welcome")]);

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
            inbound(":ircd 001 alice :Welcome"),
            ...fragments,
          ]);

          assert.deepStrictEqual(yield* allSaid, []);
          assert.strictEqual(yield* currentSelf(), "alice");

          // Its bytes stay in the Log, whatever the fold makes of them.
          const stored = yield* allEntries;

          assert.deepStrictEqual(stored.slice(0, recorded.length), [...recorded]);
          assert.deepStrictEqual(recorded.slice(-fragments.length).map(toEvent), [
            undefined,
            undefined,
            undefined,
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

  describe("restarting", () => {
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

    it.effect("pages through more Entries than one page holds", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const self = [attempt(), inbound(":ircd 001 alice :Welcome")];

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

            yield* record([attempt(), inbound(":ircd 001 alice :Welcome"), ...chatter]);

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

          const failure = yield* Effect.flip(Log.use(({ rebuild }) => rebuild));

          assert.strictEqual(failure._tag, "StorageFailed");
          assert.deepStrictEqual(yield* allMessages, before);
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

            assert.isBelow((yield* Clock.currentTimeMillis) - started, 1000);

            return refused;
          }).pipe(Effect.provide(Log.layer({ dataDir })));

          assert.deepStrictEqual(failure, new DataDirectoryLocked({ dataDir }));

          yield* opening(dataDir);
        })
      )
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

              // Two Entries to start, then whole batches of three, each saying three things.
              const batches = (reopened - 2) / 3;
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
