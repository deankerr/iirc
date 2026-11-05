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

// What a binary from before the Log's second migration knew.
const firstOnly: SqliteMigrator.Loader = logMigrations.pipe(
  Effect.map((known) => known.filter(([id]) => id === 1))
);

// What a binary from before the Log's third migration knew.
const beforeNickLimit: SqliteMigrator.Loader = logMigrations.pipe(
  Effect.map((known) => known.filter(([id]) => id <= 2))
);

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
const logMigrationNames = ["1_initial", "2_tuning_without_refusals", "3_tuning_without_nick_limit"];

// The next migration, as the first format change after the freeze will be: it adds to the Log and
// rewrites nothing in it.
const withNote: SqliteMigrator.Loader = logMigrations.pipe(
  Effect.map((known) => [
    ...known,
    [
      4,
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

// An `attempt` and its `closed`, as every Log has.
const recordAttemptAndClose = Recorder.use(({ record }) =>
  record(
    [
      {
        _tag: "Connection",
        ircd: { host: "irc.test", port: 6697, tls: true },
        network: "libera",
        nicks: ["iirc"],
        ...attemptInput,
        phase: "attempt",
      },
      {
        _tag: "Connection",
        connection: 1,
        ircd: { host: "irc.test", port: 6697, tls: true },
        network: "libera",
        phase: "closed",
        reason: "You are banned",
      },
    ],
    (recorded) => recorded.length
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
        assert.deepStrictEqual(applied(live), [...logMigrationNames, "4_test_note"]);
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
      assert.deepStrictEqual(refused instanceof LogTooNew ? refused.unknown : [], ["4_test_note"]);
      assert.include(refused.message, "newer iirc");
      assert.include(refused.message, "4_test_note");
      // It touched nothing: no Entry was appended, and no backup was taken.
      assert.deepStrictEqual(lineBytes(live), before);
      assert.deepStrictEqual(applied(live), [...logMigrationNames, "4_test_note"]);
      assert.isFalse(existsSync(`${dataDir}/backups`));
    }).pipe(Effect.scoped)
  );

  it.live("RUN-5, LIVE-5: an iirc from before refusals went refuses a Log this one wrote", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirectory;

      yield* opened(dataDir, recordLines);

      const refused = yield* Effect.flip(opened(dataDir, recordLines, firstOnly));

      assert.instanceOf(refused, LogTooNew);
      assert.deepStrictEqual(refused instanceof LogTooNew ? refused.unknown : [], [
        "2_tuning_without_refusals",
        "3_tuning_without_nick_limit",
      ]);
    }).pipe(Effect.scoped)
  );

  it.live(
    "RUN-5, CONN-4: an iirc from before the nick limit went refuses a Log this one wrote",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;

        yield* opened(dataDir, recordLines);

        const refused = yield* Effect.flip(opened(dataDir, recordLines, beforeNickLimit));

        assert.instanceOf(refused, LogTooNew);
        assert.deepStrictEqual(refused instanceof LogTooNew ? refused.unknown : [], [
          "3_tuning_without_nick_limit",
        ]);
      }).pipe(Effect.scoped)
  );

  it.live(
    "RUN-5, LIVE-5, CONN-4: a Log from before is backed up, and its old Tuning and marks still read",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;
        const live = `${dataDir}/iirc.sqlite`;

        yield* opened(dataDir, recordAttemptAndClose, firstOnly);

        // What that binary wrote: its Tuning had the wait, and its close the mark.
        const database = new Database(live);

        try {
          database.run(
            "UPDATE entries SET tuning = json_set(tuning, '$.refusalBackoffMillis', 1800000, '$.firstContactNickLimit', 9) WHERE phase = 'attempt'"
          );
          database.run("UPDATE entries SET refused = 1 WHERE phase = 'closed'");
        } finally {
          database.close();
        }

        const read = yield* opened(
          dataDir,
          Log.use(({ entries: all }) => all({ after: 0, limit: 10 }))
        );

        const phases = read.flatMap((entry) => (entry._tag === "Connection" ? [entry] : []));

        assert.lengthOf(readdirSync(`${dataDir}/backups`), 1);
        assert.deepStrictEqual(applied(live), logMigrationNames);
        assert.deepStrictEqual(
          phases.map((entry) => entry.phase),
          ["attempt", "closed"]
        );
        assert.notProperty(
          phases[0]?.phase === "attempt" ? phases[0].tuning : {},
          "refusalBackoffMillis"
        );
        assert.notProperty(
          phases[0]?.phase === "attempt" ? phases[0].tuning : {},
          "firstContactNickLimit"
        );
        assert.isTrue(phases[1]?.phase === "closed" && phases[1].refused === true);
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
    "RUN-5: a Log a later migration upgraded keeps its Entries, and takes new writes and a redaction",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* dataDirectory;

        yield* opened(dataDir, recordLines);

        const upgraded = yield* opened(
          dataDir,
          Effect.gen(function* () {
            const log = yield* Log;
            const recorder = yield* Recorder;
            const before = yield* log.entries({ after: 0, limit: 100 });

            // An attempt with its login fields, a Line, and a redaction of the first Line,
            // whose Change is recorded beside it.
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
              1,
              { _tag: "Change", by: "owner", change: { _tag: "EntryRedacted", sequence: 1 } },
              (recorded) => recorded
            );

            return {
              after: yield* log.entries({ after: before.length, limit: 100 }),
              before,
              change,
              redacted: (yield* log.entries({ after: 0, limit: 1 }))[0],
            };
          }),
          withNote
        );

        assert.lengthOf(upgraded.before, 2);
        assert.deepInclude(upgraded.after[0], { loginLines: 2, services: ["NickServ"] });
        assert.deepInclude(upgraded.redacted, {
          bytes: new Uint8Array(),
          redactedBy: upgraded.change.sequence,
        });
        assert.lengthOf(readdirSync(`${dataDir}/backups`), 1);
      }).pipe(Effect.scoped)
  );
});
