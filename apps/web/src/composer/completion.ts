/**
 * Tab completion, as atoms: the state the core folds, the commands the composer runs for
 * Tab, Escape, and typing, and `completer`, which asks the Daemon's members route for the
 * nicks the core is waiting on. What completion puts in the composer becomes the draft,
 * which stays the one copy of what is typed.
 *
 * @packageDocumentation
 */
import type { NetworkId } from "@iirc/api";
import {
  chantypesWanted,
  nicksLimit,
  nicksWanted,
  reduceCompletion,
  sourcesOf,
} from "@iirc/frontend/completion";
import type { Completed, CompletionEvent } from "@iirc/frontend/completion";
import type { Place } from "@iirc/frontend/composer";
import { draftOf, reduceComposers } from "@iirc/frontend/composer";
import { listed } from "@iirc/frontend/options";
import { Clock, Duration, Effect, FiberMap, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { optionsState, signedOut } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { sidebarNetworks, timelinesState, Waits } from "../timelines/atoms.ts";
import { composerState, edit, placeOf } from "./atoms.ts";
import { chantypesState } from "./chantypes-state.ts";
import { completionState } from "./completion-state.ts";

/**
 * Folds one event into completion, from what a word can be completed from at the place it
 * is under way, and puts what it says in the composer's draft.
 * @param registry - The registry.
 * @param place - The composer's place.
 * @param event - What happened.
 */
const completing = (registry: AtomRegistry.AtomRegistry, place: Place, event: CompletionEvent) => {
  const sources = sourcesOf(
    registry.get(timelinesState),
    place,
    listed(registry.get(optionsState), ""),
    registry.get(chantypesState)
  );

  const step: Completed = reduceCompletion(registry.get(completionState), event, sources);

  registry.set(completionState, step.state);

  if (step.edit !== undefined) {
    registry.set(
      composerState,
      reduceComposers(registry.get(composerState), {
        _tag: "Edited",
        text: step.edit.text,
        timeline: step.edit.place,
      })
    );
  }
};

/** A Network whose `CHANTYPES` completion needs read, for the Session begun at `since`. */
interface Wanted {
  readonly network: NetworkId;
  readonly since: number;
}

/**
 * The last Network completion asked to have its `CHANTYPES` read, each ask a new object,
 * so asking again for the same Network is seen.
 */
const chantypesAsked = Atom.make<Wanted | undefined>(undefined).pipe(Atom.keepAlive);

/** Tab, or Shift+Tab, in a composer, with its text and caret. */
export const tab = Atom.fnSync(
  (
    input: {
      readonly place: Place;
      readonly text: string;
      readonly caret: number;
      readonly backwards: boolean;
    },
    get
  ) => {
    const { registry } = get;

    completing(registry, input.place, { _tag: "Tabbed", ...input });

    // A Network whose CHANTYPES is not yet known for its Session is asked again, for the
    // next Tab, since one read before the Ircd's 005 said none.
    const wanted = chantypesWanted(
      registry.get(timelinesState),
      input.place,
      registry.get(chantypesState)
    );

    if (wanted !== undefined) {
      registry.set(chantypesAsked, { ...wanted });
    }
  }
).pipe(Atom.keepAlive);

/** Escape while completing, which gives back what was typed. */
export const escapeCompletion = Atom.fnSync((place: Place, get) => {
  completing(get.registry, place, { _tag: "Escaped", place });
}).pipe(Atom.keepAlive);

/** The Owner typed: what was being completed is let go of, and the draft is what they typed. */
export const typed = Atom.fnSync(
  ({ text, timeline }: { readonly timeline: Place; readonly text: string }, get) => {
    completing(get.registry, timeline, { _tag: "LetGo" });
    get.registry.set(edit, { text, timeline });
  }
).pipe(Atom.keepAlive);

/** The members route's request the core waits on, if any. */
const asking = Atom.make((get) => nicksWanted(get(completionState)));

/**
 * Asks the members route for the nicks that start with a prefix, after a moment, and folds
 * in the answer. A refusal signs the page out, and any other failure completes nothing.
 * @param registry - The registry.
 * @param wanted - The request.
 * @returns Once folded in.
 */
const askNicks = (
  registry: AtomRegistry.AtomRegistry,
  wanted: NonNullable<ReturnType<typeof nicksWanted>>
) =>
  Effect.gen(function* () {
    const { complete } = yield* Waits;
    const client = yield* DaemonClient;
    const { phase } = registry.get(completionState);
    const place = phase._tag === "Asking" ? phase.place : "Nowhere";

    yield* Effect.sleep(complete);

    const event = yield* client.timelines
      .members({
        params: { timeline: wanted.timeline },
        query: { limit: nicksLimit, prefix: wanted.prefix },
      })
      .pipe(
        // Said with the composer as it is now, for the core to put the nick in only if it
        // still shows the draft it was asked for.
        Effect.map((page): CompletionEvent => {
          const now = placeOf(registry);

          return {
            _tag: "NicksRead",
            nicks: page.members.map((member) => member.nick),
            place: now,
            request: wanted.request,
            text: draftOf(registry.get(composerState), now).text,
          };
        }),
        Effect.catch((error) =>
          Effect.sync((): CompletionEvent => {
            if (error._tag === "Unauthorized") {
              signedOut(registry);
            }

            return { _tag: "NicksFailed", request: wanted.request };
          })
        )
      );

    completing(registry, place, event);
  });

/**
 * While the browser is signed in, asks for the nicks the core waits on: one request at a
 * time, after a moment, so a Tab that supersedes another before then asks once, and one
 * let go of, by typing or Escape, is interrupted. Mounted once for the page.
 */
export const completer = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      if (!get(signedIn)) {
        return;
      }

      const fibers = yield* FiberMap.make<"Nicks">();
      let started = 0;

      yield* get.stream(asking).pipe(
        Stream.runForEach((wanted) =>
          Effect.gen(function* () {
            if (wanted === undefined) {
              yield* FiberMap.remove(fibers, "Nicks");

              return;
            }

            if (wanted.request > started) {
              started = wanted.request;
              yield* FiberMap.run(fibers, "Nicks", askNicks(registry, wanted));
            }
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);

/** How often a Network's `CHANTYPES` was read during a Session with none said, and when next. */
interface Attempts {
  readonly since: number;
  readonly tries: number;
  readonly nextAt: number;
}

/**
 * Reads a Network's `CHANTYPES` from `known`, and keeps it for the Session it was read
 * during when the Session said it. None said, as before the Ircd's `005`, or a read that
 * fails, keeps nothing: it is provisional, and read again when completion next needs it.
 * @param registry - The registry.
 * @param wanted - The Network, and its Session.
 * @returns Whether it was kept.
 */
const readChantypes = (registry: AtomRegistry.AtomRegistry, wanted: Wanted) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const known = yield* client.networks.known({ params: { network: wanted.network } });
    const { chantypes } = known;

    if (chantypes === null) {
      return false;
    }

    registry.set(
      chantypesState,
      new Map(registry.get(chantypesState)).set(wanted.network, {
        chantypes,
        since: wanted.since,
      })
    );

    return true;
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * While the browser is signed in, reads each connected Network's `CHANTYPES`, for
 * completion to tell a Channel's name from a nick: once as each Session is seen, and while
 * it said none, again as completion needs it, at most one read a Network at a time, and no
 * sooner than the runtime's backoff allows, soon at first and then up to every 15 s. A
 * reset forgets them all. Mounted once for the page.
 */
export const chantypesSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;
      const { longest, retry } = yield* Waits;

      registry.set(chantypesState, new Map());

      if (!get(signedIn)) {
        return;
      }

      const fibers = yield* FiberMap.make<NetworkId>();
      // The runtime's own bookkeeping of its retries, not what completion reads.
      const attempts = new Map<NetworkId, Attempts>();

      const consider = (wanted: Wanted, asked: boolean) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const tried = attempts.get(wanted.network);
          const kept = registry.get(chantypesState).get(wanted.network);
          const sameSession = tried?.since === wanted.since;

          if (
            kept?.since === wanted.since ||
            (yield* FiberMap.has(fibers, wanted.network)) ||
            (sameSession && (!asked || now < tried.nextAt))
          ) {
            return;
          }

          const tries = sameSession ? tried.tries + 1 : 1;

          const wait = Math.min(
            Duration.toMillis(retry) * 2 ** (tries - 1),
            Duration.toMillis(longest)
          );

          attempts.set(wanted.network, { nextAt: now + wait, since: wanted.since, tries });
          yield* FiberMap.run(fibers, wanted.network, readChantypes(registry, wanted));
        });

      const seen = get
        .stream(sidebarNetworks)
        .pipe(
          Stream.runForEach((networks) =>
            Effect.forEach(
              networks,
              ({ connection, network }) =>
                connection._tag === "Connected"
                  ? consider({ network, since: connection.since }, false)
                  : Effect.void,
              { discard: true }
            )
          )
        );

      const asked = get
        .stream(chantypesAsked)
        .pipe(
          Stream.runForEach((wanted) =>
            wanted === undefined ? Effect.void : consider(wanted, true)
          )
        );

      yield* Effect.all([seen, asked], { concurrency: "unbounded", discard: true });
    })
  )
  .pipe(Atom.keepAlive);
