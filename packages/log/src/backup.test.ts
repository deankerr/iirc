import { Database } from "bun:sqlite";
import { chmodSync, readdirSync, statSync, writeSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import type { NewEntry } from "@iirc/session/entry";
import { Recorder } from "@iirc/session/recorder";
import { Effect, Exit, Fiber, FileSystem, Layer, Ref } from "effect";
import type { Scope } from "effect";

import { Log, LogReader } from "./log.ts";
import type { LogReaderOptions } from "./log.ts";

// RUN-2 from the outside: a backup is a whole, checked copy of the Log, taken while it
// runs, on a Worker of its own, so that neither appends nor reads wait for it.

const encoder = new TextEncoder();

const line = (text: string): NewEntry => ({
  _tag: "Line",
  bytes: encoder.encode(text),
  connection: 1,
  direction: "inbound",
  network: "libera",
});

const record = (text: string) =>
  Recorder.use(({ record: append }) => append([line(text)], ([{ sequence }]) => sequence));

const dataDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  // Not `/tmp`, because that is tmpfs here, where fsync means nothing.
  return yield* fileSystem.makeTempDirectoryScoped({
    directory: "/var/tmp",
    prefix: "iirc-backup-",
  });
}).pipe(Effect.provide(BunServices.layer));

const withLog = <A, E>(
  test: (dataDir: string) => Effect.Effect<A, E, Log | LogReader | Recorder | Scope.Scope>,
  options: Omit<LogReaderOptions, "dataDir"> = {}
) =>
  Effect.gen(function* () {
    const dataDir = yield* dataDirectory;

    return yield* test(dataDir).pipe(
      Effect.provide(
        LogReader.layer({ dataDir, ...options }).pipe(Layer.provideMerge(Log.layer({ dataDir })))
      )
    );
  }).pipe(Effect.scoped);

// Every Entry, as SQLite holds it, oldest first.
const rowsOf = (filename: string, head: number) => {
  const database = new Database(filename, { readonly: true });

  try {
    return database
      .query<unknown, [number]>("SELECT * FROM entries WHERE sequence <= ? ORDER BY sequence")
      .all(head);
  } finally {
    database.close();
  }
};

const quickCheck = (filename: string) => {
  const database = new Database(filename, { readonly: true });

  try {
    return database.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
  } finally {
    database.close();
  }
};

// Daemon Entries with a kilobyte each, written past the writer, so that a copy of the
// Log takes long enough to watch. The fold has nothing to do with them.
const grow = (dataDir: string, entries: number) => {
  const database = new Database(`${dataDir}/iirc.sqlite`);
  const version = "v".repeat(1024);

  const insert = database.prepare(
    "INSERT INTO entries (at, kind, phase, version) VALUES (?, 'Daemon', 'started', ?)"
  );

  try {
    database.transaction(() => {
      for (let index = 0; index < entries; index += 1) {
        insert.run(index, version);
      }
    })();
  } finally {
    database.close();
  }
};

describe("backing up the Log (RUN-2)", () => {
  it.live("RUN-2: a backup opens, passes quick_check, and holds every Entry up to its head", () =>
    withLog((dataDir) =>
      Effect.gen(function* () {
        for (const text of [":a PRIVMSG #iirc :one", ":a PRIVMSG #iirc :two", "ÿþ"]) {
          yield* record(text);
        }

        const head = yield* Log.use(({ head: newest }) => newest);
        const backup = yield* LogReader.use(({ backup: take }) => take);

        assert.strictEqual(backup.head, head);
        assert.match(
          backup.path,
          new RegExp(`^${dataDir}/backups/iirc-${head}-\\d{8}T\\d{9}Z\\.sqlite$`, "u")
        );
        assert.strictEqual(backup.bytes, statSync(backup.path).size);
        assert.deepStrictEqual(quickCheck(backup.path), [{ quick_check: "ok" }]);
        assert.deepStrictEqual(rowsOf(backup.path, head), rowsOf(`${dataDir}/iirc.sqlite`, head));
        // Only the backup itself, and nothing left half made.
        assert.deepStrictEqual(readdirSync(`${dataDir}/backups`), [
          backup.path.slice(`${dataDir}/backups/`.length),
        ]);
        assert.strictEqual(statSync(`${dataDir}/backups`).mode % 0o1000, 0o700);
      })
    )
  );

  it.live(
    "RUN-2: appends and reads carry on while a backup runs, and it has no read budget to outlast",
    () =>
      withLog(
        (dataDir) =>
          Effect.gen(function* () {
            grow(dataDir, 50_000);

            const done = yield* Ref.make(false);
            const started = performance.now();

            const backup = yield* LogReader.use(({ backup: take }) => take).pipe(
              Effect.ensuring(Ref.set(done, true)),
              Effect.forkChild
            );

            // Each turn appends and then reads back what it appended, as a Frontend
            // following the Log would, for as long as the backup runs.
            let during = 0;
            let slowest = 0;

            while (!(yield* Ref.get(done))) {
              const turn = performance.now();
              const sequence = yield* record(`:a PRIVMSG #iirc :during ${during}`);

              const [read] = yield* LogReader.use(({ entries }) =>
                entries({ after: sequence - 1, limit: 1 })
              );

              assert.strictEqual(read?.sequence, sequence);
              slowest = Math.max(slowest, performance.now() - turn);
              during += 1;
            }

            const taken = yield* Fiber.join(backup);
            const tookMillis = performance.now() - started;

            writeSync(
              process.stdout.fd,
              `RUN-2 a backup to sequence ${taken.head} took ${tookMillis.toFixed(0)} ms, beside ${during} appends and reads, the slowest ${slowest.toFixed(1)} ms\n`
            );

            assert.isAbove(tookMillis, 100, "the backup ran past the reader's 100 ms budget");
            assert.isAtLeast(during, 3, "appends and reads went on while it ran");
            assert.isBelow(slowest, 250, "none of them waited for the backup");
            assert.deepStrictEqual(quickCheck(taken.path), [{ quick_check: "ok" }]);
            assert.isAtLeast(taken.head, 50_000);
          }),
        { budget: "100 millis" }
      ),
    { timeout: 30_000 }
  );

  it.live("RUN-2: a backup that cannot be written fails, and leaves nothing behind", () =>
    withLog((dataDir) =>
      Effect.gen(function* () {
        yield* record(":a PRIVMSG #iirc :one");

        const fileSystem = yield* FileSystem.FileSystem;

        yield* fileSystem.makeDirectory(`${dataDir}/backups`);
        chmodSync(`${dataDir}/backups`, 0o500);

        const failed = yield* Effect.exit(LogReader.use(({ backup }) => backup));

        chmodSync(`${dataDir}/backups`, 0o700);

        assert.isTrue(Exit.isFailure(failed));
        assert.deepStrictEqual(readdirSync(`${dataDir}/backups`), []);
      }).pipe(Effect.provide(BunServices.layer))
    )
  );
});
