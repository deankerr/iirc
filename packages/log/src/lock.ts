import { Database } from "bun:sqlite";

import { Effect, Predicate } from "effect";
import type { Scope } from "effect";

import { DataDirectoryLocked, StorageFailed } from "./errors.ts";

const isBusy = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && cause.code === "SQLITE_BUSY";

/**
 * Holds a data directory exclusively until the enclosing scope closes (RUN-4). The
 * lock is an open `BEGIN EXCLUSIVE` on a sidecar database, which the kernel frees
 * if the process is killed, however it dies. Its journal is in memory, so taking it
 * writes nothing, and a full disk cannot refuse it: the Daemon can start, and wait for
 * space like any other time the Log cannot append (LOG-9).
 * @param dataDir - The directory to hold, which must exist.
 * @returns An effect that fails at once if another holder exists.
 */
export const holdDataDirectory = (
  dataDir: string
): Effect.Effect<void, DataDirectoryLocked | StorageFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => new StorageFailed({ cause }),
        try: () => new Database(`${dataDir}/iirc.lock`),
      }),
      // Closing abandons the open transaction, which is what frees the lock.
      (opened) =>
        Effect.sync(() => {
          opened.close();
        })
    );

    yield* Effect.try({
      catch: (cause) =>
        isBusy(cause) ? new DataDirectoryLocked({ dataDir }) : new StorageFailed({ cause }),
      try: () => {
        // Any wait here would block the event loop, and a holder never lets go.
        database.run("PRAGMA busy_timeout = 0");
        // Not a file: a rollback journal is written as the lock is taken.
        database.run("PRAGMA journal_mode = MEMORY");
        database.run("BEGIN EXCLUSIVE");
      },
    });
  });
