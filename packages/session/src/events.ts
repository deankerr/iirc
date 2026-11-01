import type { NetworkEvent } from "@iirc/lifecycle";
import { parseFrame } from "@iirc/protocol/line";

import type { Entry } from "./entry.ts";

type ConnectionEntry = Extract<Entry, { readonly _tag: "Connection" }>;

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

const connectionEvent = ({ at, phase, reason }: ConnectionEntry): NetworkEvent => {
  if (phase === "attempt") {
    return { at, type: "ATTEMPT" };
  }

  return phase === "opened"
    ? { at, type: "OPENED" }
    : { at, reason: reason ?? "the Connection closed", type: "CLOSED" };
};

// Our own Lines say nothing to the machine, or an outbound `PING` would answer
// itself. A cut Line is a fragment, whose first word is not a command worth obeying.
const lineEvent = ({ at, bytes, cut, direction }: LineEntry): NetworkEvent | undefined => {
  if (direction === "outbound" || cut === true) {
    return undefined;
  }

  const parsed = parseFrame(bytes);

  return parsed._tag === "Line"
    ? { at, command: parsed.line.command, params: parsed.line.params, type: "LINE" }
    : undefined;
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

    case "Daemon": {
      return undefined;
    }

    default: {
      return entry satisfies never;
    }
  }
};
