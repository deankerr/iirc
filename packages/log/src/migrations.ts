import { Database } from "bun:sqlite";

import type { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Data, Effect } from "effect";
import type { SqlClient } from "effect/sql";

import { keepBackup, vacuumInto } from "./backup.ts";
import { StorageFailed } from "./errors.ts";

/** The table the migrator records each migration it applied in. */
const migrationsTable = "effect_sql_migrations";

/**
 * The Log has applied a migration this binary does not know, so it was written by a newer
 * iirc, and this one will not touch it (RUN-5).
 */
export class LogTooNew extends Data.TaggedError("LogTooNew")<{
  readonly dataDir: string;
  /** Each migration the Log has and this binary lacks, as `<id>_<name>`. */
  readonly unknown: readonly string[];
}> {
  override readonly message = `The Log in ${this.dataDir} was written by a newer iirc, which applied migrations this one does not know (${this.unknown.join(", ")}), so it will not open it. Run that newer iirc, or restore a backup taken before it ran.`;
}

const tableExists = (sql: SqlClient.SqlClient, name: string) =>
  Effect.map(
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${name}
    `,
    (rows) => rows.length > 0
  );

const applied = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  if (!(yield* tableExists(sql, migrationsTable))) {
    return [];
  }

  return yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(migrationsTable)} ORDER BY migration_id
  `;
});

const hasEntries = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  if (!(yield* tableExists(sql, "entries"))) {
    return false;
  }

  return (yield* sql`SELECT 1 FROM entries LIMIT 1`).length > 0;
});

// A read connection of its own, as every backup takes, though nothing else is running
// yet, so this one may block (RUN-2).
const copyLog = (dataDir: string) => (into: string) =>
  Effect.try({
    catch: (cause) => new StorageFailed({ cause }),
    try: () => {
      const database = new Database(`${dataDir}/iirc.sqlite`, { readonly: true });

      try {
        return vacuumInto(database, into);
      } finally {
        database.close();
      }
    },
  });

/**
 * Makes the Log ready for its migrations to run (RUN-5). A Log that has applied a
 * migration this binary does not know is refused, because it is newer than the binary.
 * A Log with Entries and a migration still to apply is backed up first, to
 * `backups/pre-migration-…`, so that a migration gone wrong costs nothing.
 * @param sql - The writer's connection, before any migration has run.
 * @param dataDir - The data directory.
 * @param loader - Every migration this binary knows.
 * @returns The backup it took, if it took one, once the migrations may run.
 */
export const prepareMigrations = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  dataDir: string,
  loader: SqliteMigrator.Loader
) {
  const known = yield* loader;
  const knownIds = new Set(known.map(([id, name]) => `${id}_${name}`));
  const done = yield* applied(sql);
  const unknown = done.map(({ migration_id, name }) => `${migration_id}_${name}`);
  const newer = unknown.filter((id) => !knownIds.has(id));

  if (newer.length > 0) {
    return yield* new LogTooNew({ dataDir, unknown: newer });
  }

  // The migrator runs every migration past the latest it applied, and nothing else.
  const latest = Math.max(0, ...done.map(({ migration_id }) => migration_id));
  const pending = known.some(([id]) => id > latest);

  return pending && (yield* hasEntries(sql))
    ? yield* keepBackup(dataDir, "pre-migration", copyLog(dataDir))
    : undefined;
});
