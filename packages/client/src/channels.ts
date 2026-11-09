/**
 * The Channel machines: a keyed `Map` of reducer states, one per Channel the Owner
 * wants, keyed by its name folded by the casemapping in force. Wanted, Joining, Joined
 * (Syncing, Synced), Refused, and Kicked, as the statechart in the architecture
 * proposal has them, with one backoff for every wait.
 *
 * @packageDocumentation
 */
import { targetLimitsOf } from "@iirc/protocol/isupport";
import { isRejected, join, part } from "@iirc/protocol/line";

import { backoff } from "./backoff.ts";
import type { WantedChannel } from "./configuration.ts";
import { Instant } from "./ids.ts";
import type { Fact } from "./known.ts";
import type { Listed, ModeRules } from "./modes.ts";
import { applyModes, changePrefix } from "./modes.ts";
import type { Activity } from "./news.ts";
import type { Run } from "./run.ts";
import { folder, send, sendSecret, updateOpen } from "./run.ts";
import type { Channel, ChannelPhase, Joined, Member, Seen, State } from "./state.ts";
import { openOf, sessionOf } from "./views.ts";

/** The most members kept for one Channel, so a hostile Ircd cannot grow the State without bound. */
export const maxMembers = 100_000;

const setChannel = (run: Run, key: string, channel: Channel): void => {
  run.state = { ...run.state, channels: new Map(run.state.channels).set(key, channel) };
};

const changeChannel = (run: Run, key: string, change: (channel: Channel) => Channel): void => {
  const channel = run.state.channels.get(key);

  if (channel !== undefined) {
    setChannel(run, key, change(channel));
  }
};

const retryAt = (run: Run, channel: Channel): Instant =>
  Instant.make(run.at + backoff(channel.attempt));

const membersOf = (phase: ChannelPhase): readonly string[] =>
  phase._tag === "Joined" ? [...phase.members.keys()] : [];

// Forgets what was seen of Users who no longer share a Channel with Self.
const forgetUnshared = (run: Run, nicks: readonly string[]): void => {
  const shared = new Set(
    [...run.state.channels.values()].flatMap((channel) => membersOf(channel.phase))
  );

  const leaving = nicks.filter((nick) => !shared.has(nick));

  if (leaving.length > 0) {
    updateOpen(run, (open) => {
      const users = new Map(open.users);

      for (const nick of leaving) {
        users.delete(nick);
      }

      return { ...open, users };
    });
  }
};

/**
 * Takes the Owner's wanted Channels: a new one is Wanted, one no longer wanted is
 * parted if Self is in it or joining it, and one refused for want of its key may try
 * again.
 * @param run - The step.
 * @param wanted - The Channels in the new Configuration.
 */
export const reconcile = (run: Run, wanted: readonly WantedChannel[]): void => {
  const fold = folder(run.state);
  const next = new Map<string, Channel>();
  const inSession = sessionOf(run.state) !== undefined;

  for (const { key, name } of wanted) {
    const folded = fold(name);
    const was = run.state.channels.get(folded);

    if (next.has(folded)) {
      continue;
    }

    const waiting = was?.phase._tag === "Refused" && was.phase.retry === undefined;

    next.set(
      folded,
      was === undefined
        ? { attempt: 0, key, name, phase: { _tag: "Wanted" } }
        : { ...was, key, name, phase: waiting ? { _tag: "Wanted" } : was.phase }
    );
  }

  const gone = [...run.state.channels].filter(([folded]) => !next.has(folded));
  run.state = { ...run.state, channels: next };

  for (const [, channel] of gone) {
    if (inSession && (channel.phase._tag === "Joined" || channel.phase._tag === "Joining")) {
      send(run, part(channel.name), "PART");
    }

    forgetUnshared(run, membersOf(channel.phase));
  }
};

/**
 * Joins every Channel that is Wanted, while in a Session. Channels without a key share
 * `JOIN` Lines, as many to a Line as fit and as `TARGMAX` allows. A Channel with a key
 * goes alone, as a `JoinWithKey` with its Credential named. A name that cannot be sent
 * is refused until the Configuration changes.
 * @param run - The step.
 */
export const joinWanted = (run: Run): void => {
  const open = openOf(run.state);

  if (open === undefined || sessionOf(run.state) === undefined) {
    return;
  }

  const limit = targetLimitsOf(open.isupport.get("TARGMAX")).get("JOIN");
  const wanted = [...run.state.channels].filter(([, channel]) => channel.phase._tag === "Wanted");
  let batch: string[] = [];

  const flush = () => {
    if (batch.length > 0) {
      send(run, join(batch), "JOIN");
      batch = [];
    }
  };

  for (const [folded, channel] of wanted) {
    if (channel.key !== undefined) {
      sendSecret(run, { _tag: "JoinWithKey", channel: channel.name, credential: channel.key });
      setChannel(run, folded, { ...channel, phase: { _tag: "Joining" } });
      continue;
    }

    if (isRejected(join([channel.name]))) {
      setChannel(run, folded, { ...channel, phase: { _tag: "Refused", retry: undefined } });
      continue;
    }

    const longer = [...batch, channel.name];

    if (isRejected(join(longer)) || (limit !== undefined && longer.length > limit)) {
      flush();
      batch = [channel.name];
    } else {
      batch = longer;
    }

    setChannel(run, folded, { ...channel, phase: { _tag: "Joining" } });
  }

  flush();
};

/**
 * A rejoin timer fired: join that one Channel again.
 * @param run - The step.
 * @param folded - The Channel's key.
 */
export const rejoin = (run: Run, folded: string): void => {
  changeChannel(run, folded, (channel) => ({ ...channel, phase: { _tag: "Wanted" } }));
  joinWanted(run);
};

/**
 * Every Channel goes back to Wanted, as when a Session ends.
 * @param state - The State.
 * @returns The State, with every Channel Wanted.
 */
export const allWanted = (state: State): State => ({
  ...state,
  channels: new Map(
    [...state.channels].map(([folded, channel]) => [
      folded,
      { ...channel, phase: { _tag: "Wanted" } },
    ])
  ),
});

/**
 * The Ircd refused to let Self join a Channel it is joining, by a numeric. It is tried
 * again after the backoff.
 * @param run - The step.
 * @param name - The Channel, as the numeric names it.
 */
export const refused = (run: Run, name: string): void => {
  const folded = folder(run.state)(name);

  changeChannel(run, folded, (channel) =>
    channel.phase._tag === "Joining"
      ? {
          ...channel,
          attempt: channel.attempt + 1,
          phase: { _tag: "Refused", retry: retryAt(run, channel) },
        }
      : channel
  );
};

/**
 * A Channel key could not be filled. The Channel is refused until the next Session or a
 * change of Configuration.
 * @param run - The step.
 * @param name - The Channel, as the `JoinWithKey` named it.
 */
export const unfilledKey = (run: Run, name: string): void => {
  changeChannel(run, folder(run.state)(name), (channel) =>
    channel.phase._tag === "Joining"
      ? { ...channel, phase: { _tag: "Refused", retry: undefined } }
      : channel
  );
};

const joinedOf = (run: Run, folded: string): Joined | undefined => {
  const phase = run.state.channels.get(folded)?.phase;

  return phase?._tag === "Joined" ? phase : undefined;
};

/**
 * Changes what is known of a Channel Self is in.
 * @param run - The step.
 * @param name - The Channel, as a Line names it.
 * @param change - What to change.
 */
export const changeJoined = (run: Run, name: string, change: (joined: Joined) => Joined): void => {
  const folded = folder(run.state)(name);
  const joined = joinedOf(run, folded);

  if (joined !== undefined) {
    changeChannel(run, folded, (channel) => ({ ...channel, phase: change(joined) }));
  }
};

const withMember = (
  members: ReadonlyMap<string, Member>,
  folded: string,
  member: Member
): ReadonlyMap<string, Member> =>
  members.size >= maxMembers && !members.has(folded)
    ? members
    : new Map(members).set(folded, member);

const withoutMember = (
  members: ReadonlyMap<string, Member>,
  folded: string
): ReadonlyMap<string, Member> => {
  if (!members.has(folded)) {
    return members;
  }

  const next = new Map(members);
  next.delete(folded);

  return next;
};

const none: ReadonlySet<string> = new Set();

const fresh = (run: Run, nick: string): Member => ({
  nick,
  prefixes: { _tag: "Known", at: run.at, from: "ircd", value: none },
});

const isSelf = (run: Run, nick: string): boolean => {
  const self = sessionOf(run.state);

  return self !== undefined && folder(run.state)(self.nick) === folder(run.state)(nick);
};

/**
 * Records what a Line showed of another User, while they share a Channel with Self, so
 * what is kept is bounded by the members kept.
 * @param run - The step.
 * @param nick - The User.
 * @param change - What it showed.
 */
export const see = (run: Run, nick: string, change: (seen: Seen) => Seen): void => {
  const folded = folder(run.state)(nick);

  const shared = [...run.state.channels.values()].some(
    ({ phase }) => phase._tag === "Joined" && phase.members.has(folded)
  );

  if (!shared || isSelf(run, nick)) {
    return;
  }

  updateOpen(run, (open) => {
    const was = open.users.get(folded) ?? { away: undefined, mask: undefined, nick };

    return { ...open, users: new Map(open.users).set(folded, change(was)) };
  });
};

const kickedOrParted = (run: Run, channel: string, nick: string): void => {
  const fold = folder(run.state);

  if (isSelf(run, nick)) {
    const folded = fold(channel);
    const members = membersOf(run.state.channels.get(folded)?.phase ?? { _tag: "Wanted" });

    changeChannel(run, folded, (wanted) => ({
      ...wanted,
      attempt: wanted.attempt + 1,
      phase: { _tag: "Kicked", retry: retryAt(run, wanted) },
    }));
    forgetUnshared(run, members);

    return;
  }

  changeJoined(run, channel, (joined) => ({
    ...joined,
    listing: joined.listing === undefined ? undefined : withoutMember(joined.listing, fold(nick)),
    members: withoutMember(joined.members, fold(nick)),
  }));
  forgetUnshared(run, [fold(nick)]);
};

const renamed = (
  members: ReadonlyMap<string, Member>,
  from: string,
  to: string,
  nick: string
): ReadonlyMap<string, Member> => {
  const member = members.get(from);

  return member === undefined
    ? members
    : withMember(withoutMember(members, from), to, { ...member, nick });
};

const joinedSelf = (run: Run, channel: string): void => {
  const fold = folder(run.state);
  const folded = fold(channel);
  const self = sessionOf(run.state);

  changeChannel(run, folded, (wanted) =>
    wanted.phase._tag === "Joined" || self === undefined
      ? wanted
      : {
          ...wanted,
          attempt: 0,
          phase: {
            _tag: "Joined",
            burst: true,
            listing: undefined,
            members: new Map([[fold(self.nick), fresh(run, self.nick)]]),
            modes: { _tag: "Unknown" },
            synced: false,
            topic: { _tag: "Unknown" },
          },
        }
  );
};

/**
 * Folds an Activity into the Channels it touches.
 * @param run - The step.
 * @param activity - What happened.
 * @param rules - The Network's mode rules.
 * @param isChannel - Whether a name is a Channel's.
 */
export const foldActivity = (
  run: Run,
  activity: Activity,
  rules: ModeRules,
  isChannel: (name: string) => boolean
): void => {
  const fold = folder(run.state);

  switch (activity._tag) {
    case "Joined": {
      if (isSelf(run, activity.nick)) {
        joinedSelf(run, activity.channel);

        return;
      }

      const folded = fold(activity.nick);
      const member = fresh(run, activity.nick);

      changeJoined(run, activity.channel, (joined) => ({
        ...joined,
        listing:
          joined.listing === undefined ? undefined : withMember(joined.listing, folded, member),
        members: withMember(joined.members, folded, member),
      }));

      return;
    }

    case "Parted":
    case "Kicked": {
      kickedOrParted(run, activity.channel, activity.nick);

      return;
    }

    case "Quit": {
      const folded = fold(activity.nick);

      for (const channel of run.state.channels.values()) {
        changeJoined(run, channel.name, (joined) => ({
          ...joined,
          listing: joined.listing === undefined ? undefined : withoutMember(joined.listing, folded),
          members: withoutMember(joined.members, folded),
        }));
      }

      forgetUnshared(run, [folded]);

      return;
    }

    case "NickChanged": {
      const from = fold(activity.from);
      const to = fold(activity.to);

      for (const channel of run.state.channels.values()) {
        changeJoined(run, channel.name, (joined) => ({
          ...joined,
          listing:
            joined.listing === undefined
              ? undefined
              : renamed(joined.listing, from, to, activity.to),
          members: renamed(joined.members, from, to, activity.to),
        }));
      }

      updateOpen(run, (open) => {
        const seen = open.users.get(from);

        if (seen === undefined) {
          return open;
        }

        const users = new Map(open.users);
        users.delete(from);

        return { ...open, users: users.set(to, { ...seen, nick: activity.to }) };
      });

      return;
    }

    case "ModeChanged": {
      if (!isChannel(activity.target)) {
        return;
      }

      changeJoined(run, activity.target, (joined) => {
        let { members } = joined;

        for (const change of activity.changes) {
          const member = change.param === undefined ? undefined : members.get(fold(change.param));

          if (member !== undefined && rules.prefix.some((each) => each.mode === change.mode)) {
            members = withMember(members, fold(member.nick), {
              ...member,
              prefixes: changePrefix(member.prefixes, change, run.at),
            });
          }
        }

        const modes: Fact<ReadonlyMap<string, string | null>> =
          joined.modes._tag === "Known"
            ? {
                _tag: "Known",
                at: run.at,
                from: "ircd",
                value: applyModes(joined.modes.value, activity.changes, rules),
              }
            : joined.modes;

        return { ...joined, members, modes };
      });

      return;
    }

    case "TopicChanged": {
      changeJoined(run, activity.channel, (joined) => ({
        ...joined,
        topic: { _tag: "Known", at: run.at, from: "ircd", value: activity.topic },
      }));

      return;
    }

    case "AwayChanged": {
      see(run, activity.nick, (seen) => ({
        ...seen,
        away: { at: run.at, value: activity.away },
      }));

      return;
    }

    default: {
      activity satisfies never;
    }
  }
};

/**
 * Folds part of a `NAMES` listing into a Channel Self is in. The listing replaces the
 * members when it ends.
 * @param run - The step.
 * @param channel - The Channel, as the listing names it.
 * @param members - Its members, as listed.
 */
export const foldListed = (run: Run, channel: string, members: readonly Listed[]): void => {
  const fold = folder(run.state);

  changeJoined(run, channel, (joined) => {
    let listing = joined.listing ?? new Map<string, Member>();

    for (const member of members) {
      listing = withMember(listing, fold(member.nick), member);
    }

    return { ...joined, listing };
  });
};

/**
 * A `NAMES` listing ended. Its members are now the Channel's, and the end of the replies
 * to our `JOIN` with no topic means the Channel has none.
 * @param run - The step.
 * @param channel - The Channel, as the end names it.
 */
export const endOfNames = (run: Run, channel: string): void => {
  changeJoined(run, channel, (joined) => ({
    ...joined,
    burst: false,
    listing: undefined,
    members: joined.listing ?? joined.members,
    synced: true,
    topic:
      joined.burst && joined.topic._tag === "Unknown"
        ? { _tag: "Known", at: run.at, from: "ircd", value: null }
        : joined.topic,
  }));
};

// Keys and values, where the first of any that share a key is kept.
const once = <V>(entries: readonly (readonly [string, V])[]): ReadonlyMap<string, V> => {
  const next = new Map<string, V>();

  for (const [key, value] of entries) {
    if (!next.has(key)) {
      next.set(key, value);
    }
  }

  return next;
};

/**
 * Folds every key again after the casemapping changed: Channels, their members, and
 * the Users seen. Where two keys now fold together, the first is kept.
 * @param run - The step.
 */
export const refold = (run: Run): void => {
  const fold = folder(run.state);

  const members = (map: ReadonlyMap<string, Member>) =>
    once([...map.values()].map((member) => [fold(member.nick), member] as const));

  run.state = {
    ...run.state,
    channels: once(
      [...run.state.channels.values()].map((channel) => {
        const { phase } = channel;

        return [
          fold(channel.name),
          phase._tag === "Joined"
            ? {
                ...channel,
                phase: {
                  ...phase,
                  listing: phase.listing === undefined ? undefined : members(phase.listing),
                  members: members(phase.members),
                },
              }
            : channel,
        ] as const;
      })
    ),
  };

  updateOpen(run, (open) => ({
    ...open,
    users: once([...open.users.values()].map((seen) => [fold(seen.nick), seen] as const)),
  }));
};
