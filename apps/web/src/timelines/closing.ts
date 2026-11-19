/**
 * Closing a Timeline, as atoms: what carries out a close, and the offer to leave a Channel
 * Self is in, which the core folds. The Daemon never closes a Channel Self is in, and says
 * so in its answer, decided as the close was stepped, so the page asks nothing first: a
 * close refused as `Joined` offers to leave the Channel instead, with nothing sent until the
 * Owner chooses. A close shows at once: the sidebar leaves its Timeline out from when it is
 * asked, and until the changes stream says it is closed, or shows it again if it was not.
 *
 * @packageDocumentation
 */
import {
  closedBy,
  initialLeaving,
  leaveOf,
  reduceClosing,
  reduceLeaving,
} from "@iirc/frontend/closing";
import type { ClosingEvent, Leave, Leaving, LeavingEvent } from "@iirc/frontend/closing";
import type { CloseTimeline } from "@iirc/frontend/commands";
import { Effect, Exit } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { decodeIntent, IntentNames } from "../app/intent-names.ts";
import { runtime } from "../app/runtime.ts";
import { configureInTurn, inTurn, readChannels, signedOut } from "../options/atoms.ts";
import type { Outcome } from "../options/atoms.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { closingState, timelinesState } from "./atoms.ts";

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
 * Folds one event into the closes on their way.
 * @param registry - The registry.
 * @param event - What happened.
 */
const closingHappened = (registry: AtomRegistry.AtomRegistry, event: ClosingEvent) => {
  registry.set(closingState, reduceClosing(registry.get(closingState), event));
};

/**
 * Carries out a close that shows at once, when it names a Timeline held: it is folded in as
 * asked, and let go of once answered, however that ends, but for a close the Daemon did,
 * which holds until the stream says so, so the Timeline never shows again meanwhile.
 * @param registry - The registry.
 * @param close - The close.
 * @param work - What carries it out.
 * @param closedAt - The step the Daemon closed the Timeline in, from what the work came to,
 * or none when it did not.
 * @returns What the work came to.
 */
const onItsWay = <A, E, R>(
  registry: AtomRegistry.AtomRegistry,
  close: CloseTimeline,
  work: Effect.Effect<A, E, R>,
  closedAt: (done: A) => number | undefined
) => {
  const timeline = closedBy(registry.get(timelinesState).networks, close);

  return timeline === undefined
    ? work
    : Effect.acquireUseRelease(
        Effect.sync(() => {
          const { next } = registry.get(closingState);

          closingHappened(registry, { _tag: "Asked", network: close.network, timeline });

          return next;
        }),
        () => work,
        (ask, exit) =>
          Effect.sync(() => {
            closingHappened(registry, {
              _tag: "Answered",
              ask,
              closedAt: Exit.isSuccess(exit) ? closedAt(exit.value) : undefined,
            });
          })
      );
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
 * Asks the Daemon to close a Timeline, which shows at once, and offers to leave a Channel it
 * refused to close because Self is in it. An answer that lands once the page signed out, or
 * signed in again, offers nothing, since its offer would outlive the sign-in it was asked in.
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
        onItsWay(
          registry,
          close,
          client.networks
            .close({ params: { network: close.network }, payload: { target: close.target } })
            .pipe(
              Effect.map((closed) => ({ _tag: "Answered", closed }) as const),
              Effect.catch((error) =>
                Effect.succeed({ _tag: "Failed", error: error._tag } as const)
              )
            ),
          (done) =>
            done._tag === "Answered" && done.closed._tag === "Closed"
              ? done.closed.sequence
              : undefined
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
      happened(registry, {
        _tag: "Offered",
        channel: closed.reason.channel,
        network: close.network,
      });
    }

    return { _tag: "Done" } satisfies Outcome;
  });

/** The Owner let the offer go. */
export const dismissLeaving = Atom.fnSync((_: undefined, get) => {
  happened(get.registry, { _tag: "Dismissed" });
}).pipe(Atom.keepAlive);

/**
 * Why leaving was not done, in words, from its error's tag, never its text.
 * @param leave - What leaves the Channel.
 * @param tag - The error's tag.
 * @returns What it came to.
 */
const unleftWith = (leave: Extract<Leave, { readonly _tag: "Act" }>, tag: string): Outcome => {
  if (tag === "Unauthorized") {
    return { _tag: "SignedOut" };
  }

  const channel = leave.action._tag === "Part" ? leave.action.channel : "the Channel";

  return {
    _tag: "NotDone",
    message:
      tag === "UnknownNetwork"
        ? `The Daemon has no Network ${leave.network}, so ${channel} was not left.`
        : `The Daemon did not answer, so whether ${channel} was left is unknown. Check before leaving it again.`,
  };
};

/**
 * Parts a Channel with the `Part` action, under an intent the runtime names, and reads what
 * the Client did with it in that step.
 * @param leave - The action.
 * @returns What it came to, in words when it was not done.
 */
const parted = (leave: Extract<Leave, { readonly _tag: "Act" }>) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const name = yield* IntentNames;

    const answer = yield* client.networks.act({
      params: { network: leave.network },
      payload: { action: leave.action, intent: decodeIntent(name()) },
    });

    if (answer._tag === "Acted") {
      return { _tag: "Done" } satisfies Outcome;
    }

    return {
      _tag: "NotDone",
      message:
        answer.reason._tag === "Offline"
          ? `${leave.network} is not connected, so nothing was sent. Leave it once it is.`
          : "The Channel's name could not be sent as it is, so it was not left.",
    } satisfies Outcome;
  }).pipe(Effect.catch((error) => Effect.succeed(unleftWith(leave, error._tag))));

/**
 * Leaves the Channel offered: as `/part` with its name does, by editing the Network's
 * Configuration, when it wants the Channel, or it would be joined again, and otherwise by
 * parting it and leaving the Configuration alone, since an edit refuses a Channel that is
 * not among those wanted. It reads in the Network's turn, so a change of its Channels on
 * its way is answered first.
 * @param registry - The registry.
 * @param offered - The offer.
 * @returns What it came to, in words when it was not done.
 */
const leaveOffered = (
  registry: AtomRegistry.AtomRegistry,
  offered: Extract<Leaving, { readonly _tag: "Offered" }>
) =>
  inTurn(
    registry,
    offered.network,
    Effect.gen(function* () {
      const read = yield* readChannels(registry, offered.network);

      if (read._tag !== "Read") {
        return read;
      }

      const leave = leaveOf(offered, read.configuration, read.naming);

      if (leave === undefined) {
        return { _tag: "Done" } satisfies Outcome;
      }

      return leave._tag === "Configure"
        ? yield* configureInTurn(registry, leave.network, leave.edit)
        : yield* parted(leave);
    })
  );

/**
 * Leaves the Channel offered, once, and takes what came of it. Leaving does not close it:
 * the part is Activity in its Timeline, which would show it again, so the Owner closes it
 * once Self has left.
 */
export const confirmLeaving = runtime
  .fn((_: undefined, get) =>
    Effect.gen(function* () {
      const { registry } = get;
      const offered = registry.get(leavingState);

      if (offered._tag !== "Offered" || offered.sending) {
        return;
      }

      happened(registry, { _tag: "Sent" });

      const outcome = yield* leaveOffered(registry, offered);

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
