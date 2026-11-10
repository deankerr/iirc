/**
 * One Connection's Outbox: which Line goes next, and when. It is plain data and pure
 * functions over it. Time arrives as an argument, in milliseconds, and nothing here reads
 * a clock.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

/**
 * How fast Lines may leave: up to `burst` at once, then one every `interval`
 * milliseconds, as a token bucket.
 */
export const Pacing = Schema.Struct({
  burst: Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 })),
  interval: Schema.Int.check(Schema.isBetween({ maximum: 3_600_000, minimum: 0 })),
});

/** The decoded form of {@link Pacing}. */
export type Pacing = typeof Pacing.Type;

/**
 * A burst of 5, then one Line every 2 s, as RFC 1459 §8.10 describes an Ircd's own
 * limit, and as irssi and WeeChat pace by default. It is safe on every Ircd, and tuned
 * for none.
 */
export const defaultPacing: Pacing = { burst: 5, interval: 2000 };

/** How many ordinary Lines may wait in one Outbox. */
export const defaultCapacity = 1000;

/** How many `PING` and `PONG` Lines may wait in one Outbox, apart from the ordinary ones. */
export const defaultFirstCapacity = 64;

/** One Line waiting, wrapped so that what is queued may be anything, `undefined` included. */
export interface Waiting<A> {
  readonly item: A;
}

/**
 * One Connection's queue. Lines that go first, `PING` and `PONG`, wait in `ahead`, at
 * most `firstCapacity` of them, and every other Line in `behind`, at most `capacity` of
 * them but for a `QUIT`, each in the order it was offered. The token bucket is held as
 * `fullAt`, the time it is next full, so there is no fraction of a token to round.
 */
export interface Outbox<A> {
  readonly pacing: Pacing;
  readonly capacity: number;
  readonly firstCapacity: number;
  readonly ahead: readonly Waiting<A>[];
  readonly behind: readonly Waiting<A>[];
  readonly fullAt: number;
}

/** What came of an offer: the Outbox with the Line queued, or `Full`, with nothing queued. */
export type Offered<A> =
  | { readonly _tag: "Queued"; readonly outbox: Outbox<A> }
  | { readonly _tag: "Full" };

/**
 * What came of asking for the next Line: it was `Taken`, spending a token; it must
 * `Wait` until a later time; or the Outbox is `Empty`. Each carries the Outbox to use
 * from then on, which has seen the time it was asked at.
 */
export type Take<A> =
  | { readonly _tag: "Taken"; readonly item: A; readonly outbox: Outbox<A> }
  | { readonly _tag: "Wait"; readonly until: number; readonly outbox: Outbox<A> }
  | { readonly _tag: "Empty"; readonly outbox: Outbox<A> };

/**
 * An empty Outbox, with a full bucket.
 * @param options - The pacing, by default {@link defaultPacing}, how many ordinary Lines
 * may wait, by default {@link defaultCapacity}, and how many `PING` and `PONG`, by default
 * {@link defaultFirstCapacity}.
 * @returns The Outbox.
 */
export const makeOutbox = <A>(
  options: {
    readonly pacing?: Pacing | undefined;
    readonly capacity?: number | undefined;
    readonly firstCapacity?: number | undefined;
  } = {}
): Outbox<A> => ({
  ahead: [],
  behind: [],
  capacity: Math.max(0, Math.floor(options.capacity ?? defaultCapacity)),
  firstCapacity: Math.max(0, Math.floor(options.firstCapacity ?? defaultFirstCapacity)),
  fullAt: Number.NEGATIVE_INFINITY,
  pacing: options.pacing ?? defaultPacing,
});

/**
 * Whether a Line with this command goes ahead of the Lines waiting. Only `PING` and
 * `PONG` do: the keepalive must not wait behind a burst.
 * @param command - The Line's command.
 * @returns Whether it goes first.
 */
export const goesFirst = (command: string): boolean => {
  const upper = command.toUpperCase();

  return upper === "PING" || upper === "PONG";
};

/**
 * Whether a Line with this command is admitted past a full queue. Only `QUIT` is: it is
 * the last Line, and leaving is what was asked.
 * @param command - The Line's command.
 * @returns Whether it is always admitted.
 */
export const alwaysAdmitted = (command: string): boolean => command.toUpperCase() === "QUIT";

/**
 * How many Lines are waiting.
 * @param outbox - The Outbox.
 * @returns Their count.
 */
export const depth = <A>(outbox: Outbox<A>): number => outbox.ahead.length + outbox.behind.length;

/**
 * Queues a Line behind every other Line, or, for `PING` and `PONG`, behind only each
 * other. `PING` and `PONG` have their own bound, so a full queue of ordinary Lines never
 * refuses a keepalive, and a flood of them never grows the queue past it. A `QUIT` is
 * always admitted. Any other Line is refused once `capacity` ordinary Lines wait. A
 * refused Line is not queued, and nothing waits for room.
 * @param outbox - The Outbox.
 * @param item - What to queue.
 * @param command - The Line's command, which decides where it waits.
 * @returns The Outbox with it queued, or `Full`.
 */
export const offer = <A>(outbox: Outbox<A>, item: A, command: string): Offered<A> => {
  if (goesFirst(command)) {
    return outbox.ahead.length >= outbox.firstCapacity
      ? { _tag: "Full" }
      : { _tag: "Queued", outbox: { ...outbox, ahead: [...outbox.ahead, { item }] } };
  }

  return outbox.behind.length >= outbox.capacity && !alwaysAdmitted(command)
    ? { _tag: "Full" }
    : { _tag: "Queued", outbox: { ...outbox, behind: [...outbox.behind, { item }] } };
};

// With a clock that only moves forward, `fullAt` is never more than a whole bucket ahead
// of `now`, since a Line leaves only when a token is free. When it is, the clock was set
// back, and the bucket is taken as empty as of `now`. A clock set back stalls the next
// Line for at most one interval, however far it moved.
const seen = <A>(outbox: Outbox<A>, now: number): Outbox<A> => {
  const most = now + outbox.pacing.burst * outbox.pacing.interval;

  return outbox.fullAt > most ? { ...outbox, fullAt: most } : outbox;
};

// When a token is next free, whether or not a Line waits for it.
const tokenAt = <A>(outbox: Outbox<A>, now: number): number =>
  Math.max(now, outbox.fullAt - (outbox.pacing.burst - 1) * outbox.pacing.interval);

/**
 * When the next Line may leave, for inspection: the time a {@link take} at `now` would
 * say to wait until.
 * @param outbox - The Outbox.
 * @param now - The time, in milliseconds.
 * @returns `now` if a Line may leave now, the later time when one may, or `undefined` if
 * nothing is waiting.
 */
export const nextAt = <A>(outbox: Outbox<A>, now: number): number | undefined =>
  depth(outbox) === 0 ? undefined : tokenAt(seen(outbox, now), now);

/**
 * Takes the next Line if one may leave now, and spends a token for it. Otherwise it says
 * how long to wait. A `take` at the time it says to wait until, with the Outbox it gives,
 * takes a Line, unless the clock was set back in between.
 * @param outbox - The Outbox.
 * @param now - The time, in milliseconds.
 * @returns The Line taken, the time to wait until, or `Empty`, each with the Outbox after.
 */
export const take = <A>(outbox: Outbox<A>, now: number): Take<A> => {
  const current = seen(outbox, now);
  const until = tokenAt(current, now);
  const fullAt = Math.max(current.fullAt, now) + current.pacing.interval;
  const [first, ...ahead] = current.ahead;
  const [next, ...behind] = current.behind;

  // `PING` and `PONG` first, then the rest.
  const head =
    first === undefined
      ? next && { item: next.item, rest: { behind } }
      : { item: first.item, rest: { ahead } };

  if (head === undefined) {
    return { _tag: "Empty", outbox: current };
  }

  if (until > now) {
    return { _tag: "Wait", outbox: current, until };
  }

  return { _tag: "Taken", item: head.item, outbox: { ...current, ...head.rest, fullAt } };
};

/** Every Line that was waiting, and the Outbox emptied. */
export interface Emptied<A> {
  readonly items: readonly A[];
  readonly outbox: Outbox<A>;
}

/** What came of spending a token: it was `Spent`, or it must `Wait` until a later time. */
export type Spend<A> =
  | { readonly _tag: "Spent"; readonly outbox: Outbox<A> }
  | { readonly _tag: "Wait"; readonly until: number; readonly outbox: Outbox<A> };

/**
 * Spends a token for a Line that is not in the queue, if one is free now: the second and
 * later wire Lines of one item taken, such as a SASL response filled to several
 * `AUTHENTICATE` Lines. Otherwise it says how long to wait, as {@link take} does.
 * @param outbox - The Outbox.
 * @param now - The time, in milliseconds.
 * @returns The Outbox after the token, or the time to wait until.
 */
export const spend = <A>(outbox: Outbox<A>, now: number): Spend<A> => {
  const current = seen(outbox, now);
  const until = tokenAt(current, now);

  return until > now
    ? { _tag: "Wait", outbox: current, until }
    : {
        _tag: "Spent",
        outbox: { ...current, fullAt: Math.max(current.fullAt, now) + current.pacing.interval },
      };
};

/**
 * Takes every Line waiting, in the order they would have left, and spends no token.
 * @param outbox - The Outbox.
 * @returns The Lines, and the Outbox emptied.
 */
export const takeAll = <A>(outbox: Outbox<A>): Emptied<A> => ({
  items: [...outbox.ahead, ...outbox.behind].map(({ item }) => item),
  outbox: { ...outbox, ahead: [], behind: [] },
});
