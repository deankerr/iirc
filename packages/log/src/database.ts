import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Duration, Effect } from "effect";
import type { Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";

import { StorageFailed } from "./errors.ts";

// Long enough for a checkpoint on a future read connection, and short enough that
// the event loop never notices, because `bun:sqlite` waits synchronously.
const busyTimeout = Duration.millis(50);

const synchronousFull = 2;

const migrations = SqliteMigrator.fromRecord({
  "1_initial": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE entries (
        sequence INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('Line', 'Connection', 'Deadline', 'Daemon', 'Dropped')),
        network TEXT,
        bytes BLOB,
        cause TEXT,
        chosen INTEGER,
        connection INTEGER,
        cut INTEGER,
        direction TEXT,
        ircd TEXT,
        nicks TEXT,
        phase TEXT,
        reason TEXT,
        refused INTEGER,
        name TEXT,
        version TEXT
      ) STRICT
    `;
  }),
});

// A derived table is no part of the Log, so it is here and not in a migration: anyone
// may drop it, and the next start brings it back for the rebuild to fill (LOG-10).
const createDerivedTables = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  yield* sql`
    CREATE TABLE IF NOT EXISTS messages (
      sequence INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      network TEXT NOT NULL,
      sender TEXT NOT NULL,
      target TEXT NOT NULL,
      text TEXT NOT NULL
    ) STRICT
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS gaps (
      sequence INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      network TEXT NOT NULL,
      reason TEXT NOT NULL,
      ended TEXT
    ) STRICT
  `;
});

const configure = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  // SQLite answers with the mode it ended up in, and may keep the old one silently.
  const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode = WAL`;
  yield* sql`PRAGMA synchronous = FULL`;
  const [durability] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;

  if (journal?.journal_mode !== "wal" || durability?.synchronous !== synchronousFull) {
    return yield* new StorageFailed({ cause: { durability, journal } });
  }

  return sql;
});

/**
 * Opens the Log's database, ready to use, until the enclosing scope closes.
 * @param dataDir - The directory holding `iirc.sqlite`, which must exist.
 * @returns The client, on a connection set up for durable writes.
 */
export const openDatabase = (
  dataDir: string
): Effect.Effect<SqlClient.SqlClient, StorageFailed, Scope.Scope> =>
  Effect.gen(function* () {
    // WAL is requested below instead, where the answer can be checked.
    const sql = yield* SqliteClient.make({
      busyTimeout,
      disableWAL: true,
      filename: `${dataDir}/iirc.sqlite`,
    });

    yield* configure(sql);
    yield* SqliteMigrator.run({ loader: migrations }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql)
    );
    yield* createDerivedTables(sql);

    return sql;
  }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.catchTag(["SqlError", "MigrationError"], (cause) =>
      Effect.fail(new StorageFailed({ cause }))
    )
  );
