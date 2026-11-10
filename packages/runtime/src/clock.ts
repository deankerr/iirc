/**
 * The Clock port. It is Effect's own `Clock`, so the live adapter is the default Clock
 * and the test adapter is `TestClock` from `effect/testing`. These two helpers are the
 * only way the Runtime reads time, so every `at` and every wake goes through the Clock
 * in context.
 *
 * @packageDocumentation
 */
import { Instant } from "@iirc/client";
import { Clock, Duration, Effect } from "effect";

/** The instant now, by the Clock in context. Every input's `at` comes from here. */
export const now: Effect.Effect<Instant> = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => Instant.make(Math.floor(millis)))
);

/**
 * Waits until an instant, by the Clock in context. An instant already past returns at once.
 * @param at - The instant a `Wake` set.
 * @returns An Effect that completes at or after `at`.
 */
export const sleepUntil = (at: Instant): Effect.Effect<void> =>
  now.pipe(Effect.flatMap((current) => Effect.sleep(Duration.millis(Math.max(0, at - current)))));
