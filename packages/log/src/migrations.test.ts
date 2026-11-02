import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import type { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { assert, describe, it } from "@effect/vitest";
import type { NewEntry } from "@iirc/session/entry";
import { Recorder } from "@iirc/session/recorder";
import { attemptInput } from "@iirc/session/testing";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { logMigrations } from "./database.ts";
import { Log, LogTooNew } from "./log.ts";

// RUN-5 with a migration only these tests know, after the Log's own.

// What no Frontend can read as text, so a migration that decoded and wrote back a Line
// would change it.
const bytes = [
  new TextEncoder().encode(":a PRIVMSG #iirc :plain"),
  Uint8Array.of(0xff, 0xfe, 0x00, 0x80, 0x0d),
];

const line = (each: Uint8Array): NewEntry => ({
  _tag: "Line",
  bytes: each,
  connection: 1,
  direction: "inbound",
  network: "libera",
});

// What a Log that has run the binary's own migrations has applied.
const logMigrationNames = ["1_initial", "2_logins_and_redaction"];

// A next migration, as the next format change would be: it adds to the Log and
// rewrites nothing in it.
const withNote: SqliteMigrator.Loader = logMigrations.pipe(
  Effect.map((known) => [
    ...known,
    [
      3,
      "test_note",
      Effect.succeed(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql`ALTER TABLE entries ADD COLUMN test_note TEXT`;
        })
      ),
    ],
  ])
);

// The Log as a9f657d wrote it, before migration 2: its `1_initial` DDL as it was, and the
// rows its Daemon recorded, written by hand because nothing writes that format any more.
const olderLog = (filename: string) => {
  const database = new Database(filename);
  const ircd = JSON.stringify({ host: "irc.example", port: 6697, tls: true });
  const { loginWaitMillis: _, ...tuning } = attemptInput.tuning;

  const lineAt = (sequence: number, direction: string, text: string) =>
    database.run(
      "INSERT INTO entries (sequence, at, kind, network, bytes, connection, direction) VALUES (?, 1000, 'Line', 'libera', ?, 2, ?)",
      [sequence, new TextEncoder().encode(text), direction]
    );

  database.run(`
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
      version TEXT
    ) STRICT
  `);
  database.run("CREATE INDEX entries_by_network ON entries (network, sequence)");
  database.run("CREATE INDEX entries_by_kind ON entries (kind, sequence)");
  database.run("CREATE INDEX entries_by_network_and_kind ON entries (network, kind, sequence)");
  database.run(`
    CREATE TABLE effect_sql_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      name VARCHAR(255) NOT NULL
    )
  `);
  database.run("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'initial')");
  database.run(
    "INSERT INTO entries (sequence, at, kind, version, phase) VALUES (1, 1000, 'Daemon', '0.0.0', 'started')"
  );
  database.run(
    "INSERT INTO entries (sequence, at, kind, network, phase, ircd, nicks, username, realname, tuning) VALUES (2, 1000, 'Connection', 'libera', 'attempt', ?, ?, 'user', 'I IRC', ?)",
    [ircd, JSON.stringify(["alice"]), JSON.stringify(tuning)]
  );
  database.run(
    "INSERT INTO entries (sequence, at, kind, network, phase, ircd, connection) VALUES (3, 1000, 'Connection', 'libera', 'opened', ?, 2)",
    [ircd]
  );
  lineAt(4, "inbound", ":ircd 001 alice :Welcome");
  lineAt(5, "outbound", "PRIVMSG #iirc :said before the upgrade");
  lineAt(6, "inbound", ":bob!u@h PRIVMSG #iirc :my password is hunter2");
  database.close();
};

const dataDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  return yield* fileSystem.makeTempDirectoryScoped({
    directory: "/var/tmp",
    prefix: "iirc-migrations-",
  });
}).pipe(Effect.provide(BunServices.layer));

// Opens the Log with these migrations, runs `use` while it is open, and closes it.
const opened = <A, E>(
  dataDir: string,
  use: Effect.Effect<A, E, Log | Recorder>,
  migrations?: SqliteMigrator.Loader
) =>
  Effect.scoped(
    Effect.flatMap(
      Layer.build(Log.layer({ dataDir, ...(migrations !== undefined && { migrations }) })),
      (context) => Effect.provideContext(use, context)
    )
  );

const recordLines = Recorder.use(({ record }) =>
  record(
    [line(bytes[0] ?? new Uint8Array()), line(bytes[1] ?? new Uint8Array())],
    (recorded) => recorded.length
  )
);

const query = <Row>(filename: string, sql: string) => {
  const database = new Database(filename, { readonly: true });

  try {
    return database.query<Row, []>(sql).all();
  } finally {
    database.close();
  }
};

const lineBytes = (filename: string) =>
  query<{ bytes: Uint8Array }>(
    filename,
    "SELECT bytes FROM entries WHERE kind = 'Line' ORDER BY sequence"
  ).map((row) => Uint8Array.from(row.bytes));

const columns = (filename: string) =>
  query<{ name: string }>(filename, "PRAGMA table_info(entries)").map(({ name }) => name);

const applied = (filename: string) =>
  query<{ migration_id: number; name: string }>(
    filename,
    "SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id"
  ).map(({ migration_id, name }) => `${migration_id}_${name}`);

describe("migrations (RUN-5)", () => {
  it.live(
    "RUN-5: backs up a Log with Entries before a migration runs, and leaves Line bytes as they were",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;
        const live = `${dataDir}/iirc.sqlite`;

        yield* opened(dataDir, recordLines);

        const before = lineBytes(live);

        assert.notInclude(columns(live), "test_note");

        const entries = yield* opened(
          dataDir,
          Log.use(({ entries: read }) => read({ after: 0, limit: 10 })),
          withNote
        );

        const [backup, ...others] = readdirSync(`${dataDir}/backups`);

        assert.lengthOf(others, 0);
        assert.match(backup ?? "", /^pre-migration-2-\d{8}T\d{9}Z\.sqlite$/u);

        // The backup is the Log as it was before: whole, and with no trace of the migration.
        const copy = `${dataDir}/backups/${backup}`;

        assert.deepStrictEqual(query(copy, "PRAGMA quick_check"), [{ quick_check: "ok" }]);
        assert.notInclude(columns(copy), "test_note");
        assert.deepStrictEqual(applied(copy), logMigrationNames);
        assert.deepStrictEqual(lineBytes(copy), before);

        // The Log has the migration, and every Line's bytes as they were.
        assert.include(columns(live), "test_note");
        assert.deepStrictEqual(applied(live), [...logMigrationNames, "3_test_note"]);
        assert.deepStrictEqual(lineBytes(live), before);
        assert.deepStrictEqual(
          entries.flatMap((entry) => (entry._tag === "Line" ? [entry.bytes] : [])),
          before
        );
      }).pipe(Effect.scoped)
  );

  it.live("RUN-5: refuses a Log that applied a migration this binary does not know", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirectory;
      const live = `${dataDir}/iirc.sqlite`;

      // A newer binary migrated it, and this one lacks the last.
      yield* opened(dataDir, recordLines, withNote);

      const before = lineBytes(live);
      const refused = yield* Effect.flip(opened(dataDir, recordLines));

      assert.instanceOf(refused, LogTooNew);
      assert.deepStrictEqual(refused instanceof LogTooNew ? refused.unknown : [], ["3_test_note"]);
      assert.include(refused.message, "newer iirc");
      assert.include(refused.message, "3_test_note");
      // It touched nothing: no Entry was appended, and no backup was taken.
      assert.deepStrictEqual(lineBytes(live), before);
      assert.deepStrictEqual(applied(live), [...logMigrationNames, "3_test_note"]);
      assert.isFalse(existsSync(`${dataDir}/backups`));
    }).pipe(Effect.scoped)
  );

  it.live("RUN-5: takes no backup of a new Log, or of one with nothing to migrate", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirectory;

      yield* opened(dataDir, recordLines);
      yield* opened(dataDir, recordLines);

      assert.isFalse(existsSync(`${dataDir}/backups`));
    }).pipe(Effect.scoped)
  );

  it.live(
    "RUN-5: upgrades a Log a9f657d wrote, backed up, replaying as it did and taking new writes and a redaction",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;
        const live = `${dataDir}/iirc.sqlite`;

        olderLog(live);

        assert.notInclude(columns(live), "login_lines");

        const upgraded = yield* opened(
          dataDir,
          Effect.gen(function* () {
            const log = yield* Log;
            const recorder = yield* Recorder;

            const before = {
              entries: yield* log.entries({ after: 0, limit: 100 }),
              messages: yield* log.messages({ after: 0, limit: 100 }),
              standing: yield* recorder.standing("libera"),
            };

            // New writes: an attempt with the new fields, a Line, and a redaction of an old
            // Line, whose Change is recorded beside it.
            yield* recorder.record(
              [
                {
                  _tag: "Connection",
                  ircd: { host: "irc.example", port: 6697, tls: true },
                  network: "libera",
                  nicks: ["alice"],
                  ...attemptInput,
                  loginLines: 2,
                  phase: "attempt",
                  services: ["NickServ"],
                },
                line(new TextEncoder().encode(":bob!u@h PRIVMSG #iirc :hello again")),
              ],
              (recorded) => recorded
            );

            const change = yield* log.redact(
              6,
              { _tag: "Change", by: "owner", change: { _tag: "EntryRedacted", sequence: 6 } },
              (recorded) => recorded
            );

            return {
              ...before,
              after: yield* log.entries({ after: 6, limit: 100 }),
              change,
              redacted: (yield* log.entries({ after: 5, limit: 1 }))[0],
            };
          })
        );

        // The old attempt reads as it ran: no login sequence and no services.
        const [, attempt] = upgraded.entries;

        assert.deepInclude(attempt, {
          _tag: "Connection",
          loginLines: 0,
          phase: "attempt",
          services: [],
        });
        assert.deepInclude(
          attempt?._tag === "Connection" && attempt.phase === "attempt" ? attempt.tuning : {},
          { loginWaitMillis: 2000 }
        );
        assert.deepStrictEqual(
          upgraded.messages.map(({ sender, text }) => `${sender}: ${text}`),
          ["alice: said before the upgrade", "bob: my password is hunter2"]
        );
        assert.strictEqual(upgraded.standing.self, "alice");

        // The Entries are as they were, and the new ones are whole.
        assert.strictEqual(upgraded.entries.length, 6);
        assert.deepInclude(upgraded.redacted, {
          bytes: new Uint8Array(),
          redactedBy: upgraded.change.sequence,
        });
        assert.deepInclude(upgraded.after[0], { loginLines: 2, services: ["NickServ"] });

        // A backup was taken first, with the Log as it was.
        const [backup, ...others] = readdirSync(`${dataDir}/backups`);

        assert.lengthOf(others, 0);
        assert.match(backup ?? "", /^pre-migration-6-\d{8}T\d{9}Z\.sqlite$/u);
        assert.notInclude(columns(`${dataDir}/backups/${backup}`), "login_lines");
        assert.deepStrictEqual(applied(`${dataDir}/backups/${backup}`), ["1_initial"]);
        assert.deepStrictEqual(applied(live), logMigrationNames);

        // The next start reads the Log it left, with nothing left to migrate.
        const restarted = yield* opened(
          dataDir,
          Log.use(({ entries, messages }) =>
            Effect.all({
              entries: entries({ after: 0, limit: 100 }),
              messages: messages({ after: 0, limit: 100 }),
            })
          )
        );

        assert.lengthOf(restarted.entries, 9);
        assert.deepStrictEqual(
          restarted.messages.map(({ sender, text }) => `${sender}: ${text}`),
          ["alice: said before the upgrade", "bob: hello again"]
        );
        assert.lengthOf(readdirSync(`${dataDir}/backups`), 1);
      }).pipe(Effect.scoped)
  );
});
