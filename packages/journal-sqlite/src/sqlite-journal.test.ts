import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Input, Instant } from "@iirc/client";
import {
  Journal,
  JournalRecord,
  NetworkId,
  Sequence,
  journalVersion,
  networkOf,
} from "@iirc/runtime/journal";
import type { Entry, Position } from "@iirc/runtime/journal";
import { holds, journalLaws } from "@iirc/runtime/testing";
import { Deferred, Effect, Exit, Fiber, Ref, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, it, vi } from "vitest";

import { layerSqliteJournal, makeSqliteJournal, openSqliteJournal } from "./sqlite-journal.ts";

// A law carries its own ten-second guard against a hang (`holds`), so Vitest must wait longer
// than that, or a law that is only slow under a loaded machine fails as Vitest's timeout.
vi.setConfig({ testTimeout: 20_000 });

const libera = NetworkId.make("libera");
const oftc = NetworkId.make("oftc");

const retry = (network: NetworkId, at: number) =>
  JournalRecord.cases.Input.make({
    input: Input.cases.Retry.make({ at: Instant.make(at) }),
    network,
  });

const recordText = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(JournalRecord)));

// A directory for one test, removed when its Scope ends.
const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(async () => await mkdtemp(path.join(tmpdir(), "iirc-journal-sqlite-"))),
  (directory) =>
    Effect.promise(async () => {
      await rm(directory, { force: true, recursive: true });
    })
);

const temporaryFile = temporaryDirectory.pipe(
  Effect.map((directory) => path.join(directory, "journal.db"))
);

const freshJournal = temporaryFile.pipe(Effect.flatMap((file) => makeSqliteJournal(file)));

const run = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(effect));

const collect = <E>(stream: Stream.Stream<Entry, E>) =>
  Stream.runCollect(stream).pipe(Effect.map((entries) => [...entries]));

// Opens the file in a Scope of its own, so it is closed again when `use` is done.
const using = <A, E>(
  file: string,
  use: (journal: Effect.Success<ReturnType<typeof makeSqliteJournal>>) => Effect.Effect<A, E>
) => Effect.scoped(makeSqliteJournal(file).pipe(Effect.flatMap(use)));

describe("the SQLite Journal", () => {
  it.each(journalLaws)("$name", async (law) => {
    await expect(run(holds(law, freshJournal))).resolves.toBeUndefined();
  });
});

describe("reopening the file", () => {
  it("keeps every Entry, and goes on numbering after the last", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        const first = yield* using(file, (journal) =>
          Effect.forEach([retry(libera, 1), retry(oftc, 2), retry(libera, 3)], journal.append)
        );

        const { entries, next } = yield* using(file, (journal) =>
          Effect.gen(function* () {
            const next = yield* journal.append(retry(oftc, 4));

            return { entries: yield* collect(journal.read({})), next };
          })
        );

        expect(first).toStrictEqual([1, 2, 3]);
        expect(next).toBe(4);
        expect(entries.map((entry) => entry.sequence)).toStrictEqual([1, 2, 3, 4]);
        expect(entries.map((entry) => recordText(entry.record))).toStrictEqual(
          [retry(libera, 1), retry(oftc, 2), retry(libera, 3), retry(oftc, 4)].map((record) =>
            recordText(record)
          )
        );
      })
    );
  });

  it("does not reuse a sequence, even when the last Entry's number was taken", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (journal) => journal.append(retry(libera, 1)));
        yield* using(file, (journal) => journal.append(retry(libera, 2)));

        const sequences = yield* using(file, (journal) =>
          collect(journal.read({})).pipe(Effect.map((entries) => entries.map((e) => e.sequence)))
        );

        expect(sequences).toStrictEqual([1, 2]);
      })
    );
  });

  it("provides the Journal as a Layer", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const program = Journal.use((journal) => journal.append(retry(libera, 1)));

        yield* program.pipe(Effect.provide(layerSqliteJournal(file)));
        const sequence = yield* program.pipe(Effect.provide(layerSqliteJournal(file)));

        expect(sequence).toBe(2);
      })
    );
  });

  it("reads more Entries than one page holds, in order, for one Network too", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const total = 1203;

        yield* using(file, (journal) => journal.append(retry(libera, 0)));

        const raw = new Database(file);

        raw.transaction(() => {
          for (let n = 1; n < total; n += 1) {
            raw
              .query("INSERT INTO journal (record) VALUES (?)")
              .run(recordText(retry(n % 3 === 0 ? oftc : libera, n)));
          }
        })();
        raw.close();

        const { all, afterMiddle, onlyOftc } = yield* using(file, (journal) =>
          Effect.gen(function* () {
            return {
              afterMiddle: yield* collect(journal.read({ after: Sequence.make(600) })),
              all: yield* collect(journal.read({})),
              onlyOftc: yield* collect(journal.follow({ network: oftc }).pipe(Stream.take(400))),
            };
          })
        );

        expect(all.map((entry) => entry.sequence)).toStrictEqual(
          Array.from({ length: total }, (_, i) => i + 1)
        );
        expect(afterMiddle).toHaveLength(total - 600);
        expect(afterMiddle[0]?.sequence).toBe(601);
        expect(onlyOftc.every((entry) => networkOf(entry.record) === oftc)).toBeTruthy();
        // The first record is Entry 1, so Entry `n + 1` holds the record numbered `n`.
        expect(onlyOftc.map((entry) => entry.sequence)).toStrictEqual(
          Array.from({ length: 400 }, (_, i) => (i + 1) * 3 + 1)
        );
      })
    );
  });
});

describe("the file", () => {
  it("is in WAL mode, and reads one Network through its index", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (journal) => journal.append(retry(libera, 1)));
        const raw = new Database(file, { readonly: true });
        const mode = raw.query("PRAGMA journal_mode").get();

        const plan = raw
          .query(
            "EXPLAIN QUERY PLAN SELECT sequence FROM journal WHERE network = ? AND sequence > ?"
          )
          .all("libera", 0);

        raw.close();
        expect(mode).toStrictEqual({ journal_mode: "wal" });
        expect(JSON.stringify(plan)).toContain("journal_by_network");
      })
    );
  });
});

describe("the version check", () => {
  it("writes the version into a new file, and opens it again", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, () => Effect.void);
        const raw = new Database(file, { readonly: true });
        const row = raw.query("PRAGMA user_version").get();

        raw.close();
        expect(row).toStrictEqual({ user_version: journalVersion });
        yield* using(file, () => Effect.void);
      })
    );
  });

  it("opens a Journal of this version written before Changes, and reads it as it was", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const raw = new Database(file);

        // The table as it was made before a Change could name no Network.
        raw.run(`
          CREATE TABLE journal (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            record TEXT NOT NULL CHECK (json_valid(record)),
            network TEXT NOT NULL GENERATED ALWAYS AS (json_extract(record, '$.network')) VIRTUAL
          ) STRICT
        `);
        raw.run("CREATE INDEX journal_by_network ON journal (network)");
        raw.run(`PRAGMA user_version = ${journalVersion}`);
        raw.query("INSERT INTO journal (record) VALUES (?)").run(recordText(retry(libera, 1)));
        raw.query("INSERT INTO journal (record) VALUES (?)").run(recordText(retry(oftc, 2)));
        raw.close();

        const { all, forOftc, next } = yield* using(file, (journal) =>
          Effect.gen(function* () {
            return {
              all: yield* collect(journal.read({})),
              forOftc: yield* collect(journal.read({ network: oftc })),
              next: yield* journal.append(retry(libera, 3)),
            };
          })
        );

        expect(all.map((entry) => recordText(entry.record))).toStrictEqual(
          [retry(libera, 1), retry(oftc, 2)].map((record) => recordText(record))
        );
        expect(forOftc.map((entry) => entry.sequence)).toStrictEqual([2]);
        expect(next).toBe(3);
      })
    );
  });

  it("refuses a Journal of another version", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (journal) => journal.append(retry(libera, 1)));
        const raw = new Database(file);

        raw.run(`PRAGMA user_version = ${journalVersion + 1}`);
        raw.close();

        const exit = yield* Effect.exit(using(file, () => Effect.void));

        expect(Exit.isFailure(exit)).toBeTruthy();
        expect(JSON.stringify(Exit.isFailure(exit) ? exit.cause : "")).toContain(
          "JournalVersionMismatch"
        );
        const failure = yield* using(file, () => Effect.void).pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "JournalVersionMismatch",
          expected: journalVersion,
          found: journalVersion + 1,
        });
      })
    );
  });

  it("refuses a database that is not a Journal, and leaves it exactly as it was", async () => {
    await run(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;
        const file = path.join(directory, "notes.db");
        const raw = new Database(file);

        raw.run("CREATE TABLE notes (body TEXT)");
        raw.run("INSERT INTO notes VALUES ('keep me')");
        raw.close();

        const before = yield* Effect.promise(async () => await readFile(file));
        const failure = yield* using(file, () => Effect.void).pipe(Effect.flip);
        const after = yield* Effect.promise(async () => await readFile(file));
        const check = new Database(file, { readonly: true });
        const mode = check.query("PRAGMA journal_mode").get();
        const tables = check.query("SELECT name FROM sqlite_master").all();

        check.close();
        expect(failure).toMatchObject({ _tag: "JournalVersionMismatch", found: 0 });
        expect(mode).toStrictEqual({ journal_mode: "delete" });
        expect(tables).toStrictEqual([{ name: "notes" }]);
        expect(after.equals(before)).toBeTruthy();
        expect(yield* Effect.promise(async () => await readdir(directory))).toStrictEqual([
          "notes.db",
        ]);
      })
    );
  });
});

describe("a Journal that cannot be read or written", () => {
  it("fails a file that is not a database with JournalFailed", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* Effect.promise(async () => {
          await writeFile(file, "this is not a database, it is a long lie".repeat(50));
        });
        const failure = yield* using(file, () => Effect.void).pipe(Effect.flip);

        expect(failure._tag).toBe("JournalFailed");
      })
    );
  });

  it("fails a path that cannot be opened with JournalFailed", async () => {
    await run(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;

        const failure = yield* using(
          path.join(directory, "missing", "journal.db"),
          () => Effect.void
        ).pipe(Effect.flip);

        expect(failure._tag).toBe("JournalFailed");
      })
    );
  });

  it("names SQLite's own reason when a path cannot be opened", async () => {
    await run(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;

        const failure = yield* using(
          path.join(directory, "missing", "journal.db"),
          () => Effect.void
        ).pipe(Effect.flip);

        expect(failure._tag).toBe("JournalFailed");
        expect(failure).toHaveProperty(
          "reason",
          expect.stringContaining("unable to open database file")
        );
      })
    );
  });

  it("gives the Entries before a record that does not decode, then fails with JournalFailed", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (journal) => journal.append(retry(libera, 1)));
        const raw = new Database(file);

        raw
          .query("INSERT INTO journal (record) VALUES (?)")
          .run('{"_tag":"Nope","network":"libera"}');
        raw.query("INSERT INTO journal (record) VALUES (?)").run(recordText(retry(libera, 3)));
        raw.close();

        yield* using(file, (journal) =>
          Effect.gen(function* () {
            // Both are in one page, so the valid Entry must not wait for the page's end.
            for (const stream of [journal.read({}), journal.follow({})]) {
              const seen = yield* Ref.make<readonly number[]>([]);

              const exit = yield* Effect.exit(
                Stream.runForEach(stream, (entry) =>
                  Ref.update(seen, (all) => [...all, entry.sequence])
                )
              );

              const failure = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "succeeded";

              expect(yield* Ref.get(seen)).toStrictEqual([1]);
              expect(failure).toContain("JournalFailed");
              expect(failure).not.toContain("Die");
            }

            // The Entries around it are still there for a reader that starts past the bad one.
            const around = yield* collect(journal.read({ after: Sequence.make(2) }));

            expect(around.map((entry) => entry.sequence)).toStrictEqual([3]);
          })
        );
      })
    );
  });

  it("fails an append when the file can no longer be written", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (journal) =>
          Effect.gen(function* () {
            yield* journal.append(retry(libera, 1));
            const raw = new Database(file);

            raw.run("DROP INDEX journal_by_network");
            raw.run("DROP TABLE journal");
            raw.close();

            const failure = yield* journal.append(retry(libera, 2)).pipe(Effect.flip);

            expect(failure._tag).toBe("JournalFailed");
          })
        );
      })
    );
  });
});

describe("following", () => {
  it("sees every Entry once, in order, under concurrent appends", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const total = 60;

        yield* using(file, (journal) =>
          Effect.gen(function* () {
            yield* Effect.forEach([1, 2, 3], (n) => journal.append(retry(libera, n)));

            // Followers start while appends are in flight, from different positions. Each
            // takes as many Entries as there will be for it: the three above and `total` more.
            const follower = (from: Position, count: number) =>
              Effect.forkChild(collect(journal.follow(from).pipe(Stream.take(count))));

            const everything = yield* follower({}, 3 + total);
            const afterTwo = yield* follower({ after: Sequence.make(2) }, 1 + total);
            const forOftc = yield* follower({ network: oftc }, total / 2);

            const appending = yield* Effect.forkChild(
              Effect.forEach(
                Array.from({ length: total }, (_, n) => n),
                (n) => journal.append(retry(n % 2 === 0 ? libera : oftc, n + 10)),
                { concurrency: 8 }
              )
            );

            yield* Fiber.join(appending);
            const expected = yield* collect(journal.read({}));

            expect((yield* Fiber.join(everything)).map((e) => e.sequence)).toStrictEqual(
              expected.map((e) => e.sequence)
            );
            expect((yield* Fiber.join(afterTwo)).map((e) => e.sequence)).toStrictEqual(
              expected.slice(2).map((e) => e.sequence)
            );
            expect((yield* Fiber.join(forOftc)).map((e) => e.sequence)).toStrictEqual(
              expected.filter((e) => networkOf(e.record) === oftc).map((e) => e.sequence)
            );
          })
        );
      })
    );
  });

  it("holds a signal and not the Entries for a follower that stops taking them", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const appended = 2000;
        const { backlog, journal } = yield* openSqliteJournal(file);

        yield* Effect.forEach([1, 2, 3], (n) => journal.append(retry(libera, n)));

        // The follower takes its first Entry and then stops, with a thousand more to come.
        const gate = yield* Deferred.make<undefined>();
        const taken = yield* Deferred.make<undefined>();
        const seen = yield* Ref.make<readonly number[]>([]);

        const follower = yield* Effect.forkChild(
          Stream.runForEach(journal.follow({}), (entry) =>
            Effect.gen(function* () {
              yield* Ref.update(seen, (all) => [...all, entry.sequence]);
              yield* Deferred.succeed(taken, undefined);
              yield* Deferred.await(gate);
            })
          )
        );

        yield* Deferred.await(taken);

        const sizes = yield* Effect.forEach(
          Array.from({ length: appended }, (_, n) => n),
          (n) =>
            journal.append(retry(n % 2 === 0 ? libera : oftc, n + 10)).pipe(Effect.andThen(backlog))
        );

        // However many appends the follower slept through, one signal is all that waits.
        expect(Math.max(...sizes)).toBeLessThanOrEqual(1);
        expect(yield* Ref.get(seen)).toStrictEqual([1]);

        yield* Deferred.succeed(gate, undefined);
        const total = 3 + appended;

        while ((yield* Ref.get(seen)).length < total) {
          yield* Effect.sleep("1 millis");
        }

        // It never got ahead of itself while waiting, and misses nothing now.
        yield* Effect.sleep("20 millis");
        expect(yield* Ref.get(seen)).toStrictEqual(Array.from({ length: total }, (_, i) => i + 1));
        yield* Fiber.interrupt(follower);
      })
    );
  }, 30_000);

  it("completes concurrent appends in the order they are numbered, and wakes a paused follower for all of them", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        // The scheduler may yield between an insert and its signal, and the one connection
        // does not prevent that. The first append here yields a hundred times there, long
        // enough for a second to commit, signal and return if nothing stopped it.
        const first = yield* Ref.make(true);

        const slowFirst = Ref.getAndSet(first, false).pipe(
          Effect.flatMap((isFirst) =>
            isFirst
              ? Effect.forEach(
                  Array.from({ length: 100 }, (_, i) => i),
                  () => Effect.yieldNow
                )
              : Effect.void
          ),
          Effect.asVoid
        );

        const { journal } = yield* openSqliteJournal(file, { afterInsert: slowFirst });

        // The follower takes Entry 1 and stops, so its signal is the one that can be lost.
        yield* journal.append(retry(libera, 1));
        yield* Ref.set(first, true);
        const gate = yield* Deferred.make<undefined>();
        const taken = yield* Deferred.make<undefined>();
        const seen = yield* Ref.make<readonly number[]>([]);

        const follower = yield* Effect.forkChild(
          Stream.runForEach(journal.follow({}), (entry) =>
            Effect.gen(function* () {
              yield* Ref.update(seen, (all) => [...all, entry.sequence]);
              yield* Deferred.succeed(taken, undefined);
              yield* Deferred.await(gate);
            })
          )
        );

        yield* Deferred.await(taken);

        // Each append notes its number as it returns, so completion order is visible.
        const completed = yield* Ref.make<readonly number[]>([]);

        const noted = journal
          .append(retry(libera, 2))
          .pipe(Effect.flatMap((sequence) => Ref.update(completed, (all) => [...all, sequence])));

        yield* Effect.all([noted, noted], { concurrency: "unbounded" });
        const order = yield* Ref.get(completed);

        expect(order).toStrictEqual([2, 3]);

        yield* Deferred.succeed(gate, undefined);

        while ((yield* Ref.get(seen)).length < 3) {
          yield* Effect.sleep("1 millis");
        }

        expect(yield* Ref.get(seen)).toStrictEqual([1, 2, 3]);
        yield* Fiber.interrupt(follower);
      })
    );
  });
});
