import { defaultAwayMessage } from "@iirc/api";
import type { OwnerInForce } from "@iirc/api";
/**
 * Self is marked away on every Network once no Frontend has been open for `away.after`
 * minutes, and is back once one has been open for {@link comingBack}. A Frontend is open
 * while it follows News, as the News stream or the Timelines' changes, which are News
 * folded. Going away and coming back are the Owner's own `Away` acts, journaled and stepped
 * as `/away` and `/back` are, so they last across Sessions and restarts as those do.
 *
 * It never fights the Owner: a Network the Owner already marked away is left as it is, and
 * only an away this marked is ever taken back. Which acts were this one's is told by their
 * intent, so what it did is read back from the Journal, and holds across a restart.
 *
 * @packageDocumentation
 */
import { IntentId } from "@iirc/client";
import { Runtime } from "@iirc/runtime";
import { Journal } from "@iirc/runtime/journal";
import type { JournalRecord, NetworkId, Sequence } from "@iirc/runtime/journal";
import { Context, Duration, Effect, Layer, Option, Random, Stream, SubscriptionRef } from "effect";

import { OwnerConfiguration } from "./options.ts";

/**
 * How long a Frontend must have been open before Self is back, so one that follows News
 * for a moment, such as a script, does not mark Self back and away again.
 */
export const comingBack = Duration.seconds(30);

/** What every intent this marks away or back under starts with. */
const intentPrefix = "away-when-closed-";

/** The Owner's away on one Network, as the last `Away` act left it, and whether it was ours. */
interface AwayHeld {
  /** The away message, or `undefined` while back. */
  readonly message: string | undefined;
  /** Whether this marked it, rather than the Owner by hand. */
  readonly ours: boolean;
}

/** Each Network's away, as its `Away` acts left it. One never marked away is absent. */
export type AwaysHeld = ReadonlyMap<NetworkId, AwayHeld>;

/**
 * Folds one Journal record: an `Away` act sets its Network's away, as the Client keeps it,
 * where an empty message is back, and anything else passes.
 * @param held - What was held.
 * @param record - The record.
 * @returns What is held after it.
 */
export const foldAway = (held: AwaysHeld, record: JournalRecord): AwaysHeld => {
  if (
    record._tag !== "Input" ||
    record.input._tag !== "Act" ||
    record.input.action._tag !== "Away"
  ) {
    return held;
  }

  const { message } = record.input.action;
  const next = new Map(held);

  next.set(record.network, {
    message: message === null || message === "" ? undefined : message,
    ours: record.input.intent.startsWith(intentPrefix),
  });

  return next;
};

/** What to do next: mark Self away, with a message, or back. */
export type Move = { readonly _tag: "Away"; readonly message: string } | { readonly _tag: "Back" };

/** What the move depends on: whether a Frontend is open, the options, and the aways held. */
export interface Situation {
  readonly open: boolean;
  /** How long no Frontend may be open before Self is away, or `undefined` while that is off. */
  readonly after: Duration.Duration | undefined;
  readonly message: string;
  /** Whether any Network is away because this marked it. */
  readonly away: boolean;
}

/**
 * The move a situation calls for, and how long it must last first, or none.
 * @param situation - The situation.
 * @returns The move and its wait, or none.
 */
export const moveOf = (
  situation: Situation
): { readonly move: Move; readonly wait: Duration.Duration } | undefined => {
  const { after, away, message, open } = situation;

  if (away) {
    if (after === undefined) {
      return { move: { _tag: "Back" }, wait: Duration.zero };
    }

    return open ? { move: { _tag: "Back" }, wait: comingBack } : undefined;
  }

  return !open && after !== undefined
    ? { move: { _tag: "Away", message }, wait: after }
    : undefined;
};

/**
 * The Networks a move acts on: going away, each one not away, and coming back, each one
 * away because this marked it.
 * @param move - The move.
 * @param networks - The Networks.
 * @param held - The aways held.
 * @returns The Networks to act on.
 */
export const movedOn = (
  move: Move,
  networks: Iterable<NetworkId>,
  held: AwaysHeld
): readonly NetworkId[] =>
  [...networks].filter((network) => {
    const away = held.get(network);

    return move._tag === "Away"
      ? away?.message === undefined
      : away?.ours === true && away.message !== undefined;
  });

const situationOf = (open: number, inForce: OwnerInForce, held: AwaysHeld): Situation => {
  const minutes = inForce.options["away.after"];

  return {
    after: minutes === undefined ? undefined : Duration.minutes(minutes),
    away: [...held.values()].some((one) => one.ours && one.message !== undefined),
    message: inForce.options["away.message"] ?? defaultAwayMessage,
    open: open > 0,
  };
};

const sameSituation = (one: Situation, other: Situation): boolean =>
  one.open === other.open &&
  one.away === other.away &&
  one.message === other.message &&
  (one.after === undefined || other.after === undefined
    ? one.after === other.after
    : Duration.equals(one.after, other.after));

// 128 bits from Effect's Random, as hex, after the prefix that marks it as ours.
const intentId = Effect.map(
  Effect.all(Array.from({ length: 8 }, () => Random.nextIntBetween(0, 0xff_ff))),
  (parts) =>
    IntentId.make(
      `${intentPrefix}${parts.map((part) => part.toString(16).padStart(4, "0")).join("")}`
    )
);

/** The aways the Journal held as it was read whole, and the sequence of its last Entry. */
interface Folded {
  readonly held: AwaysHeld;
  readonly last: Sequence | undefined;
}

/** How many Frontends are open, as each follows News. */
export class Following extends Context.Service<
  Following,
  {
    /** The stream, counted as a Frontend open for as long as it is read. */
    readonly follow: <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>;
  }
>()("@iirc/daemon/Following") {}

/**
 * {@link Following}, and Self marked away and back by it on every Network, from the
 * options and the Owner's `Away` acts the Journal holds, which are read whole first.
 */
export const layerAwayWhenClosed = Layer.effect(Following)(
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const journal = yield* Journal;
    const owner = yield* OwnerConfiguration;
    const open = yield* SubscriptionRef.make(0);
    const held = yield* SubscriptionRef.make<AwaysHeld>(new Map());

    const follow = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
      Stream.unwrap(
        Effect.acquireRelease(
          SubscriptionRef.update(open, (count) => count + 1),
          () => SubscriptionRef.update(open, (count) => count - 1)
        ).pipe(Effect.as(stream))
      );

    const act = (move: Move) =>
      Effect.gen(function* () {
        const networks = yield* runtime.networks;
        const now = yield* SubscriptionRef.get(held);
        const message = move._tag === "Away" ? move.message : null;

        const acts = movedOn(move, networks.keys(), now).map((network) =>
          intentId.pipe(
            Effect.flatMap((intent) =>
              runtime.act(network, { action: { _tag: "Away", message }, intent })
            ),
            Effect.catchTags({
              NetworkStopped: () => Effect.void,
              UnknownNetwork: () => Effect.void,
            })
          )
        );

        yield* Effect.all(acts, { discard: true });

        yield* Effect.logInfo(
          move._tag === "Away" ? "Away, as no Frontend is open" : "Back, as a Frontend is open"
        );
      });

    // Each `Away` act already journaled, read whole before anything is decided, so what
    // this marked before a restart is known as its own.
    const readWhole = journal.read({}).pipe(
      Stream.runFold(
        (): Folded => ({ held: new Map(), last: undefined }),
        (folded, { record, sequence }) => ({ held: foldAway(folded.held, record), last: sequence })
      ),
      Effect.tap((folded) => SubscriptionRef.set(held, folded.held))
    );

    // Then each one journaled after it. Only an `Away` act changes what is held, and only a
    // change is told.
    const followFrom = (last: Sequence | undefined) =>
      journal.follow(last === undefined ? {} : { after: last }).pipe(
        Stream.runForEach(({ record }) =>
          SubscriptionRef.updateSome(held, (before) => {
            const after = foldAway(before, record);

            return after === before ? Option.none() : Option.some(after);
          })
        )
      );

    const decide = Stream.zipLatestAll(
      SubscriptionRef.changes(open),
      owner.changes,
      SubscriptionRef.changes(held)
    ).pipe(
      Stream.map(([count, inForce, aways]) => situationOf(count, inForce, aways)),
      Stream.changesWith(sameSituation),
      Stream.switchMap((situation) => {
        const next = moveOf(situation);

        return next === undefined
          ? Stream.empty
          : Stream.fromEffect(Effect.as(Effect.sleep(next.wait), next.move));
      }),
      Stream.runForEach((move) => act(move))
    );

    yield* Effect.forkScoped(
      readWhole.pipe(
        Effect.flatMap(({ last }) =>
          Effect.all([followFrom(last), decide], { concurrency: 2, discard: true })
        ),
        Effect.catchCause((cause) => Effect.logError("Away when closed stopped", cause))
      )
    );

    return { follow };
  })
);
