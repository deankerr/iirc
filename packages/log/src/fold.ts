import type { Entry, NetworkId } from "@iirc/session/entry";
import { foldStandings } from "@iirc/session/standing";
import type { Gap, Standings, StandingStep } from "@iirc/session/standing";
import { messageOf } from "@iirc/state";

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

/** What a run of Entries adds to what came before it. */
export interface Folded {
  /** Each Gap as it stood after each change, in order, so the last write of one wins. */
  readonly gaps: readonly Gap[];
  readonly messages: readonly LoggedMessage[];
  readonly standings: Standings;
}

// Self sent an outbound Line whatever the Line claims, and only Ircds move state, so
// who Self was before it is who Self is.
const messageFrom = ({ before, entry, line }: StandingStep): LoggedMessage | undefined => {
  if (entry._tag !== "Line" || line === undefined) {
    return undefined;
  }

  const { at, direction, network, sequence } = entry;

  const message =
    direction === "inbound"
      ? messageOf(line)
      : messageOf({ ...line, source: undefined }, before.irc.self);

  return message === undefined ? undefined : { ...message, at, network, sequence };
};

/**
 * Derives what a run of Entries adds. `record` and `rebuild` both come through here,
 * so a rebuilt table can only differ from a live one if the code did.
 * @param standings - The Standings so far, which stay as they are.
 * @param entries - The Entries that follow them, in sequence order.
 * @returns The Messages and Gaps those Entries carry, and the Standings after them.
 */
export const foldEntries = (standings: Standings, entries: readonly Entry[]): Folded => {
  const gaps: Gap[] = [];
  const messages: LoggedMessage[] = [];

  const folded = foldStandings(standings, entries, (step) => {
    const { after, before } = step;
    const message = messageFrom(step);

    if (after.gap !== undefined && after.gap !== before.gap) {
      gaps.push(after.gap);
    }

    if (message !== undefined) {
      messages.push(message);
    }
  });

  return { gaps, messages, standings: folded };
};
