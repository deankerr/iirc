import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunFileSystem } from "@effect/platform-bun";
import { PreviewCache } from "@iirc/preview-cache";
import type { Kept, PreviewCacheService } from "@iirc/preview-cache";
import { previewCacheLaws } from "@iirc/preview-cache/testing";
import { holds } from "@iirc/runtime/testing";
import { Effect, Layer, Option } from "effect";
import type { Scope } from "effect";
import { describe, expect, it, vi } from "vitest";

import { layerSqlitePreviewCache, makeSqlitePreviewCache } from "./sqlite-preview-cache.ts";

// A law carries its own ten-second guard against a hang (`holds`), so Vitest must wait longer
// than that, or a law that is only slow under a loaded machine fails as Vitest's timeout.
vi.setConfig({ testTimeout: 20_000 });

// A directory for one test, removed when its Scope ends.
const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(async () => await mkdtemp(path.join(tmpdir(), "iirc-preview-cache-sqlite-"))),
  (directory) =>
    Effect.promise(async () => {
      await rm(directory, { force: true, recursive: true });
    })
);

const temporaryFile = temporaryDirectory.pipe(
  Effect.map((directory) => path.join(directory, "previews.sqlite"))
);

const opened = (file: string) =>
  makeSqlitePreviewCache(file).pipe(Effect.provide(BunFileSystem.layer));

const freshCache = temporaryFile.pipe(Effect.flatMap(opened));

const run = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(effect));

// Opens the file in a Scope of its own, so it is closed again when `use` is done.
const using = <A, E>(file: string, use: (cache: PreviewCacheService) => Effect.Effect<A, E>) =>
  Effect.scoped(opened(file).pipe(Effect.flatMap(use)));

const raw = (file: string, statement: string) => {
  const database = new Database(file);

  database.run(statement);
  database.close();
};

const link = "https://example.com/é";

const kept: Kept = {
  fetched: 1000,
  image: null,
  link,
  shown: 2000,
  state: {
    _tag: "Ready",
    preview: {
      description: null,
      image: null,
      kind: "page",
      link,
      site: "example.com",
      title: "Ünïcode 🙂",
      type: null,
    },
  },
};

describe("the SQLite Preview cache", () => {
  it.each(previewCacheLaws)("$name", async (law) => {
    await expect(Effect.runPromise(holds(law, freshCache))).resolves.toBeUndefined();
  });

  it("keeps a record across closing and opening the file", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(kept));

        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.some(kept));
      })
    );
  });

  it("provides the cache as a Layer", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const layer = layerSqlitePreviewCache(file).pipe(Layer.provide(BunFileSystem.layer));

        yield* PreviewCache.use((cache) => cache.put(kept)).pipe(Effect.provide(layer));

        expect(
          yield* PreviewCache.use((cache) => cache.get(link)).pipe(Effect.provide(layer))
        ).toStrictEqual(Option.some(kept));
      })
    );
  });

  it("fails reading a row that does not decode, and keeps the file", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(kept));
        raw(file, `UPDATE previews SET state = '{"_tag":"Nope"}'`);

        const failure = yield* using(file, (cache) => cache.get(link)).pipe(Effect.flip);

        expect(failure._tag).toBe("PreviewCacheFailed");
        expect(failure.reason).toContain("cannot decode");
      })
    );
  });
});

describe("a file it cannot use", () => {
  it("makes a file of another user_version again", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(kept));
        raw(file, "PRAGMA user_version = 99");

        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.none());
        yield* using(file, (cache) => cache.put(kept));
        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.some(kept));
      })
    );
  });

  it("makes a file of the layout before images were referred to again", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(kept));
        raw(file, "DROP INDEX previews_image");
        raw(file, "PRAGMA user_version = 1");

        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.none());
      })
    );
  });

  it("makes a file of this version whose table lacks a column again", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(kept));
        raw(file, "ALTER TABLE previews DROP COLUMN fetched");

        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.none());
      })
    );
  });

  it("makes a file that is not a database again", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        writeFileSync(file, "this is not a database, it is a long lie".repeat(50));

        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.none());
        yield* using(file, (cache) => cache.put(kept));
        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.some(kept));
      })
    );
  });

  it("fails with PreviewCacheFailed for a path that cannot be opened, and removes nothing", async () => {
    await run(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;

        const failure = yield* Effect.scoped(
          opened(path.join(directory, "missing", "previews.sqlite"))
        ).pipe(Effect.flip);

        expect(failure._tag).toBe("PreviewCacheFailed");
        expect(failure.reason).toContain("unable to open database file");
        expect(yield* Effect.promise(async () => await readdir(directory))).toStrictEqual([]);
      })
    );
  });

  it("fails while another connection holds it locked, and keeps the file as it was", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(kept));

        const holder = new Database(file);

        holder.run("PRAGMA locking_mode = EXCLUSIVE");
        holder.run("BEGIN EXCLUSIVE");

        const failure = yield* Effect.scoped(
          makeSqlitePreviewCache(file, { busyTimeout: "50 millis" }).pipe(
            Effect.provide(BunFileSystem.layer)
          )
        ).pipe(Effect.flip);

        holder.run("ROLLBACK");
        holder.close();

        expect(failure._tag).toBe("PreviewCacheFailed");
        expect(failure.reason).toContain("database is locked");
        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.some(kept));
      })
    );
  });
});
