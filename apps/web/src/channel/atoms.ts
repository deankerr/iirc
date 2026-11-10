/**
 * Who is here, as atoms: each Pane's header and its Channel's members, derived from what
 * the core holds, and the reads it calls for. While the browser is signed in,
 * `channelSync` makes each read the core asks for: the head of each Channel a Pane shows,
 * and while the members show, their pages. A change that may have changed the
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
  initialChannels,
  openChannel,
  openChannels,
  queried,
  refreshDelay,
  rosterOf,
} from "@iirc/frontend/channel";
import type { ChannelEvent, ChannelRead } from "@iirc/frontend/channel";
import type { Intent } from "@iirc/frontend/commands";
import { opened } from "@iirc/frontend/timelines";
import { Clock, Duration, Effect, FiberMap, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedOut } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, timelinesState, Waits } from "../timelines/atoms.ts";
import { channelHappened, channelState, membersShown } from "./state.ts";

/**
 * The Channel a Pane shows, as held, or nothing read of it yet.
 * @param pane - The Pane's id.
 * @returns The atom.
 */
const paneChannel = Atom.family((pane: string) =>
  Atom.make((get) => {
    const shown = opened(get(timelinesState), pane);

    return channelIn(get(channelState), shown._tag === "Closed" ? undefined : shown.timeline);
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

/** The member the Owner chose in a Pane's list, by nick, by the Pane's id. */
const memberChoice = Atom.family((_pane: string) =>
  Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive)
);

/** The member chosen in a Pane's list, while the list still holds them. */
export const chosenMember = Atom.family((pane: string) =>
  Atom.make((get) => {
    const chosen = get(memberChoice(pane));
    const members = get(roster(pane));

    return members._tag === "Listed" && members.rows.some((row) => row.nick === chosen)
      ? chosen
      : undefined;
  })
);

/** Chooses a member in a Pane's list, or none. */
export const chooseMember = Atom.fnSync(
  ({ nick, pane }: { readonly pane: string; readonly nick: string | undefined }, get) => {
    get.registry.set(memberChoice(pane), nick);
  }
).pipe(Atom.keepAlive);

/**
 * The reads the core calls for now, for every Channel the Panes show.
 * @param read - Reads an atom, from the registry or as a derived atom does.
 * @returns The reads.
 */
const readsNow = (read: <A>(atom: Atom.Atom<A>) => A) =>
  channelsReads(read(channelState), openChannels(read(timelinesState)), read(membersShown));

/** The reads the core calls for now. */
const wanted = Atom.make((get) => readsNow(get));

/** The Channels the Panes show, to keep, as their Timelines' ids. */
const shownChannels = Atom.make((get) =>
  openChannels(get(timelinesState))
    .map((one) => one.timeline)
    .join(" ")
);

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
 * Makes one read and folds in its answer. A read again waits as the core said first, and
 * nothing interrupts it: a change while it is asked leaves what it reads dirty, and the
 * core calls for the next read once it answers. It is asked at the generation the state
 * has then, which its answer says. A failure is asked again until it succeeds, except a
 * refusal, which signs the page out, and an answer that there is nothing to read, or, for
 * the members, that Self is not in the Channel.
 * @param registry - The registry.
 * @param read - The read.
 * @param delay - How long to wait first, in milliseconds.
 * @returns The read, which never fails.
 */
const perform = (registry: AtomRegistry.AtomRegistry, read: ChannelRead, delay: number) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    if (delay > 0) {
      yield* Effect.sleep(Duration.millis(delay));
    }

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
 * While the browser is signed in, the open Channel's head is read, and its members while
 * they show, as the core calls for them, from nothing each time it signs in. The core
 * gives one read of each kind at a time, and says how long a read again waits: the first
 * change after quiet is read after `debounce`, and changes that keep coming at most once
 * an `interval`. Each kind is one fiber, which only a read of another Channel interrupts.
 * Mounted once for the page.
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
      const fibers = yield* FiberMap.make<string>();

      // A Channel no Pane shows any more is let go of, and a read of it in flight with it.
      const keep = get.stream(shownChannels).pipe(
        Stream.runForEach((shown) =>
          Effect.gen(function* () {
            const timelines = openChannels(registry.get(timelinesState)).map((one) => one.timeline);

            channelHappened(registry, { _tag: "Kept", timelines });

            for (const key of [...fibers].map(([one]) => one)) {
              if (!shown.includes(key.slice(key.indexOf(" ") + 1))) {
                yield* FiberMap.remove(fibers, key);
              }
            }
          })
        )
      );

      const read = get.stream(wanted).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            // As the state is now, so a read taken on since is not taken on again.
            for (const one of readsNow((atom) => registry.get(atom))) {
              const now = yield* Clock.currentTimeMillis;
              const channel = channelIn(registry.get(channelState), one.timeline);
              const delay = refreshDelay(channel, one, now, timing);

              channelHappened(registry, { _tag: "ReadStarted", at: now + delay, read: one });
              yield* FiberMap.run(
                fibers,
                `${one._tag} ${one.timeline}`,
                perform(registry, one, delay)
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
