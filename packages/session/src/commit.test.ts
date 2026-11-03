import { assert, describe, it } from "@effect/vitest";
import { phase, start } from "@iirc/lifecycle";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import { makeCommit } from "./connection.ts";
import type { Hosted } from "./connection.ts";
import type { NewEntry } from "./entry.ts";
import { MemoryEntries, Recorder } from "./recorder.ts";
import { attemptInput } from "./testing.ts";

// The host's one way to step its machine. Recording protects its own transaction, but the
// snapshot that follows is the host's to keep, and a caller cancelled in between must not
// leave the Log ahead of the machine.

const attempt: NewEntry = {
  _tag: "Connection",
  ircd: { host: "irc.example", port: 6697, tls: true },
  network: "libera",
  nicks: ["alice"],
  ...attemptInput,
  phase: "attempt",
};

// A Recorder that commits, and then takes a second to hand the result back, as one does
// that has to leave its transaction. Said to `committed` when the Entries are in.
const slowToAnswer = (committed: Deferred.Deferred<undefined>) =>
  Effect.gen(function* () {
    const memory = yield* Recorder;

    return {
      record: (entries, within) =>
        Effect.uninterruptible(memory.record(entries, within)).pipe(
          Effect.tap(() => Deferred.succeed(committed, undefined)),
          Effect.tap(() => Effect.sleep("1 second"))
        ),
      standing: memory.standing,
    } satisfies Recorder["Service"];
  });

const idle = {
  live: undefined,
  snapshot: start({
    loginLines: 0,
    realname: "I IRC",
    services: [],
    tuning: attemptInput.tuning,
    username: "user",
  }),
  stopped: false,
  unclosed: [],
  unrecorded: undefined,
} satisfies Hosted;

// Cancels `commit` once the Log holds its Entries, and lets the Recorder answer.
const cancelledAfterRecording = (
  committed: Deferred.Deferred<undefined>,
  fiber: Fiber.Fiber<unknown, unknown>
) =>
  Effect.gen(function* () {
    yield* Deferred.await(committed);

    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));

    yield* TestClock.adjust("1 second");
    yield* Fiber.join(interrupting);
  });

describe(makeCommit, () => {
  it.effect("keeps the snapshot the Log's Entries led to, though its caller is cancelled", () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<undefined>();
      const hosted = yield* Ref.make<Hosted>(idle);
      const { record } = yield* slowToAnswer(committed);
      const commit = makeCommit(hosted, record);

      const caller = yield* Effect.forkChild(commit([attempt]));

      yield* cancelledAfterRecording(committed, caller);

      assert.lengthOf(yield* MemoryEntries.use(({ entries }) => entries), 1);
      assert.strictEqual(phase((yield* Ref.get(hosted)).snapshot), "connecting");
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("runs `after` in the same unit, though its caller is cancelled", () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<undefined>();
      const hosted = yield* Ref.make<Hosted>(idle);
      const published = yield* Ref.make(false);
      const { record } = yield* slowToAnswer(committed);
      const commit = makeCommit(hosted, record);

      const caller = yield* Effect.forkChild(commit([attempt], () => Ref.set(published, true)));

      yield* cancelledAfterRecording(committed, caller);

      assert.isTrue(yield* Ref.get(published));
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );

  it.effect("still lets a caller waiting for its turn be cancelled", () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<undefined>();
      const hosted = yield* Ref.make<Hosted>(idle);
      const { record } = yield* slowToAnswer(committed);
      const commit = makeCommit(hosted, record);

      const first = yield* Effect.forkChild(commit([attempt]));

      yield* Deferred.await(committed);

      const waiting = yield* Effect.forkChild(commit([attempt]));

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(first);

      assert.lengthOf(yield* MemoryEntries.use(({ entries }) => entries), 1);
    }).pipe(Effect.provide(Recorder.memoryReadable))
  );
});
