import { initialTransition, transition } from "xstate";
import type { SnapshotFrom } from "xstate";

import { commandsOf, network } from "./machine.ts";

/** Who to be on a Network, and where to go once registered. */
export interface NetworkInput {
  readonly channels: readonly string[];
  readonly nick: string;
  readonly realname: string;
  readonly username: string;
}

/** Everything that can move a Network's machine. `at` is epoch milliseconds. */
export type NetworkEvent =
  | { readonly type: "ATTEMPT"; readonly at: number }
  | { readonly type: "OPENED"; readonly at: number }
  | {
      readonly type: "LINE";
      readonly at: number;
      readonly command: string;
      readonly params: readonly string[];
    }
  | { readonly type: "CLOSED"; readonly at: number; readonly reason: string }
  | { readonly type: "DEADLINE"; readonly at: number; readonly name: string };

/** What the machine asks its host to do. */
export type Command =
  | {
      readonly type: "sendLine";
      readonly command: string;
      readonly params: readonly string[];
      readonly cause: string;
    }
  | { readonly type: "closeConnection"; readonly reason: string };

/** The coarse state of a Network, as the machine's host sees it. */
export type Phase = "idle" | "connecting" | "registering" | "session" | "closed";

/** A Network's machine at one point in its fold. */
export type NetworkSnapshot = SnapshotFrom<typeof network>;

/**
 * Starts a Network's machine.
 * @param input - Who to be on the Network.
 * @returns The first snapshot.
 */
export const start: (input: NetworkInput) => NetworkSnapshot = (input) => {
  const [snapshot] = initialTransition(network, input);

  return snapshot;
};

/**
 * Advances the machine by one event.
 * @param snapshot - The machine so far.
 * @param event - What happened.
 * @returns The next snapshot, and the Commands for the host to run after commit.
 */
export const step: (
  snapshot: NetworkSnapshot,
  event: NetworkEvent
) => { readonly commands: readonly Command[]; readonly next: NetworkSnapshot } = (
  snapshot,
  event
) => {
  const [next, effects] = transition(network, snapshot, event);

  return { commands: effects.flatMap(commandsOf), next };
};

/**
 * Replays events into a snapshot, discarding Commands because their outcomes are
 * already in the events.
 * @param events - Everything that happened, in order.
 * @param input - Who to be on the Network.
 * @returns The snapshot after the last event.
 */
export const fold: (events: Iterable<NetworkEvent>, input: NetworkInput) => NetworkSnapshot = (
  events,
  input
) => {
  let snapshot = start(input);

  for (const event of events) {
    snapshot = step(snapshot, event).next;
  }

  return snapshot;
};

/**
 * The soonest deadline the host must wake for, if any.
 * @param snapshot - The machine so far.
 * @returns The deadline, or `undefined` when nothing is pending.
 */
export const deadline: (
  snapshot: NetworkSnapshot
) => { readonly at: number; readonly name: string } | undefined = ({ context }) =>
  context.deadlines.toSorted((one, other) => one.at - other.at)[0];

/**
 * Reads a snapshot's Phase.
 * @param snapshot - The machine so far.
 * @returns The Phase.
 */
export const phase: (snapshot: NetworkSnapshot) => Phase = ({ value }) =>
  value === "idle" || value === "closed" ? value : value.connection;

/**
 * Reads why the last Connection closed.
 * @param snapshot - The machine so far.
 * @returns The reason, or `undefined` unless the Network is closed.
 */
export const closeReason = (snapshot: NetworkSnapshot): string | undefined =>
  snapshot.context.closeReason;
