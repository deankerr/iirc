import { Database } from "bun:sqlite";

import { Clock, Effect, FileSystem } from "effect";

import { StorageFailed } from "./errors.ts";

/** A backup of the Log (RUN-2): where it is, how many bytes, and the last sequence it holds. */
export interface Backup {
  readonly bytes: number;
  readonly head: number;
  readonly path: string;
}

/**
 * What a backup is for, which starts its file's name: one asked for through the API, or
 * the one taken before migrations run (RUN-5).
 */
export type BackupKind = "iirc" | "pre-migration";

// Backups hold the whole Log, so only the Owner may read them.
const backupsMode = 0o700;

/**
 * Copies the database a connection reads into a new file, as one snapshot, and reads
 * back the last sequence the copy holds. `VACUUM INTO` takes only a read transaction, so
 * on a read connection in WAL mode it holds up no append (RUN-2). It is synchronous, and
 * runs as long as the copy takes, so only a Worker, or a startup that nothing else is
 * waiting on, may call it.
 * @param database - A connection to the Log, which may be read-only.
 * @param into - The new file, which must not exist.
 * @returns The newest sequence in the copy, or 0 if it holds no Entry.
 */
export const vacuumInto = (database: Database, into: string): number => {
  database.run("VACUUM INTO ?", [into]);

  const copy = new Database(into, { readonly: true });

  try {
    return (
      copy.query<{ head: number | null }, []>("SELECT MAX(sequence) AS head FROM entries").get()
        ?.head ?? 0
    );
  } finally {
    copy.close();
  }
};

// `2026-11-03T12:01:02.345Z` as `20261103T120102345Z`, which sorts and fits a file name.
const stampOf = (millis: number) => new Date(millis).toISOString().replaceAll(/[-:.]/gu, "");

const syncPath = (fileSystem: FileSystem.FileSystem, path: string) =>
  Effect.scoped(Effect.flatMap(fileSystem.open(path, { flag: "r" }), (file) => file.sync));

/**
 * Takes a backup into `backups/` in the data directory, and never anywhere a request
 * could name (RUN-2). The copy is made under a temporary name, synced, and renamed only
 * once whole, so a file with a backup's name is always a whole backup, and a crash leaves
 * at most a temporary file, which the next backup of that name does not reuse.
 * @param dataDir - The data directory.
 * @param kind - What the backup is for, which starts its name.
 * @param copy - Makes the copy at the path it is given, and answers with its head.
 * @returns Where the backup is, its size, and its head.
 */
export const keepBackup = <E>(
  dataDir: string,
  kind: BackupKind,
  copy: (into: string) => Effect.Effect<number, E>
): Effect.Effect<Backup, E | StorageFailed, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = `${dataDir}/backups`;
    const stamp = stampOf(yield* Clock.currentTimeMillis);
    const partial = `${directory}/.${kind}-${stamp}.partial`;

    yield* fileSystem
      .makeDirectory(directory, { mode: backupsMode, recursive: true })
      .pipe(Effect.mapError((cause) => new StorageFailed({ cause })));

    return yield* Effect.gen(function* () {
      const head = yield* copy(partial);
      const path = `${directory}/${kind}-${head}-${stamp}.sqlite`;

      // Synced before it takes its name, and the name synced after, so that a backup that
      // was reported survives power loss as the Log itself would (LOG-4).
      yield* syncPath(fileSystem, partial).pipe(
        Effect.andThen(fileSystem.rename(partial, path)),
        Effect.andThen(syncPath(fileSystem, directory)),
        Effect.mapError((cause) => new StorageFailed({ cause }))
      );

      const { size } = yield* fileSystem
        .stat(path)
        .pipe(Effect.mapError((cause) => new StorageFailed({ cause })));

      return { bytes: Number(size), head, path };
    }).pipe(Effect.onError(() => Effect.ignore(fileSystem.remove(partial, { force: true }))));
  });
