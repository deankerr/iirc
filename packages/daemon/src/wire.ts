/**
 * Total maps from what the Runtime and the Client give, as TypeScript types, to the
 * contract's wire Schemas. Each map's return type is checked with {@link Fields}, and each
 * union is switched over to `never`, so a News variant, a field, or a Knowledge fact added
 * to the Client fails to compile here until the contract catches up.
 *
 * @packageDocumentation
 */
import type {
  Activity as WireActivity,
  ChannelKnowledge as WireChannelKnowledge,
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
  NetworkInspection as WireNetworkInspection,
  NetworkStatus as WireNetworkStatus,
  News as WireNews,
  RefusedReason as WireRefusedReason,
} from "@iirc/api";
import type {
  Activity,
  EndReason,
  IgnoredReason,
  Inspection,
  ModeChange,
  News,
  RefusedReason,
  TimerTable,
} from "@iirc/client";
import type {
  ChannelKnowledge,
  Fact,
  Knowledge,
  KnownFact,
  StaleFact,
  UnknownFact,
  MemberKnowledge,
  Topic,
  UserKnowledge,
} from "@iirc/client/known";
import type { Happened, NetworkInspection, NetworkStatus } from "@iirc/runtime";

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

const setFact = <T>(source: Fact<ReadonlySet<T>>) => {
  switch (source._tag) {
    case "Known": {
      return {
        _tag: "Known",
        at: source.at,
        from: source.from,
        value: [...source.value],
      } as const;
    }

    case "Partial": {
      return {
        _tag: "Partial",
        at: source.at,
        atLeast: [...source.atLeast],
        from: source.from,
      } as const;
    }

    case "Stale": {
      return { _tag: "Stale", since: source.since, was: [...source.was] } as const;
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

const activity = (source: Activity): WireActivity => {
  switch (source._tag) {
    case "AwayChanged": {
      const wire: Case<Activity, WireActivity, "AwayChanged"> = {
        _tag: "AwayChanged",
        away: source.away === null ? null : { message: source.away.message },
        nick: source.nick,
      };

      return wire;
    }

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

    default: {
      return source satisfies never;
    }
  }
};

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
        live: source.live,
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

    case "ConnectionFailed":
    case "SessionEnded": {
      const wire: Case<News, WireNews, typeof source._tag> = {
        _tag: source._tag,
        at: source.at,
        reason: endReason(source.reason),
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
        at: fact(source.at, same),
        id: fact(source.id, same),
        kind: source.kind,
        live: source.live,
        ours:
          source.ours === undefined ? null : { echo: source.ours.echo, intent: source.ours.intent },
        sender: source.sender,
        tags: [...source.tags].map(([key, value]) => ({ key, value })),
        target: source.target,
        text: source.text,
      };

      return wire;
    }

    case "Refused": {
      const wire: Case<News, WireNews, "Refused"> = {
        _tag: "Refused",
        intent: source.intent,
        reason: refusedReason(source.reason),
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

const member = (
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
  members: [...source.members].map(([nick, one]) => member(nick, one)),
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
      };

      return wire;
    }

    default: {
      return source satisfies never;
    }
  }
};

/**
 * What a Client knows, as the contract says it.
 * @param source - The Client's Knowledge.
 * @returns Its wire form.
 */
export const knowledge = (source: Knowledge): Fields<Knowledge, WireKnowledge> => ({
  casemapping: source.casemapping,
  channels: [...source.channels].map(([key, one]) => channel(key, one)),
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
