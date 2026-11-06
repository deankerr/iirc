import { BunFileSystem } from "@effect/platform-bun";
import type { SqliteMigrator } from "@effect/sql-sqlite-bun";
import type { Entry, NewEntry } from "@iirc/session/entry";
import { Committed, Recorder } from "@iirc/session/recorder";
import type { Gap } from "@iirc/session/standing";
import { Context, Effect, FileSystem, Layer } from "effect";

import type { Backup } from "./backup.ts";
import { openDatabase } from "./database.ts";
import { StorageFailed } from "./errors.ts";
import type {
  DataDirectoryLocked,
  EntryAlreadyRedacted,
  EntryNotFound,
  EntryNotRedactable,
  ReaderBusy,
  ReadTimedOut,
} from "./errors.ts";
import type { LoggedActivity, LoggedMessage } from "./fold.ts";
import { holdDataDirectory } from "./lock.ts";
import type { LogTooNew } from "./migrations.ts";
import type {
  ActivityQuery,
  ConnectionEncoding,
  EntryQuery,
  NetworkPage,
} from "./reader-protocol.ts";
import { makeReader } from "./reader.ts";
import type { LogReaderOptions } from "./reader.ts";
import type { ActivityPage } from "./rows.ts";
import { makeStore } from "./store.ts";
import type { ChangeEntry } from "./store.ts";

export type { Backup } from "./backup.ts";

export {
  DataDirectoryLocked,
  EntryAlreadyRedacted,
  EntryNotFound,
  EntryNotRedactable,
  ReaderBusy,
  ReadTimedOut,
  StorageFailed,
} from "./errors.ts";

export { LogTooNew } from "./migrations.ts";

export type { ActivityDetails, ActivityKind, LoggedActivity, LoggedMessage } from "./fold.ts";

export type {
  ActivityQuery,
  ConnectionEncoding,
  EntryQuery,
  NetworkPage,
  PlaceKey,
} from "./reader-protocol.ts";

export type { ActivityCursor, ActivityPage } from "./rows.ts";

export { longestReadMillis } from "./reader.ts";

export type { LogReaderOptions } from "./reader.ts";

export type { ChangeEntry } from "./store.ts";

export type { Gap } from "@iirc/session/standing";

export type { Place } from "@iirc/state/place";

/** Where the Log keeps its files. */
export interface LogOptions {
  readonly dataDir: string;
  /** The migrations to run, which only a test changes (RUN-5). */
  readonly migrations?: SqliteMigrator.Loader;
}

const open = Effect.fnUntraced(function* ({ dataDir, migrations }: LogOptions) {
  const fileSystem = yield* FileSystem.FileSystem;

  yield* fileSystem
    .makeDirectory(dataDir, { recursive: true })
    .pipe(Effect.mapError((cause) => new StorageFailed({ cause })));

  // The lock comes first, so that a second Daemon never touches a live database.
  yield* holdDataDirectory(dataDir);

  return yield* Effect.flatMap(openDatabase(dataDir, migrations), makeStore);
});

/**
 * The Daemon's ordered record of everything that happened. Reads see only what has
 * committed, and everything but Entries can be deleted and derived again. Its reads run
 * on the writer's connection, where they hold up every append until they finish, so
 * only the writer's own work and tests use them: a Frontend's go to {@link LogReader}.
 */
export class Log extends Context.Service<
  Log,
  {
    /**
     * Activity after the cursor `after`, ascending by sequence and then by `ordinal`, at most
     * `limit` rows. Pass back the last row's `sequence` and `ordinal` to resume.
     */
    readonly activity: (
      query: ActivityPage
    ) => Effect.Effect<readonly LoggedActivity[], StorageFailed>;
    /**
     * Change Entries with a sequence greater than `after`, ascending, at most `limit`. It
     * has no time budget, because it is for when nothing else appends: the Daemon's
     * startup, and `iirc key create`, each folding every Change into Configuration.
     */
    readonly changes: (query: {
      readonly after: number;
      readonly limit: number;
    }) => Effect.Effect<readonly ChangeEntry[], StorageFailed>;
    /** Entries with a sequence greater than `after`, ascending, at most `limit`. */
    readonly entries: (query: {
      readonly after: number;
      readonly limit: number;
    }) => Effect.Effect<readonly Entry[], StorageFailed>;
    /**
     * Gaps that began at a sequence greater than `after`, ascending, at most `limit`,
     * from every Network unless `network` names one. An open Gap has no `ended`.
     */
    readonly gaps: (query: {
      readonly after: number;
      readonly limit: number;
      readonly network?: string;
    }) => Effect.Effect<readonly Gap[], StorageFailed>;
    /** Messages with a sequence greater than `after`, ascending, at most `limit`. */
    readonly messages: (query: {
      readonly after: number;
      readonly limit: number;
    }) => Effect.Effect<readonly LoggedMessage[], StorageFailed>;
    /** The newest Entry's sequence, or 0 for an empty Log. */
    readonly head: Effect.Effect<number, StorageFailed>;
    /** Deletes every derived row and derives them again from Entries (LOG-10). */
    readonly rebuild: Effect.Effect<void, StorageFailed>;
    /**
     * Empties the bytes of the Line or Dropped Entry at `sequence`, marks it redacted by
     * `change`, records `change`, and derives every table again, all in one transaction
     * (LOG-7). `within` runs inside it with `change` as recorded, as `record`'s does. The
     * Standings hosts read are left as they were, apart from `change` itself: a Connection
     * under way acted on the Line as it was, and a start replays it as saying nothing.
     */
    readonly redact: <A>(
      sequence: number,
      change: Extract<NewEntry, { readonly _tag: "Change" }>,
      within: (recorded: ChangeEntry) => A
    ) => Effect.Effect<
      A,
      EntryAlreadyRedacted | EntryNotFound | EntryNotRedactable | StorageFailed
    >;
  }
>()("@iirc/log/Log") {
  /**
   * The durable Log, also serving as the Recorder, and as {@link Committed} to watch what it
   * records once each commit is durable, a redaction's Change included. A Log newer than the
   * binary is refused, and one with migrations to run is backed up before they do (RUN-5).
   * @param options - Where to keep it.
   * @returns A Layer that holds the data directory for as long as it lives.
   */
  static readonly layer = (
    options: LogOptions
  ): Layer.Layer<Committed | Log | Recorder, DataDirectoryLocked | LogTooNew | StorageFailed> =>
    Layer.effectContext(
      Effect.map(open(options), (store) =>
        Context.make(Log, store).pipe(Context.add(Recorder, store), Context.add(Committed, store))
      )
    ).pipe(Layer.provide(BunFileSystem.layer));
}

/**
 * The Log's reads, from a Worker on its own read-only connection, so that no read can
 * delay an append (LOG-11). Each has a time budget, and fails with ReadTimedOut once it
 * is spent. Reads see only what has committed, and see a commit once it lands.
 */
export class LogReader extends Context.Service<
  LogReader,
  {
    /**
     * Activity after the cursor `after`, from every Network unless `network` names one, and
     * from every place on it unless `place` names one. A page stops at `limit` rows or about
     * `pageBytes`, whichever comes first, inside an Entry if it must, so pass back the last
     * row's `sequence` and `ordinal` to resume.
     */
    readonly activity: (
      query: ActivityQuery
    ) => Effect.Effect<readonly LoggedActivity[], ReaderBusy | ReadTimedOut | StorageFailed>;
    /**
     * Copies the Log into `backups/` in the data directory with `VACUUM INTO`, on a Worker
     * and a read connection of its own, so that it holds up no append and no read, and
     * has no budget to run out of however big the Log (RUN-2). One runs at a time.
     */
    readonly backup: Effect.Effect<Backup, StorageFailed>;
    /**
     * The fallback encoding each Connection's `attempt` recorded, by the sequence of that
     * `attempt`, for those with one, so that a reader decodes a Connection's Lines as its
     * Standing did (MSG-4). A sequence that is no `attempt` has none.
     */
    readonly encodings: (
      connections: readonly number[]
    ) => Effect.Effect<readonly ConnectionEncoding[], ReaderBusy | ReadTimedOut | StorageFailed>;
    /**
     * Entries with a sequence greater than `after`, ascending, at most `limit`, from every
     * Network unless `network` names one, and of every kind unless `kinds` lists some.
     */
    readonly entries: (
      query: EntryQuery
    ) => Effect.Effect<readonly Entry[], ReaderBusy | ReadTimedOut | StorageFailed>;
    /** Gaps by cursor, from every Network unless `network` names one. */
    readonly gaps: (
      query: NetworkPage
    ) => Effect.Effect<readonly Gap[], ReaderBusy | ReadTimedOut | StorageFailed>;
    /** Messages by cursor, from every Network unless `network` names one. */
    readonly messages: (
      query: NetworkPage
    ) => Effect.Effect<readonly LoggedMessage[], ReaderBusy | ReadTimedOut | StorageFailed>;
  }
>()("@iirc/log/LogReader") {
  /**
   * Starts the reader's Worker, which lives as long as the Layer. A read still running
   * when it closes is waited for, and its budget bounds that wait.
   * @param options - Where the Log is, and how long a read may take.
   * @returns A Layer that needs the Log open, so that the database is there to read.
   */
  static readonly layer = (options: LogReaderOptions): Layer.Layer<LogReader, StorageFailed, Log> =>
    Layer.effect(
      LogReader,
      Effect.gen(function* () {
        yield* Log;

        return yield* makeReader(options);
      })
    ).pipe(Layer.provide(BunFileSystem.layer));
}
