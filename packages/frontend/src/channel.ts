/**
 * Who is here: what a Timeline shows at its head, and a Channel's members, as a reducer
 * over what the runtime read from the Channel's routes and what the changes stream said.
 * The Daemon reads the Channel as the Client knows it now, so this holds the latest read of
 * the open Channel only, and says to read it again when a change could have changed it.
 *
 * @packageDocumentation
 */
import type {
  ChannelHeader,
  Member,
  MemberPage,
  MembersAfter,
  NetworkId,
  Rank,
  TimelineChange,
  TimelineId,
  TimelineOverflow,
} from "@iirc/api";
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";

import type { Intent } from "./commands.ts";
import { endReason, formatted, nickColour } from "./render.ts";
import type { Inline } from "./render.ts";
import { opened, resolve } from "./timelines.ts";
import type { Connection, Timelines } from "./timelines.ts";

/** Where Self stands with a Channel the Client holds. */
export type Standing = NonNullable<ChannelHeader["standing"]>;

/** How many members a page asks for, and the most a read again asks for at once. */
export const membersPage = 100;
const largestMembersPage = 500;

/** The open Channel: its Timeline and its Network. */
export interface OpenChannel {
  readonly timeline: TimelineId;
  readonly network: NetworkId;
}

/**
 * A read the runtime should make: the head, or a page of members, first or after `after`.
 * `wait` says it reads again what a change may have changed, so the runtime waits first,
 * as `refreshDelay` says.
 */
export type ChannelRead =
  | {
      readonly _tag: "Head";
      readonly timeline: TimelineId;
      readonly network: NetworkId;
      readonly wait: boolean;
    }
  | {
      readonly _tag: "Members";
      readonly timeline: TimelineId;
      readonly network: NetworkId;
      readonly after: MembersAfter | undefined;
      readonly limit: number;
      readonly wait: boolean;
    };

/**
 * How reads again are spaced, in milliseconds: the first change after quiet is read
 * `debounce` after it, and while changes keep coming, at most once an `interval`.
 */
export interface Timing {
  readonly debounce: number;
  readonly interval: number;
}

/** How reads again are spaced, unless the runtime says otherwise. */
export const refreshTiming: Timing = { debounce: 250, interval: 1000 };

/**
 * One kind of read: the generation what is held was asked at, whether one is in flight,
 * and when the last was asked.
 */
interface Load {
  /** The generation the last read answered was asked at, or -1 before any. */
  readonly read: number;
  /** A read is in flight. A change never cancels it: the next read follows it. */
  readonly reading: boolean;
  /** When the last read was, or is to be, asked, in milliseconds. */
  readonly startedAt: number | undefined;
}

/** The head as read. */
interface HeadLoad extends Load {
  readonly header: ChannelHeader | undefined;
  /** The Daemon said there is no such Channel Timeline, so asking again would not help. */
  readonly failed: boolean;
}

/** A Channel's members, read a page at a time, from the most privileged. */
export interface Roster extends Load {
  readonly members: readonly Member[];
  /** Where the next page begins, or none when no more follow. */
  readonly next: MembersAfter | null;
  readonly more: boolean;
  /** Self is not in the Channel, as the members route answered, with where Self stands. */
  readonly notIn: { readonly standing: Exclude<Standing, "Joined"> | null } | undefined;
  readonly failed: boolean;
  /** The Owner scrolled to the end of what is held. */
  readonly moreWanted: boolean;
}

/** The open Channel's head and members, as last read. */
export interface Channel {
  /** The Channel Timeline what is held is of. */
  readonly timeline: TimelineId | undefined;
  readonly network: NetworkId | undefined;
  /**
   * Bumped by every change that may have changed the Channel. What was asked at an earlier
   * generation is dirty, and read again.
   */
  readonly generation: number;
  readonly head: HeadLoad;
  readonly roster: Roster;
}

/**
 * What happened. Each answer says the `generation` its read was asked at, which the
 * runtime takes from the state as it asks.
 *
 * - `ReadStarted`: the runtime took on a read `channelReads` gave, to be asked `at` then.
 *   One of another Channel than the one held starts afresh with it.
 * - `HeadRead`, `MembersRead`: what the head and a page of members answered.
 * - `NotInChannel`: the members route said Self is not in the Channel.
 * - `Failed`: the Daemon said the Timeline is no Channel's, or it has none, so the read is
 *   not made again until something changes.
 * - `MoreWanted`: the Owner scrolled to the end of the members held.
 * - `Changed`, `Overflowed`, `Reset`: the changes stream's events, which may have changed
 *   the Channel held, so it is read again.
 */
export type ChannelEvent =
  | { readonly _tag: "ReadStarted"; readonly read: ChannelRead; readonly at: number }
  | {
      readonly _tag: "HeadRead";
      readonly read: ChannelRead;
      readonly generation: number;
      readonly header: ChannelHeader;
    }
  | {
      readonly _tag: "MembersRead";
      readonly read: ChannelRead;
      readonly generation: number;
      readonly page: MemberPage;
    }
  | {
      readonly _tag: "NotInChannel";
      readonly read: ChannelRead;
      readonly generation: number;
      readonly standing: Exclude<Standing, "Joined"> | null;
    }
  | { readonly _tag: "Failed"; readonly read: ChannelRead; readonly generation: number }
  | { readonly _tag: "MoreWanted"; readonly timeline: TimelineId }
  | { readonly _tag: "Changed"; readonly change: TimelineChange }
  | { readonly _tag: "Overflowed"; readonly overflow: TimelineOverflow }
  | { readonly _tag: "Reset" };

const unreadLoad: Load = { read: -1, reading: false, startedAt: undefined };
const unread: HeadLoad = { ...unreadLoad, failed: false, header: undefined };

const unreadRoster: Roster = {
  ...unreadLoad,
  failed: false,
  members: [],
  more: false,
  moreWanted: false,
  next: null,
  notIn: undefined,
};

/** Nothing read yet. */
export const initialChannel: Channel = {
  generation: 0,
  head: unread,
  network: undefined,
  roster: unreadRoster,
  timeline: undefined,
};

const fresh = (open: OpenChannel): Channel => ({
  ...initialChannel,
  network: open.network,
  timeline: open.timeline,
});

/**
 * The Channel the main view shows: the open Timeline, as merges resolve it, when its
 * Network lists it as a Channel's and the options do not stand in its place.
 * @param state - The Timelines.
 * @returns The open Channel, or none.
 */
export const openChannel = (state: Timelines): OpenChannel | undefined => {
  if (state.open === undefined || state.main._tag !== "Timeline") {
    return undefined;
  }

  const timeline = resolve(state, state.open);

  for (const network of state.networks.values()) {
    const listed = network.timelines.get(timeline);

    if (listed !== undefined) {
      return listed.kind === "Channel" ? { network: listed.network, timeline } : undefined;
    }
  }

  return undefined;
};

/**
 * Whether a change may have changed a Channel's head or members: an Activity in its
 * Timeline, as a join, a part, a kick, a quit, a nick, a mode, a topic, or an away does,
 * or a Gap of its Network, which a Session ending or beginning makes.
 * @param change - The change.
 * @param timeline - The Channel's Timeline.
 * @param network - Its Network.
 * @returns Whether it may have.
 */
export const touches = (
  change: TimelineChange,
  timeline: TimelineId,
  network: NetworkId | undefined
): boolean =>
  change.items.some((item) => item.timeline === timeline && item.content._tag === "Activity") ||
  change.gaps.some((gap) => gap.network === network);

/**
 * The reads to make now, for the open Channel and, while the members show, its members:
 * each kind once at a time, when what it holds was asked before the latest change, or, for
 * the members, the Owner scrolled for more. A read in flight is never superseded: a change
 * while it is asked only leaves it dirty, and the next read follows it.
 * @param state - The state.
 * @param open - The open Channel, if any.
 * @param members - Whether the members show.
 * @returns The reads.
 */
export const channelReads = (
  state: Channel,
  open: OpenChannel | undefined,
  members: boolean
): readonly ChannelRead[] => {
  if (open === undefined) {
    return [];
  }

  const held = state.timeline === open.timeline ? state : fresh(open);
  const { generation, head, roster } = held;
  const about = { network: open.network, timeline: open.timeline };
  const reads: ChannelRead[] = [];

  if (!head.reading && head.read < generation) {
    reads.push({ _tag: "Head", ...about, wait: head.read >= 0 });
  }

  if (!members || roster.reading) {
    return reads;
  }

  if (roster.read < generation) {
    reads.push({
      _tag: "Members",
      ...about,
      after: undefined,
      // Read again, as many as were held, so a list scrolled down keeps its length.
      limit: Math.min(largestMembersPage, Math.max(membersPage, roster.members.length)),
      wait: roster.read >= 0,
    });
  } else if (roster.moreWanted && roster.more && roster.next !== null) {
    reads.push({ _tag: "Members", ...about, after: roster.next, limit: membersPage, wait: false });
  }

  return reads;
};

/**
 * How long to wait before asking a read: none for a first read, and for a read again, the
 * debounce after the change, but no sooner than an interval after the last of its kind was
 * asked, so changes that keep coming are read at most once an interval.
 * @param state - The state.
 * @param read - The read.
 * @param now - The time now, in milliseconds.
 * @param timing - How reads again are spaced.
 * @returns How long to wait, in milliseconds.
 */
export const refreshDelay = (
  state: Channel,
  read: ChannelRead,
  now: number,
  timing: Timing = refreshTiming
): number => {
  if (!read.wait) {
    return 0;
  }

  const { startedAt } = read._tag === "Head" ? state.head : state.roster;

  return startedAt === undefined
    ? timing.debounce
    : Math.max(timing.debounce, startedAt + timing.interval - now);
};

const samePlace = (left: MembersAfter | null, right: MembersAfter | undefined) =>
  left !== null && right !== undefined && left.key === right.key && left.rank === right.rank;

/**
 * Folds a page the runtime read into a Roster.
 * @param roster - The Roster.
 * @param read - The read it answers.
 * @param page - The page.
 * @param generation - The generation it was asked at.
 * @returns The Roster after.
 */
const withPage = (
  roster: Roster,
  read: Extract<ChannelRead, { readonly _tag: "Members" }>,
  page: MemberPage,
  generation: number
): Roster => {
  if (read.after === undefined) {
    return {
      ...roster,
      failed: false,
      members: page.members,
      more: page.more,
      next: page.next,
      notIn: undefined,
      read: generation,
    };
  }

  // A page after a place the members held no longer end at merges nothing.
  if (!samePlace(roster.next, read.after)) {
    return roster;
  }

  return {
    ...roster,
    members: [...roster.members, ...page.members],
    more: page.more,
    moreWanted: false,
    next: page.next,
  };
};

/**
 * The state once the runtime took on a read. One of another Channel starts afresh with it.
 * @param state - The state.
 * @param read - The read.
 * @param at - When it is to be asked.
 * @returns The state after.
 */
const started = (state: Channel, read: ChannelRead, at: number): Channel => {
  const held =
    read.timeline === state.timeline
      ? state
      : fresh({ network: read.network, timeline: read.timeline });

  return read._tag === "Head"
    ? { ...held, head: { ...held.head, reading: true, startedAt: at } }
    : { ...held, roster: { ...held.roster, reading: true, startedAt: at } };
};

/**
 * The state once a read answered. Its read is no longer in flight, and what it says is
 * taken unless what is held was asked later.
 * @param state - The state.
 * @param event - The answer.
 * @returns The state after.
 */
const answered = (
  state: Channel,
  event: Extract<
    ChannelEvent,
    { readonly _tag: "HeadRead" | "MembersRead" | "NotInChannel" | "Failed" }
  >
): Channel => {
  const { generation, read } = event;

  if (read.timeline !== state.timeline) {
    return state;
  }

  const head = read._tag === "Head" ? { ...state.head, reading: false } : state.head;
  const roster = read._tag === "Members" ? { ...state.roster, reading: false } : state.roster;
  const after = { ...state, head, roster };
  const newer = generation >= (read._tag === "Head" ? head.read : roster.read);

  switch (event._tag) {
    case "HeadRead": {
      return newer
        ? { ...after, head: { ...head, failed: false, header: event.header, read: generation } }
        : after;
    }

    case "MembersRead": {
      // A later page joins what is held whenever it was asked; a first page only if newer.
      return read._tag === "Members" && (newer || read.after !== undefined)
        ? { ...after, roster: withPage(roster, read, event.page, generation) }
        : after;
    }

    case "NotInChannel": {
      return newer
        ? {
            ...after,
            roster: {
              ...unreadRoster,
              notIn: { standing: event.standing },
              read: generation,
              startedAt: roster.startedAt,
            },
          }
        : after;
    }

    case "Failed": {
      if (!newer) {
        return after;
      }

      return read._tag === "Head"
        ? { ...after, head: { ...head, failed: true, read: generation } }
        : { ...after, roster: { ...roster, failed: true, read: generation } };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Whether what the changes stream said may have changed the Channel held.
 * @param state - The state.
 * @param event - The stream's event.
 * @returns Whether it may have.
 */
const touchedBy = (
  state: Channel,
  event: Extract<ChannelEvent, { readonly _tag: "Changed" | "Overflowed" | "Reset" }>
): boolean => {
  const { network, timeline } = state;

  if (timeline === undefined) {
    return false;
  }

  switch (event._tag) {
    case "Changed": {
      return touches(event.change, timeline, network);
    }

    case "Overflowed": {
      return event.overflow.timelines === null || event.overflow.timelines.includes(timeline);
    }

    case "Reset": {
      return true;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The state after an event.
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after.
 */
export const reduceChannel = (state: Channel, event: ChannelEvent): Channel => {
  switch (event._tag) {
    case "ReadStarted": {
      return started(state, event.read, event.at);
    }

    case "HeadRead":
    case "MembersRead":
    case "NotInChannel":
    case "Failed": {
      return answered(state, event);
    }

    case "MoreWanted": {
      return event.timeline === state.timeline
        ? { ...state, roster: { ...state.roster, moreWanted: true } }
        : state;
    }

    case "Changed":
    case "Overflowed":
    case "Reset": {
      return touchedBy(state, event) ? { ...state, generation: state.generation + 1 } : state;
    }

    default: {
      return event satisfies never;
    }
  }
};

// The head, as a view shows it.

/** A topic as shown: unknown, none set, or its text with who set it and when, if known. */
export type TopicShown =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Set";
      readonly inlines: readonly Inline[];
      readonly by: string | undefined;
      readonly at: number | undefined;
      /** It was known once, and may have changed since, as across a reconnect. */
      readonly stale: boolean;
    };

/**
 * What a Timeline shows at its head.
 *
 * - `Channel`: its name, topic, modes, how many members, and, when Self is not in it, why,
 *   in words.
 * - `Direct`: the partner's name, and when it no longer follows them, why.
 * - `Network`: its id, and how its connection stands, in words.
 */
export type Header =
  | {
      readonly _tag: "Channel";
      readonly timeline: TimelineId;
      readonly name: string;
      readonly topic: TopicShown;
      readonly modes: string | undefined;
      readonly members: number | undefined;
      /** Where Self stands, in words, when not in it. */
      readonly note: string | undefined;
    }
  | {
      readonly _tag: "Direct";
      readonly timeline: TimelineId;
      readonly name: string;
      /** Why it no longer follows its partner, in words, when it does not. */
      readonly note: string | undefined;
    }
  | {
      readonly _tag: "Network";
      readonly timeline: TimelineId;
      readonly name: string;
      readonly status: string;
    };

/**
 * Where Self stands with a Channel it is not in, in words, saying what to do.
 * @param standing - Where Self stands, or none when the Client holds no such Channel.
 * @returns The words, or none when Self is in it.
 */
export const standingText = (standing: Standing | null): string | undefined => {
  switch (standing) {
    case "Joined": {
      return undefined;
    }

    case "Wanted": {
      return "not in this Channel yet: it is joined once the Network is connected";
    }

    case "Joining": {
      return "joining…";
    }

    case "Refused": {
      return "not in this Channel: the Ircd refused the join, which is tried again";
    }

    case "Kicked": {
      return "kicked from this Channel, which is joined again";
    }

    case null: {
      return "not in this Channel — /join to rejoin";
    }

    default: {
      return standing satisfies never;
    }
  }
};

/**
 * How a Network's connection stands, in words.
 * @param running - Whether the Daemon runs it.
 * @param connection - How its connection stands.
 * @returns The words.
 */
export const connectionText = (
  running: { readonly _tag: "Running" } | { readonly _tag: "Stopped"; readonly reason: string },
  connection: Connection
): string => {
  if (running._tag === "Stopped") {
    return `stopped: ${running.reason}`;
  }

  switch (connection._tag) {
    case "Connected": {
      return connection.nick === undefined ? "connected" : `connected as ${connection.nick}`;
    }

    case "Connecting": {
      return "connecting";
    }

    case "Offline": {
      return connection.reason === undefined
        ? "offline"
        : `offline: ${endReason(connection.reason)}`;
    }

    case "Unknown": {
      return "…";
    }

    default: {
      return connection satisfies never;
    }
  }
};

/**
 * A Channel's modes as a mode string, such as `+ntl 50`. A key shows as set, never its value.
 * @param modes - The modes.
 * @returns The mode string, or none when no mode is set.
 */
const modeString = (
  modes: readonly { readonly mode: string; readonly param: string | null }[]
): string | undefined =>
  modes.length === 0
    ? undefined
    : [
        `+${modes.map((one) => one.mode).join("")}`,
        ...modes.flatMap((one) => (one.param === null ? [] : [one.param])),
      ].join(" ");

/**
 * A fact's value as last known: as known now, or as it was before it went stale.
 * @param fact - The fact.
 * @returns Its value, or none when unknown.
 */
const lastKnown = <A>(
  fact:
    | { readonly _tag: "Known"; readonly value: A }
    | { readonly _tag: "Stale"; readonly was: A }
    | { readonly _tag: "Unknown" }
): A | undefined => {
  if (fact._tag === "Known") {
    return fact.value;
  }

  return fact._tag === "Stale" ? fact.was : undefined;
};

/**
 * A topic as shown.
 * @param topic - The topic fact.
 * @returns How it shows.
 */
const topicShown = (topic: ChannelHeader["topic"]): TopicShown => {
  const value = lastKnown(topic);

  if (value === undefined) {
    return { _tag: "Unknown" };
  }

  if (value === null) {
    return { _tag: "None" };
  }

  return {
    _tag: "Set",
    at: value.setAt ?? undefined,
    by: value.setBy ?? undefined,
    inlines: formatted(value.text),
    stale: topic._tag === "Stale",
  };
};

/**
 * What the open Timeline shows at its head, from what its Network lists and, for a
 * Channel, its head as last read.
 * @param state - The Timelines.
 * @param channel - The Channel held.
 * @returns The header, or none while no Timeline is shown.
 */
export const headerOf = (state: Timelines, channel: Channel): Header | undefined => {
  const shown = opened(state);

  if (shown._tag !== "Shown" || shown.description === undefined) {
    return undefined;
  }

  const { description } = shown;
  const { id: timeline, name } = description;

  switch (description.kind) {
    case "Network": {
      const network = state.networks.get(description.network);

      return {
        _tag: "Network",
        name,
        status:
          network === undefined
            ? "…"
            : connectionText(network.running ?? { _tag: "Running" }, network.connection),
        timeline,
      };
    }

    case "Direct": {
      return {
        _tag: "Direct",
        name,
        note: description.detached
          ? "no longer follows its partner, who changed nick: use /msg <nick> <text>"
          : undefined,
        timeline,
      };
    }

    case "Channel": {
      const header = channel.timeline === timeline ? channel.head.header : undefined;

      if (header === undefined) {
        return {
          _tag: "Channel",
          members: undefined,
          modes: undefined,
          name,
          note: undefined,
          timeline,
          topic: { _tag: "Unknown" },
        };
      }

      const joined = header.standing === "Joined";

      const modes = lastKnown(header.modes) ?? [];

      return {
        _tag: "Channel",
        members: joined ? header.members : undefined,
        modes: joined ? modeString(modes) : undefined,
        name: header.name,
        note: standingText(header.standing),
        timeline,
        topic: joined ? topicShown(header.topic) : { _tag: "Unknown" },
      };
    }

    default: {
      return description.kind satisfies never;
    }
  }
};

// Members, as a view shows them.

/** A member as the list shows them. */
export interface MemberRow {
  readonly nick: string;
  /** The symbol of the highest prefix they hold, such as `@`, or none. */
  readonly symbol: string | undefined;
  readonly away: boolean;
  /** Their nick's colour slot. */
  readonly colour: number;
  /** Their nick, rank, and whether they are away, in words, for a screen reader. */
  readonly label: string;
}

/**
 * The prefixes a member holds, as much as is known: all of them, at least these, or as
 * they were.
 * @param fact - The fact.
 * @returns The modes, in the order of `PREFIX`.
 */
const prefixesOf = (fact: Member["prefixes"]): readonly string[] => {
  switch (fact._tag) {
    case "Known": {
      return fact.value;
    }

    case "Partial": {
      return fact.atLeast;
    }

    case "Stale": {
      return fact.was;
    }

    case "Unknown": {
      return [];
    }

    default: {
      return fact satisfies never;
    }
  }
};

// RFC 2811 names these two membership modes; any other is named by its mode letter.
const rankNames = new Map([
  ["o", "operator"],
  ["v", "voice"],
]);

/**
 * A member as the list shows them: the symbol of the highest prefix they hold, from
 * `PREFIX`, dimmed when away, in their nick's colour.
 * @param member - The member.
 * @param ranks - The Channel's `PREFIX`, most privileged first.
 * @returns The row.
 */
export const memberRow = (member: Member, ranks: readonly Rank[]): MemberRow => {
  const held = prefixesOf(member.prefixes);
  const highest = ranks.find((rank) => held.includes(rank.mode));

  const away =
    (member.away._tag === "Known" && member.away.value !== null) ||
    (member.away._tag === "Stale" && member.away.was !== null);

  const words = [
    member.nick,
    ...(highest === undefined ? [] : [rankNames.get(highest.mode) ?? `mode ${highest.mode}`]),
    ...(away ? ["away"] : []),
  ];

  return {
    away,
    colour: nickColour(member.nick),
    label: words.join(", "),
    nick: member.nick,
    symbol: highest?.symbol,
  };
};

/**
 * The members as the list shows them.
 *
 * - `None`: no Channel is open.
 * - `Reading`: none read yet.
 * - `Out`: Self is not in the Channel, which has no members to list, and why, in words.
 * - `Failed`: the Daemon has no such Channel Timeline.
 * - `Listed`: the members read, in rank order, how many there are in all, as the head
 *   says, whether more follow, and whether more are being read.
 */
export type RosterShown =
  | { readonly _tag: "None" }
  | { readonly _tag: "Reading"; readonly timeline: TimelineId }
  | { readonly _tag: "Out"; readonly timeline: TimelineId; readonly note: string }
  | { readonly _tag: "Failed"; readonly timeline: TimelineId }
  | {
      readonly _tag: "Listed";
      readonly timeline: TimelineId;
      readonly rows: readonly MemberRow[];
      readonly count: number | undefined;
      readonly more: boolean;
      readonly loading: boolean;
    };

/**
 * The open Channel's members as the list shows them.
 * @param state - The Timelines.
 * @param channel - The Channel held.
 * @returns The members.
 */
export const rosterOf = (state: Timelines, channel: Channel): RosterShown => {
  const open = openChannel(state);

  if (open === undefined) {
    return { _tag: "None" };
  }

  const { timeline } = open;

  if (channel.timeline !== timeline || channel.roster.read < 0) {
    return { _tag: "Reading", timeline };
  }

  const { head, roster } = channel;

  if (roster.notIn !== undefined) {
    return {
      _tag: "Out",
      note: standingText(roster.notIn.standing) ?? "not in this Channel",
      timeline,
    };
  }

  if (roster.failed) {
    return { _tag: "Failed", timeline };
  }

  const ranks = head.header?.ranks ?? [];

  return {
    _tag: "Listed",
    count: head.header?.standing === "Joined" ? head.header.members : undefined,
    loading: roster.reading,
    more: roster.more,
    rows: roster.members.map((member) => memberRow(member, ranks)),
    timeline,
  };
};

// Opening a Timeline by name.

/**
 * What `/query` comes to: the Timeline a name keys on a Network, opened, when its Network
 * lists one that still follows it, as the Daemon keyed it, by the casemapping the Network
 * last declared, or `rfc1459` until one has. With none, nothing was said there yet, and a
 * Timeline is made only by what is said, so the composer starts `/msg <name> ` instead.
 * @param state - The Timelines.
 * @param network - The Network.
 * @param name - The name, as typed.
 * @param casemapping - The casemapping the Network last declared, if any.
 * @returns The intents.
 */
export const queried = (
  state: Timelines,
  network: NetworkId,
  name: string,
  casemapping: Casemapping | undefined
): readonly Intent[] => {
  const key = casefold(casemapping ?? defaultCasemapping, name);

  const found = [...(state.networks.get(network)?.timelines.values() ?? [])].find(
    (one) => one.key === key
  );

  return found === undefined
    ? [{ _tag: "FocusComposer", text: `/msg ${name} ` }]
    : [{ _tag: "Open", timeline: found.id }];
};
