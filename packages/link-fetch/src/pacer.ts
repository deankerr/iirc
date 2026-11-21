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

/**
 * One fetch's place in line, which it keeps through each hop it makes. Each waits until the
 * bounds allow it and no fetch that waits for the same bound, and that they allow, stands
 * ahead of this one. A name is counted without a trailing dot, as the URL parser has already
 * lower-cased it.
 */
export interface Turn {
  /**
   * Waits until fewer than {@link pacing}'s `perMinute` fetches started in the minute
   * before, then counts this one as started.
   */
  readonly start: Effect.Effect<void>;
  /**
   * Waits for one of a name's places, then holds it until the Scope closes, as a redirect's
   * hop does.
   */
  readonly hop: (name: string) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Waits until it may both start and take one of a name's places, then does both at once
   * and holds the place until the Scope closes, as a fetch's first hop does. A fetch is
   * counted as started only as it goes, so one waiting for a name never uses up the minute.
   */
  readonly begin: (name: string) => Effect.Effect<void, never, Scope.Scope>;
}

/** Paces fetches. An adapter asks it once for each fetch, then before each hop. */
export interface Pacer extends Turn {
  /**
   * A fetch's place in line, asked now. Alone, each of the pacer's own waits is a first
   * fetch of its own, asked as it waits.
   * @param precedence - Where it stands among those waiting.
   */
  readonly ask: (precedence: Precedence) => Effect.Effect<Turn>;
}

/** A fetch's place: its rank, and when it asked, later asks counting higher. */
interface Place {
  readonly rank: number;
  readonly asked: number;
}

/** One wait for a turn: whose, the name it takes a place at, if any, and whether it starts. */
interface Waiting {
  readonly place: Place;
  readonly name: string | undefined;
  readonly starts: boolean;
}

/**
 * What a waiter found when it looked: its turn, taken, or to wait for a change, or for the
 * time the full minute next frees a start, whichever is first.
 */
type Look = { readonly _tag: "Taken" } | { readonly _tag: "Wait"; readonly until?: number };

const taken: Look = { _tag: "Taken" };
const waitForChange: Look = { _tag: "Wait" };

/**
 * A name as it is counted, without a trailing dot.
 * @param name - The name.
 * @returns It, counted.
 */
const key = (name: string) => name.replace(/\.$/u, "");

/**
 * Whether one place stands ahead of another.
 * @param one - The one.
 * @param other - The other.
 * @returns Whether it does.
 */
const ahead = (one: Place, other: Place): boolean =>
  one.rank < other.rank || (one.rank === other.rank && one.asked > other.asked);

/**
 * Whether two waits want the same bound: the same name, or both to start.
 * @param one - The one.
 * @param other - The other.
 * @returns Whether they do.
 */
const contend = (one: Waiting, other: Waiting): boolean =>
  (one.name !== undefined && one.name === other.name) || (one.starts && other.starts);

/**
 * Makes a pacer, with nothing started and no place held.
 * @returns The pacer.
 */
export const makePacer: Effect.Effect<Pacer> = Effect.sync(() => {
  // How many places each name holds. A name holding none is forgotten.
  const held = new Map<string, number>();
  const waiting = new Set<Waiting>();
  // The waits that hold a name's place, until their Scope closes.
  const holders = new Set<Waiting>();
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
   * Whether the bounds alone allow a wait to go now.
   * @param wait - The wait.
   * @returns Whether they do.
   */
  const allowed = (wait: Waiting): boolean =>
    (wait.name === undefined || (held.get(wait.name) ?? 0) < pacing.perName) &&
    (!wait.starts || started.length < pacing.perMinute);

  /**
   * Takes a wait's turn if the bounds allow it and no wait for the same bound that they
   * allow stands ahead of it. Synchronous, so nothing changes between looking and taking,
   * and a start and a name's place are taken together.
   * @param wait - The wait.
   * @param now - The time.
   * @returns What it found.
   */
  const look = (wait: Waiting, now: number): Look => {
    started = started.filter((at) => at > now - minute);

    if (!allowed(wait)) {
      const [oldest] = started;

      return wait.starts && oldest !== undefined && started.length >= pacing.perMinute
        ? { _tag: "Wait", until: oldest + minute }
        : waitForChange;
    }

    for (const other of waiting) {
      if (
        other !== wait &&
        contend(other, wait) &&
        allowed(other) &&
        ahead(other.place, wait.place)
      ) {
        return waitForChange;
      }
    }

    waiting.delete(wait);

    if (wait.name !== undefined) {
      held.set(wait.name, (held.get(wait.name) ?? 0) + 1);
      holders.add(wait);
    }

    if (wait.starts) {
      started = [...started, now];
    }

    change();

    return taken;
  };

  /**
   * Waits for a turn, looking again at each change, and when the full minute frees a start.
   * A wait that stops waiting is forgotten at once.
   * @param wait - The wait.
   * @returns Once taken.
   */
  const waitFor = (wait: Waiting) =>
    Effect.gen(function* () {
      waiting.add(wait);
      change();

      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        const wake = changed;
        const found = look(wait, now);

        if (found._tag === "Taken") {
          return;
        }

        yield* found.until === undefined
          ? Deferred.await(wake)
          : Deferred.await(wake).pipe(
              Effect.timeoutOrElse({ duration: found.until - now, orElse: () => Effect.void })
            );
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          waiting.delete(wait);
          change();
        })
      )
    );

  /**
   * Waits for a turn that takes a name's place, then holds it until the Scope closes.
   * @param wait - The wait.
   * @returns Once held.
   */
  const holding = (wait: Waiting & { readonly name: string }) =>
    Effect.gen(function* () {
      // Added before the wait, so a place taken is always given back, once, and a wait
      // still waiting is forgotten.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          waiting.delete(wait);

          if (holders.delete(wait)) {
            const left = (held.get(wait.name) ?? 1) - 1;

            if (left === 0) {
              held.delete(wait.name);
            } else {
              held.set(wait.name, left);
            }
          }

          change();
        })
      );
      yield* waitFor(wait);
    });

  const turnOf = (precedence: Precedence): Turn => {
    asks += 1;

    const place: Place = { asked: asks, rank: rankOf[precedence] };

    return {
      begin: (name) => holding({ name: key(name), place, starts: true }),
      hop: (name) => holding({ name: key(name), place, starts: false }),
      start: Effect.suspend(() => waitFor({ name: undefined, place, starts: true })),
    };
  };

  const ask = (precedence: Precedence) => Effect.sync(() => turnOf(precedence));

  return {
    ask,
    begin: (name) => Effect.flatMap(ask("first"), (turn) => turn.begin(name)),
    hop: (name) => Effect.flatMap(ask("first"), (turn) => turn.hop(name)),
    start: Effect.flatMap(ask("first"), (turn) => turn.start),
  } satisfies Pacer;
});
