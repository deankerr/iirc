/**
 * The menu on a nick, as atoms: the one open, as the core folds it, and `nickMenuSync`,
 * which reads whether its User is still in its Channel from the Daemon's members route,
 * and how the Network's Connection folds names, from `known`, while it is open.
 *
 * @packageDocumentation
 */
import type { TimelineId } from "@iirc/api";
import { nicksLimit } from "@iirc/frontend/completion";
import { initialNickMenus, presenceWanted, reduceNickMenus } from "@iirc/frontend/nick-menu";
import type { NickMenusEvent } from "@iirc/frontend/nick-menu";
import { Effect, FiberMap, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedOut } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";

/** The menu open on a nick, if any. */
export const nickMenusState = Atom.make(initialNickMenus).pipe(Atom.keepAlive);

/**
 * Folds one event into the menu on a nick.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: NickMenusEvent) => {
  registry.set(nickMenusState, reduceNickMenus(registry.get(nickMenusState), event));
};

/**
 * Opens the menu on a nick in a Timeline, and says the request it opened under.
 * @param registry - The registry.
 * @param opened - The nick, its Timeline, and whether that is a Channel's.
 * @returns The request.
 */
export const openNickMenu = (
  registry: AtomRegistry.AtomRegistry,
  opened: { readonly nick: string; readonly timeline: TimelineId; readonly channel: boolean }
): number => {
  const { next } = registry.get(nickMenusState);

  happened(registry, { _tag: "Opened", ...opened });

  return next;
};

/** Closes the menu on a nick opened under a request. */
export const closeNickMenu = Atom.fnSync((request: number, get) => {
  happened(get.registry, { _tag: "Closed", request });
}).pipe(Atom.keepAlive);

/** The members route's request the menu open waits on, if any. */
const asking = Atom.make((get) => presenceWanted(get(nickMenusState)));

/**
 * Reads whether the User of the menu open is in its Channel: its members whose nick starts
 * with theirs, and how the Connection folds names, and folds the answer in. A refusal signs
 * the page out, and any other failure leaves it unknown.
 * @param registry - The registry.
 * @param wanted - The request.
 * @returns Once folded in.
 */
const askPresence = (
  registry: AtomRegistry.AtomRegistry,
  wanted: NonNullable<ReturnType<typeof presenceWanted>>
) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    const event = yield* client.timelines
      .members({
        params: { timeline: wanted.timeline },
        query: { limit: nicksLimit, prefix: wanted.prefix },
      })
      .pipe(
        Effect.flatMap((page) =>
          client.networks.known({ params: { network: page.network } }).pipe(
            Effect.map((known): NickMenusEvent => ({
              _tag: "MembersRead",
              casemapping: known.casemapping,
              members: page.members.map((member) => ({
                nick: member.nick,
                prefixes: member.prefixes,
              })),
              more: page.more,
              request: wanted.request,
            }))
          )
        ),
        Effect.catch((error) =>
          Effect.sync((): NickMenusEvent => {
            if (error._tag === "Unauthorized") {
              signedOut(registry);
            }

            return { _tag: "MembersFailed", request: wanted.request };
          })
        )
      );

    happened(registry, event);
  });

/**
 * While the browser is signed in, reads whether the User of the menu open on a nick is in
 * its Channel, once for each menu, and lets go of a read whose menu closed. Mounted once
 * for the page.
 */
export const nickMenuSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      if (!get(signedIn)) {
        return;
      }

      const fibers = yield* FiberMap.make<"Presence">();
      let started = 0;

      yield* get.stream(asking).pipe(
        Stream.runForEach((wanted) =>
          Effect.gen(function* () {
            if (wanted === undefined) {
              yield* FiberMap.remove(fibers, "Presence");

              return;
            }

            if (wanted.request > started) {
              started = wanted.request;
              yield* FiberMap.run(fibers, "Presence", askPresence(registry, wanted));
            }
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);
