/**
 * The laws every byte store adapter keeps, as data, so the in-memory store and a bucket
 * agree. Each is checked with `holds` from `@iirc/runtime/testing`.
 *
 * @packageDocumentation
 */
import { LawBroken } from "@iirc/runtime/testing";
import type { Law } from "@iirc/runtime/testing";
import { Cause, Effect, Exit, Stream } from "effect";

import { Sha256 } from "../store.ts";
import type {
  ByteRange,
  ByteStoreNotFound,
  ByteStoreService,
  ByteStoreUnavailable,
  Stored,
} from "../store.ts";
import type { ByteStoreHarness } from "./memory-store.ts";

type Failure = ByteStoreNotFound | ByteStoreUnavailable;

const encoder = new TextEncoder();

const same = <T>(what: string, actual: T, expected: T) => {
  const shown = { actual: JSON.stringify(actual), expected: JSON.stringify(expected) };

  return shown.actual === shown.expected
    ? Effect.void
    : Effect.fail(new LawBroken({ ...shown, what }));
};

const chunksOf = (...texts: readonly string[]) =>
  Stream.fromIterable(texts.map((text) => encoder.encode(text)));

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const read = (store: ByteStoreService, hash: Sha256, range?: ByteRange) =>
  store.read(hash, range).pipe(Effect.flatMap(Stream.mkUint8Array));

// The tag an Effect failed with, or `succeeded` when it did not fail. A defect is a defect.
const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.exit,
    Effect.flatMap((exit) => {
      if (Exit.isSuccess(exit)) {
        return Effect.succeed("succeeded");
      }

      const failure = exit.cause.reasons.find(Cause.isFailReason);

      return failure === undefined
        ? Effect.failCause(exit.cause)
        : Effect.succeed(failure.error._tag);
    })
  );

const fails = <A, E extends { readonly _tag: string }>(
  what: string,
  effect: Effect.Effect<A, E>,
  tag: string
) => outcome(effect).pipe(Effect.flatMap((actual) => same(what, actual, tag)));

/** The SHA-256 of `abc`, of nothing, and of a million `a`s, from FIPS 180-2's examples. */
const vectors = {
  abc: Sha256.make("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
  empty: Sha256.make("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
  millionA: Sha256.make("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"),
};

/** A hash no law ever puts bytes under. */
const neverPut = Sha256.make("0".repeat(64));

const putAndRead = (
  store: ByteStoreService,
  what: string,
  bytes: Stream.Stream<Uint8Array>,
  expected: Stored,
  check: (read: Uint8Array) => Effect.Effect<void, LawBroken>
) =>
  Effect.gen(function* () {
    yield* same(`${what}: what put kept`, yield* store.put(bytes), expected);
    yield* check(yield* read(store, expected.hash));
  });

type ByteStoreLaw = Law<ByteStoreHarness, Failure>;

const putThenRead: ByteStoreLaw = {
  check: ({ store }) =>
    Effect.gen(function* () {
      yield* putAndRead(store, "abc", chunksOf("abc"), { hash: vectors.abc, size: 3 }, (bytes) =>
        same("abc read back", textOf(bytes), "abc")
      );
      yield* putAndRead(store, "nothing", Stream.empty, { hash: vectors.empty, size: 0 }, (bytes) =>
        same("nothing read back", bytes.length, 0)
      );

      const chunk = "a".repeat(1000);

      const million = Stream.fromIterable(
        Array.from({ length: 1000 }, () => encoder.encode(chunk))
      );

      yield* putAndRead(
        store,
        "a million a's in a thousand chunks",
        million,
        { hash: vectors.millionA, size: 1_000_000 },
        (bytes) =>
          same(
            "a million a's read back",
            [bytes.length, bytes.every((byte) => byte === 97)],
            [1_000_000, true]
          )
      );
      yield* same("held", yield* store.held, 1_000_003);
    }),
  name: "put then read gives the same bytes and their SHA-256 hash",
};

const putTwice: ByteStoreLaw = {
  check: ({ store }) =>
    Effect.gen(function* () {
      const first = yield* store.put(chunksOf("abc"));
      const second = yield* store.put(chunksOf("a", "bc"));
      yield* same("the second put", second, first);
      yield* same("read back", textOf(yield* read(store, vectors.abc)), "abc");
      yield* same("held", yield* store.held, 3);
    }),
  name: "putting the same bytes twice is safe, and they are held once",
};

const rangeRead: ByteStoreLaw = {
  check: ({ store }) =>
    Effect.gen(function* () {
      const { hash } = yield* store.put(chunksOf("0123", "456789"));

      const ranges: readonly (readonly [ByteRange, string])[] = [
        [{ end: 3, start: 0 }, "012"],
        [{ end: 7, start: 4 }, "456"],
        [{ end: 10, start: 7 }, "789"],
        [{ end: 10, start: 0 }, "0123456789"],
        [{ end: 100, start: 8 }, "89"],
        [{ end: 3, start: 3 }, ""],
        [{ end: 20, start: 10 }, ""],
        [{ end: 20, start: 12 }, ""],
      ];

      for (const [range, expected] of ranges) {
        yield* same(
          `bytes ${range.start} to ${range.end}`,
          textOf(yield* read(store, hash, range)),
          expected
        );
      }

      yield* store.put(Stream.empty);
      yield* same(
        "a range of nothing",
        (yield* read(store, vectors.empty, { end: 5, start: 0 })).length,
        0
      );
    }),
  name: "a range read gives exactly that range, clamped to what is held",
};

const deleteThenRead: ByteStoreLaw = {
  check: ({ store }) =>
    Effect.gen(function* () {
      const { hash } = yield* store.put(chunksOf("abc"));
      yield* store.put(chunksOf("kept"));
      yield* store.delete(hash);
      yield* fails("reading what was deleted", store.read(hash), "ByteStoreNotFound");
      yield* same("held", yield* store.held, 4);
    }),
  name: "delete then read is not found",
};

const deleteMissing: ByteStoreLaw = {
  check: ({ store }) =>
    Effect.gen(function* () {
      yield* fails("deleting what was never put", store.delete(neverPut), "succeeded");
      const { hash } = yield* store.put(chunksOf("abc"));
      yield* store.delete(hash);
      yield* fails("deleting it again", store.delete(hash), "succeeded");
    }),
  name: "deleting what is missing succeeds",
};

const neverPutRead: ByteStoreLaw = {
  check: ({ store }) =>
    Effect.gen(function* () {
      yield* fails("reading what was never put", store.read(neverPut), "ByteStoreNotFound");
      yield* fails(
        "reading a range of what was never put",
        store.read(neverPut, { end: 1, start: 0 }),
        "ByteStoreNotFound"
      );
      yield* same("held", yield* store.held, 0);
    }),
  name: "reading a hash never put is not found",
};

const unreachableStore: ByteStoreLaw = {
  check: ({ store, unreachable }) =>
    Effect.gen(function* () {
      const { hash } = yield* store.put(chunksOf("abc"));
      const unavailable = "ByteStoreUnavailable";
      yield* fails("reading what is held", unreachable.read(hash), unavailable);
      yield* fails(
        "reading a range of it",
        unreachable.read(hash, { end: 1, start: 0 }),
        unavailable
      );
      yield* fails("reading what was never put", unreachable.read(neverPut), unavailable);
      yield* fails("putting", unreachable.put(chunksOf("more")), unavailable);
      yield* fails("deleting what is held", unreachable.delete(hash), unavailable);
      yield* fails("deleting what was never put", unreachable.delete(neverPut), unavailable);
      yield* fails("how much is held", unreachable.held, unavailable);
      yield* same("still held, once reached", textOf(yield* read(store, hash)), "abc");
      yield* same("held", yield* store.held, 3);
    }),
  name: "an unreachable store is unavailable, never not found",
};

/** The laws every byte store adapter keeps, each against a fresh, empty store. */
export const byteStoreLaws: readonly ByteStoreLaw[] = [
  putThenRead,
  putTwice,
  rangeRead,
  deleteThenRead,
  deleteMissing,
  neverPutRead,
  unreachableStore,
];
