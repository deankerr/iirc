/**
 * Staging: an arriving body is written to a file of its own under `<dataDir>/staging/`,
 * hashed and counted as it arrives, and cut off as soon as it passes the most an Upload may
 * be. An image is then stripped, so what is kept, and its hash, are of the stripped bytes.
 * The file lives exactly as long as the Scope it was staged in, so a failure, an
 * interruption, or a client that goes away leaves nothing behind, and what a crash left is
 * removed at start.
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import { Data, Effect, FileSystem, Stream } from "effect";
import type { Scope } from "effect";
import { SecureRandom } from "effect/crypto";

import { headLength } from "./kind.ts";
import { patcherFor, stripperFor } from "./strip/strip.ts";
import type { Patch, Reader } from "./strip/strip.ts";

/** A body staged whole: where it is, its SHA-256 as hex, its size, and its leading bytes. */
export interface Staged {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  /** Up to `headLength` leading bytes, for reading the type. */
  readonly head: Uint8Array;
}

/** The body passed `maxSize` bytes, so it was cut off there. */
export class BodyTooLarge extends Data.TaggedError("BodyTooLarge")<{ readonly maxSize: number }> {}

/** An image whose structure could not be walked, so it cannot be kept without its metadata. */
export class UnreadableImage extends Data.TaggedError("UnreadableImage")<{
  readonly type: string;
  readonly reason: string;
}> {}

/** What is put to the store: its bytes, which may be read more than once, its SHA-256 as hex, and its size. */
export interface Keepable {
  readonly bytes: Stream.Stream<Uint8Array>;
  readonly hash: string;
  readonly size: number;
}

/**
 * The staging directory of a data directory.
 * @param dataDir - The data directory.
 * @returns Its path.
 */
const stagingOf = (dataDir: string) => `${dataDir}/staging`;

/**
 * Removes whatever staging holds, as a crash may have left it, and makes it again,
 * owner-only. Run at start, before anything is staged.
 * @param dataDir - The data directory.
 * @returns An Effect that empties it.
 */
export const clearStaging = (dataDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staging = stagingOf(dataDir);

    yield* fs.remove(staging, { force: true, recursive: true });
    yield* fs.makeDirectory(staging, { mode: 0o700, recursive: true });
  });

/**
 * Stages a body: writes it to a new file under staging, mode `0600`, hashing and counting
 * each chunk as it arrives, and fails with {@link BodyTooLarge} before writing the chunk
 * that would pass `maxSize`, reading no more of the body. The file is removed when the
 * Scope closes, however it closes.
 * @param dataDir - The data directory.
 * @param body - The body.
 * @param maxSize - The most bytes it may have.
 * @returns What was staged.
 */
export const stage = <E>(
  dataDir: string,
  body: Stream.Stream<Uint8Array, E>,
  maxSize: number
): Effect.Effect<
  Staged,
  E | BodyTooLarge,
  Scope.Scope | FileSystem.FileSystem | SecureRandom.SecureRandom
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const random = yield* SecureRandom.SecureRandom;
    const name = Buffer.from(yield* random.randomBytes(16)).toString("hex");
    const path = `${stagingOf(dataDir)}/${name}`;

    // Added before the file is made, so a file made by an open cut short is removed too.
    yield* Effect.addFinalizer(() => fs.remove(path, { force: true }).pipe(Effect.ignoreCause));

    const file = yield* fs.open(path, { flag: "wx", mode: 0o600 }).pipe(Effect.orDie);
    const hasher = createHash("sha256");
    const head = new Uint8Array(headLength);
    let size = 0;

    yield* body.pipe(
      Stream.runForEach((chunk) => {
        if (size + chunk.length > maxSize) {
          return Effect.fail(new BodyTooLarge({ maxSize }));
        }

        if (size < headLength) {
          head.set(chunk.subarray(0, headLength - size), size);
        }

        size += chunk.length;
        hasher.update(chunk);

        return file.writeAll(chunk).pipe(Effect.orDie);
      })
    );

    return {
      hash: hasher.digest("hex"),
      head: head.slice(0, Math.min(size, headLength)),
      path,
      size,
    };
  });

// How much is read at a time when a walk reads a few bytes, so that a file of many small
// boxes is not a file of as many reads.
const window = 64 * 1024;

// How much zero is written at a time, which is never more than this however large a box is.
const zeros = new Uint8Array(1024 * 1024);

/**
 * Reads a file as a walk asks, from where it asks, a window at a time.
 * @param file - The open file.
 * @returns The reader.
 */
const readerOf = (file: FileSystem.File): Reader => {
  let held = { at: 0, bytes: new Uint8Array() };

  const readFrom = (at: number, length: number) =>
    Effect.gen(function* () {
      const buffer = new Uint8Array(length);
      let got = 0;

      while (got < length) {
        const n = yield* file
          .read(buffer.subarray(got), { position: BigInt(at + got) })
          .pipe(Effect.orDie);

        if (n === 0) {
          break;
        }

        got += n;
      }

      return buffer.subarray(0, got);
    });

  return (at, length) =>
    Effect.gen(function* () {
      if (at >= held.at && at + length <= held.at + held.bytes.length) {
        return held.bytes.subarray(at - held.at, at - held.at + length);
      }

      if (length > window) {
        return yield* readFrom(at, length);
      }

      const bytes = yield* readFrom(at, window);

      held = { at, bytes };

      return bytes.subarray(0, Math.min(length, bytes.length));
    });
};

// Writes bytes at a place in a file through Node's file handle, since Bun, as of 1.4, ignores
// the position of a write made through the file system service.
const writeAt = (handle: FileHandle, buffer: Uint8Array, at: number): Effect.Effect<void> =>
  Effect.promise(async () => await handle.write(buffer, 0, buffer.length, at)).pipe(
    Effect.flatMap(({ bytesWritten }) =>
      bytesWritten === buffer.length
        ? Effect.void
        : writeAt(handle, buffer.subarray(bytesWritten), at + bytesWritten)
    )
  );

/**
 * Writes patches into a file, each where it says, so that a box of any size is zeroed a
 * piece at a time.
 * @param path - The file.
 * @param patches - The patches.
 * @returns An Effect that applies them.
 */
const applied = (path: string, patches: readonly Patch[]) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => await open(path, "r+")),
    (handle) =>
      Effect.forEach(
        patches,
        (patch) =>
          "bytes" in patch
            ? writeAt(handle, patch.bytes, patch.at)
            : Effect.forEach(
                Array.from({ length: Math.ceil(patch.zeros / zeros.length) }, (_, n) => n),
                (n) =>
                  writeAt(
                    handle,
                    zeros.subarray(0, Math.min(patch.zeros - n * zeros.length, zeros.length)),
                    patch.at + n * zeros.length
                  ),
                { discard: true }
              ),
        { discard: true }
      ),
    (handle) =>
      Effect.promise(async () => {
        await handle.close();
      })
  );

/**
 * What of a staged body is kept. An image of a type that is stripped is stripped, and hashed
 * again, so the store is given, and checked against, only what it keeps. A JPEG, PNG, GIF or
 * WebP is read whole. A HEIC, AVIF, MP4 or MOV is patched in place, which the staged file,
 * ours alone, allows, so that no video is ever read whole, and is then read again to be hashed.
 * Any other type streams from staging as it came. Nothing can skip stripping.
 * @param staged - The staged body.
 * @param type - The type read from its bytes.
 * @returns What to put, or {@link UnreadableImage} for an image whose structure could not
 *   be walked.
 */
export const keepable = (
  staged: Staged,
  type: string
): Effect.Effect<Keepable, UnreadableImage, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stripper = stripperFor(type);
    const patcher = patcherFor(type);

    if (patcher !== undefined) {
      const planned = yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(staged.path, { flag: "r" }).pipe(Effect.orDie);
          const walked = yield* patcher(readerOf(file), staged.size);

          if (walked._tag === "Planned") {
            yield* applied(staged.path, walked.patches);
          }

          return walked;
        })
      );

      if (planned._tag === "Unreadable") {
        return yield* new UnreadableImage({ reason: planned.reason, type });
      }

      const hasher = createHash("sha256");

      yield* fs.stream(staged.path).pipe(
        Stream.orDie,
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            hasher.update(chunk);
          })
        )
      );

      return {
        bytes: fs.stream(staged.path).pipe(Stream.orDie),
        hash: hasher.digest("hex"),
        size: staged.size,
      };
    }

    if (stripper === undefined) {
      return {
        bytes: fs.stream(staged.path).pipe(Stream.orDie),
        hash: staged.hash,
        size: staged.size,
      };
    }

    const result = stripper(yield* fs.readFile(staged.path).pipe(Effect.orDie));

    if (result._tag === "Unreadable") {
      return yield* new UnreadableImage({ reason: result.reason, type });
    }

    return {
      bytes: Stream.succeed(result.bytes),
      hash: createHash("sha256").update(result.bytes).digest("hex"),
      size: result.bytes.length,
    };
  });
