import { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunFileSystem } from "@effect/platform-bun";
import { Instant, IntentId, MessageId } from "@iirc/client";
import { holds } from "@iirc/runtime/testing";
import { TimelineStore } from "@iirc/timeline-store";
import type { TimelineStoreService } from "@iirc/timeline-store";
import { timelineStoreLaws } from "@iirc/timeline-store/testing";
import { emptyDirectory, step, timelineIdOf } from "@iirc/timelines";
import type { Change, Position } from "@iirc/timelines";
import { Effect, Layer, Option, Schema } from "effect";
import type { Scope } from "effect";
import { CurrentTransformer } from "effect/sql/Statement";
import { describe, expect, it } from "vitest";

import { layerSqliteTimelineStore, makeSqliteTimelineStore } from "./sqlite-timeline-store.ts";

// A directory for one test, removed when its Scope ends.
const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(async () => await mkdtemp(path.join(tmpdir(), "iirc-timeline-store-sqlite-"))),
  (directory) =>
    Effect.promise(async () => {
      await rm(directory, { force: true, recursive: true });
    })
);

const temporaryFile = temporaryDirectory.pipe(
  Effect.map((directory) => path.join(directory, "views.sqlite"))
);

const opened = (file: string) =>
  makeSqliteTimelineStore(file).pipe(Effect.provide(BunFileSystem.layer));

const freshStore = temporaryFile.pipe(Effect.flatMap(opened));

const run = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(effect));

// Opens the file in a Scope of its own, so it is closed again when `use` is done.
const using = <A, E>(file: string, use: (store: TimelineStoreService) => Effect.Effect<A, E>) =>
  Effect.scoped(opened(file).pipe(Effect.flatMap(use)));

const libera = "libera";
const t0 = 1_762_560_000_000;
const at = (ms: number) => Instant.make(t0 + ms);
const position = (ms: number, sequence: number, n = 0): Position => ({ at: at(ms), n, sequence });
const network = timelineIdOf(1, 0, 0);
const channel = timelineIdOf(1, 0, 1);
const other = timelineIdOf(1, 0, 2);

const said = (sequence: number, text: string, id?: string): Change => ({
  _tag: "Added",
  content: {
    _tag: "Message",
    at: { _tag: "Known", at: at(sequence), from: "ircd", value: at(sequence) },
    id:
      id === undefined
        ? { _tag: "Unknown" }
        : { _tag: "Known", at: at(sequence), from: "ircd", value: MessageId.make(id) },
    kind: "Privmsg",
    live: true,
    ours: { delivery: { _tag: "Pending" }, intent: IntentId.make(`intent-${text}`) },
    sender: "iirc",
    tags: [["+draft/reply", "abc"]],
    target: "#a",
    text,
  },
  intent: IntentId.make(`intent-${text}`),
  messageId: id === undefined ? undefined : MessageId.make(id),
  network: libera,
  position: position(sequence, sequence),
  sequence,
  timeline: channel,
});

// Steps of every kind, each with the directory a real fold gives.
const steps: readonly { readonly through: number; readonly changes: readonly Change[] }[] = [
  {
    changes: [
      {
        _tag: "Described",
        sequence: 1,
        timeline: { id: network, key: null, kind: "Network", name: libera, network: libera },
      },
      {
        _tag: "Described",
        sequence: 1,
        timeline: { id: channel, key: "#a", kind: "Channel", name: "#a", network: libera },
      },
      {
        _tag: "Described",
        sequence: 1,
        timeline: { id: other, key: "#b", kind: "Channel", name: "#B", network: libera },
      },
      { _tag: "Gap", from: position(0, 1), network: libera, sequence: 1, to: undefined },
    ],
    through: 1,
  },
  { changes: [said(2, "one", "m1"), said(3, "two")], through: 3 },
  {
    changes: [
      {
        _tag: "Confirmed",
        at: { _tag: "Unknown" },
        id: { _tag: "Unknown" },
        intent: IntentId.make("intent-two"),
        messageId: MessageId.make("m2"),
        network: libera,
        sequence: 4,
        text: "two!",
      },
      { _tag: "Gap", from: position(0, 1), network: libera, sequence: 4, to: position(4, 4) },
      { _tag: "Merged", from: other, into: channel, network: libera, sequence: 4 },
    ],
    through: 4,
  },
];

const directoryAt = (through: number) =>
  step(emptyDirectory, {
    at: at(through),
    network: libera,
    news: [{ _tag: "SessionBegan", at: at(through), nick: "iirc" }],
    sequence: through,
  }).directory;

const applyAll = (store: TimelineStoreService) =>
  Effect.gen(function* () {
    yield* store.reset(1);

    for (const each of steps) {
      yield* store.apply({ ...each, directory: directoryAt(each.through) });
    }
  });

// Everything a reader can see of the store.
const everything = (store: TimelineStoreService) =>
  Effect.gen(function* () {
    return {
      changed: yield* store.changedAfter(undefined),
      directory: yield* store.directory,
      folded: yield* store.folded,
      gaps: yield* store.gaps(libera, {}),
      located: yield* store.locate(libera, 3),
      merged: yield* store.window(other, { _tag: "Before" }, 10),
      timelines: yield* store.timelines(libera),
      window: yield* store.window(channel, { _tag: "Around", position: position(3, 3) }, 1),
    };
  });

const raw = (file: string, statement: string) => {
  const database = new Database(file);

  database.run(statement);
  database.close();
};

describe("the SQLite Timeline store", () => {
  it.each(timelineStoreLaws)("$name", async (law) => {
    await expect(run(holds(law, freshStore))).resolves.toBeUndefined();
  });
});

describe("reopening the file", () => {
  it("reads everything as it was before it was closed", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        const before = yield* using(file, (store) =>
          applyAll(store).pipe(Effect.andThen(everything(store)))
        );

        const after = yield* using(file, everything);

        expect(before.folded).toStrictEqual({ through: 4, version: 1 });
        expect(Option.isSome(before.merged)).toBeTruthy();
        expect(before.changed.items.length).toBeGreaterThan(0);
        expect(after).toStrictEqual(before);
      })
    );
  });

  it("provides the store as a Layer", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const program = TimelineStore.use((store) => store.folded);

        const layer = layerSqliteTimelineStore(file).pipe(Layer.provide(BunFileSystem.layer));

        yield* TimelineStore.use((store) => store.reset(7)).pipe(Effect.provide(layer));
        const folded = yield* program.pipe(Effect.provide(layer));

        expect(folded).toStrictEqual({ through: undefined, version: 7 });
      })
    );
  });
});

// Applies every step, spoils the file while it is closed, and opens it again: what it reads
// then, and how far it folds once given every step again.
const spoiled = async (spoil: (file: string) => void) =>
  await run(
    Effect.gen(function* () {
      const file = yield* temporaryFile;

      yield* using(file, applyAll);
      spoil(file);

      const { folded, timelines } = yield* using(file, everything);

      yield* using(file, applyAll);
      const again = yield* using(file, (store) => store.folded);

      return { again: again.through, folded, timelines };
    })
  );

// It reads as a store that was never applied to, and keeps what it is given.
const madeAgain = { again: 4, folded: { through: undefined, version: undefined }, timelines: [] };

const removed = (file: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${file}${suffix}`, { force: true });
  }
};

describe("a file it cannot use", () => {
  it("makes a file of another layout again", async () => {
    await expect(
      spoiled((file) => {
        raw(file, "PRAGMA user_version = 99");
      })
    ).resolves.toStrictEqual(madeAgain);
  });

  it("makes a file of this layout's version whose table lacks a column again", async () => {
    await expect(
      spoiled((file) => {
        raw(file, "ALTER TABLE folded DROP COLUMN version");
      })
    ).resolves.toStrictEqual(madeAgain);
  });

  it("makes a file whose directory does not decode again", async () => {
    await expect(
      spoiled((file) => {
        raw(file, `UPDATE folded SET directory = '{"networks":"nope"}'`);
      })
    ).resolves.toStrictEqual(madeAgain);
  });

  it("makes a database that is not a store again", async () => {
    await expect(
      spoiled((file) => {
        removed(file);
        raw(file, "CREATE TABLE notes (body TEXT)");
      })
    ).resolves.toStrictEqual(madeAgain);
  });

  it("makes a file that is not a database again", async () => {
    await expect(
      spoiled((file) => {
        removed(file);
        writeFileSync(file, "this is not a database, it is a long lie".repeat(50));
      })
    ).resolves.toStrictEqual(madeAgain);
  });

  it("fails with TimelineStoreFailed for a path that cannot be opened, and removes nothing", async () => {
    await run(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;

        const failure = yield* Effect.scoped(
          opened(path.join(directory, "missing", "views.sqlite"))
        ).pipe(Effect.flip);

        expect(`${failure._tag}: ${failure.reason}`).toContain("TimelineStoreFailed: cannot open");
        expect(failure.reason).toContain("unable to open database file");
        expect(yield* Effect.promise(async () => await readdir(directory))).toStrictEqual([]);
      })
    );
  });
});

describe("a store it cannot read now", () => {
  it("fails while another connection holds it locked, and keeps the file as it was", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        const before = yield* using(file, (store) =>
          applyAll(store).pipe(Effect.andThen(everything(store)))
        );

        const holder = new Database(file);

        holder.run("PRAGMA locking_mode = EXCLUSIVE");
        holder.run("BEGIN EXCLUSIVE");

        const failure = yield* Effect.scoped(
          makeSqliteTimelineStore(file, { busyTimeout: "50 millis" }).pipe(
            Effect.provide(BunFileSystem.layer)
          )
        ).pipe(Effect.flip);

        holder.run("ROLLBACK");
        holder.close();

        expect(`${failure._tag}: ${failure.reason}`).toContain("TimelineStoreFailed: cannot read");
        expect(failure.reason).toContain("database is locked");
        expect(yield* using(file, everything)).toStrictEqual(before);
      })
    );
  });
});

// What a statement the store emitted searches, line by line, as SQLite plans it.
const searches = (plan: string) => plan.split("\n").filter((line) => line.includes("gaps"));

// A run of Gaps is bounded below by the key, so it never reaches older Gaps, and its count
// reads the index alone, never a row to filter on `to_cursor`.
const keyedBelow = (line: string) =>
  /SEARCH gaps USING (?:COVERING )?INDEX sqlite_autoindex_gaps_1 \(network=\? AND from_cursor>=?\?/u.test(
    line
  );

// A run before a cursor is bounded above by the key too, so it never reads the Gaps after.
const keyedBothSides = (line: string) =>
  /SEARCH gaps USING (?:COVERING )?INDEX sqlite_autoindex_gaps_1 \(network=\? AND from_cursor>=?\? AND from_cursor<=?\?\)/u.test(
    line
  );

const Bindings = Schema.Array(Schema.Union([Schema.String, Schema.Finite, Schema.Null]));

/**
 * Runs a read of the store, and gives each statement it emitted, as the SQL client compiled
 * it, with its parameters: the store's own SQL, never a copy of it.
 * @param read - The read.
 * @returns The statements, in order.
 */
const emitted = <A, E>(read: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const statements: { readonly sql: string; readonly params: readonly unknown[] }[] = [];

    yield* read.pipe(
      Effect.provideService(CurrentTransformer, (statement) =>
        Effect.sync(() => {
          const [sql, params] = statement.compile();

          statements.push({ params, sql });

          return statement;
        })
      )
    );

    return statements;
  });

describe("the file", () => {
  it("is in WAL mode, and answers each read through an index, as the store emits it", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        const reads = yield* using(file, (store) =>
          Effect.gen(function* () {
            yield* applyAll(store);

            const at = position(3, 3);
            const run = { at: [position(2, 2)], from: position(1, 1) };

            return {
              // A step that confirms by intent and keeps one item per message id.
              apply: yield* emitted(
                store.apply({
                  changes: [said(5, "three", "m1"), said(6, "four", "m3")],
                  directory: directoryAt(6),
                  through: 6,
                })
              ),
              changedAfter: yield* emitted(store.changedAfter(1, 2)),
              collapsedGaps: yield* emitted(store.collapsedGaps(libera, run)),
              collapsedGapsAfter: yield* emitted(
                store.collapsedGaps(libera, { ...run, beganAfter: position(1, 1) })
              ),
              collapsedGapsBefore: yield* emitted(
                store.collapsedGaps(libera, { ...run, endedBefore: at })
              ),
              gaps: yield* emitted(store.gaps(libera, { from: position(1, 1), to: at })),
              locate: yield* emitted(
                store.locate(libera, 3, { after: { position: at, timeline: channel }, limit: 1 })
              ),
              overflowed: yield* emitted(store.changedAfter(3, 1)),
              timelines: yield* emitted(store.timelines(libera, { after: network, limit: 1 })),
              windowAfter: yield* emitted(
                store.window(channel, { _tag: "After", position: at }, 1)
              ),
              windowAround: yield* emitted(
                store.window(channel, { _tag: "Around", position: at }, 1)
              ),
              windowBefore: yield* emitted(
                store.window(channel, { _tag: "Before", position: at }, 1)
              ),
            };
          })
        );

        const database = new Database(file, { readonly: true });
        const mode = database.query("PRAGMA journal_mode").get();

        const planOf = (statement: { readonly sql: string; readonly params: readonly unknown[] }) =>
          database
            .query<{ readonly detail: string }, (string | number | null)[]>(
              `EXPLAIN QUERY PLAN ${statement.sql}`
            )
            .all(...Schema.decodeUnknownSync(Bindings)(statement.params))
            .map((row) => row.detail)
            .join("\n");

        // Every statement that reads, or finds what it changes, with its plan.
        const planned = Object.entries(reads).flatMap(([read, statements]) =>
          statements
            .filter(({ sql }) => /^\s*(?:SELECT|UPDATE|DELETE|WITH)/iu.test(sql))
            .map((statement) => ({ plan: planOf(statement), read, sql: statement.sql }))
        );

        // The runs of Gaps: one statement each, counted with where the first began and the
        // last ended.
        const runs = (read: keyof typeof reads) =>
          planned.filter((each) => each.read === read && each.sql.includes("count(*)"));

        // The filter a run once had, on `to_cursor`, which no key bounds: the checks below
        // must tell it from a run.
        const unkeyed = planOf({
          params: [],
          sql: "SELECT count(*) FROM gaps WHERE network = 'libera' AND from_cursor <= 'b' AND (to_cursor IS NULL OR to_cursor >= 'a')",
        });

        database.close();

        expect(mode).toStrictEqual({ journal_mode: "wal" });

        expect({
          after: runs("collapsedGapsAfter").flatMap(({ plan }) => searches(plan).map(keyedBelow)),
          before: runs("collapsedGapsBefore").flatMap(({ plan }) =>
            searches(plan).map(keyedBothSides)
          ),
          covered: runs("collapsedGaps").every(({ plan }) => plan.includes("COVERING INDEX")),
          keyed: runs("collapsedGaps").flatMap(({ plan }) => searches(plan).map(keyedBelow)),
          unkeyed: [keyedBelow(unkeyed), unkeyed.includes("COVERING INDEX")],
        }).toStrictEqual({
          // Two runs, around the one item, each a count and a search for its end.
          after: [true, true, true, true],
          before: [true, true, true, true],
          covered: true,
          keyed: [true, true, true, true],
          unkeyed: [false, false],
        });

        // Every read was emitted, and none scans a table or sorts.
        expect(
          Object.entries(reads).filter(([, statements]) => statements.length === 0)
        ).toStrictEqual([]);

        for (const { plan, read, sql } of planned) {
          expect([read, sql, plan]).not.toStrictEqual([
            read,
            sql,
            expect.stringMatching(
              /SCAN items|SCAN timelines|SCAN gaps|SCAN tombstones|TEMP B-TREE/u
            ),
          ]);
        }
      })
    );
  });
});
