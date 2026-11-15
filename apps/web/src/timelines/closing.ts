/**
 * Closing a Timeline, as atoms: what carries out a close, and the offer to leave a Channel
 * Self is in, which the core folds. The Daemon never closes a Channel Self is in, so before
 * a close is sent, what the Client knows of the Network is read, and a Channel joined is
 * offered to be left instead, with nothing sent until the Owner chooses. Whether a Timeline
 * is closed comes back on the changes stream, and the sidebar derives it from there.
 *
 * @packageDocumentation
 */
import { initialLeaving, isJoined, leaveOf, reduceLeaving } from "@iirc/frontend/closing";
import type { LeavingEvent } from "@iirc/frontend/closing";
import type { CloseTimeline } from "@iirc/frontend/commands";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { configure, signedOut } from "../options/atoms.ts";
import type { Outcome } from "../options/atoms.ts";

/** The offer to leave a Channel, as the core folds it. */
export const leavingState = Atom.make(initialLeaving).pipe(Atom.keepAlive);

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
 * Closes a Timeline: reads what the Client knows of its Network, and offers to leave a
 * Channel Self is in, sending nothing, or asks the Daemon to close any other.
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
    const params = { network: close.network };

    const known = yield* client.networks.known({ params }).pipe(
      Effect.map((knowledge) => ({ _tag: "Known", knowledge }) as const),
      Effect.catch((error) => Effect.succeed({ _tag: "Failed", error: error._tag } as const))
    );

    if (known._tag === "Failed") {
      return known.error === "Unauthorized" || known.error === "UnknownNetwork"
        ? refusedWith(close, known.error)
        : ({
            _tag: "NotDone",
            message: `The Daemon did not say whether you are in ${close.target}, so nothing was closed. Try again.`,
          } satisfies Outcome);
    }

    if (isJoined(known.knowledge, close.target)) {
      happened(registry, { _tag: "Offered", channel: close.target, network: close.network });

      return { _tag: "Done" } satisfies Outcome;
    }

    return yield* client.networks.close({ params, payload: { target: close.target } }).pipe(
      Effect.as<Outcome>({ _tag: "Done" }),
      Effect.catch((error) => Effect.succeed(refusedWith(close, error._tag)))
    );
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
