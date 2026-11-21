import { Effect, Exit, Fiber, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { makePacer, pacing } from "./pacer.ts";
import type { Precedence } from "./pacer.ts";

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

    // The place given up goes to the latest ask.
    expect(order).toStrictEqual({ first: [0, 1], second: [0, 1, 3], third: [0, 1, 3, 2] });
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

/** A waiting fetch: what it is called, and its precedence. */
type Waiter = readonly [label: string, precedence: Precedence];

/** Which bound the waiters wait on: the minute's starts, or one name's places. */
type Bound = "minute" | "name";

/**
 * The order waiting fetches are given their turns once a bound is full: the minute's starts
 * freeing one a second, or one of a name's places given up, which each passes on.
 * @param bound - Which bound they wait on.
 * @param waiters - The fetches, in the order they asked.
 * @returns Their labels, in the order their turns came.
 */
const turnsOf = async (bound: Bound, waiters: readonly Waiter[]) =>
  await run(
    Effect.gen(function* () {
      const pacer = yield* makePacer;
      const turns = yield* Ref.make<readonly string[]>([]);

      // The minute fills one start a second, so it frees one a second once it turns.
      const holders = yield* Effect.forEach(
        Array.from({ length: bound === "minute" ? pacing.perMinute : pacing.perName }),
        () =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();

            if (bound === "minute") {
              yield* pacer.start;
              yield* TestClock.adjust(1000);
            } else {
              yield* Scope.provide(pacer.hop("a.test"), scope);
            }

            return scope;
          })
      );

      for (const [label, precedence] of waiters) {
        const turn = yield* pacer.ask(precedence);

        const taken = Ref.update(turns, (all) => [...all, label]);

        // A name's place is given up as soon as it is taken, so the next is given it then.
        yield* Effect.forkChild(
          bound === "minute"
            ? Effect.andThen(turn.start, taken)
            : Effect.scoped(Effect.andThen(turn.hop("a.test"), taken))
        );
        yield* settle;
      }

      if (bound === "minute") {
        yield* TestClock.adjust(60_000 - pacing.perMinute * 1000);
        yield* settle;
      }

      for (const scope of holders) {
        yield* bound === "minute" ? TestClock.adjust(1000) : Scope.close(scope, Exit.void);
        yield* settle;
      }

      return yield* Ref.get(turns);
    })
  );

describe("a fetch's first hop", () => {
  it("counts as started only once it goes, and goes only once both bounds allow it", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const pacer = yield* makePacer;
        const gone = yield* Ref.make<readonly string[]>([]);
        const held = yield* Scope.make();

        const going = (label: string, name: string, scope?: Scope.Scope) =>
          Effect.forkChild(
            Scope.provide(
              pacer.begin(name).pipe(Effect.andThen(Ref.update(gone, (all) => [...all, label]))),
              scope ?? held
            )
          );

        const first = yield* Scope.make();

        yield* going("a1", "a.test", first);
        yield* going("a2", "a.test");
        yield* settle;
        yield* going("waits for a.test", "a.test");
        yield* settle;

        for (const at of Array.from({ length: pacing.perMinute - pacing.perName }, (_, n) => n)) {
          yield* going(`other ${at}`, `${at}.test`);
        }

        yield* settle;

        const others = (yield* Ref.get(gone)).filter((label) => label.startsWith("other")).length;

        // a.test frees a place, but the minute is full.
        yield* Scope.close(first, Exit.void);
        yield* settle;

        const freed = (yield* Ref.get(gone)).includes("waits for a.test");

        yield* TestClock.adjust(60_000);
        yield* settle;

        return { freed, others, turned: (yield* Ref.get(gone)).includes("waits for a.test") };
      })
    );

    expect(seen).toStrictEqual({
      freed: false,
      others: pacing.perMinute - pacing.perName,
      turned: true,
    });
  });
});

describe("the pacer's order", () => {
  it("forgets a hop that stopped waiting while its Scope stays open", async () => {
    const turns = await run(
      Effect.gen(function* () {
        const pacer = yield* makePacer;
        const taken = yield* Ref.make<readonly string[]>([]);
        const first = yield* Scope.make();
        const open = yield* Scope.make();

        yield* Scope.provide(pacer.hop("a.test"), first);
        yield* Scope.provide(pacer.hop("a.test"), open);

        const hop = (label: string, precedence: Precedence) =>
          Effect.flatMap(pacer.ask(precedence), (turn) =>
            Effect.forkChild(
              Scope.provide(
                turn
                  .hop("a.test")
                  .pipe(Effect.andThen(Ref.update(taken, (all) => [...all, label]))),
                open
              )
            )
          );

        const gaveUp = yield* hop("gave up", "begun");

        yield* hop("next", "first");
        yield* settle;
        yield* Fiber.interrupt(gaveUp);
        yield* Scope.close(first, Exit.void);
        yield* settle;

        return yield* Ref.get(taken);
      })
    );

    expect(turns).toStrictEqual(["next"]);
  });

  it("forgets a fetch that stopped waiting to start, ahead of the rest as it stood", async () => {
    const turns = await run(
      Effect.gen(function* () {
        const pacer = yield* makePacer;
        const started = yield* Ref.make<readonly string[]>([]);

        yield* Effect.forEach(Array.from({ length: pacing.perMinute }), () => pacer.start);

        const waiting = (label: string, precedence: Precedence) =>
          Effect.flatMap(pacer.ask(precedence), (turn) =>
            Effect.forkChild(
              turn.start.pipe(Effect.andThen(Ref.update(started, (all) => [...all, label])))
            )
          );

        const gaveUp = yield* waiting("gave up", "begun");

        yield* waiting("next", "first");
        yield* settle;
        yield* Fiber.interrupt(gaveUp);
        yield* TestClock.adjust(60_000);
        yield* settle;

        return yield* Ref.get(started);
      })
    );

    expect(turns).toStrictEqual(["next"]);
  });

  const orders: readonly (readonly [string, readonly Waiter[], readonly string[]])[] = [
    [
      "gives the next turn to the latest ask",
      [
        ["a", "first"],
        ["b", "first"],
        ["c", "first"],
      ],
      ["c", "b", "a"],
    ],
    [
      "gives a first fetch its turn ahead of a refresh, whenever either asked",
      [
        ["first a", "first"],
        ["refresh", "refresh"],
        ["first b", "first"],
        ["refresh later", "refresh"],
      ],
      ["first b", "first a", "refresh later", "refresh"],
    ],
    [
      "finishes what a fetch began before starting another, a page asked later included",
      [
        ["page a", "first"],
        ["begun", "begun"],
        ["page b", "first"],
        ["refresh", "refresh"],
      ],
      ["begun", "page b", "page a", "refresh"],
    ],
  ];

  const rows = (["minute", "name"] as const).flatMap((bound) =>
    orders.map(([title, waiters, expected]) => ({ bound, expected, title, waiters }))
  );

  it.each(rows)("$title, waiting on the $bound", async ({ bound, expected, waiters }) => {
    await expect(turnsOf(bound, waiters)).resolves.toStrictEqual(expected);
  });
});
