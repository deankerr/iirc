/**
 * Lookups, as atoms: each Pane's card, as the core folds it, and what carries out a `Look`.
 * A Lookup is asked once, under an intent the runtime names, and never sent again: when
 * the Daemon answers `Pending`, the Network stops, or no answer comes, the runtime asks
 * `GET …/lookups/{intent}`, soon and then less often, until its result comes or `lookup`,
 * two minutes, has passed. It runs beside the composer's turn, so a Say never waits behind
 * a Lookup, and it is let go of once its card is replaced or dismissed, or the page signs
 * out.
 *
 * @packageDocumentation
 */
import type { LookedAnswer, NetworkId, TimeShown } from "@iirc/api";
import { panesOf } from "@iirc/frontend/layout";
import {
  cardShown,
  cardWithId,
  initialLookups,
  reduceLookups,
  shownCard,
} from "@iirc/frontend/lookup";
import type { Look, LookFailure, Lookups, LookupsEvent } from "@iirc/frontend/lookup";
import { paneOf } from "@iirc/frontend/timelines";
import { Duration, Effect, Option, Stream } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { decodeIntent, IntentNames } from "../app/intent-names.ts";
import { runtime } from "../app/runtime.ts";
import { signedOut } from "../options/atoms.ts";
import { timeShown } from "../options/ui.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { timelinesState, Waits } from "../timelines/atoms.ts";
import { formattedAt } from "../ui/dates.ts";

/** Each Pane's card, as the core folds it. */
export const lookupsState = Atom.make<Lookups>(initialLookups).pipe(Atom.keepAlive);

/**
 * Folds one event into the Lookups.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: LookupsEvent) => {
  registry.set(lookupsState, reduceLookups(registry.get(lookupsState), event));
};

// The Owner's own calendar, clock, and time zone, which only the runtime and the view read.
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
});

const clockWithSeconds = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * An instant as the Owner reads a date and a time: the date, and the time with seconds
 * when `ui.time` shows them, or none when a `Date` cannot hold the instant. A signon is no
 * line's time, so it shows even under `none`.
 * @param shown - How a line's time shows.
 * @returns The format.
 */
const timeFor =
  (shown: TimeShown) =>
  (at: number): string | undefined => {
    const day = formattedAt(date, at);
    const time = formattedAt(shown === "HH:mm:ss" ? clockWithSeconds : clock, at);

    return day === undefined || time === undefined ? undefined : `${day}, ${time}`;
  };

/**
 * What a Pane's card shows, by the Pane's id, while the Pane has open the Timeline it was
 * asked from, with a signon in the Owner's time zone, as `ui.time` says.
 */
export const paneCard = Atom.family((pane: string) =>
  Atom.make((get) => {
    const timelines = get(timelinesState);
    const card = shownCard(get(lookupsState), timelines, pane);

    return card === undefined ? undefined : cardShown(timelines, card, timeFor(get(timeShown)));
  })
);

/** Puts a Pane's card away, letting go of its Lookup if it is still asked. */
export const dismissCard = Atom.fnSync((pane: string, get) => {
  happened(get.registry, { _tag: "Dismissed", pane });
}).pipe(Atom.keepAlive);

// A gateway in front of the Daemon answers these when it could not reach it.
const gatewayStatuses: ReadonlySet<number> = new Set([502, 504]);

/**
 * What asking came to.
 *
 * - `Settled`: nothing more to ask.
 * - `Ask`: ask by intent, where `NotJournaled` is final only once the append `settled`, as
 *   after `NetworkStopped`, and otherwise may be a request still appending.
 */
type Asked = { readonly _tag: "Settled" } | { readonly _tag: "Ask"; readonly settled: boolean };

const settledNow: Asked = { _tag: "Settled" };

/**
 * Whether the card is gone, or the page signed out: its Lookup is let go of then.
 * @param registry - The registry.
 * @param id - The card's id.
 * @returns Whether it is let go.
 */
const letGo = (registry: AtomRegistry.AtomRegistry, id: number) =>
  cardWithId(registry.get(lookupsState), id) === undefined || !registry.get(signedIn);

/**
 * Waits until a card's Lookup is let go.
 * @param registry - The registry.
 * @param id - The card's id.
 * @returns Once it is.
 */
const lettingGo = (registry: AtomRegistry.AtomRegistry, id: number) =>
  Stream.merge(
    AtomRegistry.toStream(registry, lookupsState),
    AtomRegistry.toStream(registry, signedIn)
  ).pipe(
    Stream.filter(() => letGo(registry, id)),
    Stream.take(1),
    Stream.runDrain
  );

/**
 * Folds what asking by intent answered: its result, still pending, or, once the append
 * settled, journaled under no Lookup.
 * @param registry - The registry.
 * @param id - The card's id.
 * @param answer - The answer.
 * @param settled - Whether `NotJournaled` is final.
 * @returns Whether it is settled.
 */
const foldAnswer = (
  registry: AtomRegistry.AtomRegistry,
  id: number,
  answer: LookedAnswer,
  settled: boolean
): boolean => {
  switch (answer._tag) {
    case "LookedUp": {
      happened(registry, { _tag: "Answered", id, result: answer.result });

      return true;
    }

    case "Pending": {
      happened(registry, { _tag: "Waited", id });

      return false;
    }

    case "NotJournaled": {
      if (settled) {
        happened(registry, { _tag: "Failed", failure: "Stopped", id });
      }

      return settled;
    }

    default: {
      return answer satisfies never;
    }
  }
};

/**
 * Asks after a Lookup by its intent, soon and then less often, until it settles. A failure,
 * or an ask with no answer within `lookRequest`, is asked again, but `Unauthorized`, which
 * signs the page out. The Lookup's own deadline ends it, wherever it is.
 * @param registry - The registry.
 * @param id - The card's id.
 * @param network - The Network.
 * @param intent - Its intent.
 * @param settled - Whether `NotJournaled` is final.
 * @returns Once it settles.
 */
const askAfter = (
  registry: AtomRegistry.AtomRegistry,
  id: number,
  network: NetworkId,
  intent: ReturnType<typeof decodeIntent>,
  settled: boolean
) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { longest, lookRequest, retry } = yield* Waits;

    const once = client.networks.looked({ params: { intent, network } }).pipe(
      Effect.timeoutOption(lookRequest),
      Effect.map((answer) =>
        Option.isSome(answer) ? foldAnswer(registry, id, answer.value, settled) : false
      ),
      Effect.catch((error) => {
        if (error._tag === "Unauthorized") {
          signedOut(registry);

          return Effect.succeed(true);
        }

        return Effect.succeed(false);
      })
    );

    let done = yield* once;

    for (let attempt = 0; !done; attempt += 1) {
      yield* Effect.sleep(
        Duration.min(
          Duration.times(Duration.fromInputUnsafe(retry), 2 ** attempt),
          Duration.fromInputUnsafe(longest)
        )
      );
      done = yield* once;
    }
  });

/**
 * Says a Lookup came to nothing, and that nothing more is asked.
 * @param registry - The registry.
 * @param id - The card's id.
 * @param failure - Why.
 * @returns Nothing more to ask.
 */
const failing = (registry: AtomRegistry.AtomRegistry, id: number, failure: LookFailure) => {
  happened(registry, { _tag: "Failed", failure, id });

  return Effect.succeed(settledNow);
};

/**
 * Asks the Daemon to look a nick up, once, under its intent, and folds what it answered.
 * With no answer within `lookRequest`, it may still be appending, so it is asked after by
 * its intent, never sent again.
 * @param registry - The registry.
 * @param id - The card's id.
 * @param look - The Lookup.
 * @param intent - Its intent.
 * @returns What is left to ask.
 */
const ask = (
  registry: AtomRegistry.AtomRegistry,
  id: number,
  look: Look,
  intent: ReturnType<typeof decodeIntent>
) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { lookRequest } = yield* Waits;

    return yield* client.networks
      .look({ params: { network: look.network }, payload: { intent, lookup: look.lookup } })
      .pipe(
        Effect.timeoutOption(lookRequest),
        Effect.map((answered): Asked => {
          if (Option.isNone(answered)) {
            return { _tag: "Ask", settled: false };
          }

          const answer = answered.value;

          if (answer._tag === "LookedUp") {
            happened(registry, { _tag: "Answered", id, result: answer.result });

            return settledNow;
          }

          happened(registry, { _tag: "Waited", id });

          return { _tag: "Ask", settled: false };
        }),
        Effect.catch((error): Effect.Effect<Asked> => {
          switch (error._tag) {
            case "Unauthorized": {
              signedOut(registry);

              return Effect.succeed(settledNow);
            }

            case "UnknownNetwork": {
              return failing(registry, id, "UnknownNetwork");
            }

            // The Network stopped, so its append has settled: asking by intent answers
            // for good.
            case "NetworkStopped": {
              return Effect.succeed({ _tag: "Ask", settled: true });
            }

            case "HttpClientError": {
              // No answer came, so the request may still be appending: it is never sent
              // again, only asked after.
              const lost =
                error.reason._tag === "TransportError" ||
                (error.response !== undefined && gatewayStatuses.has(error.response.status));

              return lost
                ? Effect.succeed({ _tag: "Ask", settled: false })
                : failing(registry, id, "Unexpected");
            }

            case "CrossOrigin":
            case "InvalidRequest":
            case "SchemaError": {
              return failing(registry, id, "Unexpected");
            }

            default: {
              return error satisfies never;
            }
          }
        })
      );
  });

/**
 * Reads how the card's Network names Channels, so a Channel it lists can open or join. A
 * read that fails leaves its Channels as text.
 * @param registry - The registry.
 * @param id - The card's id.
 * @param network - The Network.
 * @returns Once read.
 */
const name = (registry: AtomRegistry.AtomRegistry, id: number, network: NetworkId) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { lookRequest } = yield* Waits;

    const known = yield* client.networks
      .known({ params: { network } })
      .pipe(Effect.timeout(lookRequest));

    happened(registry, {
      _tag: "Named",
      chantypes: known.chantypes,
      declared: known.declared,
      id,
    });
  }).pipe(Effect.ignore);

/**
 * Carries out one card's Lookup, by the card's id, until it settles or is let go. One
 * deadline, `lookup` from when the Owner asked, covers the whole of it, the `look`, each
 * ask after it, and the waits between: whatever is outstanding then is interrupted, and
 * the card says no result came in time.
 */
const looking = runtime
  .fn(
    (id: number, get) =>
      Effect.gen(function* () {
        const { registry } = get;
        const found = cardWithId(registry.get(lookupsState), id);

        if (found === undefined) {
          return;
        }

        const { look } = found.card;
        const names = yield* IntentNames;
        const intent = decodeIntent(names());

        const { lookup: deadline } = yield* Waits;

        const lookup = Effect.gen(function* () {
          const asked = yield* ask(registry, id, look, intent);

          if (asked._tag === "Ask") {
            yield* askAfter(registry, id, look.network, intent, asked.settled);
          }
        }).pipe(
          Effect.timeoutOption(deadline),
          Effect.tap((done) =>
            Effect.sync(() => {
              if (Option.isNone(done)) {
                happened(registry, { _tag: "Failed", failure: "NoAnswer", id });
              }
            })
          )
        );

        yield* Effect.raceFirst(
          Effect.all([lookup, name(registry, id, look.network)], {
            concurrency: "unbounded",
            discard: true,
          }),
          lettingGo(registry, id)
        );
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/** Every Pane there is, shown or not, by id, in the layout's order, as text that changes only with them. */
const paneIds = Atom.make((get) =>
  panesOf(get(timelinesState).layout.root)
    .map((pane) => pane.id)
    .join(" ")
);

/**
 * Keeps the cards to the Panes there are: a card whose Pane was closed is let go of, which
 * interrupts its Lookup, and a Pane hidden by a zoom, a phone's width, or another Timeline
 * keeps its card. Signing out lets go of every card, so none comes back on signing in
 * again. Mounted once for the page.
 */
export const lookupSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      happened(registry, { _tag: "Cleared" });

      if (!get(signedIn)) {
        return;
      }

      yield* get.stream(paneIds).pipe(
        Stream.runForEach((panes) =>
          Effect.sync(() => {
            happened(registry, { _tag: "Kept", panes: panes.split(" ") });
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Carries out a `Look`: a card in the Pane that has its Timeline open, or the focused one,
 * replacing the card there, and its Lookup asked beside the composer's turn.
 * @param registry - The registry.
 * @param look - The Lookup.
 */
export const look = (registry: AtomRegistry.AtomRegistry, look: Look) => {
  const timelines = registry.get(timelinesState);
  const pane = paneOf(timelines, look.timeline) ?? timelines.layout.focused;

  happened(registry, { _tag: "Asked", look, pane });

  const card = registry.get(lookupsState).cards.get(pane);

  if (card !== undefined) {
    registry.set(looking, card.id);
  }
};
