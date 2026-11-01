import type { Line } from "@iirc/protocol/line";
import { parseFrame } from "@iirc/protocol/line";
import type { Entry, NetworkId } from "@iirc/session/entry";
import { initialState, messageOf, reduce } from "@iirc/state";
import type { Message, SessionState } from "@iirc/state";

/** Something a participant said, derived from a Line. */
export interface LoggedMessage {
  readonly at: number;
  readonly kind: "PRIVMSG" | "NOTICE";
  readonly network: NetworkId;
  readonly sender: string;
  readonly sequence: number;
  readonly target: string;
  readonly text: string;
}

/** What the fold keeps between Entries: each Network's current Session. */
export type Sessions = ReadonlyMap<NetworkId, SessionState>;

/** Sessions as they stand before the first Entry. */
export const noSessions: Sessions = new Map();

/** What a run of Entries adds to what came before it. */
export interface Folded {
  readonly messages: readonly LoggedMessage[];
  readonly sessions: Sessions;
}

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

const foldParsed = (
  sessions: Map<NetworkId, SessionState>,
  entry: LineEntry,
  line: Line
): Message | undefined => {
  const state = sessions.get(entry.network) ?? initialState;

  if (entry.direction === "inbound") {
    sessions.set(entry.network, reduce(state, line));

    return messageOf(line);
  }

  // Self sent this whatever the Line claims, and state follows only what Ircds say.
  return messageOf({ ...line, source: undefined }, state.self);
};

// An unparseable Line stays an Entry, but it says nothing and changes nothing.
const foldLine = (sessions: Map<NetworkId, SessionState>, entry: LineEntry) => {
  const parsed = parseFrame(entry.bytes);

  return parsed._tag === "Line" ? foldParsed(sessions, entry, parsed.line) : undefined;
};

/**
 * Derives what a run of Entries adds. `record`, startup, and `rebuild` all come
 * through here, so a rebuilt table can only differ from a live one if the code did.
 * @param sessions - The Sessions so far, which stay as they are.
 * @param entries - The Entries that follow them, in sequence order.
 * @returns The Messages those Entries carry, and the Sessions after them.
 */
export const foldEntries = (sessions: Sessions, entries: readonly Entry[]): Folded => {
  const folded = new Map(sessions);
  const messages: LoggedMessage[] = [];

  for (const entry of entries) {
    if (entry._tag === "Line") {
      const message = foldLine(folded, entry);

      if (message !== undefined) {
        const { at, network, sequence } = entry;

        messages.push({ ...message, at, network, sequence });
      }
    }

    // A reconnect is a new Session, so nothing carries over (LIVE-6).
    if (entry._tag === "Connection" && entry.phase === "attempt") {
      folded.delete(entry.network);
    }
  }

  return { messages, sessions: folded };
};
