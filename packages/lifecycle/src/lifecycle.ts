import { initialTransition, transition } from "xstate";
import type { SnapshotFrom } from "xstate";

import { commandsOf, network } from "./machine.ts";
import type { Tuning } from "./tuning.ts";

/** What stays the same for every Connection to a Network. */
export interface NetworkInput {
  readonly realname: string;
  readonly tuning: Tuning;
  readonly username: string;
}

/** Everything that can move a Network's machine. `at` is epoch milliseconds. */
export type NetworkEvent =
  /** A new Connection, and the nicks it will try, as recorded so replay makes the same choices. */
  | { readonly type: "ATTEMPT"; readonly at: number; readonly nicks: readonly string[] }
  | { readonly type: "OPENED"; readonly at: number }
  /** An inbound Line that parsed. A `PING` arrives as `PING`, never as this. */
  | {
      readonly type: "LINE";
      readonly at: number;
      readonly command: string;
      readonly params: readonly string[];
    }
  /** An inbound `PING`, with its first parameter exactly as it arrived. */
  | { readonly type: "PING"; readonly at: number; readonly token: Uint8Array | undefined }
  /** An inbound Line with no command to obey: it proves the Connection is alive, and no more. */
  | { readonly type: "HEARD"; readonly at: number }
  /** The Daemon chose to leave (LIVE-9). */
  | { readonly type: "CLOSING"; readonly at: number; readonly reason: string }
  /**
   * The Daemon's host is ending the Connection for a reason the machine did not decide. No
   * welcome starts a Session after this, and a refusal that follows is still read (LOG-2).
   */
  | { readonly type: "LEAVING"; readonly at: number }
  | {
      readonly type: "CLOSED";
      readonly at: number;
      readonly reason: string;
      readonly refused?: true;
    }
  | { readonly type: "DEADLINE"; readonly at: number; readonly name: string };

/** Which queue an outbound Line waits in (SEND-1). */
export type Lane = "control" | "interactive" | "background";

/** What the machine asks its host to do. */
export type Command =
  | {
      readonly type: "sendLine";
      readonly command: string;
      readonly params: readonly string[];
      readonly cause: string;
      readonly lane: Lane;
    }
  /** A `PONG`, kept apart from `sendLine` because its token is bytes, not text (LIVE-1). */
  | {
      readonly type: "sendPong";
      readonly token: Uint8Array | undefined;
      readonly cause: string;
      readonly lane: Lane;
    }
  /** `refused` is copied to the `closed` Entry, where backoff reads it (LIVE-5). */
  | { readonly type: "closeConnection"; readonly reason: string; readonly refused?: true }
  /** The burst is over, once per Session, so what waits on it can start (CONN-7). */
  | { readonly type: "burstComplete" };

/**
 * The coarse state of a Network, as the machine's host sees it. `closing` is any close
 * under way, whoever started it. A `closing` Entry is what says the Daemon chose it.
 */
export type Phase = "idle" | "connecting" | "registering" | "session" | "closing" | "closed";

/** A Network's machine at one point in its fold. */
export type NetworkSnapshot = SnapshotFrom<typeof network>;

/**
 * Starts a Network's machine.
 * @param input - What stays the same for every Connection.
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
 * @param input - What stays the same for every Connection.
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
  value === "idle" || value === "closed" || value === "closing" ? value : value.connection;

/**
 * Reads why the last Connection closed.
 * @param snapshot - The machine so far.
 * @returns The reason, or `undefined` unless the Network is closed.
 */
export const closeReason = (snapshot: NetworkSnapshot): string | undefined =>
  snapshot.context.closeReason;
