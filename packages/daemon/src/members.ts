/**
 * A Channel's members a page at a time: the most privileged first, by `PREFIX`, and then by
 * nick folded with the Connection's casemapping. Pure, so a page is the same for the same
 * Channel, whatever the clock or locale.
 *
 * @packageDocumentation
 */
import type { ChannelView, Fact, MemberKnowledge, UserKnowledge } from "@iirc/client/known";
import { casefold } from "@iirc/protocol/casemapping";

/** Where a page ends: a member's rank, and their nick folded with the Connection's casemapping. */
export interface MemberPlace {
  readonly rank: number;
  readonly key: string;
}

/** A member, where they stand in the order, and whether their User is away. */
export interface Placed extends MemberPlace {
  readonly member: MemberKnowledge;
  readonly away: UserKnowledge["away"];
}

/** A page of members, and where the next begins, or `undefined` when no more follow. */
export interface MembersPage {
  readonly members: readonly Placed[];
  readonly next: MemberPlace | undefined;
}

/** Which members a page gives. */
export interface MembersQuery {
  /** The place the page before ended at. */
  readonly after?: MemberPlace | undefined;
  /** How many members to give at most. */
  readonly limit: number;
  /** The start of the nicks wanted, compared under the Connection's casemapping. */
  readonly prefix?: string | undefined;
}

const unknown = { _tag: "Unknown" } as const;

// The prefixes a member holds, as far as anything says, partly or as they were.
const heldOf = (prefixes: Fact<ReadonlySet<string>>): ReadonlySet<string> | undefined => {
  switch (prefixes._tag) {
    case "Known": {
      return prefixes.value;
    }

    case "Partial": {
      return prefixes.atLeast;
    }

    case "Stale": {
      return prefixes.was;
    }

    case "Unknown": {
      return undefined;
    }

    default: {
      return prefixes satisfies never;
    }
  }
};

/**
 * A member's rank: the index in `PREFIX` of the highest prefix they hold, or the count of
 * prefixes when they hold none that `PREFIX` names, so a lower rank is more privileged.
 * @param prefixes - What is known of the prefixes they hold.
 * @param order - Each prefix mode's index in `PREFIX`.
 * @returns The rank.
 */
export const rankOf = (
  prefixes: Fact<ReadonlySet<string>>,
  order: ReadonlyMap<string, number>
): number => {
  let rank = order.size;

  for (const mode of heldOf(prefixes) ?? []) {
    rank = Math.min(rank, order.get(mode) ?? rank);
  }

  return rank;
};

// By code unit, so the order never depends on a locale.
const byText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

/**
 * The order of two places: by rank, then by folded nick.
 * @param left - One place.
 * @param right - The other.
 * @returns Negative when `left` comes first, positive when `right` does.
 */
export const comparePlaces = (left: MemberPlace, right: MemberPlace): number =>
  left.rank - right.rank || byText(left.key, right.key);

/**
 * The prefix modes a member holds, in the order of `PREFIX`, and any it does not name after,
 * by code unit, so a Frontend can show their symbols as the Network does.
 * @param held - The modes.
 * @param order - Each prefix mode's index in `PREFIX`.
 * @returns The modes, in order.
 */
export const inRankOrder = (
  held: Iterable<string>,
  order: ReadonlyMap<string, number>
): readonly string[] =>
  [...held].toSorted(
    (left, right) =>
      (order.get(left) ?? order.size) - (order.get(right) ?? order.size) || byText(left, right)
  );

/**
 * Each prefix mode's index in `PREFIX`, most privileged first.
 * @param view - The Channel.
 * @returns The indexes, by mode.
 */
export const rankOrder = (view: ChannelView): ReadonlyMap<string, number> =>
  new Map(view.ranks.map(({ mode }, index) => [mode, index]));

/**
 * A page of a Channel's members: those after `after` in the order, up to `limit`, and with
 * `prefix`, only those whose nick starts with it under the Connection's casemapping. A
 * member who left since `after` was given is simply not there, and none is given twice
 * while their rank and nick stay as they were.
 * @param view - The Channel, as the Client knows it now.
 * @param query - Where to start, how many, and the start of the nicks wanted.
 * @returns The page, and where the next begins.
 */
export const membersPage = (view: ChannelView, query: MembersQuery): MembersPage => {
  const order = rankOrder(view);
  const start = query.prefix === undefined ? "" : casefold(view.casemapping, query.prefix);
  const { after } = query;
  const placed: Placed[] = [];

  for (const [key, member] of view.channel.members) {
    if (!key.startsWith(start)) {
      continue;
    }

    const place = { key, rank: rankOf(member.prefixes, order) };

    if (after === undefined || comparePlaces(place, after) > 0) {
      placed.push({ ...place, away: view.users.get(key)?.away ?? unknown, member });
    }
  }

  const sorted = placed.toSorted(comparePlaces);
  const members = sorted.slice(0, query.limit);
  const last = members.at(-1);

  return {
    members,
    next:
      sorted.length > query.limit && last !== undefined
        ? { key: last.key, rank: last.rank }
        : undefined,
  };
};
