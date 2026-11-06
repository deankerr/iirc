import { SortedMap } from "./sorted-map.ts";

/** A Channel's topic (KNOW-4). */
export interface Topic {
  readonly text: string;
  /** Who set it, as a nick or a mask, whichever the Ircd gave. */
  readonly setBy: string | undefined;
  /** When it was set, in epoch milliseconds. */
  readonly setAt: number | undefined;
}

/** Someone in a Channel Self is in, Self included (KNOW-4). */
export interface Member {
  /** Their nick as the Ircd last spelled it. */
  readonly nick: string;
  /**
   * The letters of the prefix modes they hold, such as `ov`, highest first by `PREFIX`.
   * Without `multi-prefix`, `NAMES` shows only the highest, so this can be short (KNOW-5).
   */
  readonly prefixes: string;
}

/** A Channel's members, by casefolded nick, in that order. */
export type Members = SortedMap<Member>;

/** A `NAMES` reply under way: `353`s so far, waiting for the `366` that swaps them in. */
export interface PendingNames {
  readonly members: Members;
  /** Some members were not held, because of a bound. */
  readonly cut: boolean;
}

/** A Channel Self is in. */
export interface Channel {
  /** Its name as the Ircd last spelled it, for display (KNOW-3). */
  readonly name: string;
  readonly topic: Topic | undefined;
  /** From `329`, in epoch milliseconds. */
  readonly createdAt: number | undefined;
  /**
   * Every mode set but list and prefix modes, by letter, with its parameter, which is
   * `undefined` for a flag, or for one hidden or too long to hold (KNOW-6). The key is
   * `k`'s. List modes such as `b` are not held: they flow through `ModesChanged`, and a
   * list is a Lookup.
   */
  readonly modes: ReadonlyMap<string, string | undefined>;
  readonly members: Members;
  /** A `NAMES` reply under way, if one is. */
  readonly pending: PendingNames | undefined;
  /**
   * `modes` may be wrong: a `MODE` did not add up (KNOW-6), or a mode did not fit. A `324`
   * settles it.
   */
  readonly modesUncertain: boolean;
  /**
   * `members` may be wrong: a `MODE` did not add up, or a bound cut a `NAMES` reply. A
   * `366` that nothing cut settles it.
   */
  readonly membersUncertain: boolean;
}

/** The Channels Self is in, by casefolded name, oldest first. */
export type Channels = ReadonlyMap<string, Channel>;

// A Network chooses what goes in here, so it is bounded and drops its oldest. A real
// Network stops far short of this many Channels, and past it, only that Network suffers.
export const heldChannels = 1024;

/** The most members one Channel holds, beyond which it is `membersUncertain`. */
export const membersPerChannel = 65_536;

/** The most members all Channels hold together, `NAMES` replies under way included. */
export const heldMembers = 131_072;

/** The most modes, list and prefix modes aside, that one Channel holds. */
export const modesPerChannel = 64;

/**
 * The longest nick, `user`, `host`, realname, or mode parameter held, in UTF-16 units. A
 * member with a longer nick is not held, and a longer value is held as unknown.
 */
export const longestField = 255;

/**
 * A value as it can be held: itself, or unknown when it is longer than {@link longestField}.
 * @param value - The value as sent.
 * @returns It, or `undefined`.
 */
export const heldField = (value: string | undefined): string | undefined =>
  value === undefined || value.length > longestField ? undefined : value;

const noMembers: Members = SortedMap.empty();

const noModes: ReadonlyMap<string, string | undefined> = new Map();

/**
 * A Channel Self has just joined, with Self its only member until `NAMES` says more.
 * @param name - The Channel, spelled as the `JOIN` spelled it.
 * @param self - Self's nick, casefolded and as spelled.
 * @returns The Channel.
 */
export const joinedChannel = (
  name: string,
  self: { readonly folded: string; readonly nick: string }
): Channel => ({
  createdAt: undefined,
  members: noMembers.with(self.folded, { nick: self.nick, prefixes: "" }),
  membersUncertain: false,
  modes: noModes,
  modesUncertain: false,
  name,
  pending: undefined,
  topic: undefined,
});

/**
 * A Channel in, as the newest, dropping the oldest past {@link heldChannels}.
 * @param channels - The Channels so far.
 * @param folded - Its casefolded name.
 * @param channel - The Channel.
 * @returns The Channels after it.
 */
export const withNewest = (channels: Channels, folded: string, channel: Channel): Channels => {
  const next = new Map(channels);

  // Deleted first, so that a Channel joined again counts as the newest.
  next.delete(folded);
  next.set(folded, channel);

  if (next.size > heldChannels) {
    const [oldest] = next.keys();

    next.delete(oldest ?? folded);
  }

  return next;
};

/**
 * Self has left a Channel.
 * @param channels - The Channels so far.
 * @param folded - The Channel's casefolded name.
 * @returns The Channels after it, and the very same map if Self was not in it.
 */
export const withoutChannel = (channels: Channels, folded: string): Channels => {
  if (!channels.has(folded)) {
    return channels;
  }

  const next = new Map(channels);

  next.delete(folded);

  return next;
};

/**
 * Each Channel as `change` leaves it, in place. Only one `change` returns anew is copied.
 * @param channels - The Channels so far.
 * @param change - What becomes of each Channel, given its casefolded name.
 * @returns The Channels after it, and the very same map if no Channel changed.
 */
export const mapChannels = (
  channels: Channels,
  change: (channel: Channel, folded: string) => Channel
): Channels => {
  let next: Map<string, Channel> | undefined;

  for (const [folded, channel] of channels) {
    const changed = change(channel, folded);

    if (changed !== channel) {
      next ??= new Map(channels);
      next.set(folded, changed);
    }
  }

  return next ?? channels;
};

/**
 * How many members all Channels hold, `NAMES` replies under way included.
 * @param channels - The Channels.
 * @returns The count.
 */
export const membersHeld = (channels: Channels): number => {
  let count = 0;

  for (const { members, pending } of channels.values()) {
    count += members.size + (pending?.members.size ?? 0);
  }

  return count;
};

/**
 * A Channel with its members, and any `NAMES` reply under way, changed alike, so that a
 * `JOIN` or `QUIT` between a `353` and its `366` is not lost at the swap.
 * @param channel - The Channel.
 * @param change - What becomes of a set of members.
 * @returns The Channel after it, or the very same one if neither moved.
 */
export const withMembers = (channel: Channel, change: (members: Members) => Members): Channel => {
  const members = change(channel.members);

  const pendingMembers =
    channel.pending === undefined ? undefined : change(channel.pending.members);

  if (members === channel.members && pendingMembers === channel.pending?.members) {
    return channel;
  }

  return {
    ...channel,
    members,
    pending:
      channel.pending === undefined || pendingMembers === undefined
        ? channel.pending
        : { ...channel.pending, members: pendingMembers },
  };
};

/**
 * Prefix letters, highest first by `PREFIX`, each once. A letter `PREFIX` no longer names
 * keeps its place after the rest.
 * @param letters - Letters in any order.
 * @param order - `PREFIX`'s letters, highest first.
 * @returns The letters, ranked.
 */
export const ranked = (letters: string, order: string): string => {
  if (letters.length < 2) {
    return letters;
  }

  const rank = (letter: string) => {
    const index = order.indexOf(letter);

    return index === -1 ? order.length : index;
  };

  return [...new Set(letters)].toSorted((one, other) => rank(one) - rank(other)).join("");
};

/**
 * The same members, keyed by another fold, as after a new `CASEMAPPING`.
 * @param members - The members.
 * @param fold - The fold in force from now on.
 * @returns The members, keyed under it.
 */
export const refoldedMembers = (members: Members, fold: (nick: string) => string): Members =>
  SortedMap.from([...members.values()].map((member) => [fold(member.nick), member] as const));

/**
 * The same members with their prefixes ranked by a new `PREFIX` order. Only members whose
 * ranking moves are copied.
 * @param members - The members.
 * @param order - `PREFIX`'s letters from now on, highest first.
 * @returns The members, or the very same ones if no ranking moved.
 */
export const reranked = (members: Members, order: string): Members => {
  const moved: [string, Member][] = [];

  for (const [folded, member] of members) {
    const prefixes = ranked(member.prefixes, order);

    if (prefixes !== member.prefixes) {
      moved.push([folded, { ...member, prefixes }]);
    }
  }

  return members.withEntries(moved);
};
