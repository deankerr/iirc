/**
 * The in-memory byte store, for tests.
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";

import { Effect, Stream } from "effect";

import { ByteStoreNotFound, ByteStoreUnavailable, Sha256 } from "../store.ts";
import type { ByteRange, ByteStoreService } from "../store.ts";

/**
 * Two views of one store's bytes: `store` reaches them, and `unreachable` is the same
 * store unable to reach them, failing everything with `ByteStoreUnavailable`.
 */
export interface ByteStoreHarness {
  readonly store: ByteStoreService;
  readonly unreachable: ByteStoreService;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

const sliced = (bytes: Uint8Array, range: ByteRange | undefined) => {
  if (range === undefined) {
    return bytes;
  }

  const start = clamp(range.start, 0, bytes.length);

  return bytes.subarray(start, clamp(range.end, start, bytes.length));
};

const unavailable = Effect.fail(new ByteStoreUnavailable({ reason: "unreachable" }));

const unreachable: ByteStoreService = {
  delete: () => unavailable,
  held: unavailable,
  put: () => unavailable,
  read: () => unavailable,
};

/**
 * Makes an empty in-memory byte store, and the same store unreachable.
 * @returns Its harness.
 */
export const makeMemoryByteStore: Effect.Effect<ByteStoreHarness> = Effect.sync(() => {
  const held = new Map<Sha256, Uint8Array>();

  const store: ByteStoreService = {
    delete: (hash) =>
      Effect.sync(() => {
        held.delete(hash);
      }),
    held: Effect.sync(() => held.values().reduce((total, bytes) => total + bytes.length, 0)),
    put: (bytes) =>
      // `mkUint8Array` copies the chunks into a new array, so the caller's are never held.
      Stream.mkUint8Array(bytes).pipe(
        Effect.map((all) => {
          const hash = Sha256.make(createHash("sha256").update(all).digest("hex"));
          held.set(hash, all);

          return { hash, size: all.length };
        })
      ),
    read: (hash, range) =>
      Effect.suspend(() => {
        const bytes = held.get(hash);

        if (bytes === undefined) {
          return Effect.fail(new ByteStoreNotFound({ hash }));
        }

        // A copy, so a reader can never change what is held.
        const part = new Uint8Array(sliced(bytes, range));

        return Effect.succeed(part.length === 0 ? Stream.empty : Stream.make(part));
      }),
  };

  return { store, unreachable };
});
