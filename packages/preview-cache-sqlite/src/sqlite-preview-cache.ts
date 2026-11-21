// The cache is disposable (ADR 0017), so this adapter never refuses a file: one it cannot use
// is removed and made again, and the Daemon fetches what it needs once more.
//
// Each operation is one statement, so it is kept whole or not at all. `@effect/sql-sqlite-bun`
// runs every statement on one connection, so a read never sees part of another's write.
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Held, Kept, PreviewCache, PreviewCacheFailed, Settled } from "@iirc/preview-cache";
import type { PreviewCacheService } from "@iirc/preview-cache";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import type { Duration, Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import type { SqlClient } from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";

/**
 * The version of the file's layout, in SQLite's `user_version`. A file of an earlier version
 * that has a step to this one is brought up to it, and one of any other is made again.
 */
const layoutVersion = 6;

// The versions that have a step, each the layout of this table with Previews as that
// version wrote them.
const versionBefore = 5;
const versionBeforeThat = 4;

// Brings a file of 4 up to 5: each Preview's `media` is its `stream`. A row that is not JSON
// is left as it is, to fail its own read as it did before.
const fromBeforeThat = `UPDATE previews SET state = json_set(
  json_remove(state, '$.preview.media'),
  '$.preview.stream',
  json_extract(state, '$.preview.media')
) WHERE CASE WHEN json_valid(state) THEN json_type(state, '$.preview.media') IS NOT NULL END`;

// Brings a file of 5 up to this one: a Preview's image, which had no size, has none stated
// now, until the Preview is fetched again. A row that is not JSON, or whose image is none, is
// left as it is.
const fromBefore = `UPDATE previews SET state = json_set(
  state,
  '$.preview.image.dimensions',
  json('null')
) WHERE CASE WHEN json_valid(state) THEN json_type(state, '$.preview.image') = 'object' END`;

const decodeCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

// SQLite's extended result code, such as `SQLITE_IOERR_GETTEMPPATH`, which names the cause
// where the message says only `disk I/O error`. Carried to be read, never decided from.
const codeOf = (native: Error) =>
  Option.match(decodeCode(native), { onNone: () => "", onSome: ({ code }) => ` (${code})` });

// What SQLite itself said, when the error carries it. An SQL error's own message is generic,
// and keeps SQLite's error in its reason's cause. Another error may keep one in its cause.
const failed =
  (what: string) => (error: { readonly message: string; readonly cause?: unknown }) => {
    const native = error instanceof SqlError ? error.reason.cause : error.cause;

    return new PreviewCacheFailed({
      reason: `${what}: ${native instanceof Error ? `${native.message}${codeOf(native)}` : error.message}`,
    });
  };

const decodeErrno = Schema.decodeUnknownOption(Schema.Struct({ errno: Schema.Int }));

// SQLite's primary result codes that say a file is not a database, or is damaged. Each is read
// from the native error's number, never its text. Extended codes keep the primary code in
// their low byte.
const damaged = new Set([11, 26]);

const isDamage = (error: SqlError) =>
  Option.match(decodeErrno(error.reason.cause), {
    onNone: () => false,
    onSome: ({ errno }) => damaged.has(errno % 256),
  });

const layout = `CREATE TABLE previews (
  link TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  image TEXT,
  fetched INTEGER NOT NULL,
  shown INTEGER NOT NULL
) STRICT`;

// Whether a record holds an image is asked by its hash, for every image served.
const imageIndex = "CREATE INDEX previews_image ON previews (image) WHERE image IS NOT NULL";

// The layout's tables and their columns, each with its declared type, as SQLite's
// `table_info` describes them, in the order they were declared.
const columns = [
  "previews.link TEXT",
  "previews.state TEXT",
  "previews.image TEXT",
  "previews.fetched INTEGER",
  "previews.shown INTEGER",
].join("\n");

/** What a file was found to be. */
type Found = "Before" | "BeforeThat" | "Empty" | "Ready" | "Unusable";

// Reads only, so it changes nothing in the file. A file is of an earlier version when its
// `user_version` says so and its table is this one. A file is unusable when its layout is not
// this cache's or one with a step, or when SQLite says it is not a database or is damaged.
// Any other failure, such as a lock held too long, fails, and leaves the file as it is.
const inspect = (sql: SqlClient): Effect.Effect<Found, SqlError> =>
  Effect.gen(function* () {
    const versions = yield* sql<{
      readonly version: number;
    }>`SELECT user_version AS version FROM pragma_user_version`;

    const objects = yield* sql<{
      readonly count: number;
    }>`SELECT count(*) AS count FROM sqlite_master`;

    const version = versions[0]?.version ?? 0;

    if (version === 0 && objects[0]?.count === 0) {
      return "Empty" as const;
    }

    if (version !== layoutVersion && version !== versionBefore && version !== versionBeforeThat) {
      return "Unusable" as const;
    }

    const found = yield* sql<{ readonly column: string }>`
      SELECT tables.name || '.' || info.name || ' ' || info.type AS "column"
      FROM pragma_table_list AS tables, pragma_table_info(tables.name) AS info
      WHERE tables.schema = 'main' AND tables.type = 'table'
        AND tables.name NOT LIKE 'sqlite~_%' ESCAPE '~'
      ORDER BY tables.name, info.cid
    `;

    if (found.map(({ column }) => column).join("\n") !== columns) {
      return "Unusable" as const;
    }

    if (version === layoutVersion) {
      return "Ready" as const;
    }

    return version === versionBefore ? ("Before" as const) : ("BeforeThat" as const);
  }).pipe(Effect.catchIf(isDamage, () => Effect.succeed("Unusable" as const)));

// Removes the file and what SQLite keeps beside it, so it is made again from nothing.
const remove = (filename: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      yield* fs
        .remove(`${filename}${suffix}`, { force: true })
        .pipe(Effect.mapError(failed(`cannot remove ${filename}${suffix}`)));
    }
  });

/** Seams for tests. */
export interface OpenOptions {
  /** How long a statement waits on a lock another connection holds. 5 seconds unless given. */
  readonly busyTimeout?: Duration.Input | undefined;
}

const open = (filename: string, options: OpenOptions) =>
  SqliteClient.make({
    busyTimeout: options.busyTimeout ?? "5 seconds",
    disableWAL: true,
    filename,
  }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(failed(`cannot open ${filename}`)));

// A row as it is kept: the state is the JSON text of its encoding.
const Row = Schema.Struct({
  ...Kept.fields,
  state: Schema.fromJsonString(Schema.toCodecJson(Settled)),
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const decodeHeld = Schema.decodeUnknownEffect(Schema.Array(Held));
const encodeState = Schema.encodeEffect(Row.fields.state);

/**
 * Opens a Preview cache in a SQLite file, creating it when it does not exist, and making it
 * again when it is not a cache of this layout. It is closed when the Scope ends.
 * @param filename - The path of the database file.
 * @param options - Seams for tests.
 * @returns The cache.
 */
export const makeSqlitePreviewCache = (
  filename: string,
  options: OpenOptions = {}
): Effect.Effect<PreviewCacheService, PreviewCacheFailed, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // A path that cannot be opened, or a file that cannot be read now, is a failure, and
    // nothing is removed. A file that is not a cache of this layout, or is damaged, is
    // disposable, so it is made again.
    const found = yield* Effect.scoped(
      open(filename, options).pipe(
        Effect.flatMap((sql) =>
          inspect(sql).pipe(Effect.mapError(failed(`cannot read ${filename}`)))
        )
      )
    );

    if (found === "Unusable") {
      yield* Effect.logWarning("The Preview cache is not of this layout, so it is made again").pipe(
        Effect.annotateLogs({ file: filename })
      );
      yield* remove(filename);
    }

    const sql = yield* open(filename, options);

    // Losing the last commits to a power failure loses only fetches.
    yield* sql`PRAGMA synchronous = NORMAL`.pipe(Effect.mapError(failed("cannot configure")));
    // SQLite's temporary files, such as a statement's journal, are kept in memory, so the
    // cache asks for no directory but its own.
    yield* sql`PRAGMA temp_store = MEMORY`.pipe(Effect.mapError(failed("cannot configure")));
    yield* sql
      .withTransaction(
        inspect(sql).pipe(
          Effect.flatMap((now): Effect.Effect<void, SqlError | PreviewCacheFailed> => {
            switch (now) {
              case "Empty": {
                return sql
                  .unsafe(layout)
                  .pipe(
                    Effect.andThen(sql.unsafe(imageIndex)),
                    Effect.andThen(sql.unsafe(`PRAGMA user_version = ${layoutVersion}`))
                  );
              }

              case "BeforeThat": {
                return sql
                  .unsafe(fromBeforeThat)
                  .pipe(
                    Effect.andThen(sql.unsafe(fromBefore)),
                    Effect.andThen(sql.unsafe(`PRAGMA user_version = ${layoutVersion}`))
                  );
              }

              case "Before": {
                return sql
                  .unsafe(fromBefore)
                  .pipe(Effect.andThen(sql.unsafe(`PRAGMA user_version = ${layoutVersion}`)));
              }

              case "Ready": {
                return Effect.void;
              }

              case "Unusable": {
                return Effect.fail(
                  new PreviewCacheFailed({ reason: `${filename} changed while it was opened` })
                );
              }

              default: {
                return now satisfies never;
              }
            }
          })
        )
      )
      .pipe(
        Effect.catchTag("SqlError", (error) => Effect.fail(failed("cannot make the cache")(error)))
      );
    yield* sql`PRAGMA journal_mode = WAL`.pipe(Effect.mapError(failed("cannot configure")));

    const one = (what: string, rows: Effect.Effect<readonly unknown[], SqlError>) =>
      rows.pipe(
        Effect.mapError(failed(`cannot ${what}`)),
        Effect.flatMap((got) =>
          decodeRows(got).pipe(Effect.mapError(failed(`cannot decode ${what}`)))
        ),
        Effect.map(([kept]) => Option.fromUndefinedOr(kept))
      );

    return {
      evict: (hash) =>
        sql`
          UPDATE previews
          SET image = NULL,
              fetched = 0,
              state = json_set(state, '$.preview.image', json('null'))
          WHERE image = ${hash}
        `.pipe(Effect.mapError(failed("cannot drop a Preview's image")), Effect.asVoid),
      get: (link) =>
        one(
          "read a Preview",
          sql`SELECT link, state, image, fetched, shown FROM previews WHERE link = ${link}`
        ),
      images: sql`
        SELECT image AS hash,
               max(shown) AS shown,
               coalesce(max(json_extract(state, '$.preview.image.size')), 0) AS size
        FROM previews
        WHERE image IS NOT NULL
        GROUP BY image
        ORDER BY max(shown), image
      `.pipe(
        Effect.mapError(failed("cannot read the Previews' images")),
        Effect.flatMap((rows) =>
          decodeHeld(rows).pipe(Effect.mapError(failed("cannot decode the Previews' images")))
        )
      ),
      put: (kept) =>
        encodeState(kept.state).pipe(
          Effect.mapError(failed("cannot encode a Preview")),
          Effect.flatMap((state) =>
            sql`
                INSERT OR REPLACE INTO previews (link, state, image, fetched, shown)
                VALUES (${kept.link}, ${state}, ${kept.image}, ${kept.fetched}, ${kept.shown})
              `.pipe(Effect.mapError(failed("cannot keep a Preview")))
          ),
          Effect.asVoid
        ),
      refers: (hash) =>
        sql<{ readonly held: number }>`
          SELECT EXISTS (SELECT 1 FROM previews WHERE image = ${hash}) AS held
        `.pipe(
          Effect.mapError(failed("cannot read a Preview's image")),
          Effect.map(([row]) => row?.held === 1)
        ),
      shown: (link, at) =>
        one(
          "mark a Preview shown",
          sql`
            UPDATE previews SET shown = max(shown, ${at}) WHERE link = ${link}
            RETURNING link, state, image, fetched, shown
          `
        ),
    };
  });

/**
 * The Preview cache, as a Layer, in a SQLite file.
 * @param filename - The path of the database file.
 * @returns The Layer.
 */
export const layerSqlitePreviewCache = (filename: string) =>
  Layer.effect(PreviewCache)(makeSqlitePreviewCache(filename));
