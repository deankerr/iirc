import { BunFileSystem } from "@effect/platform-bun";
import { Duration, Effect, FileSystem, Layer, Semaphore } from "effect";

import { keepBackup, vacuumInto } from "./backup.ts";
import { StorageFailed } from "./errors.ts";
import type { ReadFailed, ReadTimedOut } from "./errors.ts";
import { Log, LogReader } from "./log.ts";
import type { LogReaderOptions } from "./log.ts";
import { defaultBudget } from "./reader.ts";
import { makeReads, openReadConnection } from "./reads.ts";

// What the Worker's client makes of a read the Worker could not make.
const asStorageFailed = <A>(read: Effect.Effect<A, ReadFailed | ReadTimedOut>) =>
  Effect.catchTag(read, "ReadFailed", ({ reason }) =>
    Effect.fail(new StorageFailed({ cause: reason }))
  );

/**
 * A LogReader that serves the same reads as the Worker's, from the same statements on a
 * read-only connection of its own, but on the caller's thread. Starting a Worker costs a
 * test about 180 ms, which a test that builds a Daemon only to use it would pay each time.
 *
 * It still reads the Log on disk, sees only what has committed, pages by bytes, and keeps
 * each read to its budget. It proves nothing of the Worker: a read here holds up appends
 * while it runs, nothing queues, so nothing is ReaderBusy, and nothing can die or be started
 * again. `reader.test.ts` and `backup.test.ts` prove those with the real one, as do the
 * binary's tests, and the shipped Daemon never uses this.
 * @param options - Where the Log is, and how long a read may take.
 * @returns A Layer that needs the Log open, as {@link LogReader.layer} does.
 */
export const inProcessReader = ({
  budget = defaultBudget,
  dataDir,
}: Omit<LogReaderOptions, "spawn">): Layer.Layer<LogReader, StorageFailed, Log> =>
  Layer.effect(
    LogReader,
    Effect.gen(function* () {
      yield* Log;

      const fileSystem = yield* FileSystem.FileSystem;

      const database = yield* openReadConnection(`${dataDir}/iirc.sqlite`).pipe(
        Effect.mapError(({ reason }) => new StorageFailed({ cause: reason }))
      );

      const reads = makeReads(database, Duration.toMillis(budget));
      const backups = yield* Semaphore.make(1);

      const copy = (into: string) =>
        Effect.try({
          catch: (cause) => new StorageFailed({ cause }),
          try: () => vacuumInto(database, into),
        });

      return {
        activity: (query) => asStorageFailed(reads.activity(query)),
        backup: backups
          .withPermit(keepBackup(dataDir, "iirc", copy))
          .pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
        encodings: (connections) => asStorageFailed(reads.encodings({ connections })),
        entries: (query) => asStorageFailed(reads.entries(query)),
        gaps: (query) => asStorageFailed(reads.gaps(query)),
        messages: (query) => asStorageFailed(reads.messages(query)),
      } satisfies LogReader["Service"];
    })
  ).pipe(Layer.provide(BunFileSystem.layer));
