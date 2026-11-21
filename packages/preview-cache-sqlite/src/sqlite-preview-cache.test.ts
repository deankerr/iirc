import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunFileSystem } from "@effect/platform-bun";
import { Kept } from "@iirc/preview-cache";
import type { PreviewCacheService } from "@iirc/preview-cache";
import { previewCacheLaws } from "@iirc/preview-cache/testing";
import { holds } from "@iirc/runtime/testing";
import { Effect, Logger, Option, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { makeSqlitePreviewCache } from "./sqlite-preview-cache.ts";

// No logger, so what the code under test logs is not printed over the test run.
const quiet = Logger.layer([]);

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
  await Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(quiet)));

// Opens the file in a Scope of its own, so it is closed again when `use` is done.
const using = <A, E>(file: string, use: (cache: PreviewCacheService) => Effect.Effect<A, E>) =>
  Effect.scoped(opened(file).pipe(Effect.flatMap(use)));

const raw = (file: string, statement: string) => {
  const database = new Database(file);

  database.run(statement);
  database.close();
};

const link = "https://example.com/é";

const page: Extract<Kept["state"], { readonly _tag: "Ready" }>["preview"] = {
  description: null,
  image: null,
  kind: "page",
  link,
  player: null,
  site: "example.com",
  stream: null,
  title: "Ünïcode 🙂",
  type: null,
};

const kept: Kept = {
  fetched: 1000,
  image: null,
  link,
  shown: 2000,
  state: { _tag: "Ready", preview: page },
};

const hash = Schema.decodeSync(Kept.fields.image.members[0])("ab".repeat(32));

// A Preview with an image of a size the bytes state.
const sized: Kept = {
  ...kept,
  image: hash,
  state: {
    _tag: "Ready",
    preview: {
      ...page,
      image: {
        animated: false,
        dimensions: { height: 480, width: 640 },
        hash,
        size: 1234,
        type: "image/png",
      },
      kind: "image",
    },
  },
};

// The record as a layout before the sizes wrote it, which a file of that layout holds.
const unsized = (version: 4 | 5) =>
  `UPDATE previews SET state = json_remove(state, '$.preview.image.dimensions');
   ${version === 4 ? `UPDATE previews SET state = replace(state, '"stream":', '"media":');` : ""}
   PRAGMA user_version = ${version}`;

const withoutSize: Kept =
  sized.state._tag === "Ready" && sized.state.preview.image !== null
    ? {
        ...sized,
        state: {
          ...sized.state,
          preview: {
            ...sized.state.preview,
            image: { ...sized.state.preview.image, dimensions: null },
          },
        },
      }
    : sized;

describe("the SQLite Preview cache", () => {
  it.each(previewCacheLaws)("$name", async (law) => {
    await expect(Effect.runPromise(holds(law, freshCache))).resolves.toBeUndefined();
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

describe("a file of the layout before", () => {
  it("reads a Preview kept with its stream as media, as it was", async () => {
    const video = "https://example.com/cat.mp4";

    const streamed: Kept = {
      ...kept,
      state: {
        _tag: "Ready",
        preview: { ...page, kind: "video", stream: video, type: "video/mp4" },
      },
    };

    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(streamed));
        raw(
          file,
          `UPDATE previews SET state = replace(state, '"stream":', '"media":');
           PRAGMA user_version = 4`
        );

        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.some(streamed));
      })
    );
  });

  it("reads a Preview kept before sizes with none, and still refers to, lists, and evicts its image", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(sized));
        yield* using(file, (cache) => cache.put({ ...kept, link: "https://example.com/plain" }));
        raw(file, unsized(5));

        yield* using(file, (cache) =>
          Effect.gen(function* () {
            expect(yield* cache.get(link)).toStrictEqual(Option.some(withoutSize));
            expect(yield* cache.get("https://example.com/plain")).toStrictEqual(
              Option.some({ ...kept, link: "https://example.com/plain" })
            );
            expect(yield* cache.refers(hash)).toBeTruthy();
            expect(yield* cache.images).toStrictEqual([{ hash, shown: 2000, size: 1234 }]);

            yield* cache.evict(hash);
            expect(yield* cache.refers(hash)).toBeFalsy();
          })
        );
      })
    );
  });

  it("reads a Preview kept two layouts before, with its media and its image, as it is now but for the size", async () => {
    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;
        const video = "https://example.com/cat.mp4";

        const streamed: Kept =
          sized.state._tag === "Ready"
            ? {
                ...sized,
                state: {
                  ...sized.state,
                  preview: { ...sized.state.preview, kind: "video", stream: video },
                },
              }
            : sized;

        yield* using(file, (cache) => cache.put(streamed));
        raw(file, unsized(4));

        const expected: Kept =
          withoutSize.state._tag === "Ready"
            ? {
                ...withoutSize,
                state: {
                  ...withoutSize.state,
                  preview: { ...withoutSize.state.preview, kind: "video", stream: video },
                },
              }
            : withoutSize;

        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.some(expected));
      })
    );
  });

  it("opens with a row that is not JSON, which fails only its own read", async () => {
    const other = "https://example.com/other";

    await run(
      Effect.gen(function* () {
        const file = yield* temporaryFile;

        yield* using(file, (cache) => cache.put(kept));
        yield* using(file, (cache) => cache.put({ ...kept, link: other }));
        raw(
          file,
          `UPDATE previews SET state = 'not json' WHERE link = '${other}';
           PRAGMA user_version = 4`
        );

        expect(yield* using(file, (cache) => cache.get(link))).toStrictEqual(Option.some(kept));
        expect((yield* using(file, (cache) => cache.get(other)).pipe(Effect.flip))._tag).toBe(
          "PreviewCacheFailed"
        );
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
        expect(failure.reason).toContain("unable to open database file (SQLITE_CANTOPEN)");
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
