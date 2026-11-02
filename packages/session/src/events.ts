import type { NetworkEvent } from "@iirc/lifecycle";
import { parseFrame, pingToken } from "@iirc/protocol/line";

import type { Entry } from "./entry.ts";

type ConnectionEntry = Extract<Entry, { readonly _tag: "Connection" }>;

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

const connectionEvent = (entry: ConnectionEntry): NetworkEvent | undefined => {
  const { at } = entry;

  switch (entry.phase) {
    case "attempt": {
      return { at, nicks: entry.nicks, type: "ATTEMPT" };
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
      return {
        at,
        reason: entry.reason ?? "the Connection closed",
        type: "CLOSED",
        ...(entry.refused && { refused: true }),
      };
    }

    default: {
      return entry satisfies never;
    }
  }
};

// Our own Lines say nothing to the machine, or an outbound `PING` would answer itself.
// Anything inbound proves the Connection is alive, but a cut Line is a fragment whose
// first word is not a command worth obeying, so it says that and nothing more.
const lineEvent = ({ at, bytes, cut, direction }: LineEntry): NetworkEvent | undefined => {
  if (direction === "outbound") {
    return undefined;
  }

  const parsed = parseFrame(bytes);

  if (cut === true || parsed._tag === "Unparseable") {
    return { at, type: "HEARD" };
  }

  const { command, params } = parsed.line;

  return command === "PING"
    ? { at, token: pingToken(bytes), type: "PING" }
    : { at, command, params, type: "LINE" };
};

/**
 * The machine event an Entry stands for, if any. The only Entry-to-event mapping,
 * which is what makes a live Network and a replayed one the same fold. Never throws.
 * @param entry - The Entry, as the Log holds it.
 * @returns The event, or `undefined` for an Entry the machine has no use for.
 */
export const toEvent = (entry: Entry): NetworkEvent | undefined => {
  switch (entry._tag) {
    case "Connection": {
      return connectionEvent(entry);
    }

    case "Deadline": {
      return { at: entry.at, name: entry.name, type: "DEADLINE" };
    }

    case "Line": {
      return lineEvent(entry);
    }

    case "Daemon":
    case "Dropped": {
      return undefined;
    }

    default: {
      return entry satisfies never;
    }
  }
};
