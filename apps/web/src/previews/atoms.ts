/**
 * Previews, as atoms: what the core holds of them; what the Owner opened or closed with
 * each link's toggle, which is this view's own; `previewsSync`, which, while the browser is
 * signed in and any Timeline's mode asks, follows their stream and makes each ask and press
 * the core calls for; and a Timeline's own choice over `ui.previews`, made for every
 * device. A Message is shown to the core only by the view, as it scrolls into sight, so
 * nothing is asked for ahead of it, and a closed Preview is asked for not at all. What the
 * Daemon holds of a window's is read with the window, by the Timelines' `sync`.
 *
 * @packageDocumentation
 */
import { PreviewsByTimeline } from "@iirc/api";
import type { TimelineId, TimelineItem } from "@iirc/api";
import type { Intent } from "@iirc/frontend/commands";
import {
  asksAnywhere,
  asksWanted,
  choosing,
  linkKey,
  messageKey,
  pressesWanted,
  pressOf,
  reducePreviews,
} from "@iirc/frontend/previews";
import type {
  Opening,
  PreviewsAsk,
  PreviewsEvent,
  PreviewsPress,
  Toggles,
} from "@iirc/frontend/previews";
import { Effect, FiberSet, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedOut } from "../options/atoms.ts";
import type { Outcome } from "../options/atoms.ts";
import { previewsStartShown, readShared, uiFailed } from "../options/ui.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, timelinesState, Waits } from "../timelines/atoms.ts";
import { previewsModes, previewsState } from "./state.ts";

export { previewsModes, previewsState } from "./state.ts";

/**
 * What the Owner opened or closed with each link's toggle, by its `linkKey`, held here
 * rather than in a row, since a Timeline's rows are drawn again as they scroll back into
 * view, and forgotten when the page is loaded again.
 */
const previewsToggles = Atom.make<Toggles>(new Map<string, boolean>()).pipe(Atom.keepAlive);

/** How this view opens Previews: `ui.previews.start` on this device, and what was toggled. */
export const previewsOpening = Atom.make((get): Opening => ({
  start: get(previewsStartShown),
  toggles: get(previewsToggles),
}));

/** Whether a Timeline is a Direct Message, as its Network lists it, and not while unknown. */
export const directIn = Atom.family((timeline: TimelineId) =>
  Atom.make((get) =>
    [...get(timelinesState).networks.values()].some(
      (network) => network.timelines.get(timeline)?.kind === "Direct"
    )
  )
);

/** Whether Previews are followed now: while any Timeline's mode asks. */
const previewsAsked = Atom.make((get) => asksAnywhere(get(previewsModes)));

/**
 * Folds one event into what the core holds.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: PreviewsEvent) => {
  registry.set(previewsState, reducePreviews(registry.get(previewsState), event));
};

/** The errors that end an ask for good: the Daemon has no such Message, or Previews are off. */
const refusals: ReadonlySet<string> = new Set(["UnknownTimeline", "UnknownMessage", "PreviewsOff"]);

/**
 * Makes one ask and folds in its answer. A failure is asked again until it is answered,
 * except a refusal, which ends it, and `Unauthorized`, which signs the page out.
 * @param registry - The registry.
 * @param ask - The ask.
 * @returns The ask, which never fails.
 */
const perform = (registry: AtomRegistry.AtomRegistry, ask: PreviewsAsk) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const schedule = yield* retrying;

    yield* client.previews
      .ask({ params: { timeline: ask.timeline }, payload: { position: ask.position } })
      .pipe(
        Effect.retry({
          schedule,
          while: (error) => error._tag !== "Unauthorized" && !refusals.has(error._tag),
        }),
        Effect.match({
          onFailure: (error) => {
            if (error._tag === "Unauthorized") {
              signedOut(registry);
            } else {
              happened(registry, { _tag: "Refused", ask });
            }
          },
          onSuccess: ({ previews }) => {
            happened(registry, { _tag: "Answered", ask, previews });
          },
        })
      );
  });

/** The errors that end a press: the link is not waiting for one, or no longer can be. */
const pressRefusals: ReadonlySet<string> = new Set([...refusals, "NotWaiting"]);

/**
 * Presses a link the Daemon holds for a press, so it is fetched, and folds in its item as
 * the Daemon answered. A failure is pressed again until it is answered, except a refusal,
 * after which its Message is asked again, to draw what the Daemon holds, and
 * `Unauthorized`, which signs the page out.
 * @param registry - The registry.
 * @param press - The press.
 * @returns The press, which never fails.
 */
const performPress = (registry: AtomRegistry.AtomRegistry, press: PreviewsPress) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const schedule = yield* retrying;

    yield* client.previews
      .press({
        params: { timeline: press.timeline },
        payload: { link: press.link, position: press.position },
      })
      .pipe(
        Effect.retry({
          schedule,
          while: (error) => error._tag !== "Unauthorized" && !pressRefusals.has(error._tag),
        }),
        Effect.match({
          onFailure: (error) => {
            if (error._tag === "Unauthorized") {
              signedOut(registry);
            } else {
              happened(registry, { _tag: "PressRefused", press });
            }
          },
          onSuccess: (item) => {
            happened(registry, { _tag: "Pressed", item, press });
          },
        }),
        // Let go of unanswered, as Previews stop being followed, it may be pressed again.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            happened(registry, { _tag: "PressDropped", press });
          })
        )
      );
  });

/**
 * Presses a link whose fetch failed, in a Timeline that waits for a press, so the Daemon
 * fetches it again. Each press is its own, so pressing one link lets no other go.
 */
export const retryPreview = runtime
  .fn(
    (
      retried: {
        readonly timeline: TimelineId;
        readonly position: TimelineItem["position"];
        readonly link: number;
      },
      get
    ) => {
      const { registry } = get;

      const press = pressOf(
        registry.get(previewsState),
        retried.timeline,
        retried.position,
        retried.link
      );

      happened(registry, { _tag: "Pressing", press });

      return performPress(registry, press);
    },
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/**
 * While the browser is signed in and any Timeline's mode asks, follows the stream of
 * Previews, and asks for each Message the core says, as what it holds, the modes, or what
 * is open change, only while the stream is followed, so no change an ask starts is missed,
 * and presses each link the Owner opened that waits for a press. Whenever the stream ends, or gives nothing for longer than three
 * heartbeats, it is followed again, and the core asks again for what was still pending. Off,
 * or signed out, nothing is followed or asked, and signed out, everything is forgotten.
 * Mounted once.
 */
export const previewsSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      if (!get(signedIn)) {
        happened(registry, { _tag: "Forgotten" });

        return;
      }

      if (!get(previewsAsked)) {
        return;
      }

      const client = yield* DaemonClient;
      const { idle, reconnect } = yield* Waits;
      const schedule = yield* retrying;
      const asks = yield* FiberSet.make();

      const askWanted = Effect.gen(function* () {
        const opening = registry.get(previewsOpening);

        for (const ask of asksWanted(
          registry.get(previewsState),
          registry.get(previewsModes),
          opening
        )) {
          happened(registry, { _tag: "Asked", ask });
          yield* FiberSet.run(asks, perform(registry, ask));
        }

        for (const press of pressesWanted(registry.get(previewsState), opening.toggles)) {
          happened(registry, { _tag: "Pressing", press });
          yield* FiberSet.run(asks, performPress(registry, press));
        }
      });

      const asking = Stream.merge(
        Stream.merge(get.stream(previewsState), get.stream(previewsModes)),
        get.stream(previewsOpening)
      ).pipe(Stream.runForEach(() => askWanted));

      const follow = Effect.gen(function* () {
        const events = yield* client.previews.changes().pipe(Effect.timeout(idle));

        happened(registry, { _tag: "Followed" });

        yield* events.pipe(
          Stream.timeout(idle),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.event === "changed") {
                happened(registry, { _tag: "Changed", item: event.data });
              }
            })
          )
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            happened(registry, { _tag: "Lost" });
          })
        )
      );

      const following = follow.pipe(
        Effect.retry({ schedule, while: (error) => error._tag !== "Unauthorized" }),
        Effect.repeat(Schedule.spaced(reconnect)),
        Effect.catchTag("Unauthorized", () =>
          Effect.sync(() => {
            signedOut(registry);
          })
        )
      );

      // Whatever is in flight when Previews stop being asked for is let go of with it.
      yield* Effect.all([asking, following], { concurrency: "unbounded", discard: true }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            happened(registry, { _tag: "Lost" });
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Says a Message came into view, with how many links it holds that may be previewed and
 * whether its Timeline is a Direct Message, so its Previews may be asked for.
 */
export const previewsShown = Atom.fnSync(
  (
    shown: {
      readonly timeline: TimelineId;
      readonly position: TimelineItem["position"];
      readonly links: number;
      readonly direct: boolean;
    },
    get
  ) => {
    happened(get.registry, { _tag: "Shown", ...shown });
  }
).pipe(Atom.keepAlive);

/**
 * Opens or closes one Preview, by its Message and its link's index, for this view alone. A
 * link opened that waits for a press is pressed, and a Message one of whose Previews opens is
 * asked for, by `previewsSync`.
 */
export const togglePreview = Atom.fnSync(
  (
    toggled: {
      readonly timeline: TimelineId;
      readonly position: TimelineItem["position"];
      readonly link: number;
      readonly open: boolean;
    },
    get
  ) => {
    const key = linkKey(messageKey(toggled.timeline, toggled.position), toggled.link);

    get.registry.set(
      previewsToggles,
      new Map(get.registry.get(previewsToggles)).set(key, toggled.open)
    );
  }
).pipe(Atom.keepAlive);

const choicesJson = Schema.encodeSync(Schema.toCodecJson(PreviewsByTimeline));

/** A conflict: the shared options were not the ones the choice was made from. */
const conflict = { _tag: "Conflict" } as const;

/**
 * One try at a Timeline's own choice: the options read, the choice made in
 * `ui.previews.timelines`, and the option sent whole, made from the sequence read.
 * @param registry - The registry.
 * @param intent - The Timeline, and its choice or none.
 * @returns What it came to, or a conflict to try again.
 */
const tryChoice = (
  registry: AtomRegistry.AtomRegistry,
  { mode, timeline }: Extract<Intent, { readonly _tag: "ChoosePreviews" }>
) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const read = yield* readShared(registry);

    yield* client.ui.set({
      params: { option: "previews.timelines" },
      payload: {
        value: choicesJson(choosing(read.options["previews.timelines"], timeline, mode)),
      },
      query: { ifSequence: read.sequence },
    });

    yield* readShared(registry);

    const done: Outcome = { _tag: "Done" };

    return done;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(error._tag === "UiChanged" ? conflict : uiFailed(error._tag))
    )
  );

/**
 * Makes or removes a Timeline's own choice over `ui.previews`, for every device: made from
 * the options read, and made once more from those read again after a conflict, so another
 * Timeline's choice made in between is kept.
 * @param registry - The registry.
 * @param intent - The Timeline, and its choice or none.
 * @returns What it came to.
 */
export const choosePreviews = (
  registry: AtomRegistry.AtomRegistry,
  intent: Extract<Intent, { readonly _tag: "ChoosePreviews" }>
) =>
  Effect.gen(function* () {
    const first = yield* tryChoice(registry, intent);

    if (first._tag !== "Conflict") {
      return first;
    }

    const second = yield* tryChoice(registry, intent);

    return second._tag === "Conflict" ? uiFailed("UiChanged") : second;
  });
