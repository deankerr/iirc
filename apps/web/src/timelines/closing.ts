/**
 * Closing a Timeline, as atoms: what carries out a close, and the offer to leave a Channel
 * Self is in, which the core folds. The Daemon never closes a Channel Self is in, and says
 * so in its answer, decided as the close was stepped, so the page asks nothing first: a
 * close refused as `Joined` offers to leave the Channel instead, with nothing sent until the
 * Owner chooses. Whether a Timeline is closed comes back on the changes stream, and the
 * sidebar derives it from there.
 *
 * @packageDocumentation
 */
import { initialLeaving, leaveOf, reduceLeaving } from "@iirc/frontend/closing";
import type { Leaving, LeavingEvent } from "@iirc/frontend/closing";
import type { CloseTimeline } from "@iirc/frontend/commands";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { configure, signedOut } from "../options/atoms.ts";
import type { Outcome } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";

/**
 * The offer to leave a Channel, as the core folds it, which begins again as nothing offered
 * whenever the page signs in or out, so an offer never outlives the sign-in it was made in.
 */
export const leavingState = Atom.writable(
  (get) => {
    get(signedIn);

    return initialLeaving;
  },
  (ctx, value: Leaving) => {
    ctx.setSelf(value);
  }
).pipe(Atom.keepAlive);

/**
 * Folds one event into the offer.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: LeavingEvent) => {
  registry.set(leavingState, reduceLeaving(registry.get(leavingState), event));
};

/**
 * Why a close was not done, in words, from its error's tag, never its text. Closing can be
 * asked again freely.
 * @param close - The close.
 * @param tag - The error's tag.
 * @returns What it came to.
 */
const refusedWith = (close: CloseTimeline, tag: string): Outcome => {
  if (tag === "Unauthorized") {
    return { _tag: "SignedOut" };
  }

  const reasons: ReadonlyMap<string, string> = new Map([
    ["UnknownNetwork", `The Daemon has no Network ${close.network}, so nothing was closed.`],
    [
      "NetworkStopped",
      `${close.network} has stopped, so whether ${close.target} was closed is unknown. Closing it again is safe.`,
    ],
  ]);

  return {
    _tag: "NotDone",
    message: reasons.get(tag) ?? `The Daemon did not close ${close.target}. Try again.`,
  };
};

/**
 * Asks the Daemon to close a Timeline, and offers to leave a Channel it refused to close
 * because Self is in it. An answer that lands once the page signed out, or signed in again,
 * offers nothing, since its offer would outlive the sign-in it was asked in.
 * @param registry - The registry.
 * @param close - The close.
 * @returns What it came to, in words when it was not done.
 */
export const closeTimeline = (
  registry: AtomRegistry.AtomRegistry,
  close: CloseTimeline
): Effect.Effect<Outcome, never, DaemonClient> =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    let stayed = registry.get(signedIn);

    const answer = yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        registry.subscribe(signedIn, (now) => {
          stayed &&= now;
        })
      ),
      () =>
        client.networks
          .close({ params: { network: close.network }, payload: { target: close.target } })
          .pipe(
            Effect.map((closed) => ({ _tag: "Answered", closed }) as const),
            Effect.catch((error) => Effect.succeed({ _tag: "Failed", error: error._tag } as const))
          ),
      (unsubscribe) => Effect.sync(unsubscribe)
    );

    if (answer._tag === "Failed") {
      return refusedWith(close, answer.error);
    }

    const { closed } = answer;

    if (closed._tag === "Closed") {
      return { _tag: "Done" } satisfies Outcome;
    }

    if (closed.reason._tag === "NoTimeline") {
      return {
        _tag: "NotDone",
        message: `${close.target} names no one Timeline, so nothing was closed.`,
      } satisfies Outcome;
    }

    if (stayed) {
      happened(registry, { _tag: "Offered", channel: close.target, network: close.network });
    }

    return { _tag: "Done" } satisfies Outcome;
  });

/** The Owner let the offer go. */
export const dismissLeaving = Atom.fnSync((_: undefined, get) => {
  happened(get.registry, { _tag: "Dismissed" });
}).pipe(Atom.keepAlive);

/**
 * Leaves the Channel offered, once, as `/part` with its name does, and takes what came of
 * it. Leaving does not close it: the part is Activity in its Timeline, which would show it
 * again, so the Owner closes it once Self has left.
 */
export const confirmLeaving = runtime
  .fn((_: undefined, get) =>
    Effect.gen(function* () {
      const { registry } = get;
      const leave = leaveOf(registry.get(leavingState));

      if (leave === undefined) {
        return;
      }

      happened(registry, { _tag: "Sent" });

      const outcome = yield* configure(registry, leave.network, leave.edit);

      happened(registry, {
        _tag: "Answered",
        failure: outcome._tag === "NotDone" ? outcome.message : undefined,
      });

      if (outcome._tag === "SignedOut") {
        signedOut(registry);
      }
    })
  )
  .pipe(Atom.keepAlive);
