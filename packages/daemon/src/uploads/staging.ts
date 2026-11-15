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

import { Data, Effect, FileSystem, Stream } from "effect";
import type { Scope } from "effect";
import { SecureRandom } from "effect/crypto";

import { headLength } from "./kind.ts";
import { stripperFor } from "./strip/strip.ts";

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

/**
 * What of a staged body is kept. An image of a type that is stripped is read whole, stripped,
 * and hashed again, so the store is given, and checked against, only what it keeps. Any
 * other type streams from staging as it came. Nothing can skip stripping.
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
