/**
 * The Timelines, as atoms: the state the pure core folds, the reads it calls for, and the
 * one changes stream for the whole page, which feeds it. While the browser is signed in,
 * `sync` makes every read the core asks for and follows the stream from the place the
 * core says, and the core decides everything else.
 *
 * @packageDocumentation
 */
import type { SearchQuery, TimelineChangesEvent, TimelineId, TimelineItem } from "@iirc/api";
import { notificationsOf } from "@iirc/frontend/notifications";
import type { SearchRequest } from "@iirc/frontend/search";
import { reduce as reduceSignIn } from "@iirc/frontend/sign-in";
import {
  followFrom,
  initialTimelines,
  keptLayout,
  layoutKeptText,
  opened,
  openOf,
  reduceTimelines,
  sidebar,
  wanted,
} from "@iirc/frontend/timelines";
import type {
  Drafted,
  OlderMode,
  PaneChange,
  Read,
  Timelines,
  TimelinesEvent,
} from "@iirc/frontend/timelines";
import { Context, Duration, Effect, FiberSet, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { channelHappened } from "../channel/state.ts";
import { forgetChantypes } from "../composer/chantypes-state.ts";
import { cancelCompletion } from "../composer/completion-state.ts";
import { notifyAll } from "../notifications/notifier.ts";
import { pageState } from "../page/atoms.ts";
import { readChoice, writeChoice } from "../page/device.ts";
import { signedIn, signInState } from "../sign-in/atoms.ts";

/** Everything the Frontend holds of the Timelines, as the core folds it. */
export const timelinesState = Atom.make<Timelines>(initialTimelines).pipe(Atom.keepAlive);

/** The Networks and their Timelines, in sidebar order. */
export const sidebarNetworks = Atom.make((get) => sidebar(get(timelinesState)));

/** The focused Pane's open Timeline, as shown. */
export const openTimeline = Atom.make((get) => opened(get(timelinesState)));

/** Each Pane's open Timeline, as shown, by the Pane's id. */
export const paneTimeline = Atom.family((pane: string) =>
  Atom.make((get) => opened(get(timelinesState), pane))
);

/** How long the runtime waits, each a duration. */
export interface WaitTimes {
  /** A stream that gives nothing for this long, heartbeats included, is gone. */
  readonly idle: Duration.Input;
  /** The first wait before asking again after a failure, doubling each time. */
  readonly retry: Duration.Input;
  /** The longest wait before asking again. */
  readonly longest: Duration.Input;
  /** The wait before following again after the stream ended. */
  readonly reconnect: Duration.Input;
  /**
   * How long the Owner must have seen the latest of the open Timeline before it is marked
   * read, so passing through a Timeline marks nothing.
   */
  readonly settle: Duration.Input;
  /**
   * How long a read again of the open Channel waits after the first change after quiet
   * that may have changed it, so a burst of joins or quits is read once.
   */
  readonly debounce: Duration.Input;
  /** While such changes keep coming, the open Channel is read again at most once this often. */
  readonly interval: Duration.Input;
  /** How long completing a nick waits before asking the Daemon, superseded by another Tab. */
  readonly complete: Duration.Input;
  /**
   * How long a Lookup has, from when the Owner asked, for its result: its `look`, every ask
   * after it by its intent, and the waits between.
   */
  readonly lookup: Duration.Input;
  /** How long one request of a Lookup waits for its answer, within its deadline. */
  readonly lookRequest: Duration.Input;
}

/** How long the runtime waits: a test makes these short. */
export class Waits extends Context.Reference<WaitTimes>("@iirc/web/Waits", {
  defaultValue: () => ({
    complete: "60 millis",
    debounce: "250 millis",
    idle: "45 seconds",
    interval: "1 second",
    longest: "15 seconds",
    lookRequest: "45 seconds",
    lookup: "2 minutes",
    reconnect: "1 second",
    retry: "500 millis",
    settle: "1 second",
  }),
}) {}

/**
 * Folds one event into the Timelines' state.
 * @param registry - The registry the state is in.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: TimelinesEvent) => {
  registry.set(timelinesState, reduceTimelines(registry.get(timelinesState), event));
};

/**
 * Signs the page out: a read was `Unauthorized`, so the sign-in is gone.
 * @param registry - The registry.
 */
const refused = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(signInState, reduceSignIn(registry.get(signInState), { _tag: "Refused" }));
};

/** The errors a read gives up on: the Daemon said it has no such thing, or no sign-in. */
const final: ReadonlySet<string> = new Set(["Unauthorized", "UnknownTimeline", "UnknownNetwork"]);

/**
 * Asks again after a failure: soon at first, then less often, up to the longest wait.
 * @returns The schedule.
 */
export const retrying = Effect.gen(function* () {
  const { longest, retry } = yield* Waits;

  return Schedule.min([Schedule.exponential(retry), Schedule.spaced(longest)]);
});

/**
 * The query of a page of a search, with only the filters it has.
 * @param read - The read.
 * @returns The query.
 */
const searchQueryOf = (read: SearchRequest): SearchQuery => {
  const { after, filters } = read;
  let query: SearchQuery = { limit: read.limit, text: filters.text };

  if (after !== undefined) {
    query = { ...query, after };
  }

  if (filters.from !== undefined) {
    query = { ...query, from: filters.from };
  }

  if (filters.network !== undefined) {
    query = { ...query, network: filters.network };
  }

  if (filters.since !== undefined) {
    query = { ...query, since: filters.since };
  }

  if (filters.timeline !== undefined) {
    query = { ...query, timeline: filters.timeline };
  }

  if (filters.until !== undefined) {
    query = { ...query, until: filters.until };
  }

  return query;
};

/** Why a search found nothing, in words, by what the Daemon answered. */
const searchRefusals: ReadonlyMap<string, string> = new Map([
  ["InvalidRequest", "The Daemon could not read this search, so nothing was searched."],
  ["UnknownNetwork", "That Network is not configured, so nothing was searched."],
  ["UnknownTimeline", "That Timeline is gone, so nothing was searched."],
]);

/**
 * The request a read makes, and the event its answer is.
 * @param read - The read.
 * @returns The request.
 */
const request = (read: Read) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    switch (read._tag) {
      case "Networks": {
        const entries = yield* client.networks.list();

        return { _tag: "NetworksRead", entries } as const;
      }

      case "List": {
        const page = yield* client.timelines.list({
          params: { network: read.network },
          query: read.after === undefined ? {} : { after: read.after },
        });

        return { _tag: "ListRead", after: read.after, network: read.network, page } as const;
      }

      case "Status": {
        const known = yield* client.networks.known({ params: { network: read.network } });

        return {
          _tag: "StatusRead",
          network: read.network,
          self: known.self,
          session: known.session,
        } as const;
      }

      case "Latest": {
        const window = yield* client.timelines.window({
          params: { timeline: read.timeline },
          query: { limit: read.limit },
        });

        return { _tag: "WindowRead", read, window } as const;
      }

      case "Older": {
        const window = yield* client.timelines.window({
          params: { timeline: read.timeline },
          query: { before: read.before, limit: read.limit },
        });

        return { _tag: "WindowRead", read, window } as const;
      }

      case "Newer": {
        const window = yield* client.timelines.window({
          params: { timeline: read.timeline },
          query: { after: read.after, limit: read.limit },
        });

        return { _tag: "WindowRead", read, window } as const;
      }

      case "Around": {
        const window = yield* client.timelines.window({
          params: { timeline: read.timeline },
          query: { around: read.around, limit: read.limit },
        });

        return { _tag: "WindowRead", read, window } as const;
      }

      case "Search": {
        const page = yield* client.timelines.search({ query: searchQueryOf(read) });

        return { _tag: "SearchRead", page, read } as const;
      }

      default: {
        return read satisfies never;
      }
    }
  });

/**
 * Makes one read and folds in its answer. A read the core asked for again, because the
 * last came back too old to use, waits first, longer each time, and the core is told as
 * each attempt begins. A failure is asked again
 * until it succeeds, except a refusal, which signs the page out, and a Timeline or Network
 * the Daemon says it never had.
 * @param registry - The registry.
 * @param read - The read.
 * @returns The read, which never fails.
 */
const perform = (registry: AtomRegistry.AtomRegistry, read: Read) =>
  Effect.gen(function* () {
    const { longest, retry } = yield* Waits;

    if (read.attempt > 0) {
      yield* Effect.sleep(
        Duration.min(
          Duration.times(Duration.fromInputUnsafe(retry), 2 ** (read.attempt - 1)),
          Duration.fromInputUnsafe(longest)
        )
      );
    }

    const schedule = yield* retrying;

    // Each attempt is marked as it begins, after any wait, so the answer is current from
    // where the stream is when the Daemon is asked, not from when the read was taken on.
    const attempt = Effect.sync(() => {
      happened(registry, { _tag: "Requesting", read });
    }).pipe(Effect.andThen(request(read)));

    // A search the Daemon refused says why, and is not asked again.
    const refusal = (tag: string) => (read._tag === "Search" ? searchRefusals.get(tag) : undefined);

    yield* attempt.pipe(
      Effect.retry({
        schedule,
        while: (error) => !final.has(error._tag) && refusal(error._tag) === undefined,
      }),
      Effect.match({
        onFailure: (error) => {
          const words = refusal(error._tag);

          if (error._tag === "Unauthorized") {
            refused(registry);
          } else if (read._tag === "Search" && words !== undefined) {
            happened(registry, { _tag: "SearchFailed", message: words, read });
          } else if (error._tag === "UnknownTimeline" && "timeline" in read) {
            happened(registry, { _tag: "Vanished", timeline: read.timeline });
          } else if (error._tag === "UnknownNetwork" && "network" in read) {
            happened(registry, { _tag: "NetworkVanished", network: read.network });
          }
        },
        onSuccess: (event) => {
          happened(registry, event);
        },
      })
    );
  });

/**
 * Makes every read the core calls for, each once, as the state changes.
 * @param registry - The registry.
 * @param changes - The state, each time it changes.
 * @returns The reader, which runs until it is interrupted.
 */
const reader = (registry: AtomRegistry.AtomRegistry, changes: Stream.Stream<Timelines>) =>
  Effect.gen(function* () {
    const reads = yield* FiberSet.make();

    yield* changes.pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          // The state as it is now, not as it was when this change was queued, so a read
          // started since is not started again.
          for (const read of wanted(registry.get(timelinesState))) {
            happened(registry, { _tag: "ReadStarted", read });
            yield* FiberSet.run(reads, perform(registry, read));
          }
        })
      )
    );
  });

/**
 * Folds one event of the changes stream into the core, the Timelines and the open Channel,
 * and shows the notifications the core says a change calls for. A heartbeat only says the
 * stream is alive.
 * @param registry - The registry.
 * @param event - The event.
 * @returns Once folded and shown.
 */
const changed = (registry: AtomRegistry.AtomRegistry, event: TimelineChangesEvent) => {
  switch (event.event) {
    case "changed": {
      const before = registry.get(timelinesState);

      happened(registry, { _tag: "Changed", change: event.data, place: event.id });
      channelHappened(registry, { _tag: "Changed", change: event.data });

      const notifies = notificationsOf(
        before,
        registry.get(timelinesState),
        event.data,
        registry.get(pageState)
      );

      return notifyAll(notifies, (notify) => {
        happened(registry, { _tag: "Opened", timeline: notify.timeline });
      });
    }

    case "overflowed": {
      happened(registry, { _tag: "Overflowed", overflow: event.data, place: event.id });
      channelHappened(registry, { _tag: "Overflowed", overflow: event.data });

      return Effect.void;
    }

    case "reset": {
      happened(registry, { _tag: "Reset", reset: event.data });
      channelHappened(registry, { _tag: "Reset" });
      forgetChantypes(registry);

      return Effect.void;
    }

    case "heartbeat": {
      return Effect.void;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Follows the changes stream for the whole page, from the place the core holds, once the
 * first reads are in. The place moves with every event, so whenever the stream ends, or
 * gives nothing for longer than three heartbeats, it is followed again from where it left
 * off, and so it is when opening it gives no answer for as long. A refusal signs the page
 * out.
 * @param registry - The registry.
 * @param changes - The state, each time it changes.
 * @returns The follower, which runs until it is interrupted.
 */
const follower = (registry: AtomRegistry.AtomRegistry, changes: Stream.Stream<Timelines>) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { idle, reconnect } = yield* Waits;
    const schedule = yield* retrying;

    yield* changes.pipe(
      Stream.filter((state) => followFrom(state) !== undefined),
      Stream.take(1),
      Stream.runDrain
    );

    const follow = Effect.gen(function* () {
      const from = followFrom(registry.get(timelinesState));

      // Opening the stream is bounded as its silence is: a request whose answer never
      // begins is given up, which aborts it, and followed again.
      const events = yield* client.timelines
        .changes({
          headers: {},
          query: from === null || from === undefined ? {} : { after: from },
        })
        .pipe(Effect.timeout(idle));

      yield* events.pipe(
        Stream.timeout(idle),
        Stream.runForEach((event) => Effect.suspend(() => changed(registry, event)))
      );
    });

    yield* follow.pipe(
      Effect.retry({ schedule, while: (error) => error._tag !== "Unauthorized" }),
      Effect.repeat(Schedule.spaced(reconnect)),
      Effect.catchTag("Unauthorized", () =>
        Effect.sync(() => {
          refused(registry);
        })
      )
    );
  });

/** Where this device keeps its layout. */
export const layoutKey = "iirc.layout";

/** The layout as this device keeps it, as JSON text, or none while one kept waits. */
const layoutKept = Atom.make((get) => {
  const kept = keptLayout(get(timelinesState));

  return kept === undefined ? undefined : JSON.stringify(kept);
});

/**
 * Restores the layout this device kept, if it reads as one within the core's bounds: the
 * core sets it aside until the Timelines are read, and drops the Panes whose Timeline is gone.
 * @param registry - The registry.
 */
const restore = (registry: AtomRegistry.AtomRegistry) => {
  const text = readChoice(layoutKey);

  // Whatever was kept, the page starts: a layout that cannot be taken leaves the one it
  // starts with, which the core bounds and refuses safely, and this guards past it.
  try {
    const layout = text === undefined ? undefined : layoutKeptText(text);

    if (layout !== undefined) {
      happened(registry, { _tag: "Restore", layout });
    }
  } catch {
    // The layout the page starts with stands.
  }
};

/**
 * Keeps the layout on this device as it changes, as best it can: in the same tick as the
 * change, from the registry's own subscription, so a reload straight after it finds it
 * kept, and once more as the page is hidden for good, on `pagehide`. Text already kept is
 * not written again, and the core bounds what a layout can be.
 * @param registry - The registry.
 * @returns The keeper, which runs until it is interrupted.
 */
const keeper = (registry: AtomRegistry.AtomRegistry) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let written: string | undefined;

      const keep = () => {
        const text = registry.get(layoutKept);

        if (text !== undefined && text !== written && writeChoice(layoutKey, text)) {
          written = text;
        }
      };

      const stop = registry.subscribe(layoutKept, keep, { immediate: true });

      globalThis.addEventListener("pagehide", keep);

      return () => {
        stop();
        globalThis.removeEventListener("pagehide", keep);
      };
    }),
    (release) => Effect.sync(release)
  ).pipe(Effect.andThen(Effect.never), Effect.scoped);

/**
 * While the browser is signed in, the Timelines are read and followed, from nothing each
 * time it signs in. Mounted once for the page.
 */
export const sync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      registry.set(timelinesState, initialTimelines);

      if (!get(signedIn)) {
        return;
      }

      restore(registry);

      const changes = get.stream(timelinesState);

      yield* Effect.all(
        [reader(registry, changes), follower(registry, changes), keeper(registry)],
        { concurrency: "unbounded", discard: true }
      );
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Opens a Timeline in the focused Pane, or focuses the Pane it is open in, letting go of
 * what was being completed.
 */
export const open = Atom.fnSync((timeline: TimelineId, get) => {
  cancelCompletion(get.registry);
  happened(get.registry, { _tag: "Opened", timeline });
}).pipe(Atom.keepAlive);

/**
 * Shows a Direct Message not yet begun in the focused Pane, letting go of what was being
 * completed, since the composer then stands under it.
 */
export const showDraft = Atom.fnSync((draft: Drafted, get) => {
  cancelCompletion(get.registry);
  happened(get.registry, { _tag: "DraftShown", ...draft });
}).pipe(Atom.keepAlive);

/** Closes the focused Pane's Direct Message not yet begun, showing what it showed before. */
export const closeDraft = Atom.fnSync((_, get) => {
  cancelCompletion(get.registry);
  happened(get.registry, { _tag: "DraftClosed" });
}).pipe(Atom.keepAlive);

/**
 * Changes the Panes, letting go of what was being completed when the composer then stands
 * under another Timeline.
 */
export const paned = Atom.fnSync((change: PaneChange, get) => {
  const before = openOf(get.registry.get(timelinesState));

  happened(get.registry, { _tag: "Pane", change });

  if (openOf(get.registry.get(timelinesState)) !== before) {
    cancelCompletion(get.registry);
  }
}).pipe(Atom.keepAlive);

/**
 * Asks for what lies before the open Timeline's first item: `Asked` when the Owner asked on
 * purpose, and `Auto` when the view reads on its own, which never drops the latest.
 */
export const older = Atom.fnSync(
  ({ mode, timeline }: { readonly timeline: TimelineId; readonly mode: OlderMode }, get) => {
    happened(get.registry, { _tag: "OlderWanted", mode, timeline });
  }
).pipe(Atom.keepAlive);

/** Reads a Timeline's latest again, whole, and follows it from there. */
export const latest = Atom.fnSync((timeline: TimelineId, get) => {
  happened(get.registry, { _tag: "LatestWanted", timeline });
}).pipe(Atom.keepAlive);

/** The most items a window holds, which a view reads older pages without asking within. */
export const windowCapOf = Atom.make((get) => get(timelinesState).windowCap);

/** Asks for what lies after the open Timeline's last item, when the Owner scrolled back. */
export const newer = Atom.fnSync((timeline: TimelineId, get) => {
  happened(get.registry, { _tag: "NewerWanted", timeline });
}).pipe(Atom.keepAlive);

/**
 * Says whether the Owner is at the latest of the open Timeline, and the last item in view
 * there. Only the view says it, once it has laid out.
 */
export const following = Atom.fnSync(
  (
    {
      following: at,
      owned,
      seen,
      timeline,
    }: {
      readonly timeline: TimelineId;
      readonly following: boolean;
      readonly seen: TimelineItem["position"] | undefined;
      /** The Owner moved the view there themselves. */
      readonly owned: boolean;
    },
    get
  ) => {
    happened(get.registry, { _tag: "Following", following: at, owned, seen, timeline });
  }
).pipe(Atom.keepAlive);
