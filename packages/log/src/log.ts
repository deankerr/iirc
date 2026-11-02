import { BunFileSystem } from "@effect/platform-bun";
import type { Entry } from "@iirc/session/entry";
import { Recorder } from "@iirc/session/recorder";
import type { Gap } from "@iirc/session/standing";
import { Context, Effect, FileSystem, Layer } from "effect";

import { openDatabase } from "./database.ts";
import { StorageFailed } from "./errors.ts";
import type { DataDirectoryLocked } from "./errors.ts";
import type { LoggedMessage } from "./fold.ts";
import { holdDataDirectory } from "./lock.ts";
import { makeStore } from "./store.ts";

export { DataDirectoryLocked, StorageFailed } from "./errors.ts";

export type { LoggedMessage } from "./fold.ts";

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
 * committed, and everything but Entries can be deleted and derived again.
 */
export class Log extends Context.Service<
  Log,
  {
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
