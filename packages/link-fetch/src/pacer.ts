/**
 * The pacer: how many fetches may run at once to one name, and how many may start in a
 * minute. Every adapter builds one in, so a flood of links can neither hammer one site nor
 * fetch without limit. A fetch beyond either bound waits its turn, in the order it asked,
 * and never fails for waiting.
 *
 * @packageDocumentation
 */
import { Clock, Effect, Semaphore } from "effect";
import type { Scope } from "effect";

/** The bounds every adapter paces its fetches to. */
export const pacing = {
  /** Fetches started in any rolling minute, all names together. */
  perMinute: 30,
  /** Hops held at once to one name. */
  perName: 2,
} as const;

const minute = 60_000;

/** Paces fetches. An adapter asks it before each fetch starts, and before each hop. */
export interface Pacer {
  /**
   * Waits until fewer than {@link pacing}'s `perMinute` fetches started in the minute before,
   * then counts this one as started. Fetches start in the order they asked.
   */
  readonly start: Effect.Effect<void>;
  /**
   * Waits for one of a name's places, then holds it until the Scope closes. A name's places
   * are given in the order they were asked. A name is counted without a trailing dot, as the
   * URL parser has already lower-cased it.
   */
  readonly hop: (name: string) => Effect.Effect<void, never, Scope.Scope>;
}

/** A name's places, and how many hops hold or wait for one, so an idle name is forgotten. */
interface Places {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
}

/**
 * Makes a pacer, with nothing started and no place held.
 * @returns The pacer.
 */
export const makePacer: Effect.Effect<Pacer> = Effect.sync(() => {
  const names = new Map<string, Places>();
  // One fetch at a time decides when it may start, so they start in the order they asked.
  const line = Semaphore.makeUnsafe(1);
  // When each fetch in the last minute started, oldest first, at most `perMinute` of them.
  let started: readonly number[] = [];

  const join = (name: string) =>
    Effect.sync(() => {
      const places = names.get(name) ?? {
        semaphore: Semaphore.makeUnsafe(pacing.perName),
        users: 0,
      };

      places.users += 1;
      names.set(name, places);

      return places;
    });

  const leave = (name: string, places: Places) =>
    Effect.sync(() => {
      places.users -= 1;

      if (places.users === 0) {
        names.delete(name);
      }
    });

  const hop = (name: string) => {
    const key = name.replace(/\.$/u, "");

    // The place is released before the name is left, as finalizers run in reverse.
    return Effect.acquireRelease(join(key), (places) => leave(key, places)).pipe(
      Effect.flatMap((places) => places.semaphore.takeScoped(1))
    );
  };

  const start = line.withPermit(
    Effect.gen(function* () {
      const asked = yield* Clock.currentTimeMillis;
      const recent = started.filter((at) => at > asked - minute);
      const [oldest] = recent;

      if (recent.length >= pacing.perMinute && oldest !== undefined) {
        yield* Effect.sleep(oldest + minute - asked);
      }

      const now = yield* Clock.currentTimeMillis;

      started = [...started.filter((at) => at > now - minute), now];
    })
  );

  return { hop, start } satisfies Pacer;
});
