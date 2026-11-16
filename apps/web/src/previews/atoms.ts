/**
 * Previews, as atoms: what the core holds of them; `previewsSync`, which, while the
 * browser is signed in and any Timeline's mode asks, follows their stream and makes each
 * ask the core calls for; a press of a link the Daemon holds for one; and a Timeline's own
 * choice over `ui.previews`, made for every device. A Message is shown to the core only by
 * the view, as it scrolls into sight, so nothing is asked for ahead of it.
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
  initialPreviews,
  pressOf,
  previewsModesOf,
  reducePreviews,
} from "@iirc/frontend/previews";
import type { Previews, PreviewsAsk, PreviewsEvent } from "@iirc/frontend/previews";
import { Effect, FiberSet, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { optionsState, signedOut } from "../options/atoms.ts";
import type { Outcome } from "../options/atoms.ts";
import { readShared, uiFailed } from "../options/ui.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, Waits } from "../timelines/atoms.ts";

/** What the core holds of Previews. */
export const previewsState = Atom.make<Previews>(initialPreviews).pipe(Atom.keepAlive);

/** `ui.previews` and each Timeline's own choice over it, as the Daemon acts on them, once read. */
export const previewsModes = Atom.make((get) => previewsModesOf(get(optionsState).ui));

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

/**
 * While the browser is signed in and any Timeline's mode asks, follows the stream of
 * Previews, and asks for each Message the core says, as what it holds or the modes change,
 * only while the stream is followed, so no change an ask starts is missed. Whenever the stream ends, or gives nothing for longer than three
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
        for (const ask of asksWanted(registry.get(previewsState), registry.get(previewsModes))) {
          happened(registry, { _tag: "Asked", ask });
          yield* FiberSet.run(asks, perform(registry, ask));
        }
      });

      const asking = Stream.merge(get.stream(previewsState), get.stream(previewsModes)).pipe(
        Stream.runForEach(() => askWanted)
      );

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

/** Says a Message came into view, so its Previews may be asked for. */
export const previewsShown = Atom.fnSync(
  (shown: { readonly timeline: TimelineId; readonly position: TimelineItem["position"] }, get) => {
    happened(get.registry, { _tag: "Shown", ...shown });
  }
).pipe(Atom.keepAlive);

/** The errors that end a press: the link is not waiting for one, or no longer can be. */
const pressRefusals: ReadonlySet<string> = new Set([...refusals, "NotWaiting"]);

/**
 * Presses a link the Daemon holds for a press, so it is fetched, and folds in its item as
 * the Daemon answered. A failure is pressed again until it is answered, except a refusal,
 * after which its Message is asked again, to draw what the Daemon holds, and
 * `Unauthorized`, which signs the page out.
 */
export const pressPreview = runtime
  .fn(
    (
      pressed: {
        readonly timeline: TimelineId;
        readonly position: TimelineItem["position"];
        readonly link: number;
      },
      get
    ) =>
      Effect.gen(function* () {
        const { registry } = get;
        const client = yield* DaemonClient;
        const schedule = yield* retrying;

        const press = pressOf(
          registry.get(previewsState),
          pressed.timeline,
          pressed.position,
          pressed.link
        );

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
            })
          );
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

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
