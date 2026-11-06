import type { Entry, NetworkId } from "@iirc/session/entry";
import { foldStandings, noStandings } from "@iirc/session/standing";
import type { Gap, Standings } from "@iirc/session/standing";
import type { Casemapping } from "@iirc/state";
import type { Place } from "@iirc/state/place";

import { derivedFrom } from "./derive.ts";
import { Partners } from "./partners.ts";
import type { ActivityDetails } from "./rows.ts";

export type { ActivityDetails, ActivityKind } from "./rows.ts";

/** Something a participant said, derived from a Line (MSG-1). */
export interface LoggedMessage {
  readonly at: number;
  /** An `ACTION` is a Message of its own kind, and its text is the action's (PROT-2). */
  readonly kind: "PRIVMSG" | "NOTICE" | "ACTION";
  readonly network: NetworkId;
  /** Where it belongs (MSG-2). */
  readonly place: Place;
  readonly sender: string;
  readonly sequence: number;
  /** The `STATUSMSG` prefix of its Channel Target, such as `@` for `@#chan`. */
  readonly statusmsg?: string;
  /** As the Line gave it, `STATUSMSG` prefix and all. */
  readonly target: string;
  /** As the Line gave it, formatting codes and all (MSG-3). */
  readonly text: string;
}

/**
 * Something that changed on a Network rather than something said, derived from a Line
 * (MSG-5). One Line can be several, such as a `QUIT` in each Channel it leaves (KNOW-8), so
 * each is numbered among its Entry's by `ordinal`.
 */
export interface LoggedActivity {
  /** Who did it: a nick, or an Ircd's name. Absent for a Line with no source. */
  readonly actor?: string;
  readonly at: number;
  /**
   * The mapping in force before its Line, which its place's key was casefolded under, so
   * a place asked for by name finds it whatever mapping is in force now (KNOW-3).
   */
  readonly casemapping: Casemapping;
  readonly details: ActivityDetails;
  readonly network: NetworkId;
  /** From 0, in the order the Line gave rise to them. */
  readonly ordinal: number;
  readonly place: Place;
  readonly sequence: number;
}

/**
 * What the Log's fold carries from one Entry to the next: each Network's Standing, and
 * each Network's Direct Message partners, which only the Log knows, because a partner is
 * someone with a place in the Log (KNOW-8).
 */
export interface Projection {
  readonly partners: ReadonlyMap<NetworkId, Partners>;
  readonly standings: Standings;
}

/** What the fold carries before any Entry. */
export const noProjection: Projection = { partners: new Map(), standings: noStandings };

/** What a run of Entries adds to what came before it. */
export interface Folded {
  readonly activity: readonly LoggedActivity[];
  /** Each Gap as it stood after each change, in order, so the last write of one wins. */
  readonly gaps: readonly Gap[];
  readonly messages: readonly LoggedMessage[];
  readonly projection: Projection;
}

/**
 * Derives what a run of Entries adds. `record` and `rebuild` both come through here,
 * so a rebuilt table can only differ from a live one if the code did.
 * @param projection - What the fold carried so far, which stays as it is.
 * @param entries - The Entries that follow it, in sequence order.
 * @returns The Messages, Activity, and Gaps those Entries carry, and what the fold carries
 * after them.
 */
export const foldEntries = (projection: Projection, entries: readonly Entry[]): Folded => {
  const activity: LoggedActivity[] = [];
  const gaps: Gap[] = [];
  const messages: LoggedMessage[] = [];
  let { partners } = projection;

  const standings = foldStandings(projection.standings, entries, (step) => {
    const { after, before, entry, line } = step;

    if (after.gap !== undefined && after.gap !== before.gap) {
      gaps.push(after.gap);
    }

    if (entry._tag !== "Line" || line === undefined) {
      return;
    }

    const held = partners.get(entry.network) ?? Partners.empty();
    const derived = derivedFrom(step, entry, line, held);

    if (derived.message !== undefined) {
      messages.push(derived.message);
    }

    activity.push(...derived.activity);

    if (derived.partners !== held) {
      partners = new Map(partners).set(entry.network, derived.partners);
    }
  });

  return { activity, gaps, messages, projection: { partners, standings } };
};
