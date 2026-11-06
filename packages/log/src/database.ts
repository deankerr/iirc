import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Duration, Effect, Predicate } from "effect";
import type { FileSystem, Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { StorageFailed } from "./errors.ts";
import { prepareMigrations } from "./migrations.ts";
import type { LogTooNew } from "./migrations.ts";

// Long enough for a checkpoint on the reader's connection, and short enough that the
// event loop never notices, because `bun:sqlite` waits synchronously.
const busyTimeout = Duration.millis(50);

const synchronousFull = 2;

// The Log's format froze when the soak test began (PROOF-5), and every Log written
// before that has been thrown away. So `1_initial` is the whole of what a Log is, and
// any change to it from here on is a new migration, never an edit to one already here,
// because a Log in the wild has run that one already (RUN-5).
const migrations = SqliteMigrator.fromRecord({
  "1_initial": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // One table for every kind of Entry, so a column is NULL for a kind it does not
    // describe, and `rows.ts` decodes each kind from the columns it has.
    yield* sql`
      CREATE TABLE entries (
        sequence INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('Line', 'Connection', 'Change', 'Deadline', 'Daemon', 'Dropped')
        ),
        network TEXT,
        bytes BLOB,
        cause TEXT,
        chosen INTEGER,
        connection INTEGER,
        cut INTEGER,
        direction TEXT,
        ircd TEXT,
        nicks TEXT,
        username TEXT,
        realname TEXT,
        tuning TEXT,
        phase TEXT,
        reason TEXT,
        refused INTEGER,
        ended_at INTEGER,
        tls TEXT,
        "by" TEXT,
        change TEXT,
        name TEXT,
        version TEXT,
        -- The services an attempt logs in to, as JSON text, and how many of its Lines are
        -- the login sequence (CONN-6).
        services TEXT,
        login_lines INTEGER,
        -- The names of the Credentials scrubbed from a Line's bytes (LOG-6), as JSON text,
        -- and the sequence of the Change that emptied them (LOG-7).
        redacted TEXT,
        redacted_by INTEGER
      ) STRICT
    `;

    // So that each filter the reader offers is a range over an index (LOG-11). Daemon
    // Entries belong to no Network, and a NULL network keeps them out of a Network's.
    yield* sql`CREATE INDEX entries_by_network ON entries (network, sequence)`;
    yield* sql`CREATE INDEX entries_by_kind ON entries (kind, sequence)`;
    yield* sql`CREATE INDEX entries_by_network_and_kind ON entries (network, kind, sequence)`;
  }),
  // Changes no table. An `attempt` Entry's Tuning no longer holds `refusalBackoffMillis`,
  // and no `closed` is marked refused, which a binary that ran only `1_initial` cannot
  // decode. Recording this migration is what has it refuse the Log, and what has a start
  // back the Log up before it writes the new form (RUN-5, LIVE-5).
  "2_tuning_without_refusals": Effect.void,
  // Changes no table. An `attempt` Entry's Tuning no longer holds `firstContactNickLimit`,
  // which a binary before this cannot decode, so it must refuse the Log (RUN-5, CONN-4).
  "3_tuning_without_nick_limit": Effect.void,
});

/**
 * Every migration this binary knows, in order (RUN-5). The format is frozen: any change to
 * the Log is a new migration appended here, as `2_<name>`, and never an edit to `1_initial`.
 * A test may add to them.
 */
export const logMigrations: SqliteMigrator.Loader = migrations;

// A derived table is no part of the Log, so it is here and not in a migration: anyone
// may drop it, and the next start brings it back for the rebuild to fill (LOG-10). Its
// shape is this binary's to choose, so one left by a binary that shaped it otherwise is
// dropped first, and the rebuild fills it again like any other.
interface DerivedTable {
  readonly columns: readonly string[];
  readonly create: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, SqlError>;
  readonly name: string;
}

const derivedTables: readonly DerivedTable[] = [
  {
    columns: [
      "sequence",
      "at",
      "kind",
      "network",
      "sender",
      "target",
      "text",
      "place_kind",
      "place_key",
      "place_name",
      "statusmsg",
    ],
    create: (sql) =>
      Effect.andThen(
        sql`
          CREATE TABLE IF NOT EXISTS messages (
            sequence INTEGER PRIMARY KEY,
            at INTEGER NOT NULL,
            kind TEXT NOT NULL,
            network TEXT NOT NULL,
            sender TEXT NOT NULL,
            target TEXT NOT NULL,
            text TEXT NOT NULL,
            place_kind TEXT NOT NULL,
            place_key TEXT NOT NULL,
            place_name TEXT NOT NULL,
            statusmsg TEXT
          ) STRICT
        `,
        sql`CREATE INDEX IF NOT EXISTS messages_by_network ON messages (network, sequence)`
      ),
    name: "messages",
  },
  {
    columns: ["sequence", "at", "network", "reason", "ended"],
    create: (sql) =>
      Effect.andThen(
        sql`
          CREATE TABLE IF NOT EXISTS gaps (
            sequence INTEGER PRIMARY KEY,
            at INTEGER NOT NULL,
            network TEXT NOT NULL,
            reason TEXT NOT NULL,
            ended TEXT
          ) STRICT
        `,
        sql`CREATE INDEX IF NOT EXISTS gaps_by_network ON gaps (network, sequence)`
      ),
    name: "gaps",
  },
  {
    // One Entry can be many rows, such as a `QUIT` in each Channel it leaves, so a row is
    // its Entry's sequence and its place among that Entry's rows.
    columns: [
      "sequence",
      "ordinal",
      "at",
      "network",
      "place_kind",
      "place_key",
      "place_name",
      "kind",
      "actor",
      "details",
    ],
    create: (sql) =>
      Effect.all([
        sql`
          CREATE TABLE IF NOT EXISTS activity (
            sequence INTEGER NOT NULL,
            ordinal INTEGER NOT NULL,
            at INTEGER NOT NULL,
            network TEXT NOT NULL,
            place_kind TEXT NOT NULL,
            place_key TEXT NOT NULL,
            place_name TEXT NOT NULL,
            kind TEXT NOT NULL,
            actor TEXT,
            details TEXT NOT NULL,
            PRIMARY KEY (sequence, ordinal)
          ) STRICT, WITHOUT ROWID
        `,
        sql`
          CREATE INDEX IF NOT EXISTS activity_by_network ON activity (network, sequence, ordinal)
        `,
        sql`
          CREATE INDEX IF NOT EXISTS activity_by_place
          ON activity (network, place_kind, place_key, sequence, ordinal)
        `,
      ]),
    name: "activity",
  },
];

const createDerivedTables = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  for (const { columns, create, name } of derivedTables) {
    const held = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${name}) ORDER BY cid
    `;

    if (held.length > 0 && held.map((column) => column.name).join(",") !== columns.join(",")) {
      yield* sql`DROP TABLE ${sql(name)}`;
    }

    yield* create(sql);
  }
});

// SQLite's words when it could not grow a file: the database or its journal, or the WAL
// index that even a read needs, which is what a full disk refuses first.
const diskFullCodes: ReadonlySet<unknown> = new Set(["SQLITE_FULL", "SQLITE_IOERR_SHMSIZE"]);

// Whether a failure, or anything that caused it, was SQLite finding no space.
const isDiskFull = (cause: unknown): boolean =>
  Predicate.hasProperty(cause, "code") && diskFullCodes.has(cause.code)
    ? true
    : Predicate.hasProperty(cause, "cause") && isDiskFull(cause.cause);

const storageFailed = (dataDir: string, cause: unknown) =>
  new StorageFailed({
    cause: isDiskFull(cause) ? new Error(`the disk holding ${dataDir} is full`, { cause }) : cause,
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
 * Opens the Log's database, ready to use, until the enclosing scope closes. A Log newer
 * than the binary is refused, and one with migrations to run is backed up first (RUN-5).
 * @param dataDir - The directory holding `iirc.sqlite`, which must exist.
 * @param loader - The migrations to run, which only a test changes.
 * @returns The client, on a connection set up for durable writes.
 */
export const openDatabase = (
  dataDir: string,
  loader: SqliteMigrator.Loader = logMigrations
): Effect.Effect<
  SqlClient.SqlClient,
  LogTooNew | StorageFailed,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    // WAL is requested below instead, where the answer can be checked.
    const sql = yield* SqliteClient.make({
      busyTimeout,
      disableWAL: true,
      filename: `${dataDir}/iirc.sqlite`,
    });

    yield* configure(sql);
    yield* prepareMigrations(sql, dataDir, loader);
    yield* SqliteMigrator.run({ loader }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    yield* createDerivedTables(sql);

    return sql;
  }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.catchTag(["SqlError", "MigrationError"], (cause) =>
      Effect.fail(storageFailed(dataDir, cause))
    )
  );
