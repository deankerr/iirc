/**
 * What a State shows: Knowledge for Views, and Inspection for agents and debugging. Both
 * are derived from the State on demand, never kept beside it.
 *
 * @packageDocumentation
 */
import type { Inspection } from "./client.ts";
import type { Kept } from "./feature.ts";
import type { CapName } from "./ids.ts";
import { ConnectionId } from "./ids.ts";
import type {
  ChannelKnowledge,
  Fact,
  Knowledge,
  MemberKnowledge,
  SessionKnowledge,
  Standing,
  UserKnowledge,
} from "./known.ts";
import type { Registered } from "./registry.ts";
import type { Seam } from "./seam.ts";
import { featuresOn } from "./seam.ts";
import type { Caps, ChannelPhase, InSession, Link, Member, Network, Open, State } from "./state.ts";
import { tableOf } from "./timers.ts";

/**
 * The open Connection, if there is one.
 * @param state - The State.
 * @returns Its open phase.
 */
export const openOf = (state: State): Open | undefined =>
  state.network._tag === "Connection" && state.network.link.phase._tag === "Open"
    ? state.network.link.phase
    : undefined;

/**
 * The Session, if there is one.
 * @param state - The State.
 * @returns Its presence.
 */
export const sessionOf = (state: State): InSession | undefined => {
  const presence = openOf(state)?.presence;

  return presence?._tag === "Session" ? presence : undefined;
};

const unknown = { _tag: "Unknown" } as const;

const noCaps: ReadonlyMap<CapName, string> = new Map();
const noneEnabled: ReadonlySet<CapName> = new Set();

/** The caps an Ircd offers, with their values, and those enabled. */
export type CapsNow = Inspection["caps"];

/**
 * What the Ircd offers and has enabled.
 * @param caps - Cap negotiation.
 * @returns The caps offered, with values, and those enabled.
 */
export const negotiated = (caps: Caps | undefined): CapsNow => {
  if (caps === undefined || caps._tag === "None") {
    return { enabled: noneEnabled, offered: noCaps };
  }

  return caps._tag === "Listing"
    ? { enabled: noneEnabled, offered: caps.offered }
    : { enabled: caps.enabled, offered: caps.offered };
};

// A fact a Feature kept, which no Feature keeps since `since`, is stale unless something
// on the floor said it again afterwards.
const kept = <T>(fact: Fact<T>, which: Kept, seam: Seam): Fact<T> => {
  const since = seam.stale.get(which);

  if (since === undefined || fact._tag === "Unknown" || fact._tag === "Stale" || fact.at > since) {
    return fact;
  }

  return { _tag: "Stale", since, was: fact._tag === "Known" ? fact.value : fact.atLeast };
};

// A Channel's members, with prefixes a Feature made complete marked stale once no
// Feature that keeps them is on.
const membersOf = (
  members: ReadonlyMap<string, Member> | undefined,
  seam: Seam | undefined
): ReadonlyMap<string, MemberKnowledge> =>
  new Map(
    [...(members ?? [])].map(([key, { nick, prefixes, complete }]) => [
      key,
      {
        nick,
        prefixes:
          complete && seam !== undefined ? kept(prefixes, "member.prefixes", seam) : prefixes,
      },
    ])
  );

const sessionKnowledge = (network: Network): SessionKnowledge => {
  switch (network._tag) {
    case "Unconfigured": {
      return { _tag: "Offline", since: undefined };
    }

    case "Idle":
    case "Waiting": {
      return { _tag: "Offline", since: network.since };
    }

    case "Connection": {
      const { phase } = network.link;

      if (phase._tag === "Dialing") {
        return { _tag: "Connecting", since: network.link.dialled };
      }

      return phase.presence._tag === "Registering"
        ? { _tag: "Registering", since: phase.opened }
        : { _tag: "Registered", ircd: phase.presence.server, since: phase.presence.began };
    }

    default: {
      return network satisfies never;
    }
  }
};

const standingOf = (phase: ChannelPhase): Standing => phase._tag;

const userOf = (nick: string, open: Open, key: string): UserKnowledge => {
  const seen = open.users.get(key);
  const mask = seen?.mask;
  const away = seen?.away;

  return {
    account: unknown,
    away: kept(
      away === undefined
        ? unknown
        : { _tag: "Known", at: away.at, from: "ircd", value: away.value },
      "user.away",
      open.seam
    ),
    mask: kept(
      mask === undefined
        ? unknown
        : { _tag: "Known", at: mask.at, from: "ircd", value: { host: mask.host, user: mask.user } },
      "user.mask",
      open.seam
    ),
    nick,
    realname: unknown,
  };
};

const selfOf = (
  state: State,
  open: Open | undefined,
  session: InSession | undefined
): UserKnowledge | undefined => {
  if (open === undefined || session === undefined) {
    return undefined;
  }

  const realname: Fact<string> =
    state.configuration === undefined
      ? unknown
      : { _tag: "Known", at: open.opened, from: "ours", value: state.configuration.realname };

  return {
    account: kept(session.account, "user.account", open.seam),
    away: unknown,
    mask: kept(session.mask, "user.mask", open.seam),
    nick: session.nick,
    realname: kept(realname, "user.realname", open.seam),
  };
};

/**
 * What is known, for Views.
 * @param state - The State.
 * @param fold - Folds a nick by the casemapping in force.
 * @returns The Knowledge.
 */
export const knowledgeOf = (state: State, fold: (name: string) => string): Knowledge => {
  const open = openOf(state);
  const session = sessionOf(state);
  const self = selfOf(state, open, session);
  const users = new Map<string, UserKnowledge>();

  const channels = new Map(
    [...state.channels].map(([key, channel]): [string, ChannelKnowledge] => {
      const { phase } = channel;
      const joined = phase._tag === "Joined" ? phase : undefined;

      if (joined !== undefined && open !== undefined) {
        for (const [nick, member] of joined.members) {
          users.set(nick, userOf(member.nick, open, nick));
        }
      }

      return [
        key,
        {
          members: membersOf(joined?.members, open?.seam),
          modes: joined?.modes ?? unknown,
          name: channel.name,
          standing: standingOf(phase),
          topic: joined?.topic ?? unknown,
          wanted: channel.wanted,
        },
      ];
    })
  );

  if (self !== undefined) {
    users.set(fold(self.nick), self);
  }

  return {
    casemapping: state.casemapping,
    channels,
    self,
    session: sessionKnowledge(state.network),
    users,
  };
};

const capsName = (caps: Caps): string => {
  switch (caps._tag) {
    case "Steady":
    case "Changing": {
      return `Ready.${caps._tag}`;
    }

    case "Listing":
    case "Requesting":
    case "Holding":
    case "None": {
      return caps._tag;
    }

    default: {
      return caps satisfies never;
    }
  }
};

const linkName = (link: Link): string =>
  link.closing === undefined ? `Connection.${link.phase._tag}` : "Connection.Closing";

const channelName = (phase: ChannelPhase): string => {
  if (phase._tag === "Joined") {
    return phase.synced ? "Joined.Synced" : "Joined.Syncing";
  }

  return phase._tag;
};

const statesOf = (state: State): Inspection["states"] => {
  const { network } = state;
  const open = openOf(state);
  const session = sessionOf(state);

  const states = new Map([
    ["network", network._tag === "Connection" ? linkName(network.link) : network._tag],
  ]);

  if (open !== undefined) {
    states.set("caps", capsName(open.caps)).set("presence", open.presence._tag);
  }

  if (session !== undefined) {
    states.set("keepalive", session.keepalive.pinged ? "Pinged" : "Listening");
  }

  for (const channel of state.channels.values()) {
    states.set(`channel ${channel.name}`, channelName(channel.phase));
  }

  return Object.fromEntries(states);
};

/**
 * The Features on now.
 * @param registry - Every Feature.
 * @param state - The State.
 * @returns Those on, in registry order.
 */
export const onNow = (registry: readonly Registered[], state: State): readonly Registered[] => {
  const open = openOf(state);

  if (open === undefined) {
    return [];
  }

  return featuresOn(
    registry,
    { ...negotiated(open.caps), isupport: open.isupport },
    state.configuration?.declined ?? [],
    open.seam
  );
};

/**
 * Everything else a State holds, for agents and debugging.
 * @param registry - Every Feature.
 * @param state - The State.
 * @returns The Inspection.
 */
export const inspectionOf = (registry: readonly Registered[], state: State): Inspection => {
  const open = openOf(state);

  return {
    caps: negotiated(open?.caps),
    connection:
      state.network._tag === "Connection" ? ConnectionId.make(state.network.link.id) : undefined,
    features: onNow(registry, state).map((feature) => feature.name),
    isupport: open?.isupport ?? new Map(),
    policies: new Map(),
    states: statesOf(state),
    timers: tableOf(state),
  };
};
