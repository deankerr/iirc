import { initialTransition, transition } from "xstate";
import type { SnapshotFrom } from "xstate";

import { commandsOf, isLoginOpen, network } from "./machine.ts";
import type { Context, LoginAnswer } from "./machine.ts";
import type { Tuning } from "./tuning.ts";

/**
 * What stays the same for the whole of one Connection. Each `ATTEMPT` brings its own, as
 * its Entry recorded it, so a replay of an old Connection makes the decisions it made
 * then, whatever the settings say now. What the machine starts with only stands until
 * the first `ATTEMPT`, and nothing reads it before then.
 */
export interface NetworkInput {
  /**
   * How many Lines the login sequence holds: `IDENTIFY`, if a service password is
   * configured, and then each connect command (CONN-6). The login wait starts once the
   * last of them is written or Dropped.
   */
  readonly loginLines: number;
  readonly realname: string;
  /** The nicks whose `NOTICE` can be a sign of login (CONN-6). */
  readonly services: readonly string[];
  readonly tuning: Tuning;
  readonly username: string;
}

/** Everything that can move a Network's machine. `at` is epoch milliseconds. */
export type NetworkEvent =
  /**
   * A new Connection, with the nicks it will try and the input it runs with, as recorded
   * so that replay makes the same choices.
   */
  | (NetworkInput & {
      readonly type: "ATTEMPT";
      readonly at: number;
      readonly nicks: readonly string[];
    })
  | { readonly type: "OPENED"; readonly at: number }
  /** An inbound Line that parsed. A `PING` arrives as `PING`, never as this. */
  | {
      readonly type: "LINE";
      readonly at: number;
      readonly command: string;
      readonly params: readonly string[];
      readonly source?: string;
    }
  /**
   * A Line of the login sequence left, or was Dropped, so it never will (CONN-6).
   * `identify` says it is the `IDENTIFY`, which is what a login wait waits on.
   */
  | {
      readonly type: "LOGIN_SENT";
      readonly at: number;
      readonly identify: boolean;
      readonly written: boolean;
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
  | { readonly type: "burstComplete" }
  /** The login sequence is out and any login wait is over, so joining can go on (CONN-6). */
  | { readonly type: "loginSettled" };

/**
 * The coarse state of a Network, as the machine's host sees it. `closing` is any close
 * under way, whoever started it. A `closing` Entry is what says the Daemon chose it.
 */
export type Phase = "idle" | "connecting" | "registering" | "session" | "closing" | "closed";

/** A Network's machine at one point in its fold. */
export type NetworkSnapshot = SnapshotFrom<typeof network>;

/**
 * How far a Connection got towards a Session. `Welcomed` stays once the Session begins to
 * close, because when it began is still what its length is measured from. `Abandoned` is
 * a Connection the machine gave up on before any welcome, which no `001` can turn into a
 * Session now.
 */
export type Registration =
  /** No Connection is under way. */
  | { readonly _tag: "None" }
  | { readonly _tag: "Connecting" }
  | {
      readonly _tag: "Registering";
      /** The nick being offered (CONN-4). */
      readonly nick: string;
    }
  | {
      readonly _tag: "Welcomed";
      /** When the `001` arrived, which is when the Session began. */
      readonly at: number;
      /** The nick registration ended on. Self is whatever the `001` names. */
      readonly nick: string;
    }
  | { readonly _tag: "Abandoned" };

/**
 * Where a login to services stands (CONN-6). `waiting` starts with an `IDENTIFY` written,
 * and the rest are how the wait ended, with the service's own words where it gave any.
 */
export interface Login {
  readonly state: "none" | "waiting" | "succeeded" | "failed" | "timedOut";
  readonly text?: string;
}

/** What a host may know of a Connection from its machine, which never shows its context. */
export interface ConnectionView {
  /**
   * Whether `JOIN`s may go out: a Session the machine has not begun to leave, with the
   * login sequence out and no login wait running (CONN-6, LIVE-11).
   */
  readonly joinable: boolean;
  readonly login: Login;
  readonly registration: Registration;
}

/**
 * Starts a Network's machine.
 * @param input - What it holds until the first `ATTEMPT` brings the input of its own.
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
 * already in the events. Each `ATTEMPT` brings the input its Connection ran with.
 * @param events - Everything that happened, in order.
 * @param input - What the machine holds until the first `ATTEMPT`.
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

const loginOf = (answer: LoginAnswer): Login => {
  switch (answer._tag) {
    case "Unasked": {
      return { state: "none" };
    }

    case "Waiting": {
      return { state: "waiting" };
    }

    case "TimedOut": {
      return { state: "timedOut" };
    }

    case "Answered": {
      const { _tag, text } = answer.sign;

      return { state: _tag === "LoggedIn" ? "succeeded" : "failed", text };
    }

    default: {
      return answer satisfies never;
    }
  }
};

const registrationOf = (snapshot: NetworkSnapshot, context: Context): Registration => {
  const at = phase(snapshot);
  const nick = context.nicks[context.nickIndex] ?? "";

  if (context.welcomedAt !== undefined && (at === "session" || at === "closing")) {
    return { _tag: "Welcomed", at: context.welcomedAt, nick };
  }

  switch (at) {
    case "idle":
    case "closed": {
      return { _tag: "None" };
    }

    case "connecting": {
      return { _tag: "Connecting" };
    }

    case "registering": {
      return { _tag: "Registering", nick };
    }

    // A Session always has its welcome, so only a close is left.
    case "session":
    case "closing": {
      return { _tag: "Abandoned" };
    }

    default: {
      return at satisfies never;
    }
  }
};

/**
 * Reads what a snapshot says of its Connection, which is all anyone outside this package
 * may know of the machine's context.
 * @param snapshot - The machine so far.
 * @returns How far registration got, how the login stands, and whether joining may go on.
 */
export const inspect = (snapshot: NetworkSnapshot): ConnectionView => {
  const { context } = snapshot;

  return {
    joinable:
      phase(snapshot) === "session" && !context.leaving && isLoginOpen(context, context.login),
    login: loginOf(context.login.answer),
    registration: registrationOf(snapshot, context),
  };
};

/**
 * Reads why the last Connection closed.
 * @param snapshot - The machine so far.
 * @returns The reason, or `undefined` unless the Network is closed.
 */
export const closeReason = (snapshot: NetworkSnapshot): string | undefined =>
  snapshot.context.closeReason;
