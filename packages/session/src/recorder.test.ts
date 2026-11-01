import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import type { Array as Arr } from "effect";
import { TestClock } from "effect/testing";

import type { NewEntry } from "./entry.ts";
import { MemoryEntries, Recorder } from "./recorder.ts";

const deadline = (name: string): NewEntry => ({ _tag: "Deadline", name, network: "libera" });

const line: NewEntry = {
  _tag: "Line",
  bytes: new TextEncoder().encode("PING :1"),
  connection: 1,
  direction: "inbound",
  network: "libera",
};

const record = (entries: Arr.NonEmptyReadonlyArray<NewEntry>) =>
  Recorder.use(({ record }) => record(entries, (recorded) => recorded));

const sequences = Effect.map(
  MemoryEntries.use(({ entries }) => entries),
  (entries) => entries.map(({ sequence }) => sequence)
);

describe("Recorder.memory", () => {
  it.effect("numbers Entries from 1 with no gaps, across calls", () =>
    Effect.gen(function* () {
      yield* record([deadline("a"), deadline("b")]);
      yield* record([deadline("c")]);

      assert.deepStrictEqual(yield* sequences, [1, 2, 3]);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("stays gapless when Fibers record concurrently", () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        Array.from({ length: 50 }, (_, index) => `${index}`),
        (name) => record([deadline(name), deadline(name)]),
        { concurrency: "unbounded" }
      );

      assert.deepStrictEqual(
        yield* sequences,
        Array.from({ length: 100 }, (_, index) => index + 1)
      );
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("keeps an Entry's fields as given", () =>
    Effect.gen(function* () {
      yield* record([line]);

      const entries = yield* MemoryEntries.use(({ entries }) => entries);

      assert.deepStrictEqual(entries, [{ ...line, at: 0, sequence: 1 }]);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("takes `at` from the Clock", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");

      const [first] = yield* record([deadline("a")]);

      yield* TestClock.adjust("1 second");

      const [second] = yield* record([deadline("b")]);

      assert.strictEqual(first?.at, 5000);
      assert.strictEqual(second?.at, 6000);
    }).pipe(Effect.provide(Recorder.memory))
  );

  it.effect("runs `within` on the numbered Entries and returns its result", () =>
    Effect.gen(function* () {
      const seen = yield* Recorder.use(({ record }) =>
        record([deadline("a"), deadline("b")], (recorded) =>
          recorded.map((entry) => entry.sequence)
        )
      );

      assert.deepStrictEqual(seen, [1, 2]);
    }).pipe(Effect.provide(Recorder.memory))
  );

  it.effect("rolls back and dies when `within` throws, consuming no sequence", () =>
    Effect.gen(function* () {
      const failure = new Error("machine threw");

      yield* record([deadline("a")]);

      const exit = yield* Recorder.use(({ record }) =>
        record([deadline("b"), deadline("c")], () => {
          throw failure;
        })
      ).pipe(Effect.exit);

      assert.deepStrictEqual(exit, Exit.die(failure));
      assert.deepStrictEqual(yield* sequences, [1]);

      const [next] = yield* record([deadline("d")]);

      assert.strictEqual(next?.sequence, 2);
      assert.deepStrictEqual(yield* sequences, [1, 2]);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("starts empty for each build of the Layer", () =>
    Effect.gen(function* () {
      const build = record([deadline("a")]).pipe(
        Effect.andThen(sequences),
        Effect.provide(Recorder.memoryReadable)
      );

      assert.deepStrictEqual(yield* build, [1]);
      assert.deepStrictEqual(yield* build, [1]);
    })
  );
});
