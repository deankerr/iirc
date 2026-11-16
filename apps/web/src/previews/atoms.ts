/**
 * Previews, as atoms: what the core holds of them, and `previewsSync`, which, while the
 * browser is signed in and `ui.previews` asks, follows their stream and makes each ask the
 * core calls for. A Message is shown to the core only by the view, as it scrolls into
 * sight, so nothing is asked for ahead of it.
 *
 * @packageDocumentation
 */
import type { TimelineId, TimelineItem } from "@iirc/api";
import {
  asksFor,
  asksWanted,
  initialPreviews,
  previewsModeOf,
  reducePreviews,
} from "@iirc/frontend/previews";
import type { Previews, PreviewsAsk, PreviewsEvent } from "@iirc/frontend/previews";
import { Effect, FiberSet, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { optionsState, signedOut } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, Waits } from "../timelines/atoms.ts";

/** What the core holds of Previews. */
export const previewsState = Atom.make<Previews>(initialPreviews).pipe(Atom.keepAlive);

/** `ui.previews` as the Daemon acts on it: the shared value, once read. */
export const previewsMode = Atom.make((get) => previewsModeOf(get(optionsState).ui));

/** Whether Previews are asked for and followed now. */
const previewsAsked = Atom.make((get) => asksFor(get(previewsMode)));

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
 * While the browser is signed in and `ui.previews` asks, follows the stream of Previews,
 * and asks for each Message the core says, only while the stream is followed, so no change
 * an ask starts is missed. Whenever the stream ends, or gives nothing for longer than three
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
        for (const ask of asksWanted(registry.get(previewsState), registry.get(previewsMode))) {
          happened(registry, { _tag: "Asked", ask });
          yield* FiberSet.run(asks, perform(registry, ask));
        }
      });

      const asking = get.stream(previewsState).pipe(Stream.runForEach(() => askWanted));

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
