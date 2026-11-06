import { step } from "@iirc/lifecycle";
import type { Command, NetworkEvent, NetworkSnapshot } from "@iirc/lifecycle";
import type { FallbackEncoding } from "@iirc/protocol/decode";
import { parseFrame, pingToken } from "@iirc/protocol/line";

import { loginCauses } from "./credentials.ts";
import { describeDefect } from "./diagnostic.ts";
import type { Entry } from "./entry.ts";

type ConnectionEntry = Extract<Entry, { readonly _tag: "Connection" }>;

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

type DroppedEntry = Extract<Entry, { readonly _tag: "Dropped" }>;

// A Line of the login sequence counts whether it left or not, so that one never sent
// cannot hold joining up for good (CONN-6).
const loginSent = (
  { at, cause }: LineEntry | DroppedEntry,
  written: boolean
): NetworkEvent | undefined =>
  cause !== undefined && loginCauses.has(cause)
    ? { at, identify: cause === "identify", type: "LOGIN_SENT", written }
    : undefined;

const connectionEvent = (entry: ConnectionEntry): NetworkEvent | undefined => {
  const { at } = entry;

  switch (entry.phase) {
    // Everything the machine runs with comes from the Entry, and never from today's
    // settings, so a replay of an old Connection makes the decisions it made then.
    case "attempt": {
      const { loginLines, nicks, realname, services, tuning, username } = entry;

      return { at, loginLines, nicks, realname, services, tuning, type: "ATTEMPT", username };
    }

    case "opened": {
      return { at, type: "OPENED" };
    }

    // Only a chosen leave sends `QUIT`. Any other close was decided by the machine already,
    // or by its host, and a machine still registering must be free to read the refusal
    // that often follows it, though no welcome may start a Session then (LOG-2).
    case "closing": {
      return entry.chosen ? { at, reason: entry.reason, type: "CLOSING" } : { at, type: "LEAVING" };
    }

    case "closed": {
      return { at, reason: entry.reason ?? "the Connection closed", type: "CLOSED" };
    }

    default: {
      return entry satisfies never;
    }
  }
};

// Our own Lines say nothing to the machine, or an outbound `PING` would answer itself, but
// for the login sequence, whose last Line starts the login wait. Anything inbound proves
// the Connection is alive, but a cut Line is a fragment whose first word is not a command
// worth obeying, so it says that and nothing more.
const lineEvent = (
  entry: LineEntry,
  fallback: FallbackEncoding | undefined
): NetworkEvent | undefined => {
  const { at, bytes, cut, direction } = entry;

  if (direction === "outbound") {
    return loginSent(entry, true);
  }

  const parsed = parseFrame(bytes, fallback);

  if (cut === true || parsed._tag === "Unparseable") {
    return { at, type: "HEARD" };
  }

  const { command, params, source } = parsed.line;

  if (command === "PING") {
    return { at, token: pingToken(bytes), type: "PING" };
  }

  return source === undefined
    ? { at, command, params, type: "LINE" }
    : { at, command, params, source, type: "LINE" };
};

/**
 * The machine event an Entry stands for, if any. The only Entry-to-event mapping,
 * which is what makes a live Network and a replayed one the same fold. Never throws.
 * @param entry - The Entry, as the Log holds it.
 * @param fallback - Its Connection's fallback encoding, from its `attempt` (MSG-4).
 * @returns The event, or `undefined` for an Entry the machine has no use for.
 */
export const toEvent = (entry: Entry, fallback?: FallbackEncoding): NetworkEvent | undefined => {
  switch (entry._tag) {
    case "Connection": {
      return connectionEvent(entry);
    }

    case "Deadline": {
      return { at: entry.at, name: entry.name, type: "DEADLINE" };
    }

    case "Line": {
      return lineEvent(entry, fallback);
    }

    case "Dropped": {
      return loginSent(entry, false);
    }

    // A Change is the Owner's, and only reaches a machine through what its host does.
    case "Change":
    case "Daemon": {
      return undefined;
    }

    default: {
      return entry satisfies never;
    }
  }
};

/** What one Entry did to a machine. Either way, `next` is where the machine is now. */
export type EntryStep =
  | {
      readonly _tag: "Stepped";
      readonly commands: readonly Command[];
      /** The event it stood for, or nothing for an Entry the machine has no use for. */
      readonly event: NetworkEvent | undefined;
      readonly next: NetworkSnapshot;
    }
  /** The transition threw, which leaves the machine where it was (HOST-1). */
  | { readonly _tag: "Threw"; readonly defect: string; readonly next: NetworkSnapshot };

/**
 * Steps a machine by one recorded Entry. Standing folds each Connection's machine this way
 * from the Log, and a host steps the machine Standing holds this way as it records, for
 * the Commands. Never throws.
 * @param snapshot - The machine so far.
 * @param entry - The Entry, as the Log holds it.
 * @param fallback - Its Connection's fallback encoding, from its `attempt` (MSG-4).
 * @returns The machine after it, with the Commands it asked for.
 */
export const stepEntry = (
  snapshot: NetworkSnapshot,
  entry: Entry,
  fallback?: FallbackEncoding
): EntryStep => {
  try {
    const event = toEvent(entry, fallback);

    return event === undefined
      ? { _tag: "Stepped", commands: [], event, next: snapshot }
      : { _tag: "Stepped", ...step(snapshot, event), event };
  } catch (error) {
    return { _tag: "Threw", defect: describeDefect(error), next: snapshot };
  }
};
