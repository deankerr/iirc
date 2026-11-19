/**
 * Total maps from what the Runtime and the Client give, as TypeScript types, to the
 * contract's wire Schemas. Each map's return type is checked with {@link Fields}, and each
 * union is switched over to `never`, so a News variant, a field, or a Knowledge fact added
 * to the Client fails to compile here until the contract catches up.
 *
 * @packageDocumentation
 */
import { NetworkId as WireNetworkId, Sequence as WireSequence } from "@iirc/api";
import type {
  Activity as WireActivity,
  Attempted as WireAttempted,
  Delivery as WireDelivery,
  Gap as WireGap,
  ItemContent as WireItemContent,
  Projection as WireProjection,
  Timeline as WireTimeline,
  Unread as WireUnread,
  TimelineItem as WireTimelineItem,
  Tombstone as WireTombstone,
  DroppedTimeline as WireDroppedTimeline,
  NetworkRemoval as WireNetworkRemoval,
  WindowGap as WireWindowGap,
  ChannelHeader as WireChannelHeader,
  ChannelKnowledge as WireChannelKnowledge,
  Member as WireMember,
  MemberKnowledge as WireMemberKnowledge,
  ModeChange as WireModeChange,
  SessionKnowledge as WireSessionKnowledge,
  Topic as WireTopic,
  UserKnowledge as WireUserKnowledge,
  ClientInspection as WireClientInspection,
  EndReason as WireEndReason,
  Happened as WireHappened,
  IgnoredReason as WireIgnoredReason,
  Knowledge as WireKnowledge,
  Looked as WireLooked,
  LookResult as WireLookResult,
  Lookup as WireLookup,
  MaskEntry as WireMaskEntry,
  NamesEntry as WireNamesEntry,
  WhoEntry as WireWhoEntry,
  Profile as WireProfile,
  Marked as WireMarked,
  Closable as WireClosable,
  NetworkInspection as WireNetworkInspection,
  NetworkStatus as WireNetworkStatus,
  News as WireNews,
  RefusedReason as WireRefusedReason,
  Where as WireWhere,
} from "@iirc/api";
import type {
  Activity,
  Attempted,
  EndReason,
  IgnoredReason,
  Inspection,
  LookResult,
  Lookup,
  Marked,
  Closable,
  MaskEntry,
  ModeChange,
  NamesEntry,
  News,
  Profile,
  RefusedAction,
  Ctcp,
  RefusedReason,
  StandardReply,
  TimerTable,
  Where,
  WhoEntry,
} from "@iirc/client";
import type {
  ChannelKnowledge,
  ChannelView,
  Fact,
  Knowledge,
  KnownFact,
  StaleFact,
  UnknownFact,
  MemberKnowledge,
  Topic,
  UserKnowledge,
} from "@iirc/client/known";
import type { IgnoreMask } from "@iirc/protocol/mask";
import type { Happened, Known, LookOutcome, NetworkInspection, NetworkStatus } from "@iirc/runtime";
import type {
  CollapsedGap,
  Dropped,
  Gap,
  Item,
  NetworkRemoval,
  Summary,
  Tombstone,
  Unread,
} from "@iirc/timeline-store";
import type { Content, Delivery } from "@iirc/timelines";

import { inRankOrder, rankOrder } from "./members.ts";
import type { Placed } from "./members.ts";
import type { ProjectorStatus } from "./projector.ts";

/**
 * `Wire` when it has exactly the fields of `Source`, by name, and no others but those in
 * `Added`. Anything else is a type that names what is missing and what is unknown, so a
 * value given that type fails to compile and the message says why. Field types are left
 * to the map, which knows how each differs, such as a `Map` sent as an array.
 */
type Fields<Source, Wire, Added extends PropertyKey = never> = [
  Exclude<keyof Source, keyof Wire> | Exclude<keyof Wire, keyof Source | Added>,
] extends [never]
  ? Wire
  : {
      readonly missing: Exclude<keyof Source, keyof Wire>;
      readonly unknown: Exclude<keyof Wire, keyof Source | Added>;
    };

/** {@link Fields} for one case of two tagged unions. */
type Case<Source, Wire, Tag extends string, Added extends PropertyKey = never> = Fields<
  Extract<Source, { readonly _tag: Tag }>,
  Extract<Wire, { readonly _tag: Tag }>,
  Added
>;

// A fact that is not a set's, which can never be partial.
type SingleFact<T> = KnownFact<T> | StaleFact<T> | UnknownFact;

const fact = <T, W>(source: SingleFact<T>, map: (value: T) => W) => {
  switch (source._tag) {
    case "Known": {
      return { _tag: "Known", at: source.at, from: source.from, value: map(source.value) } as const;
    }

    case "Stale": {
      return { _tag: "Stale", since: source.since, was: map(source.was) } as const;
    }

    case "Unknown": {
      return { _tag: "Unknown" } as const;
    }

    default: {
      return source satisfies never;
    }
  }
};

// A set's fact, its members listed as `list` orders them, or as the set holds them.
const setFact = <T>(
  source: Fact<ReadonlySet<T>>,
  list: (set: ReadonlySet<T>) => readonly T[] = (set) => [...set]
) => {
  switch (source._tag) {
    case "Known": {
      return {
        _tag: "Known",
        at: source.at,
        from: source.from,
        value: list(source.value),
      } as const;
    }

    case "Partial": {
      return {
        _tag: "Partial",
        at: source.at,
        atLeast: list(source.atLeast),
        from: source.from,
      } as const;
    }

    case "Stale": {
      return { _tag: "Stale", since: source.since, was: list(source.was) } as const;
    }

    case "Unknown": {
      return { _tag: "Unknown" } as const;
    }

    default: {
      return source satisfies never;
    }
  }
};

const same = <T>(value: T): T => value;

const orNull = <T>(value: T | undefined): T | null => value ?? null;

const topic = (source: Topic): Fields<Topic, WireTopic> => ({
  setAt: orNull(source.setAt),
  setBy: orNull(source.setBy),
  text: source.text,
});

const modeChange = (source: ModeChange): Fields<ModeChange, WireModeChange> => ({
  mode: source.mode,
  param: orNull(source.param),
  set: source.set,
});

const standardReply = (source: StandardReply): StandardReply => ({
  code: source.code,
  command: source.command,
  context: source.context,
  description: source.description,
  kind: source.kind,
});

const ctcp = (source: Ctcp): Ctcp => ({
  args: source.args,
  command: source.command,
  nick: source.nick,
  target: source.target,
});

type Presence = Extract<
  Activity,
  { readonly _tag: "AccountChanged" | "AwayChanged" | "CameOnline" | "WentOffline" }
>;

const isPresence = (source: Activity): source is Presence =>
  source._tag === "AccountChanged" ||
  source._tag === "AwayChanged" ||
  source._tag === "CameOnline" ||
  source._tag === "WentOffline";

// What a User's presence changed to, as an Away, an account, or coming or going.
const presence = (source: Presence): WireActivity => {
  if (source._tag === "CameOnline" || source._tag === "WentOffline") {
    const wire: Case<Activity, WireActivity, typeof source._tag> = {
      _tag: source._tag,
      nick: source.nick,
    };

    return wire;
  }

  if (source._tag === "AccountChanged") {
    const wire: Case<Activity, WireActivity, "AccountChanged"> = {
      _tag: "AccountChanged",
      account: source.account,
      nick: source.nick,
    };

    return wire;
  }

  const wire: Case<Activity, WireActivity, "AwayChanged"> = {
    _tag: "AwayChanged",
    away: source.away === null ? null : { message: source.away.message },
    nick: source.nick,
  };

  return wire;
};

type IrcdReport = Extract<Activity, { readonly _tag: "Numeric" | "Motd" }>;

const isIrcdReport = (source: Activity): source is IrcdReport =>
  source._tag === "Numeric" || source._tag === "Motd";

// What an Ircd said as it went about its business: a numeric, or its message of the day.
const ircdReport = (source: IrcdReport): WireActivity => {
  if (source._tag === "Motd") {
    const wire: Case<Activity, WireActivity, "Motd"> = {
      _tag: "Motd",
      cut: source.cut,
      lines: source.lines,
    };

    return wire;
  }

  const wire: Case<Activity, WireActivity, "Numeric"> = {
    _tag: "Numeric",
    numeric: source.numeric,
    params: source.params,
  };

  return wire;
};

const activity = (source: Activity): WireActivity => {
  if (isPresence(source)) {
    return presence(source);
  }

  if (isIrcdReport(source)) {
    return ircdReport(source);
  }

  switch (source._tag) {
    case "Joined": {
      const wire: Case<Activity, WireActivity, "Joined"> = {
        _tag: "Joined",
        channel: source.channel,
        nick: source.nick,
      };

      return wire;
    }

    case "Kicked": {
      const wire: Case<Activity, WireActivity, "Kicked"> = {
        _tag: "Kicked",
        by: source.by,
        channel: source.channel,
        nick: source.nick,
        reason: orNull(source.reason),
      };

      return wire;
    }

    case "ModeChanged": {
      const wire: Case<Activity, WireActivity, "ModeChanged"> = {
        _tag: "ModeChanged",
        by: source.by,
        changes: source.changes.map(modeChange),
        target: source.target,
      };

      return wire;
    }

    case "NickChanged": {
      const wire: Case<Activity, WireActivity, "NickChanged"> = {
        _tag: "NickChanged",
        from: source.from,
        to: source.to,
      };

      return wire;
    }

    case "Parted": {
      const wire: Case<Activity, WireActivity, "Parted"> = {
        _tag: "Parted",
        channel: source.channel,
        nick: source.nick,
        reason: orNull(source.reason),
      };

      return wire;
    }

    case "Quit": {
      const wire: Case<Activity, WireActivity, "Quit"> = {
        _tag: "Quit",
        nick: source.nick,
        reason: orNull(source.reason),
      };

      return wire;
    }

    case "CtcpReply": {
      const wire: Case<Activity, WireActivity, "CtcpReply"> = {
        _tag: "CtcpReply",
        ...ctcp(source),
        roundTrip: source.roundTrip,
      };

      return wire;
    }

    case "CtcpSent": {
      const wire: Case<Activity, WireActivity, "CtcpSent"> = {
        _tag: "CtcpSent",
        args: source.args,
        command: source.command,
        nick: source.nick,
      };

      return wire;
    }

    case "Invited": {
      const wire: Case<Activity, WireActivity, "Invited"> = {
        _tag: "Invited",
        by: source.by,
        channel: source.channel,
      };

      return wire;
    }

    case "OperGranted": {
      const wire: Case<Activity, WireActivity, "OperGranted"> = {
        _tag: "OperGranted",
        nick: source.nick,
      };

      return wire;
    }

    case "OperRefused": {
      const wire: Case<Activity, WireActivity, "OperRefused"> = {
        _tag: "OperRefused",
        nick: source.nick,
        reply: source.reply,
      };

      return wire;
    }

    case "CtcpUnsent": {
      const wire: Case<Activity, WireActivity, "CtcpUnsent"> = {
        _tag: "CtcpUnsent",
        command: source.command,
        nick: source.nick,
        target: source.target,
      };

      return wire;
    }

    case "CtcpRequest": {
      const wire: Case<Activity, WireActivity, "CtcpRequest"> = {
        _tag: "CtcpRequest",
        ...ctcp(source),
        answer:
          source.answer._tag === "Answered"
            ? { _tag: "Answered", text: source.answer.text }
            : { _tag: "Unanswered", reason: source.answer.reason },
      };

      return wire;
    }

    case "StandardReply": {
      const wire: Case<Activity, WireActivity, "StandardReply"> = {
        _tag: "StandardReply",
        ...standardReply(source),
      };

      return wire;
    }

    case "TopicChanged": {
      const wire: Case<Activity, WireActivity, "TopicChanged"> = {
        _tag: "TopicChanged",
        by: source.by,
        channel: source.channel,
        topic: source.topic === null ? null : topic(source.topic),
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const endReason = (source: EndReason): WireEndReason => {
  switch (source._tag) {
    case "Closed": {
      const wire: Case<EndReason, WireEndReason, "Closed"> = {
        _tag: "Closed",
        reason: source.reason,
      };

      return wire;
    }

    case "Upgrading": {
      const wire: Case<EndReason, WireEndReason, "Upgrading"> = {
        _tag: "Upgrading",
        port: source.port,
      };

      return wire;
    }

    case "Disabled":
    case "Error":
    case "LoginFailed":
    case "Restarted":
    case "Silent": {
      const wire: Case<EndReason, WireEndReason, typeof source._tag> = { _tag: source._tag };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const refusedReason = (source: RefusedReason): WireRefusedReason => {
  switch (source._tag) {
    case "Rejected": {
      const wire: Case<RefusedReason, WireRefusedReason, "Rejected"> = {
        _tag: "Rejected",
        reply: source.reply,
      };

      return wire;
    }

    case "Offline":
    case "Unsendable":
    case "Unsent": {
      const wire: Case<RefusedReason, WireRefusedReason, typeof source._tag> = {
        _tag: source._tag,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const attempted = (source: Attempted): WireAttempted => {
  switch (source._tag) {
    case "Away": {
      const wire: Case<Attempted, WireAttempted, "Away"> = { _tag: "Away", away: source.away };

      return wire;
    }

    case "Invite": {
      const wire: Case<Attempted, WireAttempted, "Invite"> = {
        _tag: "Invite",
        channel: source.channel,
        nick: source.nick,
      };

      return wire;
    }

    case "Kick": {
      const wire: Case<Attempted, WireAttempted, "Kick"> = {
        _tag: "Kick",
        channel: source.channel,
        nicks: [...source.nicks],
      };

      return wire;
    }

    case "Mode": {
      const wire: Case<Attempted, WireAttempted, "Mode"> = {
        _tag: "Mode",
        modes: source.modes,
        target: source.target,
      };

      return wire;
    }

    case "Nick": {
      const wire: Case<Attempted, WireAttempted, "Nick"> = { _tag: "Nick", nick: source.nick };

      return wire;
    }

    case "Part": {
      const wire: Case<Attempted, WireAttempted, "Part"> = {
        _tag: "Part",
        channel: source.channel,
      };

      return wire;
    }

    case "Ctcp": {
      const wire: Case<Attempted, WireAttempted, "Ctcp"> = {
        _tag: "Ctcp",
        command: source.command,
        nick: source.nick,
      };

      return wire;
    }

    case "Ping": {
      const wire: Case<Attempted, WireAttempted, "Ping"> = { _tag: "Ping", nick: source.nick };

      return wire;
    }

    case "Raw": {
      const wire: Case<Attempted, WireAttempted, "Raw"> = {
        _tag: "Raw",
        command: source.command,
      };

      return wire;
    }

    case "Topic": {
      const wire: Case<Attempted, WireAttempted, "Topic"> = {
        _tag: "Topic",
        channel: source.channel,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const profile = (source: Profile): Fields<Profile, WireProfile> => ({
  account: source.account ?? null,
  actual:
    source.actual === undefined
      ? null
      : { ip: source.actual.ip ?? null, mask: source.actual.mask ?? null },
  away: source.away ?? null,
  channels: source.channels.map(({ name, prefixes }) => ({ name, prefixes })),
  host: source.host ?? null,
  idle: source.idle ?? null,
  modes: source.modes ?? null,
  nick: source.nick,
  operator: source.operator,
  other: source.other.map(({ numeric, params }) => ({ numeric, params })),
  realname: source.realname ?? null,
  secure: source.secure,
  server:
    source.server === undefined ? null : { info: source.server.info, name: source.server.name },
  signon: source.signon ?? null,
  user: source.user ?? null,
});

const maskEntry = (source: MaskEntry): Fields<MaskEntry, WireMaskEntry> => ({
  mask: source.mask,
  setAt: source.setAt ?? null,
  setBy: source.setBy ?? null,
});

const namesEntry = (source: NamesEntry): Fields<NamesEntry, WireNamesEntry> => ({
  nick: source.nick,
  prefixes: [...source.prefixes],
});

const whoEntry = (source: WhoEntry): Fields<WhoEntry, WireWhoEntry> => ({
  away: source.away ?? null,
  host: source.host,
  nick: source.nick,
  realname: source.realname ?? null,
  user: source.user,
});

/**
 * What was looked up, as the contract says it.
 * @param source - The Lookup.
 * @returns Its wire form.
 */
const lookupOf = (source: Lookup): WireLookup => {
  switch (source._tag) {
    case "Whois":
    case "Whowas": {
      const wire: Case<Lookup, WireLookup, typeof source._tag> = {
        _tag: source._tag,
        nick: source.nick,
      };

      return wire;
    }

    case "Bans":
    case "Exceptions":
    case "Invitations": {
      const wire: Case<Lookup, WireLookup, typeof source._tag> = {
        _tag: source._tag,
        channel: source.channel,
      };

      return wire;
    }

    case "Names": {
      const wire: Case<Lookup, WireLookup, "Names"> = {
        _tag: "Names",
        channel: source.channel,
      };

      return wire;
    }

    case "Who": {
      const wire: Case<Lookup, WireLookup, "Who"> = { _tag: "Who", mask: source.mask };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const lookResult = (source: LookResult): WireLookResult => {
  switch (source._tag) {
    case "Found": {
      const wire: Case<LookResult, WireLookResult, "Found"> = {
        _tag: "Found",
        notes: source.notes.map(standardReply),
        profiles: source.profiles.map(profile),
      };

      return wire;
    }

    case "Partial": {
      const wire: Case<LookResult, WireLookResult, "Partial"> = {
        _tag: "Partial",
        notes: source.notes.map(standardReply),
        profiles: source.profiles.map(profile),
        reason: source.reason,
      };

      return wire;
    }

    case "Listed": {
      const wire: Case<LookResult, WireLookResult, "Listed"> = {
        _tag: "Listed",
        cut: source.cut ?? null,
        masks: source.masks.map(maskEntry),
        notes: source.notes.map(standardReply),
      };

      return wire;
    }

    case "Members": {
      const wire: Case<LookResult, WireLookResult, "Members"> = {
        _tag: "Members",
        cut: source.cut ?? null,
        members: source.members.map(namesEntry),
        notes: source.notes.map(standardReply),
      };

      return wire;
    }

    case "Users": {
      const wire: Case<LookResult, WireLookResult, "Users"> = {
        _tag: "Users",
        cut: source.cut ?? null,
        notes: source.notes.map(standardReply),
        users: source.users.map(whoEntry),
      };

      return wire;
    }

    case "NotFound":
    case "Failed": {
      const wire: Case<LookResult, WireLookResult, typeof source._tag> = {
        _tag: source._tag,
        notes: source.notes.map(standardReply),
        reply: source.reply,
      };

      return wire;
    }

    case "Refused": {
      const wire: Case<LookResult, WireLookResult, "Refused"> = {
        _tag: "Refused",
        reason: source.reason,
      };

      return wire;
    }

    case "Unsent": {
      const wire: Case<LookResult, WireLookResult, "Unsent"> = { _tag: "Unsent" };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

/**
 * What a `look` answers, or a Lookup found by its intent.
 * @param source - What the Runtime gave.
 * @returns Its wire form.
 */
export const looked = (source: LookOutcome): WireLooked => {
  switch (source._tag) {
    case "LookedUp": {
      const wire: Case<LookOutcome, WireLooked, "LookedUp"> = {
        _tag: "LookedUp",
        intent: source.intent,
        result: lookResult(source.result),
        sequence: source.sequence,
      };

      return wire;
    }

    case "Pending": {
      const wire: Case<LookOutcome, WireLooked, "Pending"> = {
        _tag: "Pending",
        intent: source.intent,
        sequence: source.sequence,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

type WireRefusedAction = NonNullable<Extract<WireNews, { readonly _tag: "Refused" }>["action"]>;

const refusedAction = (source: RefusedAction): WireRefusedAction => ({
  attempted: attempted(source.attempted),
  where:
    source.where._tag === "Network"
      ? { _tag: "Network" }
      : { _tag: "Channel", key: source.where.key, name: source.where.name },
});

const ignoredReason = (source: IgnoredReason): WireIgnoredReason => {
  switch (source._tag) {
    case "Endless":
    case "Malformed":
    case "Unsendable": {
      const wire: Case<IgnoredReason, WireIgnoredReason, typeof source._tag> = {
        _tag: source._tag,
        command: source.command,
      };

      return wire;
    }

    case "FeatureFailed": {
      const wire: Case<IgnoredReason, WireIgnoredReason, "FeatureFailed"> = {
        _tag: "FeatureFailed",
        feature: source.feature,
      };

      return wire;
    }

    case "NotNow": {
      const wire: Case<IgnoredReason, WireIgnoredReason, "NotNow"> = {
        _tag: "NotNow",
        input: source.input,
      };

      return wire;
    }

    case "StaleConnection": {
      const wire: Case<IgnoredReason, WireIgnoredReason, "StaleConnection"> = {
        _tag: "StaleConnection",
        connection: source.connection,
      };

      return wire;
    }

    case "StaleTimer": {
      const wire: Case<IgnoredReason, WireIgnoredReason, "StaleTimer"> = {
        _tag: "StaleTimer",
        timer: source.timer,
      };

      return wire;
    }

    case "Unparseable": {
      const wire: Case<IgnoredReason, WireIgnoredReason, "Unparseable"> = {
        _tag: "Unparseable",
        reason: source.reason,
      };

      return wire;
    }

    case "UnmatchedEcho": {
      const wire: Case<IgnoredReason, WireIgnoredReason, "UnmatchedEcho"> = {
        _tag: "UnmatchedEcho",
      };

      return wire;
    }

    case "NoTimeline": {
      const wire: Case<IgnoredReason, WireIgnoredReason, "NoTimeline"> = { _tag: "NoTimeline" };

      return wire;
    }

    case "Joined": {
      const wire: Case<IgnoredReason, WireIgnoredReason, "Joined"> = {
        _tag: "Joined",
        channel: source.channel,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const where = (source: Where): WireWhere => {
  switch (source._tag) {
    case "Channel": {
      const wire: Case<Where, WireWhere, "Channel"> = {
        _tag: "Channel",
        key: source.key,
        name: source.name,
      };

      return wire;
    }

    case "Direct": {
      const wire: Case<Where, WireWhere, "Direct"> = {
        _tag: "Direct",
        existing: source.existing,
        key: source.key,
        name: source.name,
      };

      return wire;
    }

    case "DirectRenamed": {
      const wire: Case<Where, WireWhere, "DirectRenamed"> = {
        _tag: "DirectRenamed",
        key: source.key,
        name: source.name,
        to: { key: source.to.key, name: source.to.name },
      };

      return wire;
    }

    case "Network": {
      const wire: Case<Where, WireWhere, "Network"> = { _tag: "Network" };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const marked = (source: Marked): WireMarked => {
  switch (source._tag) {
    case "Channel": {
      const wire: Case<Marked, WireMarked, "Channel"> = {
        _tag: "Channel",
        key: source.key,
        name: source.name,
      };

      return wire;
    }

    case "Direct": {
      const wire: Case<Marked, WireMarked, "Direct"> = {
        _tag: "Direct",
        existing: source.existing,
        key: source.key,
        name: source.name,
      };

      return wire;
    }

    case "Network": {
      const wire: Case<Marked, WireMarked, "Network"> = { _tag: "Network" };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const closable = (source: Closable): WireClosable => {
  switch (source._tag) {
    case "Channel": {
      const wire: Case<Closable, WireClosable, "Channel"> = {
        _tag: "Channel",
        key: source.key,
        name: source.name,
      };

      return wire;
    }

    case "Direct": {
      const wire: Case<Closable, WireClosable, "Direct"> = {
        _tag: "Direct",
        existing: source.existing,
        key: source.key,
        name: source.name,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

// The masks a Message or an Activity's sender matched, none when it matched none.
const stampOf = (ignored: readonly IgnoreMask[] | undefined): readonly IgnoreMask[] =>
  ignored ?? [];

/**
 * One piece of News, as the contract says it.
 * @param source - The Client's News.
 * @returns Its wire form.
 */
const news = (source: News): WireNews => {
  switch (source._tag) {
    case "Activity": {
      const wire: Case<News, WireNews, "Activity"> = {
        _tag: "Activity",
        activity: activity(source.activity),
        at: fact(source.at, same),
        id: fact(source.id, same),
        ignored: stampOf(source.ignored),
        live: source.live,
        where: source.where.map(where),
      };

      return wire;
    }

    case "Confirmed": {
      const wire: Case<News, WireNews, "Confirmed"> = {
        _tag: "Confirmed",
        at: fact(source.at, same),
        id: fact(source.id, same),
        intent: source.intent,
        text: source.text,
      };

      return wire;
    }

    case "ConnectionFailed": {
      const wire: Case<News, WireNews, "ConnectionFailed"> = {
        _tag: "ConnectionFailed",
        at: source.at,
        ircd: { host: source.ircd.host, port: source.ircd.port, tls: source.ircd.tls },
        opened: source.opened,
        reason: endReason(source.reason),
      };

      return wire;
    }

    case "SessionEnded": {
      const wire: Case<News, WireNews, "SessionEnded"> = {
        _tag: "SessionEnded",
        at: source.at,
        reason: endReason(source.reason),
      };

      return wire;
    }

    case "NetworkRemoved": {
      const wire: Case<News, WireNews, "NetworkRemoved"> = {
        _tag: "NetworkRemoved",
        keep: source.keep,
      };

      return wire;
    }

    case "Refolded": {
      const wire: Case<News, WireNews, "Refolded"> = {
        _tag: "Refolded",
        casemapping: source.casemapping,
      };

      return wire;
    }

    case "Ignored": {
      const wire: Case<News, WireNews, "Ignored"> = {
        _tag: "Ignored",
        reason: ignoredReason(source.reason),
      };

      return wire;
    }

    case "Message": {
      const wire: Case<News, WireNews, "Message"> = {
        _tag: "Message",
        answers: orNull(source.answers),
        at: fact(source.at, same),
        context: orNull(source.context),
        highlight: source.highlight,
        id: fact(source.id, same),
        ignored: stampOf(source.ignored),
        kind: source.kind,
        live: source.live,
        ours:
          source.ours === undefined ? null : { echo: source.ours.echo, intent: source.ours.intent },
        self: source.self,
        sender: source.sender,
        tags: [...source.tags].map(([key, value]) => ({ key, value })),
        target: source.target,
        text: source.text,
        where: source.where.map(where),
      };

      return wire;
    }

    case "ChannelLearned": {
      const wire: Case<News, WireNews, "ChannelLearned"> = {
        _tag: "ChannelLearned",
        channel: { key: source.channel.key, name: source.channel.name },
      };

      return wire;
    }

    case "PartnerLearned": {
      const wire: Case<News, WireNews, "PartnerLearned"> = {
        _tag: "PartnerLearned",
        partner: { key: source.partner.key, name: source.partner.name },
      };

      return wire;
    }

    case "ReadMarker": {
      const wire: Case<News, WireNews, "ReadMarker"> = {
        _tag: "ReadMarker",
        read: source.read,
        where: marked(source.where),
      };

      return wire;
    }

    case "TimelineClosed": {
      const wire: Case<News, WireNews, "TimelineClosed"> = {
        _tag: "TimelineClosed",
        where: closable(source.where),
      };

      return wire;
    }

    case "Refused": {
      const wire: Case<News, WireNews, "Refused"> = {
        _tag: "Refused",
        action: source.action === undefined ? null : refusedAction(source.action),
        intent: source.intent,
        reason: refusedReason(source.reason),
      };

      return wire;
    }

    case "LookedUp": {
      const wire: Case<News, WireNews, "LookedUp"> = {
        _tag: "LookedUp",
        intent: source.intent,
        lookup: lookupOf(source.lookup),
        result: lookResult(source.result),
      };

      return wire;
    }

    case "SessionBegan": {
      const wire: Case<News, WireNews, "SessionBegan"> = {
        _tag: "SessionBegan",
        at: source.at,
        nick: source.nick,
      };

      return wire;
    }

    case "Unignored": {
      const wire: Case<News, WireNews, "Unignored"> = {
        _tag: "Unignored",
        masks: source.masks,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

/**
 * One step's News, with its Network, sequence, and time.
 * @param source - What the Runtime's News stream gave.
 * @returns Its wire form.
 */
export const happened = (source: Happened): Fields<Happened, WireHappened> => ({
  at: source.at,
  life: source.life,
  network: source.network,
  news: source.news.map(news),
  sequence: source.sequence,
});

const user = (source: UserKnowledge): Fields<UserKnowledge, WireUserKnowledge> => ({
  account: fact(source.account, same),
  away: fact(source.away, (away) => (away === null ? null : { message: away.message })),
  mask: fact(source.mask, ({ host, user: name }) => ({ host, user: name })),
  nick: source.nick,
  realname: fact(source.realname, same),
});

const memberKnowledge = (
  key: string,
  source: MemberKnowledge
): Fields<MemberKnowledge, WireMemberKnowledge, "key"> => ({
  key,
  nick: source.nick,
  prefixes: setFact(source.prefixes),
});

const channel = (
  key: string,
  source: ChannelKnowledge
): Fields<ChannelKnowledge, WireChannelKnowledge, "key"> => ({
  key,
  members: [...source.members].map(([nick, one]) => memberKnowledge(nick, one)),
  modes: fact(source.modes, (modes) => [...modes].map(([mode, param]) => ({ mode, param }))),
  name: source.name,
  standing: source.standing,
  topic: fact(source.topic, (one) => (one === null ? null : topic(one))),
  wanted: source.wanted,
});

const sessionKnowledge = (source: Knowledge["session"]): WireSessionKnowledge => {
  type Wire = WireSessionKnowledge;

  switch (source._tag) {
    case "Connecting":
    case "Registering": {
      const wire: Case<Knowledge["session"], Wire, typeof source._tag> = {
        _tag: source._tag,
        since: source.since,
      };

      return wire;
    }

    case "Offline": {
      const wire: Case<Knowledge["session"], Wire, "Offline"> = {
        _tag: "Offline",
        since: orNull(source.since),
      };

      return wire;
    }

    case "Registered": {
      const wire: Case<Knowledge["session"], Wire, "Registered"> = {
        _tag: "Registered",
        ircd: source.ircd,
        since: source.since,
        tags: source.tags,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

/**
 * A Channel's head, as the contract says it: the Channel as the Client knows it now, or,
 * when it holds none by the Timeline's name, the Timeline's name with nothing known.
 * @param timeline - The Timeline read, which for a merged id is the one it went to.
 * @param view - The Channel, or `undefined` when the Client holds none by that name.
 * @returns Its wire form.
 */
export const channelHeader = (
  timeline: Summary,
  view: ChannelView | undefined
): WireChannelHeader => ({
  chanmodes:
    view === undefined
      ? null
      : {
          always: view.chanmodes.always,
          flags: view.chanmodes.flags,
          list: view.chanmodes.list,
          whenSet: view.chanmodes.whenSet,
        },
  chantypes: view?.chantypes ?? null,
  held:
    view?.held === undefined
      ? null
      : setFact(view.held, (held) => inRankOrder(held, rankOrder(view))),
  lists:
    view === undefined
      ? null
      : {
          bans: view.lists.Bans ?? null,
          exceptions: view.lists.Exceptions ?? null,
          invitations: view.lists.Invitations ?? null,
        },
  members: view?.channel.members.size ?? 0,
  modes:
    view === undefined
      ? { _tag: "Unknown" }
      : fact(view.channel.modes, (modes) => [...modes].map(([mode, param]) => ({ mode, param }))),
  name: view?.channel.name ?? timeline.name,
  network: WireNetworkId.make(timeline.network),
  ranks: (view?.ranks ?? []).map(({ mode, symbol }) => ({ mode, symbol })),
  standing: view?.channel.standing ?? null,
  timeline: timeline.id,
  topic:
    view === undefined
      ? { _tag: "Unknown" }
      : fact(view.channel.topic, (one) => (one === null ? null : topic(one))),
});

/**
 * A member, as the contract says it, with the prefix modes they hold in the order of
 * `PREFIX`.
 * @param placed - The member, and their User's account and whether they are away.
 * @param order - Each prefix mode's index in `PREFIX`.
 * @returns Its wire form.
 */
export const member = (
  placed: Placed,
  order: ReadonlyMap<string, number>
): Fields<MemberKnowledge, WireMember, "account" | "away"> => ({
  account: fact(placed.account, same),
  away: fact(placed.away, (away) => (away === null ? null : { message: away.message })),
  nick: placed.member.nick,
  prefixes: setFact(placed.member.prefixes, (held) => inRankOrder(held, order)),
});

/**
 * What a Client knows, as the contract says it.
 * @param source - The Client's Knowledge.
 * @returns Its wire form.
 */
export const knowledge = ({
  knowledge: source,
  life,
}: Known): Fields<Knowledge, WireKnowledge, "life"> => ({
  casemapping: source.casemapping,
  channels: [...source.channels].map(([key, one]) => channel(key, one)),
  chantypes: source.chantypes ?? null,
  declared: source.declared ?? null,
  life,
  partners: [...source.partners].map(([key, one]) => ({
    here: fact(one.here, same),
    key,
    nick: one.nick,
  })),
  self: source.self === undefined ? null : user(source.self),
  session: sessionKnowledge(source.session),
  users: [...source.users].map(([key, one]) => ({ ...user(one), key })),
});

/**
 * Whether a Network runs.
 * @param source - The Runtime's status.
 * @returns Its wire form.
 */
export const networkStatus = (source: NetworkStatus): WireNetworkStatus => {
  switch (source._tag) {
    case "Running": {
      const wire: Case<NetworkStatus, WireNetworkStatus, "Running"> = { _tag: "Running" };

      return wire;
    }

    case "Stopped": {
      const wire: Case<NetworkStatus, WireNetworkStatus, "Stopped"> = {
        _tag: "Stopped",
        reason: source.reason,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const timerList = (table: TimerTable) => [...table].map(([timer, at]) => ({ at, timer }));

const clientInspection = (source: Inspection): Fields<Inspection, WireClientInspection> => ({
  caps: {
    enabled: [...source.caps.enabled],
    offered: [...source.caps.offered].map(([cap, value]) => ({ cap, value })),
  },
  connection: orNull(source.connection),
  features: [...source.features],
  isupport: [...source.isupport].map(([token, value]) => ({ token, value })),
  policies: [...source.policies].map(([host, { duration, port, until }]) => ({
    duration,
    host,
    port,
    until,
  })),
  states: Object.entries(source.states).map(([machine, state]) => ({ machine, state })),
  timers: timerList(source.timers),
});

/**
 * A Network as the Runtime holds it.
 * @param source - The Runtime's inspection.
 * @returns Its wire form.
 */
export const networkInspection = (
  source: NetworkInspection
): Fields<NetworkInspection, WireNetworkInspection> => ({
  client: clientInspection(source.client),
  connections: source.connections.map(({ connection, nextAt, queued }) => ({
    connection,
    nextAt: nextAt ?? null,
    queued,
  })),
  status: networkStatus(source.status),
  timers: timerList(source.timers),
});

/**
 * Whether the Timelines are being folded.
 * @param source - The projector's status.
 * @returns Its wire form.
 */
export const projection = (source: ProjectorStatus): WireProjection => {
  switch (source._tag) {
    case "Running": {
      const wire: Case<ProjectorStatus, WireProjection, "Running"> = { _tag: "Running" };

      return wire;
    }

    case "Stopped": {
      const wire: Case<ProjectorStatus, WireProjection, "Stopped"> = {
        _tag: "Stopped",
        reason: source.reason,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

// The store keeps a Network's id and a sequence as it was given them, by the Runtime from
// a Journal the API wrote, so each is one the contract's brand accepts.
const networkOf = (network: string) => WireNetworkId.make(network);

/**
 * A sequence the store kept, or none.
 * @param through - The last sequence folded, or `undefined` before any.
 * @returns Its wire form.
 */
export const throughOf = (through: number | undefined) =>
  through === undefined ? null : WireSequence.make(through);

const delivery = (source: Delivery): WireDelivery => {
  switch (source._tag) {
    case "Confirmed": {
      const wire: Case<Delivery, WireDelivery, "Confirmed"> = {
        _tag: "Confirmed",
        at: fact(source.at, same),
        id: fact(source.id, same),
        text: source.text,
      };

      return wire;
    }

    case "Pending":
    case "Unconfirmed":
    case "Unsent": {
      const wire: Case<Delivery, WireDelivery, typeof source._tag> = { _tag: source._tag };

      return wire;
    }

    case "Rejected": {
      const wire: Case<Delivery, WireDelivery, "Rejected"> = {
        _tag: "Rejected",
        reply: source.reply,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

const itemContent = (source: Content): WireItemContent => {
  switch (source._tag) {
    case "ActionRefused": {
      const wire: Case<Content, WireItemContent, "ActionRefused"> = {
        _tag: "ActionRefused",
        at: source.at,
        attempted: attempted(source.attempted),
        intent: source.intent,
        reason:
          source.reason._tag === "Rejected"
            ? { _tag: "Rejected", reply: source.reason.reply }
            : { _tag: "Unsent" },
      };

      return wire;
    }

    case "Activity": {
      const wire: Case<Content, WireItemContent, "Activity"> = {
        _tag: "Activity",
        activity: activity(source.activity),
        at: fact(source.at, same),
        id: fact(source.id, same),
        live: source.live,
      };

      return wire;
    }

    case "ConnectionFailed": {
      const wire: Case<Content, WireItemContent, "ConnectionFailed"> = {
        _tag: "ConnectionFailed",
        at: source.at,
        ircd: { host: source.ircd.host, port: source.ircd.port, tls: source.ircd.tls },
        opened: source.opened,
        reason: endReason(source.reason),
      };

      return wire;
    }

    case "SessionEnded": {
      const wire: Case<Content, WireItemContent, "SessionEnded"> = {
        _tag: "SessionEnded",
        at: source.at,
        reason: endReason(source.reason),
      };

      return wire;
    }

    case "Message": {
      const wire: Case<Content, WireItemContent, "Message"> = {
        _tag: "Message",
        answers: orNull(source.answers),
        at: fact(source.at, same),
        context: orNull(source.context),
        id: fact(source.id, same),
        kind: source.kind,
        live: source.live,
        ours:
          source.ours === undefined
            ? null
            : { delivery: delivery(source.ours.delivery), intent: source.ours.intent },
        sender: source.sender,
        tags: source.tags.map(([key, value]) => ({ key, value })),
        target: source.target,
        text: source.text,
      };

      return wire;
    }

    case "SessionBegan": {
      const wire: Case<Content, WireItemContent, "SessionBegan"> = {
        _tag: "SessionBegan",
        at: source.at,
        nick: source.nick,
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

/**
 * An item of a Timeline, with the step that made it.
 * @param source - The item as the store keeps it.
 * @returns Its wire form.
 */
export const timelineItem = (source: Item): Fields<Item, WireTimelineItem, "sequence"> => ({
  answered:
    source.answered === undefined
      ? null
      : {
          kind: source.answered.kind,
          position: source.answered.position,
          sender: source.answered.sender,
          text: source.answered.text,
        },
  changed: WireSequence.make(source.changed),
  content: itemContent(source.content),
  level: orNull(source.level),
  network: networkOf(source.network),
  position: source.position,
  sequence: WireSequence.make(source.position.sequence),
  timeline: source.timeline,
});

/**
 * How much stands after a Timeline's Read Marker, by level, as the store counted it.
 * @param source - The counts.
 * @returns Their wire form.
 */
const unread = (source: Unread): Fields<Unread, WireUnread> => ({
  activity: source.activity,
  direct: source.direct,
  highlights: source.highlights,
  messages: source.messages,
});

/**
 * A Timeline, and whether it is detached: a Channel's or a Direct Message partner's with no
 * key, which receives nothing more.
 * @param source - The Timeline as the store keeps it.
 * @returns Its wire form.
 */
export const timeline = (source: Summary): Fields<Summary, WireTimeline, "detached"> => ({
  changed: WireSequence.make(source.changed),
  closed: source.closed,
  detached: source.kind !== "Network" && source.key === null,
  head: source.head === undefined ? null : WireSequence.make(source.head),
  id: source.id,
  key: source.key,
  kind: source.kind,
  latest: orNull(source.latest),
  life: WireSequence.make(source.life),
  name: source.name,
  network: networkOf(source.network),
  read: orNull(source.read),
  removed: source.removed,
  unread: unread(source.unread),
});

/**
 * A Gap.
 * @param source - The Gap as the store keeps it.
 * @returns Its wire form.
 */
export const gap = (source: Gap): Fields<Gap, WireGap> => ({
  changed: WireSequence.make(source.changed),
  from: source.from,
  network: networkOf(source.network),
  to: orNull(source.to),
});

/**
 * A Timeline merged into another.
 * @param source - The tombstone as the store keeps it.
 * @returns Its wire form.
 */
export const tombstone = (source: Tombstone): Fields<Tombstone, WireTombstone> => ({
  changed: WireSequence.make(source.changed),
  id: source.id,
  into: source.into,
  network: networkOf(source.network),
});

/**
 * A Timeline dropped with its Network.
 * @param source - What the store keeps of it.
 * @returns Its wire form.
 */
export const dropped = (source: Dropped): Fields<Dropped, WireDroppedTimeline> => ({
  changed: WireSequence.make(source.changed),
  id: source.id,
  life: WireSequence.make(source.life),
  network: networkOf(source.network),
});

/**
 * A Network's removal.
 * @param source - What the store keeps of it.
 * @returns Its wire form.
 */
export const removal = (source: NetworkRemoval): Fields<NetworkRemoval, WireNetworkRemoval> => ({
  changed: WireSequence.make(source.changed),
  keep: source.keep,
  life: WireSequence.make(source.life),
  network: networkOf(source.network),
});

/**
 * The projection version a read was folded by.
 * @param version - The store's version, or `undefined` for one no version has folded.
 * @returns Its wire form, `0` for none.
 */
export const versionOf = (version: number | undefined) => version ?? 0;

/**
 * Consecutive Gaps between two of a window's items, as one.
 * @param source - The run, as the store collapsed it.
 * @returns Its wire form.
 */
export const windowGap = (source: CollapsedGap): Fields<CollapsedGap, WireWindowGap> => ({
  count: source.count,
  from: source.from,
  to: orNull(source.to),
});
