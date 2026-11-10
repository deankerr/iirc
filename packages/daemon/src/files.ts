/**
 * The Daemon's own files in the data directory, `keys.json` and `sign-ins.json`: read
 * whole, and written atomically with mode `0600`, as vault-file writes its file.
 *
 * @packageDocumentation
 */
import { Effect, FileSystem, Option } from "effect";
import type { PlatformError } from "effect";

const mode = 0o600;

/**
 * A file's text, or none if it is missing.
 * @param path - The file.
 * @param unreadable - The error for a file that is there and cannot be read, given only the platform's message.
 * @returns The text, if the file exists.
 */
export const readIfPresent = <E>(path: string, unreadable: (reason: string) => E) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(path).pipe(
      Effect.asSome,
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(unreadable(error.message))
      )
    );
  });

/**
 * Writes a file in a data directory to a temporary file beside it with `wx` and mode
 * `0600`, syncs it, renames it into place, and syncs the directory. A crash leaves the
 * old file or the new one.
 * @param dataDir - The data directory.
 * @param path - The file, in the data directory.
 * @param text - What it holds.
 * @param unwritable - The error for a write that failed, given only the platform's message.
 * @returns An Effect that fails with nothing changed, or replaces the file.
 */
export const writeAtomically = <E>(
  dataDir: string,
  path: string,
  text: string,
  unwritable: (reason: string) => E
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = `${path}.tmp`;
    const removeTemporary = fs.remove(temporary, { force: true }).pipe(Effect.ignoreCause);

    const stage = Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporary, { flag: "wx", mode });

        yield* file.writeAll(new TextEncoder().encode(text));
        yield* file.sync;
      })
    );

    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* removeTemporary;
        yield* stage;
        yield* fs.rename(temporary, path);
        yield* Effect.scoped(
          Effect.flatMap(fs.open(dataDir, { flag: "r" }), (dir) => dir.sync)
        ).pipe(Effect.ignoreCause);
      }).pipe(
        Effect.onError(() => removeTemporary),
        Effect.mapError((error: PlatformError.PlatformError) => unwritable(error.message)),
        Effect.catchDefect(() => Effect.fail(unwritable("the file system failed")))
      )
    );
  });
