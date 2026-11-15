/**
 * The byte store port: keeps bytes by their hash. It knows nothing of names, types, links,
 * or what refers to the bytes it keeps.
 *
 * @packageDocumentation
 */
import { Context, Schema } from "effect";
import type { Effect, Stream } from "effect";

/** A SHA-256 hash, as 64 lower-case hex digits. */
export const Sha256 = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { message: "must be 64 lower-case hex digits" })
).pipe(Schema.brand("Sha256"));

/** The decoded form of {@link Sha256}. */
export type Sha256 = typeof Sha256.Type;

/** What a put kept: the bytes' hash, and how many there were. */
export interface Stored {
  readonly hash: Sha256;
  readonly size: number;
}

/**
 * Part of what is held, from `start` up to but not including `end`, as `Blob.slice` takes
 * it. Both are whole numbers, and `start` is at most `end`.
 */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** The store confirmed it holds nothing by this hash. */
export class ByteStoreNotFound extends Schema.TaggedError<
  ByteStoreNotFound,
  { readonly brand: unique symbol }
>()("ByteStoreNotFound", { hash: Sha256 }) {}

/**
 * The store could not be reached, refused what was asked, or failed in any other way, so
 * nothing is known about what it holds. Never a sign that bytes are missing.
 */
export class ByteStoreUnavailable extends Schema.TaggedError<
  ByteStoreUnavailable,
  { readonly brand: unique symbol }
>()("ByteStoreUnavailable", { reason: Schema.String }) {}

/** What a byte store adapter provides. */
export interface ByteStoreService {
  /**
   * Keeps the bytes a stream gives, under their SHA-256 hash. An adapter may run the stream
   * more than once, so it must give the same bytes each time it runs, as one that reads a
   * file does. Putting bytes already held is safe, and gives the same answer. A put that
   * fails leaves nothing readable under the hash that was not there before.
   */
  readonly put: <E>(
    bytes: Stream.Stream<Uint8Array, E>
  ) => Effect.Effect<Stored, E | ByteStoreUnavailable>;
  /**
   * The bytes held under a hash, or one range of them, clamped to what is held. Whether
   * they are held is decided before any byte flows.
   */
  readonly read: (
    hash: Sha256,
    range?: ByteRange
  ) => Effect.Effect<
    Stream.Stream<Uint8Array, ByteStoreUnavailable>,
    ByteStoreNotFound | ByteStoreUnavailable
  >;
  /** Stops holding the bytes under a hash. Deleting what is not held succeeds. */
  readonly delete: (hash: Sha256) => Effect.Effect<void, ByteStoreUnavailable>;
  /** How many bytes are held in all. */
  readonly held: Effect.Effect<number, ByteStoreUnavailable>;
}

/** The byte store the Daemon keeps bytes in. */
export class ByteStore extends Context.Service<ByteStore, ByteStoreService>()(
  "@iirc/byte-store/ByteStore"
) {}
