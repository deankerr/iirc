/**
 * The pacer: how many fetches may run at once to one name, and how many may start in a
 * minute. Every adapter builds one in, so a flood of links can neither hammer one site nor
 * fetch without limit. A fetch beyond either bound waits its turn, and never fails for
 * waiting. Of those waiting, what a fetch already began goes first, then a first fetch, then
 * a refresh, and among equals the one asked last.
 *
 * @packageDocumentation
 */
import { Clock, Deferred, Effect } from "effect";
import type { Scope } from "effect";

/** The bounds every adapter paces its fetches to. */
export const pacing = {
  /** Fetches started in any rolling minute, all names together. */
  perMinute: 30,
  /** Hops held at once to one name. */
  perName: 2,
} as const;

const minute = 60_000;

/**
 * Where a fetch stands among those waiting, which only orders them and never changes a
 * bound. `begun` finishes what a fetch already made began, such as a page's oEmbed or image,
 * and goes ahead of anything new. `first` fetches a link never fetched before. `refresh`
 * fetches again what is already held, and goes after both.
 */
export type Precedence = "begun" | "first" | "refresh";

const rankOf: Record<Precedence, number> = { begun: 0, first: 1, refresh: 2 };

/** One fetch's place in line, which it keeps through each hop it makes. */
export interface Turn {
  /**
   * Waits until fewer than {@link pacing}'s `perMinute` fetches started in the minute before
   * and no fetch waiting stands ahead of this one, then counts this one as started.
   */
  readonly start: Effect.Effect<void>;
  /**
   * Waits for one of a name's places, given to whichever fetch waiting for it stands
   * furthest ahead, then holds it until the Scope closes. A name is counted without a
   * trailing dot, as the URL parser has already lower-cased it.
   */
  readonly hop: (name: string) => Effect.Effect<void, never, Scope.Scope>;
}

/** Paces fetches. An adapter asks it once for each fetch, then before it starts and each hop. */
export interface Pacer extends Turn {
  /**
   * A fetch's place in line, asked now.
   * @param precedence - Where it stands among those waiting.
   */
  readonly ask: (precedence: Precedence) => Effect.Effect<Turn>;
}

/** A fetch waiting for a turn: its rank, and when it asked, later asks counting higher. */
interface Waiter {
  readonly rank: number;
  readonly asked: number;
}

/**
 * What a waiter found when it looked: its turn, taken, or to wait for a change, or for the
 * time the full minute next frees a start, whichever is first.
 */
type Look = { readonly _tag: "Taken" } | { readonly _tag: "Wait"; readonly until?: number };

const taken: Look = { _tag: "Taken" };
const waitForChange: Look = { _tag: "Wait" };

/** A name's places: how many are held, and who waits for one, so an idle name is forgotten. */
interface Places {
  held: number;
  readonly waiting: Set<Waiter>;
}

/**
 * Whether a waiter stands ahead of every other waiting beside it.
 * @param waiter - The waiter.
 * @param waiting - Every waiter, itself included.
 * @returns Whether it is first in line.
 */
const foremost = (waiter: Waiter, waiting: ReadonlySet<Waiter>): boolean => {
  for (const other of waiting) {
    if (other.rank < waiter.rank || (other.rank === waiter.rank && other.asked > waiter.asked)) {
      return false;
    }
  }

  return true;
};

/**
 * Makes a pacer, with nothing started and no place held.
 * @returns The pacer.
 */
export const makePacer: Effect.Effect<Pacer> = Effect.sync(() => {
  const names = new Map<string, Places>();
  // Fetches waiting to start.
  const starting = new Set<Waiter>();
  // When each fetch in the last minute started, oldest first.
  let started: readonly number[] = [];
  let asks = 0;
  // Settled whenever a place is held or given up, or a waiter comes or goes, so every
  // waiter looks again at where it stands.
  let changed = Deferred.makeUnsafe<undefined>();

  const change = () => {
    const was = changed;

    changed = Deferred.makeUnsafe<undefined>();
    Deferred.doneUnsafe(was, Effect.undefined);
  };

  /**
   * Waits until a waiter may go, deciding each time in one synchronous step, so nothing
   * changes between looking and taking.
   * @param look - Takes the turn if it may, and says what it found.
   * @returns Once taken.
   */
  const waitUntil = (look: (now: number) => Look) =>
    Effect.gen(function* () {
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        const wake = changed;
        const found = look(now);

        if (found._tag === "Taken") {
          return;
        }

        yield* found.until === undefined
          ? Deferred.await(wake)
          : Deferred.await(wake).pipe(
              Effect.timeoutOrElse({
                duration: found.until - now,
                orElse: () => Effect.void,
              })
            );
      }
    });

  /**
   * Waits for a place at a name, then holds it until the Scope closes. A waiter that stops
   * waiting is forgotten, and a name with none held or waiting is forgotten too.
   * @param waiter - The fetch.
   * @param key - The name, without a trailing dot.
   * @returns Once held.
   */
  const hopAs = (waiter: Waiter, key: string) => {
    let holding = false;

    const join = Effect.sync(() => {
      const places = names.get(key) ?? { held: 0, waiting: new Set<Waiter>() };

      places.waiting.add(waiter);
      names.set(key, places);
      change();

      return places;
    });

    const leave = (places: Places) =>
      Effect.sync(() => {
        if (holding) {
          places.held -= 1;
        } else {
          places.waiting.delete(waiter);
        }

        if (places.held === 0 && places.waiting.size === 0) {
          names.delete(key);
        }

        change();
      });

    return Effect.acquireRelease(join, leave).pipe(
      Effect.flatMap((places) =>
        waitUntil(() => {
          if (places.held >= pacing.perName || !foremost(waiter, places.waiting)) {
            return waitForChange;
          }

          places.waiting.delete(waiter);
          places.held += 1;
          holding = true;
          change();

          return taken;
        })
      )
    );
  };

  const startAs = (waiter: Waiter) =>
    Effect.suspend(() => {
      starting.add(waiter);
      change();

      return waitUntil((now) => {
        started = started.filter((at) => at > now - minute);

        const [oldest] = started;

        if (started.length >= pacing.perMinute && oldest !== undefined) {
          return { _tag: "Wait", until: oldest + minute };
        }

        if (!foremost(waiter, starting)) {
          return waitForChange;
        }

        starting.delete(waiter);
        started = [...started, now];
        change();

        return taken;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            starting.delete(waiter);
            change();
          })
        )
      );
    });

  const turnOf = (precedence: Precedence): Turn => {
    asks += 1;

    const waiter: Waiter = { asked: asks, rank: rankOf[precedence] };

    return {
      hop: (name) => hopAs(waiter, name.replace(/\.$/u, "")),
      start: startAs(waiter),
    };
  };

  const ask = (precedence: Precedence) => Effect.sync(() => turnOf(precedence));

  return {
    ask,
    // Alone, each is a first fetch of its own, asked as it waits.
    hop: (name) => Effect.flatMap(ask("first"), (turn) => turn.hop(name)),
    start: Effect.flatMap(ask("first"), (turn) => turn.start),
  } satisfies Pacer;
});
