/**
 * One Daemon to a data directory. The Journal and the Vault each assume one owner of
 * their file, and neither refuses a second, so the Daemon holds the directory itself.
 *
 * @packageDocumentation
 */
// `bun:sqlite`, not Effect SQL (ADR 0005): the lock is one connection holding one open
// transaction for as long as the Daemon runs, which a client that serializes statements on
// a shared connection cannot express.
import { Database } from "bun:sqlite";

import { Effect, Predicate, Schema } from "effect";
import type { Scope } from "effect";

/** Another process holds the data directory, most likely another Daemon. */
export class DataDirectoryLocked extends Schema.TaggedError<
  DataDirectoryLocked,
  { readonly brand: unique symbol }
>()("DataDirectoryLocked", { dataDir: Schema.String }) {}

/** The data directory could not be made, opened, or written. */
export class DataDirectoryFailed extends Schema.TaggedError<
  DataDirectoryFailed,
  { readonly brand: unique symbol }
>()("DataDirectoryFailed", { dataDir: Schema.String, reason: Schema.String }) {}

const isBusy = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") &&
  (cause.code === "SQLITE_BUSY" || cause.code === "SQLITE_LOCKED");

const reasonOf = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause);

/**
 * Holds a data directory exclusively until the enclosing Scope closes. The lock is an open
 * `BEGIN EXCLUSIVE` on `daemon.lock`, a database of its own. SQLite takes it with a POSIX
 * lock, which the kernel frees however the process dies, so a crash never leaves the
 * directory locked, and SQLite tracks it per file within one process too, so a second
 * Daemon in the same process is refused as well. Its journal is in memory, so taking it
 * writes nothing.
 * @param dataDir - The directory, which must exist.
 * @returns An Effect that fails at once if another holder exists.
 */
export const holdDataDirectory = (
  dataDir: string
): Effect.Effect<void, DataDirectoryLocked | DataDirectoryFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => new DataDirectoryFailed({ dataDir, reason: reasonOf(cause) }),
        try: () => new Database(`${dataDir}/daemon.lock`),
      }),
      // Closing abandons the open transaction, which is what frees the lock.
      (opened) =>
        Effect.sync(() => {
          opened.close(false);
        })
    );

    yield* Effect.try({
      catch: (cause) =>
        isBusy(cause)
          ? new DataDirectoryLocked({ dataDir })
          : new DataDirectoryFailed({ dataDir, reason: reasonOf(cause) }),
      try: () => {
        // Any wait here would block the event loop, and a holder never lets go.
        database.run("PRAGMA busy_timeout = 0");
        database.run("PRAGMA journal_mode = MEMORY");
        database.run("BEGIN EXCLUSIVE");
      },
    });
  });
