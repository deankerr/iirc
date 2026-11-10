/**
 * The composer, as atoms: the state the pure core folds, and the commands that carry out
 * the intents it gives. A Say is made under an intent the runtime names, so that when the
 * Network stops, or the Daemon does not answer, `said` can say whether it was journaled,
 * and it is sent again only when the Network stopped and it was not: after a request that
 * got no answer, it may still be appended, so the Owner can only check again. A Say the
 * Client refused as it took it is said so by `say`'s answer, and how a Message fares after
 * that is its Timeline item's delivery, so the Frontend never reads News. `/msg` opens the
 * Direct Message the Daemon placed its Message in, read from the step that said it.
 *
 * @packageDocumentation
 */
import { CallerIntent } from "@iirc/api";
import type { Sequence } from "@iirc/api";
import type { Intent, Say } from "@iirc/frontend/commands";
import {
  confirm,
  contextOf,
  draftOf,
  initialComposers,
  reduceComposers,
  started,
  submit,
  takeOffer,
} from "@iirc/frontend/composer";
import type {
  ComposerEvent,
  Composers,
  IntentId,
  Place,
  SayFailure,
} from "@iirc/frontend/composer";
import { followFrom, opened, reduceTimelines } from "@iirc/frontend/timelines";
import type { Timelines } from "@iirc/frontend/timelines";
import { Context, Effect, Option, Schedule, Schema, Semaphore, Stream } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { notifying } from "../notifications/notifier.ts";
import {
  addNetwork,
  configure,
  openOptions,
  promptCredential,
  signedOut,
} from "../options/atoms.ts";
import type { Outcome as Changed } from "../options/atoms.ts";
import { openPalette } from "../palette/state.ts";
import { markRead } from "../reading/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { open, timelinesState, Waits } from "../timelines/atoms.ts";

/** Every Timeline's composer, as the core folds it. */
export const composerState = Atom.make<Composers>(initialComposers).pipe(Atom.keepAlive);

/** The context commands are judged in, derived from the Timelines. */
export const commandContext = Atom.make((get) => contextOf(get(timelinesState)));

/** One Timeline's composer, or the one under no Timeline. */
export const draft = Atom.family((timeline: Place) =>
  Atom.make((get) => draftOf(get(composerState), timeline))
);

/**
 * How many times the composer was asked to take focus. The composer focuses its textarea
 * each time this changes, never as it mounts.
 */
export const composerFocus = Atom.make(0).pipe(Atom.keepAlive);

/**
 * Where the composer under the main view is: the open Timeline's, or the one under none.
 * @param registry - The registry.
 * @returns Its place.
 */
const placeOf = (registry: AtomRegistry.AtomRegistry): Place => {
  const shown = opened(registry.get(timelinesState));

  return shown._tag === "Shown" ? shown.timeline : "Nowhere";
};

/** Names each Say's intent, unique across the whole Journal: a test makes them predictable. */
export class IntentNames extends Context.Reference<() => string>("@iirc/web/IntentNames", {
  defaultValue: () => () => `web-${crypto.randomUUID()}`,
}) {}

const decodeIntent = Schema.decodeSync(CallerIntent);

/**
 * Folds one event into the composers.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: ComposerEvent) => {
  registry.set(composerState, reduceComposers(registry.get(composerState), event));
};

// A gateway in front of the Daemon answers these when it could not reach it.
const gatewayStatuses: ReadonlySet<number> = new Set([502, 504]);

/** What became of one Say, as the runtime found out. */
type Outcome =
  | { readonly _tag: "Said"; readonly sequence: Sequence }
  | { readonly _tag: "SignedOut" }
  | { readonly _tag: "Failed"; readonly failure: SayFailure };

/**
 * Why the Daemon refused a Say, from its error's tag.
 * @param tag - The error's tag.
 * @param network - The Say's Network.
 * @returns The failure.
 */
const failureOf = (tag: string, network: Say["network"]): SayFailure => {
  if (tag === "UnknownNetwork") {
    return { _tag: "UnknownNetwork", network };
  }

  return tag === "InvalidRequest" ? { _tag: "Malformed" } : { _tag: "Unexpected" };
};

// Says go one at a time, in the order the Owner sent them, across every Timeline.
const oneAtATime = Semaphore.makeUnsafe(1);

/**
 * Asks whether a Say under an intent was journaled.
 * @param network - Its Network.
 * @param intent - Its intent.
 * @returns What became of it.
 */
const askSaid = (network: Say["network"], intent: IntentId) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const answer = yield* client.networks.said({ params: { intent, network } });

    return answer;
  });

/**
 * Asks `said` about a Say whose request got no answer: `Journaled` settles it, and anything
 * else leaves it unknown.
 * @param network - Its Network.
 * @param intent - Its intent.
 * @returns What became of it.
 */
const checked = (network: Say["network"], intent: IntentId) =>
  askSaid(network, intent).pipe(
    Effect.map((answer): Outcome =>
      answer._tag === "Journaled"
        ? { _tag: "Failed", failure: { _tag: "Journaled" } }
        : { _tag: "Failed", failure: { _tag: "Unknown", network } }
    ),
    Effect.orElseSucceed((): Outcome => ({ _tag: "Failed", failure: { _tag: "Unknown", network } }))
  );

/** A Say said with `opens`, whose Direct Message is to be opened once it is placed. */
interface Placed {
  readonly network: Say["network"];
  readonly sequence: Sequence;
  readonly intent: IntentId;
  /** The core's navigation when its Say was submitted: opening another lets it go. */
  readonly navigation: number;
}

/**
 * Says one Message under an intent id, and finds out what became of it.
 * @param intent - The Say.
 * @param id - Its intent id.
 * @returns What became of it.
 */
const sayOne = (intent: Say, id: IntentId) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    return yield* client.networks
      .say({
        params: { network: intent.network },
        payload: { intent: id, kind: intent.kind, target: intent.target, text: intent.text },
      })
      .pipe(
        Effect.map((answer): Outcome =>
          answer._tag === "Said"
            ? { _tag: "Said", sequence: answer.sequence }
            : {
                _tag: "Failed",
                failure: { _tag: "Refused", reason: answer.reason, target: intent.target },
              }
        ),
        Effect.catch((error): Effect.Effect<Outcome, never, DaemonClient> => {
          if (error._tag === "Unauthorized") {
            return Effect.succeed<Outcome>({ _tag: "SignedOut" });
          }

          // The Network stopped, so its append has settled: `said` answers for good.
          if (error._tag === "NetworkStopped") {
            return askSaid(intent.network, id).pipe(
              Effect.map((answer): Outcome => ({
                _tag: "Failed",
                failure: { _tag: answer._tag === "Journaled" ? "Journaled" : "NotJournaled" },
              })),
              Effect.orElseSucceed((): Outcome => ({
                _tag: "Failed",
                failure: { _tag: "Unknown", network: intent.network },
              }))
            );
          }

          // No answer came, so the request may still be queued or appending: `said` can
          // settle it only by answering `Journaled`, and it is never sent again from here.
          const lost =
            error._tag === "HttpClientError" &&
            (error.reason._tag === "TransportError" ||
              (error.response !== undefined && gatewayStatuses.has(error.response.status)));

          if (lost) {
            return checked(intent.network, id);
          }

          return Effect.succeed<Outcome>({
            _tag: "Failed",
            failure: failureOf(error._tag, intent.network),
          });
        })
      );
  });

/** An intent carried out in the page at once, which waits on nothing the Daemon says. */
type Local = Extract<
  Intent,
  { readonly _tag: "OpenOptions" | "PromptCredential" | "Open" | "OpenPalette" | "FocusComposer" }
>;

const localTags: ReadonlySet<string> = new Set<Local["_tag"]>([
  "FocusComposer",
  "Open",
  "OpenOptions",
  "OpenPalette",
  "PromptCredential",
]);

/**
 * Whether an intent is carried out in the page.
 * @param intent - The intent.
 * @returns Whether it is.
 */
const isLocal = (intent: Intent): intent is Local => localTags.has(intent._tag);

/**
 * Carries out an intent in the page: shows the options or a Timeline, opens the password
 * prompt or the palette, or focuses the composer, starting an empty draft with text.
 * @param registry - The registry.
 * @param place - Where the composer under the main view is.
 * @param intent - The intent.
 */
const carryOutHere = (registry: AtomRegistry.AtomRegistry, place: Place, intent: Local): void => {
  switch (intent._tag) {
    case "OpenOptions": {
      registry.set(openOptions, intent.filter);
      break;
    }

    case "PromptCredential": {
      registry.set(promptCredential, { network: intent.network, path: intent.path });
      break;
    }

    case "Open": {
      registry.set(open, intent.timeline);
      break;
    }

    case "OpenPalette": {
      registry.set(openPalette, undefined);
      break;
    }

    case "FocusComposer": {
      registry.set(composerState, started(registry.get(composerState), place, intent.text));

      registry.set(composerFocus, registry.get(composerFocus) + 1);
      break;
    }

    default: {
      intent satisfies never;
    }
  }
};

/**
 * Carries out an intent other than a Say: in the page, by changing Configuration, by
 * marking a Timeline read, or by turning notifications on or off.
 * @param registry - The registry.
 * @param place - Where the intents came from.
 * @param intent - The intent.
 * @returns What it came to.
 */
const changeOne = (
  registry: AtomRegistry.AtomRegistry,
  place: Place,
  intent: Exclude<Intent, Say>
): Effect.Effect<Changed, never, DaemonClient> => {
  if (isLocal(intent)) {
    carryOutHere(registry, place, intent);

    return Effect.succeed({ _tag: "Done" });
  }

  switch (intent._tag) {
    case "Configure": {
      return configure(registry, intent.network, intent.edit);
    }

    case "AddNetwork": {
      return addNetwork(registry, intent.network, intent.configuration);
    }

    case "MarkRead": {
      return markRead(intent);
    }

    case "Notify": {
      return notifying(intent.on);
    }

    default: {
      return intent satisfies never;
    }
  }
};

/**
 * Carries out intents in order. One that fails stops those after it, and the composer it
 * came from says why, offering what is safe to do next after a Say.
 * @param registry - The registry.
 * @param timeline - Where they were sent from.
 * @param intents - The intents.
 * @param first - The intent id the first Say keeps, when it is sent again.
 * @param navigation - The core's navigation when they were submitted.
 * @returns The Says said that open their Direct Message once placed.
 */
const carryOut = (
  registry: AtomRegistry.AtomRegistry,
  timeline: Place,
  intents: readonly Intent[],
  first: IntentId | undefined,
  navigation: number
) =>
  Effect.gen(function* () {
    const name = yield* IntentNames;
    const placed: Placed[] = [];

    for (const [index, intent] of intents.entries()) {
      if (intent._tag !== "Say") {
        const changed = yield* changeOne(registry, timeline, intent);

        if (changed._tag === "SignedOut") {
          signedOut(registry);

          return placed;
        }

        if (changed._tag === "NotDone") {
          happened(registry, { _tag: "Noticed", message: changed.message, timeline });

          return placed;
        }

        continue;
      }

      const id = index === 0 && first !== undefined ? first : decodeIntent(name());
      const outcome = yield* sayOne(intent, id);

      if (outcome._tag === "SignedOut") {
        signedOut(registry);

        return placed;
      }

      if (outcome._tag === "Said") {
        if (intent.opens) {
          placed.push({
            intent: id,
            navigation,
            network: intent.network,
            sequence: outcome.sequence,
          });
        }

        continue;
      }

      happened(registry, {
        _tag: "Failed",
        failure: outcome.failure,
        intent: id,
        intents: intents.slice(index),
        timeline,
      });

      return placed;
    }

    return placed;
  }).pipe((effect) => oneAtATime.withPermits(1)(effect));

/**
 * Whether a placement is let go: the Owner opened another Timeline since its Say was
 * submitted, or the browser signed out, which reads the Timelines again from nothing.
 * @param registry - The registry.
 * @param state - The Timelines.
 * @param placed - The placement.
 * @returns Whether it is let go.
 */
const letGo = (registry: AtomRegistry.AtomRegistry, state: Timelines, placed: Placed) =>
  state.navigation !== placed.navigation || !registry.get(signedIn);

/**
 * Waits until the Daemon's projection has folded a Say's step, as the changes stream says,
 * or the placement is let go. After a reset, the place is the new projection's, so it waits
 * for that one to pass the step.
 * @param registry - The registry.
 * @param placed - The placement.
 * @returns Whether the step was folded, rather than the placement let go.
 */
const foldedOrLetGo = (registry: AtomRegistry.AtomRegistry, placed: Placed) =>
  AtomRegistry.toStream(registry, timelinesState).pipe(
    Stream.filter(
      (state) =>
        letGo(registry, state, placed) || (followFrom(state)?.sequence ?? 0) >= placed.sequence
    ),
    Stream.take(1),
    Stream.runHead,
    Effect.map((state) => Option.isSome(state) && !letGo(registry, state.value, placed))
  );

/**
 * Waits until a placement is let go.
 * @param registry - The registry.
 * @param placed - The placement.
 * @returns Once it is.
 */
const lettingGo = (registry: AtomRegistry.AtomRegistry, placed: Placed) =>
  AtomRegistry.toStream(registry, timelinesState).pipe(
    Stream.filter((state) => letGo(registry, state, placed)),
    Stream.take(1),
    Stream.runDrain
  );

/**
 * Opens the Direct Message Timeline a Say was placed in: the item of its intent in the step
 * that said it, which the Daemon routed. It waits until the projection has folded that step,
 * then reads it once, which is then the whole answer: with the item, its Timeline opens,
 * and without it, as for a Channel's or a refused Say, nothing does. A read that fails is
 * asked again, soon and then less often. Opening another Timeline, or signing out, lets it
 * go at any point. It only reads, so it can never say anything.
 * @param registry - The registry.
 * @param placed - The placement.
 * @returns Once it is opened, known never to be, or let go.
 */
const openPlaced = (registry: AtomRegistry.AtomRegistry, placed: Placed) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { longest, retry: soon } = yield* Waits;

    const lookup = Effect.gen(function* () {
      if (!(yield* foldedOrLetGo(registry, placed))) {
        return;
      }

      const page = yield* client.timelines
        .locate({
          params: { network: placed.network, sequence: placed.sequence },
          query: { limit: 500 },
        })
        .pipe(
          Effect.retry({
            schedule: Schedule.min([Schedule.exponential(soon), Schedule.spaced(longest)]),
            while: (error) => error._tag !== "Unauthorized",
          })
        );

      const item = page.items.find(
        (one) => one.content._tag === "Message" && one.content.ours?.intent === placed.intent
      );

      if (item !== undefined) {
        registry.set(
          timelinesState,
          reduceTimelines(registry.get(timelinesState), {
            _tag: "Located",
            navigation: placed.navigation,
            timeline: item.timeline,
          })
        );
      }
    });

    yield* Effect.raceFirst(Effect.ignore(lookup), lettingGo(registry, placed));
  });

/**
 * Carries out intents, then opens the Direct Messages they said to, once placed, outside
 * the turn so later Says need not wait for the projection.
 * @param registry - The registry.
 * @param timeline - The Timeline they were sent from.
 * @param intents - The intents.
 * @param first - The intent id the first Say keeps.
 * @returns Once done.
 */
const sendAll = (
  registry: AtomRegistry.AtomRegistry,
  timeline: Place,
  intents: readonly Intent[],
  first: IntentId | undefined
) =>
  Effect.gen(function* () {
    const { navigation } = registry.get(timelinesState);
    const placed = yield* carryOut(registry, timeline, intents, first, navigation);

    for (const one of placed) {
      yield* openPlaced(registry, one);
    }
  });

/** Edits a Timeline's draft. */
export const edit = Atom.fnSync(
  ({ text, timeline }: { readonly timeline: Place; readonly text: string }, get) => {
    happened(get.registry, { _tag: "Edited", text, timeline });
  }
).pipe(Atom.keepAlive);

/** Recalls what was sent from a Timeline, older or newer. */
export const recall = Atom.fnSync(
  (
    { direction, timeline }: { readonly timeline: Place; readonly direction: "Older" | "Newer" },
    get
  ) => {
    happened(get.registry, { _tag: "Recalled", direction, timeline });
  }
).pipe(Atom.keepAlive);

/** Lets go of a Timeline's notice and confirmation. */
export const dismiss = Atom.fnSync((timeline: Place, get) => {
  happened(get.registry, { _tag: "Dismissed", timeline });
}).pipe(Atom.keepAlive);

/**
 * Once a draft was sent and cleared, `edit` lets go of the text it was last given, which
 * it would otherwise keep as its argument, a Credential's value among it.
 * @param registry - The registry.
 * @param timeline - Where the draft was sent from.
 */
const letGoOfTyped = (registry: AtomRegistry.AtomRegistry, timeline: Place) => {
  if (draftOf(registry.get(composerState), timeline).text === "") {
    registry.set(edit, { text: "", timeline });
  }
};

/** Submits a Timeline's draft, and carries out what it asks. */
export const send = runtime
  .fn(
    (timeline: Place, get) =>
      Effect.gen(function* () {
        const { registry } = get;
        const step = submit(registry.get(composerState), timeline, registry.get(commandContext));

        registry.set(composerState, step.state);
        letGoOfTyped(registry, timeline);
        yield* sendAll(registry, timeline, step.intents, undefined);
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/** Sends the lines a Timeline's composer is waiting to have confirmed. */
export const confirmSend = runtime
  .fn(
    (timeline: Place, get) =>
      Effect.gen(function* () {
        const { registry } = get;
        const step = confirm(registry.get(composerState), timeline);

        registry.set(composerState, step.state);
        yield* sendAll(registry, timeline, step.intents, undefined);
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/**
 * Takes what a Timeline's notice offers: sends again under the intent it keeps, or asks
 * `said` again about a Say whose request got no answer, which only `Journaled` settles.
 */
export const takeUp = runtime
  .fn(
    (timeline: Place, get) =>
      Effect.gen(function* () {
        const { registry } = get;
        const taken = takeOffer(registry.get(composerState), timeline);

        registry.set(composerState, taken.state);

        const { offer } = taken;

        if (offer === undefined) {
          return;
        }

        if (offer._tag === "SendAgain") {
          yield* sendAll(registry, timeline, offer.intents, offer.intent);

          return;
        }

        const outcome = yield* checked(offer.network, offer.intent);

        if (outcome._tag === "Failed") {
          happened(registry, {
            _tag: "Failed",
            failure: outcome.failure,
            intent: offer.intent,
            intents: offer.intents,
            timeline,
          });
        }
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/** Carries out intents from the palette or a key, as the composer under the main view's. */
const performQueued = runtime
  .fn(
    (intents: readonly Intent[], get) =>
      Effect.gen(function* () {
        const { registry } = get;

        yield* sendAll(registry, placeOf(registry), intents, undefined);
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/**
 * Carries out intents that came from the palette or a key, not the composer. When every one
 * is carried out in the page, as opening a Timeline is, it is done at once, so a key that
 * moves between Timelines never waits behind a Say in flight. Otherwise they wait their
 * turn with every other submission, and a failure is said under the composer.
 */
export const perform = Atom.fnSync((intents: readonly Intent[], get) => {
  const { registry } = get;

  if (intents.every((intent) => isLocal(intent))) {
    const place = placeOf(registry);

    for (const intent of intents) {
      if (isLocal(intent)) {
        carryOutHere(registry, place, intent);
      }
    }

    return;
  }

  registry.set(performQueued, intents);
}).pipe(Atom.keepAlive);
