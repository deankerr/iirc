/**
 * Removing a Network, as atoms: the question the core folds, and what sends the removal
 * once the Owner confirms it. Nothing is sent until then. The Daemon's answer goes to the
 * Timelines at once, ahead of the step the changes stream gives for it, and the options
 * shown are read again, so the Network leaves them.
 *
 * @packageDocumentation
 */
import { Sequence } from "@iirc/api";
import type { NetworkId } from "@iirc/api";
import { initialRemoval, reduceRemoval, removalOf } from "@iirc/frontend/removal";
import type { RemovalAnswer, RemovalEvent } from "@iirc/frontend/removal";
import { reduceTimelines, standingOf } from "@iirc/frontend/timelines";
import { Effect, Schema } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { timelinesState } from "../timelines/atoms.ts";
import { optionsFilter, refresh, signedOut } from "./atoms.ts";

/** The question, as the core folds it. */
export const removalState = Atom.make(initialRemoval).pipe(Atom.keepAlive);

/** How the Network asked about stands: configured, removed with its Timelines kept, or unknown. */
export const removalStanding = Atom.make((get) => {
  const removal = get(removalState);

  return removal._tag === "Closed" ? undefined : standingOf(get(timelinesState), removal.network);
});

/**
 * Folds one event into the question.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: RemovalEvent) => {
  registry.set(removalState, reduceRemoval(registry.get(removalState), event));
};

/**
 * Asks the Owner to confirm removing a Network, in the life of it shown now, `keep` chosen
 * to start with when given.
 * @param registry - The registry.
 * @param network - The Network.
 * @param keep - Whether its Timelines are to be kept, if the Owner said.
 */
export const askRemoval = (
  registry: AtomRegistry.AtomRegistry,
  network: NetworkId,
  keep: boolean | undefined
) => {
  const life = registry.get(timelinesState).networks.get(network)?.life;

  happened(registry, { _tag: "Asked", keep, life, network });
};

const toSequence = Schema.decodeSync(Sequence);

/** Asks to remove a Network, from a button that names it. */
export const askToRemove = Atom.fnSync((network: NetworkId, get) => {
  askRemoval(get.registry, network, undefined);
}).pipe(Atom.keepAlive);

/** The Owner chose whether the Timelines stay readable. */
export const chooseKeep = Atom.fnSync((keep: boolean, get) => {
  happened(get.registry, { _tag: "Chose", keep });
}).pipe(Atom.keepAlive);

/** The Owner let the question go, or read what they were told. */
export const closeRemoval = Atom.fnSync((_: undefined, get) => {
  happened(get.registry, { _tag: "Closed" });
}).pipe(Atom.keepAlive);

/**
 * Sends the removal the Owner confirmed, once, and takes the Daemon's answer. Removed, the
 * Timelines take it at once, for the life it ended, and the options shown are read again.
 */
export const confirmRemoval = runtime
  .fn((_: undefined, get) =>
    Effect.gen(function* () {
      const { registry } = get;
      const state = registry.get(removalState);

      const removal =
        state._tag === "Asking"
          ? removalOf(state, standingOf(registry.get(timelinesState), state.network))
          : undefined;

      if (removal === undefined) {
        return;
      }

      const { keep, life: asked, network } = removal;
      const client = yield* DaemonClient;

      happened(registry, { _tag: "Sent" });

      // A Network not held when asked has no life to name, so the Daemon is not asked.
      const sent =
        asked === undefined
          ? ({ _tag: "Failed", error: "UnknownNetwork" } as const)
          : yield* client.networks
              .remove({ params: { network }, query: { keep, life: toSequence(asked) } })
              .pipe(
                Effect.map(({ life }) => ({ _tag: "Removed", life }) as const),
                Effect.catch((error) =>
                  Effect.succeed({ _tag: "Failed", error: error._tag } as const)
                )
              );

      const answer: RemovalAnswer = sent._tag === "Removed" ? { _tag: "Removed" } : sent;

      if (answer._tag === "Failed" && answer.error === "Unauthorized") {
        happened(registry, { _tag: "Answered", answer, network });
        happened(registry, { _tag: "Closed" });
        signedOut(registry);

        return;
      }

      happened(registry, { _tag: "Answered", answer, network });

      // The Timelines take the removal of the life it ended, which changes nothing once
      // another life is held. A removal whose Credentials were not all forgotten names no
      // life, so the stream alone brings it.
      if (sent._tag === "Removed") {
        registry.set(
          timelinesState,
          reduceTimelines(registry.get(timelinesState), {
            _tag: "NetworkRemoved",
            keep,
            life: sent.life,
            network,
          })
        );
      }

      // Whether a removal whose Journal failed stands is unknown, and one made from an older
      // life met another: the Network list is read again to say where it stands.
      if (
        sent._tag === "Failed" &&
        (sent.error === "JournalFailed" || sent.error === "LifeChanged")
      ) {
        registry.set(
          timelinesState,
          reduceTimelines(registry.get(timelinesState), {
            _tag: "NetworkVanished",
            network,
            of: "List",
          })
        );
      }

      if (
        (sent._tag === "Removed" ||
          sent.error === "VaultFailed" ||
          sent.error === "JournalFailed" ||
          sent.error === "LifeChanged") &&
        registry.get(optionsFilter) !== undefined
      ) {
        yield* refresh(registry);
      }
    })
  )
  .pipe(Atom.keepAlive);
