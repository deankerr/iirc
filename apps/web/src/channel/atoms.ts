/**
 * Who is here, as atoms: the open Timeline's header and the open Channel's members,
 * derived from what the core holds, and the reads it calls for. While the browser is
 * signed in, `channelSync` makes each read the core asks for: the head of the open
 * Channel, and while its members show, their pages. A change that may have changed the
 * Channel, which the one changes stream folds in, has it read again, after a moment, each
 * later change superseding the read before.
 *
 * @packageDocumentation
 */
import type { MembersQuery, NetworkId } from "@iirc/api";
import {
  channelReads,
  headerOf,
  initialChannel,
  openChannel,
  queried,
  refreshDelay,
  rosterOf,
} from "@iirc/frontend/channel";
import type { ChannelEvent, ChannelRead } from "@iirc/frontend/channel";
import type { Intent } from "@iirc/frontend/commands";
import { Clock, Duration, Effect, FiberMap, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedOut } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, timelinesState, Waits } from "../timelines/atoms.ts";
import { channelHappened, channelState, membersShown } from "./state.ts";

/** What the open Timeline shows at its head. */
export const timelineHeader = Atom.make((get) => headerOf(get(timelinesState), get(channelState)));

/** Whether a Channel is open, so its members can show. */
export const channelOpen = Atom.make((get) => openChannel(get(timelinesState)) !== undefined);

/** The open Channel's members, as the list shows them. */
export const roster = Atom.make((get) => rosterOf(get(timelinesState), get(channelState)));

/** The member the Owner chose in the list, by nick. */
const memberChoice = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

/** The member chosen, while the list still holds them. */
export const chosenMember = Atom.make((get) => {
  const chosen = get(memberChoice);
  const members = get(roster);

  return members._tag === "Listed" && members.rows.some((row) => row.nick === chosen)
    ? chosen
    : undefined;
});

/** Chooses a member in the list, or none. */
export const chooseMember = Atom.fnSync((nick: string | undefined, get) => {
  get.registry.set(memberChoice, nick);
}).pipe(Atom.keepAlive);

/** The reads the core calls for now. */
const wanted = Atom.make((get) =>
  channelReads(get(channelState), openChannel(get(timelinesState)), get(membersShown))
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

    const { generation } = registry.get(channelState);

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

      registry.set(channelState, initialChannel);

      if (!get(signedIn)) {
        return;
      }

      const fibers = yield* FiberMap.make<ChannelRead["_tag"]>();

      yield* get.stream(wanted).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            // As the state is now, so a read taken on since is not taken on again.
            const reads = channelReads(
              registry.get(channelState),
              openChannel(registry.get(timelinesState)),
              registry.get(membersShown)
            );

            for (const read of reads) {
              const now = yield* Clock.currentTimeMillis;
              const delay = refreshDelay(registry.get(channelState), read, now, timing);

              channelHappened(registry, { _tag: "ReadStarted", at: now + delay, read });
              yield* FiberMap.run(fibers, read._tag, perform(registry, read, delay));
            }
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);

/** Asks for the members after those held, as the Owner scrolls to the end of them. */
export const moreMembers = Atom.fnSync((_: undefined, get) => {
  const { timeline } = get.registry.get(channelState);

  if (timeline !== undefined) {
    channelHappened(get.registry, { _tag: "MoreWanted", timeline });
  }
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
