import { BunFileSystem } from "@effect/platform-bun";
import type { Entry } from "@iirc/session/entry";
import { Recorder } from "@iirc/session/recorder";
import type { Gap } from "@iirc/session/standing";
import { Context, Effect, FileSystem, Layer } from "effect";

import { openDatabase } from "./database.ts";
import { StorageFailed } from "./errors.ts";
import type { DataDirectoryLocked, ReaderBusy, ReadTimedOut } from "./errors.ts";
import type { LoggedMessage } from "./fold.ts";
import { holdDataDirectory } from "./lock.ts";
import type { EntryQuery, NetworkPage } from "./reader-protocol.ts";
import { makeReader } from "./reader.ts";
import type { LogReaderOptions } from "./reader.ts";
import { makeStore } from "./store.ts";
import type { ChangeEntry } from "./store.ts";

export { DataDirectoryLocked, ReaderBusy, ReadTimedOut, StorageFailed } from "./errors.ts";

export type { LoggedMessage } from "./fold.ts";

export type { EntryQuery, NetworkPage } from "./reader-protocol.ts";

export { longestReadMillis } from "./reader.ts";

export type { LogReaderOptions } from "./reader.ts";

export type { ChangeEntry } from "./store.ts";

export type { Gap } from "@iirc/session/standing";

/** Where the Log keeps its files. */
export interface LogOptions {
  readonly dataDir: string;
}

const open = Effect.fnUntraced(function* ({ dataDir }: LogOptions) {
  const fileSystem = yield* FileSystem.FileSystem;

  yield* fileSystem
    .makeDirectory(dataDir, { recursive: true })
    .pipe(Effect.mapError((cause) => new StorageFailed({ cause })));

  // The lock comes first, so that a second Daemon never touches a live database.
  yield* holdDataDirectory(dataDir);

  return yield* Effect.flatMap(openDatabase(dataDir), makeStore);
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
  }
>()("@iirc/log/Log") {
  /**
   * The durable Log, also serving as the Recorder.
   * @param options - Where to keep it.
   * @returns A Layer that holds the data directory for as long as it lives.
   */
  static readonly layer = (
    options: LogOptions
  ): Layer.Layer<Log | Recorder, DataDirectoryLocked | StorageFailed> =>
    Layer.effectContext(
      Effect.map(open(options), (store) =>
        Context.make(Log, store).pipe(Context.add(Recorder, store))
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
    );
}
