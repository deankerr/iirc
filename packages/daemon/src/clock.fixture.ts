import { eventually } from "@iirc/session/testing";
import { Duration, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

/**
 * How long real work, such as SQLite or a socket, may take before a test calls it hung.
 * Nothing that works reaches it, so it says nothing about speed.
 */
const realWork = "60 seconds";

/**
 * Waits for something real to be so, on the live clock, because a test on `TestClock`
 * never moves the clock for it.
 * @param check - What to look at.
 * @param done - Whether it is so.
 * @returns What satisfied `done`.
 */
export const untilTrue = <A, E, R>(check: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  TestClock.withLive(eventually(check, done, realWork));

/**
 * Waits on the live clock for a fiber that real work stands behind, and fails the test if
 * it never finishes. The test clock is not moved meanwhile, so a fiber that would only
 * finish once it was is a failure here, and not a pass.
 * @param fiber - The fiber.
 * @param what - What it is, for the failure.
 * @returns What the fiber came to.
 */
export const finishes = Effect.fnUntraced(function* <A, E>(fiber: Fiber.Fiber<A, E>, what: string) {
  const exit = yield* TestClock.withLive(Fiber.await(fiber).pipe(Effect.timeoutOption(realWork)));

  if (Option.isNone(exit)) {
    return yield* Effect.die(new Error(`${what} did not finish`));
  }

  return yield* exit.value;
});

/**
 * Runs something, moves the test clock by `duration`, and requires it to have finished by
 * then.
 * @param duration - How far to move the clock.
 * @param what - What is running, for the failure.
 * @param effect - What to run.
 * @returns What it came to.
 */
export const withinClock = Effect.fnUntraced(function* <A, E, R>(
  duration: Duration.Input,
  what: string,
  effect: Effect.Effect<A, E, R>
) {
  const fiber = yield* Effect.forkChild(effect);

  yield* TestClock.adjust(duration);

  return yield* finishes(
    fiber,
    `${what} within ${Duration.format(Duration.fromInputUnsafe(duration))} of the clock`
  );
});
