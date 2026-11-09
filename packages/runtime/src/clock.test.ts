import { Instant } from "@iirc/client";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { now, sleepUntil } from "./clock.ts";

const withTestClock = async <A>(effect: Effect.Effect<A>) =>
  await Effect.runPromise(Effect.provide(effect, TestClock.layer()));

describe("the Clock", () => {
  it("reads the instant from the Clock in context", async () => {
    const instant = await withTestClock(Effect.andThen(TestClock.setTime(1_762_560_000_000), now));

    expect(instant).toBe(1_762_560_000_000);
  });

  it("wakes at an instant, and not before", async () => {
    const woke = await withTestClock(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const sleeping = yield* Effect.forkChild(sleepUntil(Instant.make(61_000)));

        yield* TestClock.adjust(59_999);
        const early = sleeping.pollUnsafe();

        yield* TestClock.adjust(1);
        yield* Fiber.join(sleeping);
        const at = yield* now;

        return { at, early: early === undefined };
      })
    );

    expect(woke).toStrictEqual({ at: 61_000, early: true });
  });

  it("returns at once for an instant already past", async () => {
    const at = await withTestClock(
      Effect.gen(function* () {
        yield* TestClock.setTime(5000);
        yield* sleepUntil(Instant.make(1000));

        return yield* now;
      })
    );

    expect(at).toBe(5000);
  });
});
