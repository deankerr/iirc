import type { Line } from "@iirc/protocol/line";

import { casefold } from "./casemapping.ts";
import type { Casemapping } from "./casemapping.ts";
import {
  heldField,
  heldMembers,
  joinedChannel,
  mapChannels,
  membersHeld,
  membersPerChannel,
  modesPerChannel,
  ranked,
  reranked,
  refoldedMembers,
  withMembers,
  withNewest,
  withoutChannel,
} from "./channels.ts";
import type { Channel, Channels, Member, Members, PendingNames, Topic } from "./channels.ts";
import { defaultIsupport, withIsupport } from "./isupport.ts";
import type { Isupport } from "./isupport.ts";
import { parseModes } from "./modes.ts";
import type { ModeChange } from "./modes.ts";
import { SortedMap } from "./sorted-map.ts";
import { SeenUsers } from "./users.ts";
import type { User } from "./users.ts";

export type { Casemapping } from "./casemapping.ts";

export { casefold, mayFoldFurther } from "./casemapping.ts";

export type { Channel, Channels, Member, Members, PendingNames, Topic } from "./channels.ts";

export {
  heldChannels,
  heldMembers,
  longestField,
  membersPerChannel,
  modesPerChannel,
} from "./channels.ts";

export type { Isupport } from "./isupport.ts";

export { heldTokens } from "./isupport.ts";

export type { ModeChange } from "./modes.ts";

export { SortedMap } from "./sorted-map.ts";

export type { SeenUsers, User } from "./users.ts";

export { usersPerGeneration } from "./users.ts";

/** What a Session knows of Self (KNOW-1). */
export interface Self {
  /** As the welcome or a later `NICK` gave it. */
  readonly nick: string;
  /** From `396`, `900`, `901`, `311`, `352`, and Self's own `JOIN`. */
  readonly user: string | undefined;
  readonly host: string | undefined;
  /** User mode letters, from `221` and `MODE` on Self, in code unit order. */
  readonly modes: string;
  /** From `305` and `306`. A Session begins here. */
  readonly away: boolean;
}

/**
 * What one Session's Ircd has said of Self, the Channels Self is in, the Users it has
 * seen, and `RPL_ISUPPORT`, folded from its inbound Lines by {@link stepState}. A Session is
 * one Connection from its welcome, so a new Connection starts again from
 * {@link initialState}, or {@link sessionState} with the same options (LIVE-6).
 */
export interface IrcState {
  /** Self, from the welcome on. */
  readonly self: Self | undefined;
  readonly isupport: Isupport;
  /** The Owner's mapping, which wins over the Ircd's (KNOW-3). See {@link casemappingOf}. */
  readonly forcedCasemapping: Casemapping | undefined;
  /**
   * Keyed by name casefolded under {@link casemappingOf}. Bounded, dropping the oldest, and
   * their members are bounded too (HOST-1).
   */
  readonly channels: Channels;
  /** Other Users seen, keyed by casefolded nick. Bounded by generations (KNOW-7, HOST-1). */
  readonly users: SeenUsers;
}

/** How a Session's state is begun. */
export interface StateOptions {
  /** A mapping that wins over whatever the Ircd says (KNOW-3). */
  readonly casemapping?: Casemapping | undefined;
}

/**
 * The state of a Session before any Line has arrived.
 * @param options - How to begin it.
 * @returns The state.
 */
export const sessionState = (options: StateOptions = {}): IrcState => ({
  channels: new Map(),
  forcedCasemapping: options.casemapping,
  isupport: defaultIsupport,
  self: undefined,
  users: SeenUsers.empty(),
});

/** The state of a Session before any Line has arrived, with no mapping forced. */
export const initialState: IrcState = sessionState();

/**
 * The mapping names are compared under: the Owner's if forced, or else the Ircd's.
 * @param state - The Session's state.
 * @returns The mapping in force.
 */
export const casemappingOf = (state: IrcState): Casemapping =>
  state.forcedCasemapping ?? state.isupport.casemapping;

/** Why an Ircd would not let Self into a Channel. */
export interface JoinFailure {
  readonly numeric: string;
  readonly text: string;
}

/** A `ChannelRead`'s numeric: `331` to `333` for the topic, `324`, or `329`. */
export type ChannelRead = "topic" | "modes" | "created";

/**
 * What one Line did, each named. A Channel is named as Self holds it, except in `Joined`
 * and `JoinRefused`, which name it as the Line spelled it. Channels in `NickChanged`,
 * `UserRenamed` and `UserQuit` are those the User shared with Self just before the Line
 * (KNOW-8), oldest first.
 */
export type StateChange =
  /** The welcome began the Session and named Self. Nothing from before it carries in. */
  | { readonly _tag: "Welcomed"; readonly self: string }
  /** Self's nick changed. */
  | {
      readonly _tag: "NickChanged";
      readonly channels: readonly string[];
      readonly from: string;
      readonly to: string;
    }
  /** Self's `user@host` changed (KNOW-1). */
  | {
      readonly _tag: "SelfMaskChanged";
      readonly host: string | undefined;
      readonly user: string | undefined;
    }
  /** Self's user modes changed (KNOW-1). */
  | { readonly _tag: "SelfModesChanged"; readonly modes: string }
  /** Self went away, or came back (KNOW-1). */
  | { readonly _tag: "SelfAwayChanged"; readonly away: boolean }
  /** Self is in a Channel, perhaps again. */
  | { readonly _tag: "Joined"; readonly channel: string }
  | { readonly _tag: "Parted"; readonly channel: string; readonly reason: string | undefined }
  | {
      readonly _tag: "Kicked";
      readonly by: string | undefined;
      readonly channel: string;
      readonly reason: string | undefined;
    }
  /**
   * The Ircd refused a `JOIN` (LIVE-7). `437` names nicks as well as Channels, so this can
   * name a nick, and only someone who asked for a Channel knows which it was.
   */
  | ({ readonly _tag: "JoinRefused"; readonly channel: string } & JoinFailure)
  /** A `470`: the Ircd put Self in `to` instead of `from` (KNOW-9). `to` is joined apart. */
  | { readonly _tag: "Forwarded"; readonly from: string; readonly to: string }
  | { readonly _tag: "IsupportChanged"; readonly isupport: Isupport }
  /** Another User joined a Channel Self is in. */
  | {
      readonly _tag: "MemberJoined";
      readonly channel: string;
      readonly host: string | undefined;
      readonly nick: string;
      readonly user: string | undefined;
    }
  | {
      readonly _tag: "MemberParted";
      readonly channel: string;
      readonly nick: string;
      readonly reason: string | undefined;
    }
  | {
      readonly _tag: "MemberKicked";
      readonly by: string | undefined;
      readonly channel: string;
      readonly nick: string;
      readonly reason: string | undefined;
    }
  /** Another User left the Network. */
  | {
      readonly _tag: "UserQuit";
      readonly channels: readonly string[];
      readonly nick: string;
      readonly reason: string | undefined;
    }
  /** Another User's nick changed. */
  | {
      readonly _tag: "UserRenamed";
      readonly channels: readonly string[];
      readonly from: string;
      readonly to: string;
    }
  /** Something more is known of another User, from `301`, `311` or `352` (KNOW-7). */
  | { readonly _tag: "UserSeen"; readonly nick: string }
  /** A `TOPIC` changed a Channel's topic. `""` clears it. */
  | {
      readonly _tag: "TopicChanged";
      readonly by: string | undefined;
      readonly channel: string;
      readonly topic: string;
    }
  /**
   * A `MODE` on a Channel, every letter of it, prefix and list modes included, in order. A
   * `MODE` that did not add up is `ChannelUncertain` instead (KNOW-6).
   */
  | {
      readonly _tag: "ModesChanged";
      readonly by: string | undefined;
      readonly changes: readonly ModeChange[];
      readonly channel: string;
    }
  /**
   * A member lost a prefix mode. Without `multi-prefix`, `NAMES` showed only their highest,
   * so they may still hold one it hid, and only another `NAMES` can say (KNOW-5).
   */
  | {
      readonly _tag: "PrefixRemoved";
      readonly channel: string;
      readonly letter: string;
      readonly nick: string;
    }
  /** A `366` swapped in the members its `353`s named (KNOW-5). */
  | { readonly _tag: "NamesReplaced"; readonly channel: string }
  /** A numeric said what a Channel's topic, modes, or creation time are. */
  | { readonly _tag: "ChannelRead"; readonly channel: string; readonly read: ChannelRead }
  /**
   * A Channel's members or modes became uncertain, and may be wrong until read again: a
   * `NAMES` for `members`, a `MODE` for `modes` (KNOW-6). One for each that became so.
   */
  | {
      readonly _tag: "ChannelUncertain";
      readonly channel: string;
      readonly field: "members" | "modes";
    };

/** A state and what changed to reach it. */
export interface SteppedState {
  readonly changes: readonly StateChange[];
  readonly next: IrcState;
}

// Every way a `JOIN` is refused (LIVE-7). `437` is here as well as in CONN-4, because it
// also applies to Channels.
const joinFailureNumerics: ReadonlySet<string> = new Set([
  "403",
  "405",
  "407",
  "437",
  "471",
  "473",
  "474",
  "475",
  "476",
  "477",
  "479",
  "489",
  "520",
]);

// RFC 2812 gives `476` no `<client>`, and Ircds still follow it, so its Channel can come
// first. Left at the second parameter, the failure would land under its own prose.
const failedChannel = ({ command, params }: Line) =>
  command === "476" && params.length === 2 ? params[0] : params[1];

/**
 * The nick in a Line's source, which is `nick!user@host`, or `nick@host`, or a bare nick.
 * @param source - A Line's source, if it has one.
 * @returns The nick, or `undefined` for a Line with no source.
 */
export const nickOf = (source: string | undefined) => source?.split(/[!@]/u, 1)[0];

interface Mask {
  readonly host: string | undefined;
  readonly nick: string;
  readonly user: string | undefined;
}

// `nick!user@host`, any part of which may be missing.
const maskOf = (source: string): Mask => {
  const at = source.indexOf("@");
  const beforeHost = at === -1 ? source : source.slice(0, at);
  const bang = beforeHost.indexOf("!");

  return {
    host: at === -1 ? undefined : heldField(source.slice(at + 1)),
    nick: bang === -1 ? beforeHost : beforeHost.slice(0, bang),
    user: bang === -1 ? undefined : heldField(beforeHost.slice(bang + 1)),
  };
};

const noChanges: readonly StateChange[] = [];

const unchanged = (state: IrcState): SteppedState => ({ changes: noChanges, next: state });

// A comma never belongs to a name, so `JOIN` and `PART` can each name several Channels.
const targetsOf = (list: string | undefined) =>
  list === undefined ? [] : list.split(",").filter((name) => name !== "");

const fold = (state: IrcState, name: string) => casefold(casemappingOf(state), name);

const isSelf = (state: IrcState, nick: string | undefined) =>
  state.self !== undefined &&
  nick !== undefined &&
  fold(state, nick) === fold(state, state.self.nick);

/**
 * The Channel Self is in by that name, however it is spelled.
 * @param state - The Session's state.
 * @param name - The Channel, spelled any way the mapping in force allows.
 * @returns The Channel, or `undefined` if Self is not in it.
 */
export const channelOf = (state: IrcState, name: string): Channel | undefined =>
  state.channels.get(fold(state, name));

/**
 * A member of a Channel Self is in, by nick, however either is spelled.
 * @param state - The Session's state.
 * @param channel - The Channel.
 * @param nick - The member's nick.
 * @returns The member, or `undefined`.
 */
export const memberOf = (state: IrcState, channel: string, nick: string): Member | undefined =>
  channelOf(state, channel)?.members.get(fold(state, nick));

/**
 * What a Session knows of another User: what it has seen of them, or just their nick if
 * they share a Channel with Self and nothing more was seen (KNOW-7).
 * @param state - The Session's state.
 * @param nick - Their nick, spelled any way the mapping in force allows.
 * @returns The User, or `undefined` if neither.
 */
export const userOf = (state: IrcState, nick: string): User | undefined => {
  const folded = fold(state, nick);
  const seen = state.users.get(folded);

  if (seen !== undefined) {
    return seen;
  }

  for (const { members } of state.channels.values()) {
    const member = members.get(folded);

    if (member !== undefined) {
      return {
        away: undefined,
        host: undefined,
        nick: member.nick,
        realname: undefined,
        user: undefined,
      };
    }
  }

  return undefined;
};

const withChannelChanged = (state: IrcState, folded: string, channel: Channel): IrcState => {
  if (state.channels.get(folded) === channel) {
    return state;
  }

  return { ...state, channels: new Map(state.channels).set(folded, channel) };
};

const markedUncertain = (
  channel: Channel,
  which: { readonly members?: boolean; readonly modes?: boolean },
  changes: StateChange[]
): Channel => {
  const members = channel.membersUncertain || which.members === true;
  const modes = channel.modesUncertain || which.modes === true;

  if (members === channel.membersUncertain && modes === channel.modesUncertain) {
    return channel;
  }

  if (members && !channel.membersUncertain) {
    changes.push({ _tag: "ChannelUncertain", channel: channel.name, field: "members" });
  }

  if (modes && !channel.modesUncertain) {
    changes.push({ _tag: "ChannelUncertain", channel: channel.name, field: "modes" });
  }

  return { ...channel, membersUncertain: members, modesUncertain: modes };
};

// Self's `user@host` as a Line shows it, with a change if it moved (KNOW-1).
const selfMasked = (
  state: IrcState,
  user: string | undefined,
  host: string | undefined,
  changes: StateChange[]
): IrcState => {
  const { self } = state;

  if (
    self === undefined ||
    ((user ?? self.user) === self.user && (host ?? self.host) === self.host)
  ) {
    return state;
  }

  const next = { ...self, host: host ?? self.host, user: user ?? self.user };

  changes.push({ _tag: "SelfMaskChanged", host: next.host, user: next.user });

  return { ...state, self: next };
};

// What a Line says of another User, kept beside what was known.
const seen = (
  state: IrcState,
  nick: string,
  known: Partial<Omit<User, "nick">>,
  changes?: StateChange[]
): IrcState => {
  const folded = fold(state, nick);
  const held = heldField(nick);
  const current = state.users.get(folded);

  if (held === undefined) {
    return state;
  }

  const user: User = {
    away: known.away ?? current?.away,
    host: known.host ?? current?.host,
    nick: held,
    realname: known.realname ?? current?.realname,
    user: known.user ?? current?.user,
  };

  // Seen as already known, they still count as seen now, so they move to the newest
  // generation, which is the very same record if they are there already.
  if (
    current !== undefined &&
    current.nick === user.nick &&
    current.user === user.user &&
    current.host === user.host &&
    current.realname === user.realname &&
    current.away === user.away
  ) {
    const users = state.users.with(folded, current);

    return users === state.users ? state : { ...state, users };
  }

  changes?.push({ _tag: "UserSeen", nick: held });

  return { ...state, users: state.users.with(folded, user) };
};

const refolded = (state: IrcState, before: Casemapping): IrcState => {
  const casemapping = casemappingOf(state);

  if (casemapping === before) {
    return state;
  }

  const foldNick = (nick: string) => casefold(casemapping, nick);
  const channels = new Map<string, Channel>();

  // Each keeps its place, and of two that the new mapping makes one, the later stands.
  for (const channel of state.channels.values()) {
    const folded = foldNick(channel.name);

    channels.delete(folded);
    channels.set(folded, {
      ...channel,
      members: refoldedMembers(channel.members, foldNick),
      pending:
        channel.pending === undefined
          ? undefined
          : { ...channel.pending, members: refoldedMembers(channel.pending.members, foldNick) },
    });
  }

  return { ...state, channels, users: state.users.refolded(foldNick) };
};

const afterWelcome = (state: IrcState, [nick]: readonly string[]): SteppedState =>
  state.self !== undefined || nick === undefined
    ? unchanged(state)
    : {
        changes: [{ _tag: "Welcomed", self: nick }],
        next: {
          ...sessionState({ casemapping: state.forcedCasemapping }),
          self: { away: false, host: undefined, modes: "", nick, user: undefined },
        },
      };

const afterIsupport = (state: IrcState, tokens: readonly string[]): SteppedState => {
  const isupport = withIsupport(state.isupport, tokens);

  if (isupport === state.isupport) {
    return unchanged(state);
  }

  const order = isupport.modes.prefix;
  const next = refolded({ ...state, isupport }, casemappingOf(state));

  return {
    changes: [{ _tag: "IsupportChanged", isupport }],
    next:
      order === state.isupport.modes.prefix
        ? next
        : {
            ...next,
            channels: mapChannels(next.channels, (channel) =>
              withMembers(channel, (members) => reranked(members, order))
            ),
          },
  };
};

// Whether a Channel holds a User, published or in a `NAMES` reply under way, which the
// Ircd sent before the Line in hand, so they were there (KNOW-8).
const holds = (channel: Channel, folded: string) =>
  channel.members.has(folded) || channel.pending?.members.has(folded) === true;

// A member renamed in every Channel that holds them, naming each such Channel.
interface Renamed {
  readonly channels: Channels;
  /** The Channels that held the member, as Self holds them. */
  readonly shared: readonly string[];
}

const renamedEverywhere = (state: IrcState, from: string, to: string): Renamed => {
  const fromFolded = fold(state, from);
  const toFolded = fold(state, to);
  const shared: string[] = [];

  const rename = (members: Members) => {
    const member = members.get(fromFolded);

    return member === undefined
      ? members
      : members.without(fromFolded).with(toFolded, { ...member, nick: to });
  };

  const channels = mapChannels(state.channels, (channel) => {
    if (!holds(channel, fromFolded)) {
      return channel;
    }

    shared.push(channel.name);

    return withMembers(channel, rename);
  });

  return { channels, shared };
};

const afterNick = (state: IrcState, line: Line): SteppedState => {
  const [to] = line.params;
  const from = nickOf(line.source);

  if (from === undefined || to === undefined || to === "" || to === from) {
    return unchanged(state);
  }

  const { channels, shared } = renamedEverywhere(state, from, to);

  if (state.self !== undefined && isSelf(state, from)) {
    return {
      changes: [{ _tag: "NickChanged", channels: shared, from: state.self.nick, to }],
      next: { ...state, channels, self: { ...state.self, nick: to } },
    };
  }

  const fromFolded = fold(state, from);
  const known = state.users.get(fromFolded);
  const renamedTo = heldField(to);

  const users =
    known === undefined || renamedTo === undefined
      ? state.users.without(fromFolded)
      : state.users.without(fromFolded).with(fold(state, to), { ...known, nick: renamedTo });

  return {
    changes: [{ _tag: "UserRenamed", channels: shared, from, to }],
    next:
      channels === state.channels && users === state.users ? state : { ...state, channels, users },
  };
};

const afterSelfJoin = (state: IrcState, line: Line, mask: Mask, self: Self): SteppedState => {
  const changes: StateChange[] = [];
  const names = targetsOf(line.params[0]);
  const selfKey = { folded: fold(state, self.nick), nick: self.nick };
  let { channels } = state;

  for (const name of names) {
    const folded = fold(state, name);
    const held = channels.get(folded);

    channels = withNewest(
      channels,
      folded,
      held === undefined ? joinedChannel(name, selfKey) : { ...held, name }
    );
    changes.push({ _tag: "Joined", channel: name });
  }

  const next = selfMasked({ ...state, channels }, mask.user, mask.host, changes);

  return { changes, next };
};

// Whether a Channel has room for one more member, by both bounds.
interface Joining {
  readonly channel: Channel;
  /** How many members it took from the bound on all Channels. */
  readonly charged: number;
}

// A member into a Channel's members and into any `NAMES` reply under way, each checked and
// charged against both bounds on its own. Where either is full, that one is cut: the
// members are uncertain at once, and the reply when its `366` swaps it in (HOST-1).
const joining = (
  held: Channel,
  folded: string,
  member: Member,
  room: number,
  changes: StateChange[]
): Joining => {
  const fits = (members: Members, left: number) =>
    members.has(folded) || (left > 0 && members.size < membersPerChannel);

  const intoMembers = fits(held.members, room);
  const charged = intoMembers && !held.members.has(folded) ? 1 : 0;
  const { pending } = held;
  const intoPending = pending === undefined || fits(pending.members, room - charged);

  const withPending =
    pending === undefined
      ? undefined
      : {
          cut: pending.cut || !intoPending,
          members: intoPending ? pending.members.with(folded, member) : pending.members,
        };

  const channel: Channel = {
    ...held,
    members: intoMembers ? held.members.with(folded, member) : held.members,
    pending: withPending,
  };

  return {
    channel: intoMembers ? channel : markedUncertain(channel, { members: true }, changes),
    charged:
      charged + (intoPending && pending !== undefined && !pending.members.has(folded) ? 1 : 0),
  };
};

const afterJoin = (state: IrcState, line: Line): SteppedState => {
  if (line.source === undefined) {
    return unchanged(state);
  }

  const mask = maskOf(line.source);

  if (state.self !== undefined && isSelf(state, mask.nick)) {
    return afterSelfJoin(state, line, mask, state.self);
  }

  const changes: StateChange[] = [];
  const folded = fold(state, mask.nick);
  const nick = heldField(mask.nick);
  let room = heldMembers - membersHeld(state.channels);
  let next = state;

  for (const name of targetsOf(line.params[0])) {
    const channelFolded = fold(state, name);
    const held = next.channels.get(channelFolded);

    if (held !== undefined) {
      changes.push({
        _tag: "MemberJoined",
        channel: held.name,
        host: mask.host,
        nick: mask.nick,
        user: mask.user,
      });

      if (nick === undefined) {
        next = withChannelChanged(
          next,
          channelFolded,
          markedUncertain(held, { members: true }, changes)
        );
      } else {
        const joined = joining(held, folded, { nick, prefixes: "" }, room, changes);

        room -= joined.charged;
        next = withChannelChanged(next, channelFolded, joined.channel);
      }
    }
  }

  return changes.length === 0
    ? unchanged(state)
    : { changes, next: seen(next, mask.nick, { host: mask.host, user: mask.user }) };
};

const afterPart = (state: IrcState, line: Line): SteppedState => {
  const nick = nickOf(line.source);
  const [list, reason] = line.params;
  const changes: StateChange[] = [];

  if (nick === undefined) {
    return unchanged(state);
  }

  const self = isSelf(state, nick);
  const folded = fold(state, nick);
  let { channels } = state;

  for (const name of targetsOf(list)) {
    const channelFolded = fold(state, name);
    const held = channels.get(channelFolded);

    if (held !== undefined && self) {
      channels = withoutChannel(channels, channelFolded);
      changes.push({ _tag: "Parted", channel: held.name, reason });
    } else if (held !== undefined) {
      const channel = withMembers(held, (members) => members.without(folded));

      channels = channel === held ? channels : new Map(channels).set(channelFolded, channel);
      changes.push({ _tag: "MemberParted", channel: held.name, nick, reason });
    }
  }

  return changes.length === 0
    ? unchanged(state)
    : { changes, next: channels === state.channels ? state : { ...state, channels } };
};

// A `KICK` may name several Channels and Users, which pair up in order, or one Channel and
// several Users. Each pair is a kick of its own, in a Channel Self is in.
const afterKick = (state: IrcState, line: Line): SteppedState => {
  const [list = "", users = "", reason] = line.params;
  const by = nickOf(line.source);
  const named = list.split(",");
  const changes: StateChange[] = [];
  let { channels } = state;

  for (const [index, nick] of users.split(",").entries()) {
    const name = named.length === 1 ? list : (named[index] ?? "");
    const channelFolded = fold(state, name);
    const held = channels.get(channelFolded);

    if (name !== "" && nick !== "" && held !== undefined) {
      if (isSelf(state, nick)) {
        channels = withoutChannel(channels, channelFolded);
        changes.push({ _tag: "Kicked", by, channel: held.name, reason });
      } else {
        const folded = fold(state, nick);
        const channel = withMembers(held, (members) => members.without(folded));

        channels = channel === held ? channels : new Map(channels).set(channelFolded, channel);
        changes.push({ _tag: "MemberKicked", by, channel: held.name, nick, reason });
      }
    }
  }

  return changes.length === 0
    ? unchanged(state)
    : { changes, next: channels === state.channels ? state : { ...state, channels } };
};

// The Channels a `QUIT` leaves are those that held its User just before it (KNOW-8).
const afterQuit = (state: IrcState, line: Line): SteppedState => {
  const nick = nickOf(line.source);

  if (nick === undefined || nick === "" || isSelf(state, nick)) {
    return unchanged(state);
  }

  const folded = fold(state, nick);
  const shared: string[] = [];

  const channels = mapChannels(state.channels, (channel) => {
    if (!holds(channel, folded)) {
      return channel;
    }

    shared.push(channel.name);

    return withMembers(channel, (members) => members.without(folded));
  });

  const users = state.users.without(folded);

  return {
    changes: [{ _tag: "UserQuit", channels: shared, nick, reason: line.params[0] }],
    next:
      channels === state.channels && users === state.users ? state : { ...state, channels, users },
  };
};

// User modes carry parameters on some Ircds, such as a server notice mask, so only the
// letters are read.
const userModesAfter = (modes: string, letters: string, replacing: boolean) => {
  const held = new Set(replacing ? "" : modes);
  let adding = true;

  for (const letter of letters) {
    if (letter === "+" || letter === "-") {
      adding = letter === "+";
    } else if (adding && held.size < modesPerChannel) {
      held.add(letter);
    } else if (!adding) {
      held.delete(letter);
    }
  }

  return [...held].toSorted().join("");
};

const afterSelfModes = (state: IrcState, letters: string, replacing: boolean): SteppedState => {
  const { self } = state;

  if (self === undefined) {
    return unchanged(state);
  }

  const modes = userModesAfter(self.modes, letters, replacing);

  return modes === self.modes
    ? unchanged(state)
    : {
        changes: [{ _tag: "SelfModesChanged", modes }],
        next: { ...state, self: { ...self, modes } },
      };
};

const isListOrPrefix = (state: IrcState, letter: string) =>
  state.isupport.modes.list.includes(letter) || state.isupport.modes.prefix.includes(letter);

// One letter that is not a list or prefix mode, set or unset. A key shown as `*` is
// hidden, so it leaves a key already known as it was (KNOW-6, CRED-4).
const modeSet = (
  modes: Map<string, string | undefined>,
  { adding, letter, param }: ModeChange
): boolean => {
  if (!adding) {
    modes.delete(letter);

    return true;
  }

  if (!modes.has(letter) && modes.size >= modesPerChannel) {
    return false;
  }

  modes.set(letter, letter === "k" && param === "*" ? modes.get(letter) : heldField(param));

  return true;
};

const prefixChanged = (
  state: IrcState,
  channel: Channel,
  { adding, letter, param }: ModeChange,
  changes: StateChange[]
): Channel => {
  if (param === undefined) {
    return channel;
  }

  const folded = fold(state, param);
  const order = state.isupport.modes.prefix;
  const had = channel.members.get(folded)?.prefixes.includes(letter) === true;

  const change = (members: Members) => {
    const member = members.get(folded);

    if (member === undefined) {
      return members;
    }

    const prefixes = adding
      ? ranked(member.prefixes + letter, order)
      : member.prefixes.replace(letter, "");

    return prefixes === member.prefixes ? members : members.with(folded, { ...member, prefixes });
  };

  if (!adding && had) {
    changes.push({
      _tag: "PrefixRemoved",
      channel: channel.name,
      letter,
      nick: channel.members.get(folded)?.nick ?? param,
    });
  }

  return withMembers(channel, change);
};

const afterChannelMode = (
  state: IrcState,
  line: Line,
  folded: string,
  held: Channel
): SteppedState => {
  const parsed = parseModes(line.params.slice(1), state.isupport.modes);
  const changes: StateChange[] = [];

  // One that does not add up is kept raw, in the Log, and says only that the Channel needs
  // reading again (KNOW-6).
  if (parsed._tag === "Uneven") {
    const channel = markedUncertain(held, { members: true, modes: true }, changes);

    return { changes, next: withChannelChanged(state, folded, channel) };
  }

  changes.push({
    _tag: "ModesChanged",
    by: nickOf(line.source),
    changes: parsed.changes,
    channel: held.name,
  });

  const modes = new Map(held.modes);
  let fits = true;
  let channel = held;

  for (const change of parsed.changes) {
    if (state.isupport.modes.prefix.includes(change.letter)) {
      channel = prefixChanged(state, channel, change, changes);
    } else if (!isListOrPrefix(state, change.letter)) {
      fits = modeSet(modes, change) && fits;
    }
  }

  channel = { ...channel, modes };
  channel = fits ? channel : markedUncertain(channel, { modes: true }, changes);

  return { changes, next: withChannelChanged(state, folded, channel) };
};

const afterMode = (state: IrcState, line: Line): SteppedState => {
  const [target = "", letters = ""] = line.params;

  if (isSelf(state, target)) {
    return afterSelfModes(state, letters, false);
  }

  const folded = fold(state, target);
  const held = state.channels.get(folded);

  return held === undefined ? unchanged(state) : afterChannelMode(state, line, folded, held);
};

const afterTopic = (state: IrcState, line: Line, at: number | undefined): SteppedState => {
  const [name = "", text = ""] = line.params;
  const folded = fold(state, name);
  const held = state.channels.get(folded);

  if (held === undefined) {
    return unchanged(state);
  }

  const topic: Topic | undefined =
    text === "" ? undefined : { setAt: at, setBy: line.source, text };

  return {
    changes: [{ _tag: "TopicChanged", by: nickOf(line.source), channel: held.name, topic: text }],
    next: withChannelChanged(state, folded, { ...held, topic }),
  };
};

// What a numeric about a Channel Self is in says of it, or nothing for any other Channel
// (KNOW-5).
const readChannel = (
  state: IrcState,
  name: string | undefined,
  read: ChannelRead,
  change: (channel: Channel) => Channel
): SteppedState => {
  const folded = fold(state, name ?? "");
  const held = state.channels.get(folded);

  if (name === undefined || held === undefined) {
    return unchanged(state);
  }

  const channel = change(held);

  return channel === held
    ? unchanged(state)
    : {
        changes: [{ _tag: "ChannelRead", channel: held.name, read }],
        next: withChannelChanged(state, folded, channel),
      };
};

const seconds = /^\d{1,12}$/u;

const millisOf = (value: string | undefined) =>
  value !== undefined && seconds.test(value) ? Number(value) * 1000 : undefined;

const afterTopicWhoTime = (state: IrcState, [, name, setBy, setAt]: readonly string[]) =>
  readChannel(state, name, "topic", (channel) =>
    channel.topic === undefined
      ? channel
      : { ...channel, topic: { ...channel.topic, setAt: millisOf(setAt), setBy } }
  );

// A `324` says every mode but list and prefix modes, so it replaces them, keeping a key
// already known where it shows `*` (KNOW-6).
const afterChannelModes = (state: IrcState, [, name, ...rest]: readonly string[]): SteppedState => {
  const held = name === undefined ? undefined : channelOf(state, name);

  if (held === undefined) {
    return unchanged(state);
  }

  const parsed = parseModes(rest, state.isupport.modes);

  if (parsed._tag === "Uneven") {
    const changes: StateChange[] = [];
    const channel = markedUncertain(held, { modes: true }, changes);

    return { changes, next: withChannelChanged(state, fold(state, held.name), channel) };
  }

  return readChannel(state, name, "modes", (channel) => {
    const modes = new Map<string, string | undefined>();
    let fits = true;

    for (const change of parsed.changes) {
      if (change.adding && !isListOrPrefix(state, change.letter)) {
        const kept =
          change.letter === "k" && change.param === "*" ? channel.modes.get("k") : change.param;

        fits = modeSet(modes, { ...change, ...(kept !== undefined && { param: kept }) }) && fits;
      }
    }

    return { ...channel, modes, modesUncertain: !fits };
  });
};

// Members a `353` names, each with the prefix symbols before its nick read as letters.
// Under `userhost-in-names` a name is a mask, whose nick alone is read.
const namedMembers = (
  state: IrcState,
  pending: PendingNames,
  names: string,
  room: number
): PendingNames => {
  const { prefix } = state.isupport.modes;
  const symbols = state.isupport.prefixSymbols;
  const { members } = pending;
  const batch = new Map<string, Member>();
  let { cut } = pending;
  let left = Math.min(room, membersPerChannel - members.size);

  for (const name of names.split(" ")) {
    let start = 0;
    let letters = "";

    while (start < name.length && symbols.includes(name.charAt(start))) {
      letters += prefix.charAt(symbols.indexOf(name.charAt(start)));
      start += 1;
    }

    const named = start === 0 ? name : name.slice(start);
    const nick = heldField(named.includes("!") || named.includes("@") ? maskOf(named).nick : named);
    const folded = nick === undefined || nick === "" ? undefined : fold(state, nick);
    const isNew = folded !== undefined && !members.has(folded) && !batch.has(folded);

    if (nick === undefined || (isNew && left <= 0)) {
      cut = true;
    } else if (folded !== undefined) {
      left -= isNew ? 1 : 0;
      batch.set(folded, { nick, prefixes: ranked(letters, prefix) });
    }
  }

  return cut === pending.cut && batch.size === 0
    ? pending
    : { cut, members: members.withEntries(batch) };
};

const noPending: PendingNames = { cut: false, members: SortedMap.empty() };

// `353`s gather apart from the members, and only their `366` swaps them in (KNOW-5).
// Older Ircds leave out the symbol, so the Channel can be the second parameter.
const afterNames = (state: IrcState, params: readonly string[]): SteppedState => {
  const name = params.length >= 4 ? params[2] : params[1];
  const folded = fold(state, name ?? "");
  const held = state.channels.get(folded);

  if (name === undefined || held === undefined || params.length < 3) {
    return unchanged(state);
  }

  const room = heldMembers - membersHeld(state.channels);
  const pending = namedMembers(state, held.pending ?? noPending, params.at(-1) ?? "", room);

  return pending === held.pending
    ? unchanged(state)
    : { changes: noChanges, next: withChannelChanged(state, folded, { ...held, pending }) };
};

const afterEndOfNames = (state: IrcState, [, name]: readonly string[]): SteppedState => {
  const folded = fold(state, name ?? "");
  const held = state.channels.get(folded);

  if (held?.pending === undefined) {
    return unchanged(state);
  }

  const changes: StateChange[] = [{ _tag: "NamesReplaced", channel: held.name }];

  const swapped: Channel = {
    ...held,
    members: held.pending.members,
    membersUncertain: false,
    pending: undefined,
  };

  const channel = held.pending.cut ? markedUncertain(swapped, { members: true }, changes) : swapped;

  return { changes, next: withChannelChanged(state, folded, channel) };
};

const afterSelfAway = (state: IrcState, away: boolean): SteppedState => {
  const { self } = state;

  return self === undefined || self.away === away
    ? unchanged(state)
    : { changes: [{ _tag: "SelfAwayChanged", away }], next: { ...state, self: { ...self, away } } };
};

// What a numeric says of Self's mask, `user@host` or a bare host as `396` can give.
const afterSelfMask = (state: IrcState, mask: string | undefined): SteppedState => {
  if (mask === undefined || mask === "") {
    return unchanged(state);
  }

  const at = mask.lastIndexOf("@");
  const userPart = at === -1 ? undefined : mask.slice(0, at);

  const user =
    userPart === undefined ? undefined : heldField(userPart.slice(userPart.indexOf("!") + 1));

  const host = heldField(at === -1 ? mask : mask.slice(at + 1));
  const changes: StateChange[] = [];
  const next = selfMasked(state, user, host, changes);

  return { changes, next };
};

// What a numeric says of a User, or of Self, which is held apart (KNOW-1, KNOW-7).
const afterUserSeen = (
  state: IrcState,
  nick: string | undefined,
  known: Partial<Omit<User, "nick">>
): SteppedState => {
  if (nick === undefined || nick === "") {
    return unchanged(state);
  }

  const changes: StateChange[] = [];

  if (isSelf(state, nick)) {
    return { changes, next: selfMasked(state, known.user, known.host, changes) };
  }

  const next = seen(state, nick, known, changes);

  return { changes, next };
};

const afterWhoReply = (state: IrcState, params: readonly string[]): SteppedState => {
  const [user, host] = params.slice(2, 4);
  const [nick, flags = "", last = ""] = params.slice(5, 8);
  const space = last.indexOf(" ");
  const realname = space === -1 ? undefined : last.slice(space + 1);
  let away: boolean | undefined;

  if (flags.startsWith("G")) {
    away = true;
  } else if (flags.startsWith("H")) {
    away = false;
  }

  return afterUserSeen(state, nick, {
    away,
    host: heldField(host),
    realname: heldField(realname),
    user: heldField(user),
  });
};

const afterWhoisUser = (state: IrcState, params: readonly string[]): SteppedState => {
  const [, nick, user, host] = params;

  return afterUserSeen(state, nick, {
    host: heldField(host),
    realname: params.length >= 6 ? heldField(params.at(-1)) : undefined,
    user: heldField(user),
  });
};

const afterJoinFailure = (state: IrcState, line: Line, channel: string): SteppedState => ({
  changes: [
    { _tag: "JoinRefused", channel, numeric: line.command, text: line.params.at(-1) ?? "" },
  ],
  next: state,
});

// Whoever sends a Message is seen, a Direct Message partner who shares no Channel too
// (KNOW-7). Only a full `nick!user@host` says who, so an Ircd's own notices are not Users.
// This is the commonest Line there is, so one from someone seen as they are now gives back
// the very same state.
const afterMessage = (state: IrcState, { source }: Line): SteppedState => {
  const bang = source?.indexOf("!") ?? -1;

  if (source === undefined || bang < 1 || !source.includes("@", bang)) {
    return unchanged(state);
  }

  const mask = maskOf(source);

  if (isSelf(state, mask.nick)) {
    return unchanged(state);
  }

  const changes: StateChange[] = [];
  const next = seen(state, mask.nick, { host: mask.host, user: mask.user }, changes);

  return next === state ? unchanged(state) : { changes, next };
};

const afterForward = (state: IrcState, [, from, to]: readonly string[]): SteppedState =>
  from === undefined || to === undefined || from === "" || to === ""
    ? unchanged(state)
    : { changes: [{ _tag: "Forwarded", from, to }], next: state };

type Step = (state: IrcState, line: Line, at: number | undefined) => SteppedState;

// Every command {@link stepState} reads, beside the `JOIN` failures.
const steps: ReadonlyMap<string, Step> = new Map<string, Step>([
  ["001", (state, { params }) => afterWelcome(state, params)],
  ["005", (state, { params }) => afterIsupport(state, params.slice(1))],
  ["221", (state, { params }) => afterSelfModes(state, params[1] ?? "", true)],
  ["301", (state, { params }) => afterUserSeen(state, params[1], { away: true })],
  ["305", (state) => afterSelfAway(state, false)],
  ["306", (state) => afterSelfAway(state, true)],
  ["311", (state, { params }) => afterWhoisUser(state, params)],
  ["324", (state, { params }) => afterChannelModes(state, params)],
  [
    "329",
    (state, { params }) =>
      readChannel(state, params[1], "created", (channel) => {
        const createdAt = millisOf(params[2]);

        return createdAt === channel.createdAt ? channel : { ...channel, createdAt };
      }),
  ],
  [
    "331",
    (state, { params }) =>
      readChannel(state, params[1], "topic", (channel) =>
        channel.topic === undefined ? channel : { ...channel, topic: undefined }
      ),
  ],
  [
    "332",
    (state, { params }) =>
      readChannel(state, params[1], "topic", (channel) => {
        const text = params[2] ?? "";

        return {
          ...channel,
          topic: text === "" ? undefined : { setAt: undefined, setBy: undefined, text },
        };
      }),
  ],
  ["333", (state, { params }) => afterTopicWhoTime(state, params)],
  ["352", (state, { params }) => afterWhoReply(state, params)],
  ["353", (state, { params }) => afterNames(state, params)],
  ["366", (state, { params }) => afterEndOfNames(state, params)],
  ["396", (state, { params }) => afterSelfMask(state, params[1])],
  ["470", (state, { params }) => afterForward(state, params)],
  ["900", (state, { params }) => afterSelfMask(state, params[1])],
  ["901", (state, { params }) => afterSelfMask(state, params[1])],
  ["JOIN", (state, line) => afterJoin(state, line)],
  ["KICK", (state, line) => afterKick(state, line)],
  ["MODE", (state, line) => afterMode(state, line)],
  ["NICK", (state, line) => afterNick(state, line)],
  ["NOTICE", (state, line) => afterMessage(state, line)],
  ["PART", (state, line) => afterPart(state, line)],
  ["PRIVMSG", (state, line) => afterMessage(state, line)],
  ["QUIT", (state, line) => afterQuit(state, line)],
  ["TOPIC", (state, line, at) => afterTopic(state, line, at)],
]);

/**
 * Whether {@link stepState} reads Lines of a command at all, so that a host can skip what
 * would only look again at a state no such Line can change.
 * @param command - A Line's command.
 * @returns Whether a Line of it can change a Session's state.
 */
export const readsCommand = (command: string): boolean =>
  steps.has(command) || joinFailureNumerics.has(command);

// Every command whose Lines can change which Channels Self is in, the mapping they are
// named under, or say that a `JOIN` failed or a kick came.
const channelCommands: ReadonlySet<string> = new Set(["001", "005", "JOIN", "KICK", "PART"]);

/**
 * Whether Lines of a command can change which Channels Self is in, the mapping in force, or
 * name a `JOIN` failure or a kick of Self. A host that plans joins from those alone can
 * skip looking again after any other Line, such as the Messages of a flood.
 * @param command - A Line's command.
 * @returns Whether a Line of it can move what Self is in.
 */
export const movesChannels = (command: string): boolean =>
  channelCommands.has(command) || joinFailureNumerics.has(command);

/**
 * Advances a Session's state by one inbound Line, and says what that changed. Never
 * throws, and leaves `state` as it is.
 * @param state - The state so far.
 * @param line - The Line that arrived.
 * @param at - When it arrived, in epoch milliseconds, which dates a `TOPIC`.
 * @returns The state after it, the very same one when it changed nothing, and each change.
 */
export const stepState = (state: IrcState, line: Line, at?: number): SteppedState => {
  const failed = joinFailureNumerics.has(line.command) ? failedChannel(line) : undefined;

  if (failed !== undefined) {
    return afterJoinFailure(state, line, failed);
  }

  return steps.get(line.command)?.(state, line, at) ?? unchanged(state);
};

/** Something a participant said. */
export interface Message {
  readonly kind: "PRIVMSG" | "NOTICE";
  readonly sender: string;
  readonly target: string;
  readonly text: string;
}

/**
 * Derives the Message a Line carries, if it carries one.
 * @param line - The Line to read.
 * @param sender - Who sent it when the Line has no source, as our own Lines don't.
 * @returns The Message, or `undefined` for any other Line.
 */
export const messageOf = (line: Line, sender?: string): Message | undefined => {
  const [target, text] = line.params;
  const from = nickOf(line.source) ?? sender;

  if (
    (line.command !== "PRIVMSG" && line.command !== "NOTICE") ||
    target === undefined ||
    text === undefined ||
    from === undefined
  ) {
    return undefined;
  }

  return { kind: line.command, sender: from, target, text };
};
