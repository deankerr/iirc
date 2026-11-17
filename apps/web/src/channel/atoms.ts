/**
 * Who is here, as atoms: each Pane's header and its Channel's members, derived from what
 * the core holds, and the reads it calls for. While the browser is signed in,
 * `channelSync` makes each read the core asks for: the head of each Channel the Sidebar
 * lists, a Pane shows, or whose list a Lookup card is, so a Channel opens with its head
 * already read, and while the members show, their pages. A change that may have changed the
 * Channel, which the one changes stream folds in, has it read again, after a moment, each
 * later change superseding the read before.
 *
 * @packageDocumentation
 */
import type { MembersQuery, NetworkId, TimelineId } from "@iirc/api";
import {
  channelIn,
  channelsReads,
  headerOf,
  heldChannels,
  initialChannels,
  openChannel,
  openChannels,
  queried,
  refreshDelay,
  rosterOf,
} from "@iirc/frontend/channel";
import type { ChannelEvent, ChannelRead, OpenChannel } from "@iirc/frontend/channel";
import type { Intent } from "@iirc/frontend/commands";
import { listedChannels } from "@iirc/frontend/lookup";
import { opened } from "@iirc/frontend/timelines";
import { Clock, Duration, Effect, FiberMap, Semaphore, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { lookupsState } from "../lookup/state.ts";
import { signedOut } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, timelinesState, Waits } from "../timelines/atoms.ts";
import { channelHappened, channelState, membersPanes } from "./state.ts";

/**
 * The Channel a Pane shows, as held, or nothing read of it yet.
 * @param pane - The Pane's id.
 * @returns The atom.
 */
const paneChannel = Atom.family((pane: string) =>
  Atom.make((get) => {
    const shown = opened(get(timelinesState), pane);

    return channelIn(get(channelState), "timeline" in shown ? shown.timeline : undefined);
  })
);

/** What a Pane's open Timeline shows at its head, by the Pane's id. */
export const timelineHeader = Atom.family((pane: string) =>
  Atom.make((get) => headerOf(get(timelinesState), get(paneChannel(pane)), pane))
);

/** Whether a Pane shows a Channel, so its members can show, by the Pane's id. */
export const channelOpen = Atom.family((pane: string) =>
  Atom.make((get) => openChannel(get(timelinesState), pane) !== undefined)
);

/** A Pane's Channel's members, as the list shows them, by the Pane's id. */
export const roster = Atom.family((pane: string) =>
  Atom.make((get) => rosterOf(get(timelinesState), get(paneChannel(pane)), pane))
);

/**
 * The Channels whose members show in a Pane now, by their Timelines' ids, so only those are
 * read: members over one narrow Pane's Timeline do not have every other Channel's read.
 */
const membersRead = Atom.make((get) => {
  const state = get(timelinesState);

  return new Set(
    get(membersPanes).flatMap((pane) => {
      const open = openChannel(state, pane);

      return open === undefined ? [] : [open.timeline];
    })
  );
});

/**
 * Every Channel whose head is followed: those the Panes show, those the Sidebar lists, and
 * those whose lists the Lookup cards are, which say whether Self may remove a mask, each
 * once.
 * @param read - Reads an atom, from the registry or as a derived atom does.
 * @returns The Channels.
 */
const followed = (read: <A>(atom: Atom.Atom<A>) => A): readonly OpenChannel[] => {
  const timelines = read(timelinesState);
  const held = heldChannels(timelines);

  return [
    ...held,
    ...listedChannels(read(lookupsState), timelines).filter(
      (one) => !held.some((open) => open.timeline === one.timeline)
    ),
  ];
};

/**
 * The reads the core calls for now, for every Channel followed: its head, and its members
 * where they show, which a card's Channel's never do.
 * @param read - Reads an atom, from the registry or as a derived atom does.
 * @returns The reads.
 */
const readsNow = (read: <A>(atom: Atom.Atom<A>) => A) =>
  channelsReads(read(channelState), followed(read), read(membersRead));

/** The reads the core calls for now. */
const wanted = Atom.make((get) => readsNow(get));

/**
 * The Channels followed, whose heads are kept, and those the Panes show, whose members are
 * kept too, as their Timelines' ids.
 * @param read - Reads an atom, from the registry or as a derived atom does.
 * @returns Them.
 */
const keptNow = (read: <A>(atom: Atom.Atom<A>) => A) => ({
  shown: openChannels(read(timelinesState)).map((one) => one.timeline),
  timelines: followed(read).map((one) => one.timeline),
});

/** What is kept, as a string, so the stream of it changes only when what is kept does. */
const kept = Atom.make((get) => {
  const { shown, timelines } = keptNow(get);

  return `${timelines.join(" ")}|${shown.join(" ")}`;
});

/** How many heads of Channels no Pane shows are asked at once. */
const listedAtOnce = 2;
// A read that keeps failing keeps its turn while it is asked again, so two that never
// succeed would leave the rest waiting. The Daemon answers a head from what the Client
// holds, so one that cannot answer one cannot answer the rest either.

/** The errors a read gives up on: no sign-in, or nothing to read. */
const final: ReadonlySet<string> = new Set([
  "Unauthorized",
  "UnknownTimeline",
  "NotAChannel",
  "NotInChannel",
]);

/**
 * Asks again after a failure, until it succeeds or the Daemon says there is nothing to
 * read, and settles what it came to as an event, or signs the page out on a refusal.
 * @param registry - The registry.
 * @param read - The read.
 * @param generation - The generation it was asked at.
 * @param request - The request, its answer as an event.
 * @returns The event, or none once signed out.
 */
const settled = <E extends { readonly _tag: string }>(
  registry: AtomRegistry.AtomRegistry,
  read: ChannelRead,
  generation: number,
  request: Effect.Effect<ChannelEvent, E>
) =>
  Effect.gen(function* () {
    const schedule = yield* retrying;

    return yield* request.pipe(
      Effect.retry({ schedule, while: (error) => !final.has(error._tag) }),
      Effect.catch((error) =>
        Effect.sync((): ChannelEvent | undefined => {
          if (error._tag === "Unauthorized") {
            signedOut(registry);

            return undefined;
          }

          return { _tag: "Failed", generation, read };
        })
      )
    );
  });

/**
 * Asks one read, at the generation the state has now, and folds in its answer.
 * @param registry - The registry.
 * @param read - The read.
 * @returns The read, which never fails.
 */
const asked = (registry: AtomRegistry.AtomRegistry, read: ChannelRead) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { generation } = channelIn(registry.get(channelState), read.timeline);

    const event =
      read._tag === "Head"
        ? yield* settled(
            registry,
            read,
            generation,
            client.timelines.channel({ params: { timeline: read.timeline } }).pipe(
              Effect.map((header): ChannelEvent => ({
                _tag: "HeadRead",
                generation,
                header,
                read,
              }))
            )
          )
        : yield* settled(
            registry,
            read,
            generation,
            client.timelines
              .members({
                params: { timeline: read.timeline },
                query: (read.after === undefined
                  ? { limit: read.limit }
                  : { after: read.after, limit: read.limit }) satisfies MembersQuery,
              })
              .pipe(
                Effect.map((page): ChannelEvent => ({
                  _tag: "MembersRead",
                  generation,
                  page,
                  read,
                })),
                Effect.catchTag("NotInChannel", (error) =>
                  Effect.succeed<ChannelEvent>({
                    _tag: "NotInChannel",
                    generation,
                    read,
                    standing: error.standing,
                  })
                )
              )
          );

    if (event !== undefined) {
      channelHappened(registry, event);
    }
  });

/**
 * Makes one read and folds in its answer. A read again waits as the core said first, and
 * nothing interrupts it: a change while it is asked leaves what it reads dirty, and the
 * core calls for the next read once it answers. It is asked at the generation the state
 * has then, which its answer says. A failure is asked again until it succeeds, except a
 * refusal, which signs the page out, and an answer that there is nothing to read, or, for
 * the members, that Self is not in the Channel. Once waited, it is asked through `gate`, so
 * the heads of Channels no Pane shows take turns rather than crowd out what the Panes read.
 * @param registry - The registry.
 * @param read - The read.
 * @param delay - How long to wait first, in milliseconds.
 * @param gate - What it is asked through, once waited.
 * @returns The read, which never fails.
 */
const perform = (
  registry: AtomRegistry.AtomRegistry,
  read: ChannelRead,
  delay: number,
  gate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    if (delay > 0) {
      yield* Effect.sleep(Duration.millis(delay));
    }

    yield* gate(asked(registry, read));
  });

/**
 * Asks an effect as it is, with no turn to wait for.
 * @param effect - The effect.
 * @returns It.
 */
const asItIs = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;

/**
 * Waits until a Pane shows a Channel.
 * @param registry - The registry.
 * @param timeline - The Channel's Timeline.
 * @returns The wait.
 */
const untilShown = (registry: AtomRegistry.AtomRegistry, timeline: TimelineId) =>
  Effect.callback((resume) => {
    const stop = registry.subscribe(
      timelinesState,
      (state) => {
        if (openChannels(state).some((one) => one.timeline === timeline)) {
          resume(Effect.void);
        }
      },
      { immediate: true }
    );

    return Effect.sync(stop);
  });

/**
 * Asks a read of a Channel no Pane shows in its turn, one of `listed`'s permits, or at once
 * if a Pane shows it before then, so a Channel opened while the heads are queued is not
 * kept behind them. Once begun in its turn, it is not asked again.
 * @param registry - The registry.
 * @param listed - The turns.
 * @param timeline - The Channel's Timeline.
 * @returns The gate.
 */
const queued =
  (registry: AtomRegistry.AtomRegistry, listed: Semaphore.Semaphore, timeline: TimelineId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      let begun = false;

      return yield* Effect.raceFirst(
        listed.withPermits(1)(
          Effect.suspend(() => {
            begun = true;

            return effect;
          })
        ),
        untilShown(registry, timeline).pipe(
          Effect.andThen(Effect.suspend(() => (begun ? Effect.never : effect)))
        )
      );
    });

/**
 * While the browser is signed in, the head of each Channel followed is read, and the
 * members of each shown while they show, as the core calls for them, from nothing each time
 * it signs in. The core gives one read of each kind of each Channel at a time, and says how
 * long a read again waits: the first change after quiet is read after `debounce`, and
 * changes that keep coming at most once an `interval`. Each is one fiber, which only
 * letting go of its Channel, or of its members, interrupts. The heads of Channels no Pane
 * shows are asked `listedAtOnce` at a time, so a Gap that dirties them all queues neither
 * what the Panes read nor what the Owner says behind them. Mounted once for the page.
 */
export const channelSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;
      const { debounce, interval } = yield* Waits;

      const timing = {
        debounce: Duration.toMillis(debounce),
        interval: Duration.toMillis(interval),
      };

      registry.set(channelState, initialChannels);

      if (!get(signedIn)) {
        return;
      }

      // One fiber for each kind of read of each Channel.
      const heads = yield* FiberMap.make<TimelineId>();
      const members = yield* FiberMap.make<TimelineId>();
      const listed = yield* Semaphore.make(listedAtOnce);

      // A Channel no longer followed is let go of, and its members once no Pane shows it,
      // each with a read of it in flight.
      const keep = get.stream(kept).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const now = keptNow((atom) => registry.get(atom));

            channelHappened(registry, { _tag: "Kept", ...now });

            for (const [fibers, still] of [
              [heads, now.timelines],
              [members, now.shown],
            ] as const) {
              for (const timeline of Array.from(fibers, ([one]) => one)) {
                if (!still.includes(timeline)) {
                  yield* FiberMap.remove(fibers, timeline);
                }
              }
            }
          })
        )
      );

      const read = get.stream(wanted).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const shown = new Set(
              openChannels(registry.get(timelinesState)).map((open) => open.timeline)
            );

            // As the state is now, so a read taken on since is not taken on again.
            for (const one of readsNow((atom) => registry.get(atom))) {
              const now = yield* Clock.currentTimeMillis;
              const channel = channelIn(registry.get(channelState), one.timeline);
              const delay = refreshDelay(channel, one, now, timing);

              channelHappened(registry, { _tag: "ReadStarted", at: now + delay, read: one });
              yield* FiberMap.run(
                one._tag === "Head" ? heads : members,
                one.timeline,
                perform(
                  registry,
                  one,
                  delay,
                  shown.has(one.timeline) ? asItIs : queued(registry, listed, one.timeline)
                )
              );
            }
          })
        )
      );

      yield* Effect.all([keep, read], { concurrency: "unbounded", discard: true });
    })
  )
  .pipe(Atom.keepAlive);

/** Asks for a Channel's members after those held, as the Owner scrolls to the end of them. */
export const moreMembers = Atom.fnSync((timeline: TimelineId, get) => {
  channelHappened(get.registry, { _tag: "MoreWanted", timeline });
}).pipe(Atom.keepAlive);

/**
 * What `/query` came to: the intents to carry out, nothing because the Owner went
 * elsewhere meanwhile, why nothing was opened, in words, or a refused sign-in.
 */
export type Queried =
  | { readonly _tag: "Intents"; readonly intents: readonly Intent[] }
  | { readonly _tag: "LetGo" }
  | { readonly _tag: "NotDone"; readonly message: string }
  | { readonly _tag: "SignedOut" };

/**
 * What `/query` comes to: the Timeline the name keys on its Network, as the Daemon keys it
 * by the casemapping the Network last declared, which `known` says, `rfc1459` only when it
 * says none was declared yet, or with no Timeline, the composer started with `/msg <name> `.
 * A `known` that cannot be read opens nothing and says so, since guessing the mapping could
 * open another User's Timeline. One the Owner moved on from, by opening a Timeline or the
 * options while `known` was read, is let go of, as a `/msg` placement is.
 * @param registry - The registry.
 * @param network - The Network.
 * @param name - The name.
 * @param navigation - The core's navigation when `/query` was submitted.
 * @returns What it came to.
 */
export const query = (
  registry: AtomRegistry.AtomRegistry,
  network: NetworkId,
  name: string,
  navigation: number
): Effect.Effect<Queried, never, DaemonClient> =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    return yield* client.networks.known({ params: { network } }).pipe(
      Effect.map((known): Queried => {
        const state = registry.get(timelinesState);

        return state.navigation === navigation
          ? {
              _tag: "Intents",
              intents: queried(state, network, name, known.declared ?? undefined),
            }
          : { _tag: "LetGo" };
      }),
      Effect.catch((error) =>
        Effect.succeed<Queried>(
          error._tag === "Unauthorized"
            ? { _tag: "SignedOut" }
            : {
                _tag: "NotDone",
                message: `The Daemon did not say how ${network} compares nicks, so /query ${name} opened nothing, rather than risk another's Direct Message. Try again.`,
              }
        )
      )
    );
  });
