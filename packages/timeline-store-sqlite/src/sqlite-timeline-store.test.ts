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
import { SearchText, emptyDirectory, searchFolding, step, timelineIdOf } from "@iirc/timelines";
import type { Change, Position } from "@iirc/timelines";
import { Effect, Layer, Option, Schema } from "effect";
import type { Scope } from "effect";
import { CurrentTransformer } from "effect/sql/Statement";
import { describe, expect, it, vi } from "vitest";

import { layerSqliteTimelineStore, makeSqliteTimelineStore } from "./sqlite-timeline-store.ts";

// A law carries its own ten-second guard against a hang (`holds`), so Vitest must wait longer
// than that, or a law that is only slow under a loaded machine fails as Vitest's timeout.
vi.setConfig({ testTimeout: 20_000 });

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
const third = timelineIdOf(1, 0, 3);

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
  level: undefined,
  messageId: id === undefined ? undefined : MessageId.make(id),
  network: libera,
  position: position(sequence, sequence),
  sequence,
  timeline: channel,
});

// Something someone else said, which counts as unread.
const heard = (sequence: number, text: string, timeline = channel): Change => ({
  _tag: "Added",
  content: {
    _tag: "Message",
    at: { _tag: "Known", at: at(sequence), from: "ircd", value: at(sequence) },
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours: undefined,
    sender: "peer",
    tags: [],
    target: "#a",
    text,
  },
  intent: undefined,
  level: "Message",
  messageId: undefined,
  network: libera,
  position: position(sequence, sequence, 1),
  sequence,
  timeline,
});

const marked = (sequence: number, read: number): Change => ({
  _tag: "ReadMarker",
  network: libera,
  read: at(read),
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
  { changes: [said(2, "one", "m1"), said(3, "two"), heard(3, "three")], through: 3 },
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
      marked(4, 2),
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
      searched: yield* store.search({ limit: 10, text: SearchText.make("two") }),
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

  it("folds its search again when it was folded another way, and keeps everything else", async () => {
    const result = await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, applyAll);
        const before = yield* using(file, everything);

        // An index and senders as another folding would have kept them.
        const database = new Database(file);

        database.run("UPDATE folded SET folding = 'simple-lower/0.0'");
        database.run("INSERT INTO search (search) VALUES ('delete-all')");

        for (const { id } of database.query<{ id: number }, []>("SELECT id FROM items").all()) {
          database.run("INSERT INTO search (rowid, text) VALUES (?, 'stale text')", [id]);
        }

        database.run("UPDATE items SET sender = 'nobody' WHERE sender IS NOT NULL");
        database.close();

        const after = yield* using(file, everything);

        const found = yield* using(file, (store) =>
          Effect.all({
            byOld: store.search({ limit: 10, text: SearchText.make("stale") }),
            bySender: store.search({ from: "PEER", limit: 10, text: SearchText.make("THREE") }),
          })
        );

        const folding = new Database(file, { readonly: true })
          .query("SELECT folding FROM folded")
          .get();

        return {
          after,
          before,
          byOld: found.byOld.length,
          bySender: found.bySender.length,
          folding,
          searched: after.searched.length,
        };
      })
    );

    expect(result.after).toStrictEqual(result.before);
    expect({ ...result, after: undefined, before: undefined }).toStrictEqual({
      after: undefined,
      before: undefined,
      byOld: 0,
      bySender: 1,
      folding: { folding: searchFolding },
      searched: 1,
    });
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

// A count of one level's items after a Read Marker searches `items_by_level` by the key,
// from the marker on, reading the index alone.
const byLevel = (line: string) =>
  /SEARCH items USING COVERING INDEX items_by_level \(timeline=\? AND level=\? AND cursor>=?\?\)/u.test(
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
              // A step that confirms by intent, keeps one item per message id, and counts
              // one more unread.
              apply: yield* emitted(
                store.apply({
                  changes: [said(5, "three", "m1"), said(6, "four", "m3"), heard(6, "five")],
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
              // A Read Marker moved, which counts the Timeline again.
              mark: yield* emitted(
                store.apply({ changes: [marked(7, 3)], directory: directoryAt(7), through: 7 })
              ),
              // A merge, which counts the kept Timeline again.
              merge: yield* Effect.andThen(
                store.apply({
                  changes: [
                    {
                      _tag: "Described",
                      sequence: 8,
                      timeline: {
                        id: third,
                        key: "#c",
                        kind: "Channel",
                        name: "#c",
                        network: libera,
                      },
                    },
                    heard(8, "six", third),
                  ],
                  directory: directoryAt(8),
                  through: 8,
                }),
                emitted(
                  store.apply({
                    changes: [
                      { _tag: "Merged", from: third, into: channel, network: libera, sequence: 9 },
                    ],
                    directory: directoryAt(9),
                    through: 9,
                  })
                )
              ),
              overflowed: yield* emitted(store.changedAfter(3, 1)),
              // A search with every filter, through a merged id, and one with none.
              search: yield* emitted(
                store.search({
                  after: { position: at, timeline: channel },
                  from: "Peer",
                  limit: 2,
                  network: libera,
                  since: at.at,
                  text: SearchText.make("thr"),
                  timeline: other,
                  until: position(9, 9).at,
                })
              ),
              searchAll: yield* emitted(store.search({ limit: 2, text: SearchText.make("thr") })),
              // One Timeline by its id, and by an id merged into it.
              timeline: yield* emitted(store.timeline(channel)),
              timelineMerged: yield* emitted(store.timeline(third)),
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

        // The counts of what lies after a Read Marker: one statement for a Timeline, a count
        // for each level, each bounded by the key and a limit, never a walk of its history.
        const recounts = planned.filter(
          (each) => (each.read === "mark" || each.read === "merge") && each.sql.includes("count(*)")
        );

        // A count of a Timeline's items with no level, which walks them all: the check below
        // must tell it from one.
        const unbounded = planOf({
          params: [],
          sql: "SELECT count(*) FROM items WHERE timeline = 'x' AND cursor >= ''",
        });

        // The filter a run once had, on `to_cursor`, which no key bounds: the checks below
        // must tell it from a run.
        const unkeyed = planOf({
          params: [],
          sql: "SELECT count(*) FROM gaps WHERE network = 'libera' AND from_cursor <= 'b' AND (to_cursor IS NULL OR to_cursor >= 'a')",
        });

        database.close();

        expect(mode).toStrictEqual({ journal_mode: "wal" });

        expect({
          bounded: recounts.map(({ plan, sql }) => ({
            counts: plan
              .split("\n")
              .filter((line) => line.includes("items"))
              .map(byLevel),
            limited: (sql.match(/LIMIT/gu) ?? []).length,
          })),
          unbounded: byLevel(unbounded),
        }).toStrictEqual({
          bounded: [
            { counts: [true, true, true, true], limited: 4 },
            { counts: [true, true, true, true], limited: 4 },
          ],
          unbounded: false,
        });

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

        // A search walks the index's matches, finds each item by its row, and keeps only
        // its page of them in order, never walking a table.
        const searched = planned.filter((each) => each.read.startsWith("search"));

        expect(
          searched.map(({ plan, sql }) => ({
            index: plan.split("\n").filter((line) => /SCAN|SEARCH|TEMP/u.test(line)),
            limited: /LIMIT \?\s*$/u.test(sql),
          }))
        ).toStrictEqual([
          {
            index: [
              expect.stringMatching(/^SCAN search VIRTUAL TABLE INDEX \d+:M/u),
              "SEARCH items USING INTEGER PRIMARY KEY (rowid=?)",
              // Where a merged id went, once.
              "SEARCH tombstones USING INDEX sqlite_autoindex_tombstones_1 (id=?)",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            limited: true,
          },
          {
            index: [
              expect.stringMatching(/^SCAN search VIRTUAL TABLE INDEX \d+:M/u),
              "SEARCH items USING INTEGER PRIMARY KEY (rowid=?)",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            limited: true,
          },
        ]);

        // Every read was emitted, and none scans a table or sorts.
        expect(
          Object.entries(reads).filter(([, statements]) => statements.length === 0)
        ).toStrictEqual([]);

        for (const { plan, read, sql } of planned.filter((each) => !searched.includes(each))) {
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
