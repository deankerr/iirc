import { Effect, Exit, Fiber, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { makePacer, pacing } from "./pacer.ts";

const run = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test).pipe(Effect.provide(TestClock.layer())));

/** Lets every fiber that can run do so, without moving the clock. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

describe("the pacer", () => {
  it("holds two places at once to one name, giving a third its turn once one is given up", async () => {
    const order = await run(
      Effect.gen(function* () {
        const pacer = yield* makePacer;
        const turns = yield* Ref.make<readonly number[]>([]);
        const scopes = yield* Effect.forEach([0, 1, 2, 3], () => Scope.make());

        // Forked one after another, so they ask in order.
        for (const [at, scope] of scopes.entries()) {
          yield* Effect.forkChild(
            Scope.provide(pacer.hop("example.com"), scope).pipe(
              Effect.andThen(Ref.update(turns, (all) => [...all, at]))
            )
          );
        }

        yield* settle;

        const first = yield* Ref.get(turns);

        const [, held] = scopes;

        if (held !== undefined) {
          yield* Scope.close(held, Exit.void);
        }

        yield* settle;

        const second = yield* Ref.get(turns);

        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
        yield* Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void));
        yield* settle;

        return { first, second, third: yield* Ref.get(turns) };
      })
    );

    expect(order).toStrictEqual({ first: [0, 1], second: [0, 1, 2], third: [0, 1, 2, 3] });
  });

  it("counts a name with and without its trailing dot as one, and another name apart", async () => {
    const turns = await run(
      Effect.gen(function* () {
        const pacer = yield* makePacer;
        const taken = yield* Ref.make<readonly string[]>([]);

        yield* Effect.forEach(["a.test", "a.test.", "a.test", "b.test"], (name) =>
          Effect.forkChild(
            Effect.scoped(
              pacer
                .hop(name)
                .pipe(
                  Effect.andThen(Ref.update(taken, (all) => [...all, name])),
                  Effect.andThen(Effect.never)
                )
            )
          )
        );
        yield* settle;

        return yield* Ref.get(taken);
      })
    );

    expect(turns).toStrictEqual(["a.test", "a.test.", "b.test"]);
  });

  it("starts thirty in a minute, and the rest in the order they asked once the minute turns", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const pacer = yield* makePacer;
        const started = yield* Ref.make<readonly number[]>([]);

        const fibers = yield* Effect.forEach(
          Array.from({ length: pacing.perMinute + 2 }, (_, at) => at),
          (at) =>
            Effect.forkChild(
              pacer.start.pipe(Effect.andThen(Ref.update(started, (all) => [...all, at])))
            )
        );

        yield* settle;

        const atFirst = (yield* Ref.get(started)).length;

        yield* TestClock.adjust(59_999);
        yield* settle;

        const before = (yield* Ref.get(started)).length;

        yield* TestClock.adjust(1);
        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
        yield* Effect.forEach(fibers, Fiber.join);

        return { atFirst, before, order: yield* Ref.get(started) };
      })
    );

    expect(seen.atFirst).toBe(pacing.perMinute);
    expect(seen.before).toBe(pacing.perMinute);
    expect(seen.order).toStrictEqual(Array.from({ length: pacing.perMinute + 2 }, (_, at) => at));
  });

  it("counts the minute rolling, from when each fetch started", async () => {
    const counts = await run(
      Effect.gen(function* () {
        const pacer = yield* makePacer;
        const started = yield* Ref.make(0);
        const start = pacer.start.pipe(Effect.andThen(Ref.update(started, (count) => count + 1)));

        // Half start at once, and half thirty seconds on.
        yield* Effect.forEach(Array.from({ length: pacing.perMinute / 2 }), () => start);
        yield* TestClock.adjust(30_000);
        yield* Effect.forEach(Array.from({ length: pacing.perMinute / 2 }), () => start);

        yield* Effect.forkChild(Effect.forEach(Array.from({ length: 2 }), () => start));
        yield* settle;

        const full = yield* Ref.get(started);

        // The first half's minute is up, so the waiting two start, and no more than that.
        yield* TestClock.adjust(30_000);
        yield* settle;

        return { full, turned: yield* Ref.get(started) };
      })
    );

    expect(counts).toStrictEqual({ full: pacing.perMinute, turned: pacing.perMinute + 2 });
  });

  it("forgets a hop that stopped waiting, giving its turn to the next", async () => {
    const taken = await run(
      Effect.gen(function* () {
        const pacer = yield* makePacer;
        const turns = yield* Ref.make<readonly string[]>([]);
        const first = yield* Scope.make();

        const hop = (name: string, scope: Scope.Scope) =>
          Effect.forkChild(
            Scope.provide(pacer.hop("a.test"), scope).pipe(
              Effect.andThen(Ref.update(turns, (all) => [...all, name]))
            )
          );

        yield* hop("first", first);
        yield* hop("second", yield* Scope.make());
        yield* settle;

        const gaveUp = yield* hop("gave up", yield* Scope.make());

        yield* hop("next", yield* Scope.make());
        yield* settle;
        yield* Fiber.interrupt(gaveUp);
        yield* Scope.close(first, Exit.void);
        yield* settle;

        return yield* Ref.get(turns);
      })
    );

    expect(taken).toStrictEqual(["first", "second", "next"]);
  });
});
