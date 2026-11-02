import { assert, describe, it } from "@effect/vitest";
import type { Lane } from "@iirc/lifecycle";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { Deferred, Effect, Fiber, Option } from "effect";

import { makeLanes } from "./lanes.ts";
import type { QueuedLine } from "./lanes.ts";
import { safe } from "./network.fixture.ts";

const queuedOn = (lane: Lane, cause = "test"): QueuedLine => ({
  cause,
  lane,
  line: safe("PRIVMSG", ["#one", "hi"]),
  outcome: Deferred.makeUnsafe(),
});

const tuning = { ...defaultTuning, controlLaneLimit: 2, laneLimit: 2 };

const causeOf = (taken: Option.Option<QueuedLine>) =>
  Option.isSome(taken) ? taken.value.cause : undefined;

describe("lanes", () => {
  it.effect("SEND-1: control, then interactive, then background, in order within each", () =>
    Effect.gen(function* () {
      const { lanes, pumpLanes } = yield* makeLanes(tuning);

      yield* lanes.offerNow(queuedOn("background", "b"));
      yield* lanes.offerNow(queuedOn("interactive", "i1"));
      yield* lanes.offerNow(queuedOn("interactive", "i2"));
      yield* lanes.offerNow(queuedOn("control", "c"));

      const order = [];

      for (let index = 0; index < 5; index += 1) {
        order.push(causeOf(yield* pumpLanes.takeNext(true)));
      }

      assert.deepStrictEqual(order, ["c", "i1", "i2", "b", undefined]);
    })
  );

  it.effect("SEND-2: with no token, only control may leave", () =>
    Effect.gen(function* () {
      const { lanes, pumpLanes } = yield* makeLanes(tuning);

      yield* lanes.offerNow(queuedOn("interactive", "i"));

      assert.isUndefined(causeOf(yield* pumpLanes.takeNext(false)));

      yield* lanes.offerNow(queuedOn("control", "c"));

      assert.strictEqual(causeOf(yield* pumpLanes.takeNext(false)), "c");
      assert.isUndefined(causeOf(yield* pumpLanes.takeNext(false)));
    })
  );

  it.effect("SEND-3: each lane refuses past its limit, and counts what it holds", () =>
    Effect.gen(function* () {
      const { lanes } = yield* makeLanes(tuning);

      for (const lane of ["control", "interactive", "background"] as const) {
        assert.strictEqual(yield* lanes.offerNow(queuedOn(lane)), "queued");
        assert.strictEqual(yield* lanes.offerNow(queuedOn(lane)), "queued");
        assert.strictEqual(yield* lanes.offerNow(queuedOn(lane)), "full");
      }

      assert.deepStrictEqual(yield* lanes.depths, { background: 2, control: 2, interactive: 2 });
    })
  );

  it.effect("a waiting offer lands as soon as there is room", () =>
    Effect.gen(function* () {
      const { lanes, pumpLanes } = yield* makeLanes(tuning);

      yield* lanes.offerNow(queuedOn("control"));
      yield* lanes.offerNow(queuedOn("control"));

      const waiting = yield* Effect.forkChild(lanes.offerWaiting(queuedOn("control", "next")));

      yield* Effect.yieldNow;

      assert.isUndefined(waiting.pollUnsafe());

      yield* pumpLanes.takeNext(false);

      assert.isTrue(yield* Fiber.join(waiting));
    })
  );

  for (const [name, close] of [
    ["quitting", "quit"],
    ["shut", "shut"],
  ] as const) {
    it.effect(`a waiting offer gives up when the gate is ${name}`, () =>
      Effect.gen(function* () {
        const { lanes } = yield* makeLanes(tuning);

        yield* lanes.offerNow(queuedOn("control"));
        yield* lanes.offerNow(queuedOn("control"));

        const waiting = yield* Effect.forkChild(lanes.offerWaiting(queuedOn("control")));

        yield* Effect.yieldNow;
        yield* lanes[close];

        assert.isFalse(yield* Fiber.join(waiting));
        assert.strictEqual(yield* lanes.offerNow(queuedOn("control")), "shut");
        assert.isFalse(yield* lanes.isOpen);
      })
    );
  }

  it.effect("LIVE-9: quitting lets only control out, whatever tokens there are", () =>
    Effect.gen(function* () {
      const { lanes, pumpLanes } = yield* makeLanes(tuning);

      yield* lanes.offerNow(queuedOn("interactive", "i"));
      yield* lanes.offerNow(queuedOn("background", "b"));
      yield* lanes.quit;

      assert.isUndefined(causeOf(yield* pumpLanes.takeNext(true)));

      assert.isTrue(yield* lanes.offerQuit(queuedOn("control", "quit")));
      assert.strictEqual(causeOf(yield* pumpLanes.takeNext(true)), "quit");
    })
  );

  it.effect("LIVE-9: `QUIT` has a place beyond the limit, and only `QUIT` does", () =>
    Effect.gen(function* () {
      const { lanes } = yield* makeLanes(tuning);

      yield* lanes.offerNow(queuedOn("control"));
      yield* lanes.offerNow(queuedOn("control"));

      assert.strictEqual(yield* lanes.offerNow(queuedOn("control")), "full");
      assert.isTrue(yield* lanes.offerQuit(queuedOn("control")));
      assert.strictEqual((yield* lanes.depths).control, 3);
    })
  );

  it.effect("SEND-4: emptying hands over everything in order, and nothing can follow", () =>
    Effect.gen(function* () {
      const { lanes, pumpLanes } = yield* makeLanes(tuning);

      yield* lanes.offerNow(queuedOn("background", "b"));
      yield* lanes.offerNow(queuedOn("interactive", "i"));
      yield* lanes.offerNow(queuedOn("control", "c"));

      assert.deepStrictEqual(
        (yield* lanes.empty).map(({ cause }) => cause),
        ["c", "i", "b"]
      );
      assert.strictEqual(yield* lanes.offerNow(queuedOn("interactive")), "shut");
      assert.isFalse(yield* lanes.offerWaiting(queuedOn("interactive")));
      assert.isFalse(yield* lanes.offerQuit(queuedOn("control")));
      assert.isUndefined(causeOf(yield* pumpLanes.takeNext(true)));
    })
  );

  it.effect("the pump's wait wakes for what it may take, and sleeps through the rest", () =>
    Effect.gen(function* () {
      const { lanes, pumpLanes } = yield* makeLanes(tuning);

      yield* lanes.offerNow(queuedOn("interactive"));

      const noTokens = yield* Effect.forkChild(pumpLanes.awaitLine(false));

      yield* Effect.yieldNow;

      assert.isUndefined(noTokens.pollUnsafe());

      yield* lanes.offerNow(queuedOn("control"));
      yield* Fiber.join(noTokens);
    })
  );
});
