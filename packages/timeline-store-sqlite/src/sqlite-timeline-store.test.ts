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
import { Effect, Layer, Option } from "effect";
import type { Scope } from "effect";
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

describe("the file", () => {
  it("is in WAL mode, and answers each read through an index", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, applyAll);
        const database = new Database(file, { readonly: true });
        const mode = database.query("PRAGMA journal_mode").get();

        const plan = (statement: string) =>
          JSON.stringify(database.query(`EXPLAIN QUERY PLAN ${statement}`).all());

        const reads = {
          byChanged: plan(
            "SELECT * FROM items WHERE changed > 1 AND changed <= 3 ORDER BY changed, timeline, cursor"
          ),
          byIntent: plan("SELECT * FROM items WHERE network = 'libera' AND intent = 'x'"),
          byMessageId: plan("SELECT 1 FROM items WHERE timeline = 'a' AND message_id = 'm'"),
          byStep: plan(
            "SELECT * FROM items WHERE network = 'libera' AND step = 3 ORDER BY cursor, timeline"
          ),
          gapsByChanged: plan(
            "SELECT * FROM gaps WHERE changed > 1 ORDER BY changed, network, from_cursor"
          ),
          timelinesByNetwork: plan("SELECT * FROM timelines WHERE network = 'libera' ORDER BY id"),
          tombstonesByChanged: plan(
            "SELECT * FROM tombstones WHERE changed > 1 ORDER BY changed, id"
          ),
          window: plan(
            "SELECT * FROM items WHERE timeline = 'a' AND cursor < 'b' ORDER BY cursor DESC LIMIT 5"
          ),
        };

        database.close();
        expect(mode).toStrictEqual({ journal_mode: "wal" });

        for (const [read, found] of Object.entries(reads)) {
          expect([read, found]).not.toStrictEqual([
            read,
            expect.stringMatching(
              /SCAN items|SCAN timelines|SCAN gaps|SCAN tombstones|TEMP B-TREE/u
            ),
          ]);
        }
      })
    );
  });
});
