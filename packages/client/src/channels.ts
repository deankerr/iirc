/**
 * The Channel machines: a keyed `Map` of reducer states, one per Channel the Owner
 * wants, keyed by its name folded by the casemapping in force. Wanted, Joining, Joined
 * (Syncing, Synced), Refused, and Kicked, with one backoff for every wait.
 *
 * @packageDocumentation
 */
import { chantypesOf, limitsOf, targetLimitsOf } from "@iirc/protocol/isupport";
import { isRejected, join, part } from "@iirc/protocol/line";

import { backoff } from "./backoff.ts";
import type { WantedChannel } from "./configuration.ts";
import { Instant } from "./ids.ts";
import type { Casemapping, Fact } from "./known.ts";
import {
  changeListing,
  inListing,
  listedMembers,
  listMore,
  withMember,
  withoutListed,
  withoutMember,
} from "./members.ts";
import type { Listed, ModeRules } from "./modes.ts";
import { applyModes, changePrefix } from "./modes.ts";
import { changesNothingHere } from "./news.ts";
import type { Activity, ModeChange } from "./news.ts";
import type { Run } from "./run.ts";
import { folder, ignore, linkOf, send, sendSecret, updateOpen } from "./run.ts";
import type { Channel, Joined, Listing, Member, Seen, State } from "./state.ts";
import { userIn, usersFrom, usersOf, withUser, withoutUsers } from "./users.ts";
import { openOf, sessionOf } from "./views.ts";
import { keptWatched } from "./watched.ts";

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

/**
 * Whether a User shares a Channel with Self, counting a listing still being read.
 * @param state - The State.
 * @param folded - The User's nick, folded by the Connection's casemapping.
 * @returns Whether they do.
 */
export const shares = (state: State, folded: string): boolean =>
  [...state.channels.values()].some(
    ({ phase }) =>
      phase._tag === "Joined" &&
      (phase.members.has(folded) ||
        (phase.listing !== undefined && inListing(phase.listing, folded)))
  );

/**
 * Forgets what was seen of every User who no longer shares a Channel with Self, unless
 * a Feature keeps them while `MONITOR` says they are online, so the Users kept are never
 * more than the members and the monitored kept. It runs wherever membership or the
 * monitor list is replaced or removed.
 * @param run - The step.
 * @param left - The only Users who may have left, by folded nick, when it is known, such
 * as the one who parted. Left out, every User seen.
 */
export const pruneUsers = (run: Run, left?: readonly string[]): void => {
  const users = openOf(run.state)?.users;

  if (users === undefined || users.size === 0) {
    return;
  }

  const gone = (left ?? usersOf(users).map(([folded]) => folded)).filter(
    (folded) =>
      userIn(users, folded) !== undefined && !shares(run.state, folded) && !keptWatched(run, folded)
  );

  if (gone.length === 0) {
    return;
  }

  updateOpen(run, (open) => ({ ...open, users: withoutUsers(open.users, gone) }));
};

/**
 * Takes the Owner's wanted Channels. A new one is Wanted, one no longer wanted is parted
 * if Self is in it or joining it, and a Channel Self was put in without asking stays
 * until Self leaves it, wanted from now on if the Owner names it. On a new
 * Configuration, one refused for want of its key may try again. Run again after the
 * casemapping changes, it keeps every machine that survived the refold, and makes one
 * for each wanted Channel that the new casemapping tells apart.
 * @param run - The step.
 * @param wanted - The Channels in the Configuration.
 * @param fresh - Whether this is a new Configuration, rather than a refold.
 */
export const reconcile = (run: Run, wanted: readonly WantedChannel[], fresh = true): void => {
  const fold = folder(run.state);
  const next = new Map<string, Channel>();
  const inSession = sessionOf(run.state) !== undefined;

  for (const { key, name } of wanted) {
    const folded = fold(name);
    const was = run.state.channels.get(folded);

    if (next.has(folded)) {
      continue;
    }

    const waiting = fresh && was?.phase._tag === "Refused" && was.phase.retry === undefined;

    next.set(
      folded,
      was === undefined
        ? { attempt: 0, key, name, phase: { _tag: "Wanted" }, wanted: true }
        : { ...was, key, name, phase: waiting ? { _tag: "Wanted" } : was.phase, wanted: true }
    );
  }

  for (const [folded, channel] of run.state.channels) {
    if (!next.has(folded) && !channel.wanted) {
      next.set(folded, channel);
    }
  }

  const gone = [...run.state.channels].filter(([folded]) => !next.has(folded));

  run.state = { ...run.state, channels: next };

  for (const [, channel] of gone) {
    if (inSession && (channel.phase._tag === "Joined" || channel.phase._tag === "Joining")) {
      send(run, part(channel.name), "PART");
    }
  }

  pruneUsers(run);
};

/**
 * Joins every Channel that is Wanted, while in a Session. Channels without a key share
 * `JOIN` Lines, as many to a Line as fit and as `TARGMAX` allows. A Channel with a key
 * goes alone, as a `JoinWithKey` with its Credential named. A name that cannot be sent
 * is refused until the Configuration changes. Nothing is joined while the Channels wait
 * on a service login.
 * @param run - The step.
 */
export const joinWanted = (run: Run): void => {
  const open = openOf(run.state);
  const session = sessionOf(run.state);

  if (
    open === undefined ||
    session === undefined ||
    session.identifying !== undefined ||
    run.state.configuration?.enabled !== true ||
    linkOf(run)?.closing !== undefined
  ) {
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
 * Every wanted Channel goes back to Wanted, as when a Session ends, and every Channel
 * Self was put in without asking is forgotten, never to be joined again.
 * @param state - The State.
 * @returns The State, with every wanted Channel Wanted.
 */
export const allWanted = (state: State): State => ({
  ...state,
  channels: new Map(
    [...state.channels].flatMap(([folded, channel]) =>
      channel.wanted ? [[folded, { ...channel, phase: { _tag: "Wanted" } }] as const] : []
    )
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

const none: ReadonlySet<string> = new Set();

const fresh = (run: Run, nick: string): Member => ({
  complete: false,
  nick,
  prefixes: { _tag: "Known", at: run.at, from: "ircd", value: none },
});

const isSelf = (run: Run, nick: string): boolean => {
  const self = sessionOf(run.state);

  return self !== undefined && folder(run.state)(self.nick) === folder(run.state)(nick);
};

/**
 * Records what a Line showed of another User, while they share a Channel with Self, or a
 * Feature keeps them while `MONITOR` says they are online, so what is kept is bounded by
 * the members and the monitored kept.
 * @param run - The step.
 * @param nick - The User.
 * @param change - What it showed.
 */
export const see = (run: Run, nick: string, change: (seen: Seen) => Seen): void => {
  const folded = folder(run.state)(nick);

  const shared = [...run.state.channels.values()].some(
    ({ phase }) => phase._tag === "Joined" && phase.members.has(folded)
  );

  if ((!shared && !keptWatched(run, folded)) || isSelf(run, nick)) {
    return;
  }

  updateOpen(run, (open) => {
    const was: Seen = userIn(open.users, folded) ?? {
      account: { _tag: "Unknown" },
      away: { _tag: "Unknown" },
      mask: { _tag: "Unknown" },
      nick,
      realname: { _tag: "Unknown" },
    };

    return { ...open, users: withUser(open.users, folded, change(was)) };
  });
};

const kickedOrParted = (run: Run, channel: string, nick: string): void => {
  const fold = folder(run.state);

  if (isSelf(run, nick)) {
    const folded = fold(channel);
    const was = run.state.channels.get(folded);

    if (was !== undefined && !was.wanted) {
      const channels = new Map(run.state.channels);

      channels.delete(folded);
      run.state = { ...run.state, channels };
    } else {
      changeChannel(run, folded, (wanted) => ({
        ...wanted,
        attempt: wanted.attempt + 1,
        phase: { _tag: "Kicked", retry: retryAt(run, wanted) },
      }));
    }

    pruneUsers(run);

    return;
  }

  changeJoined(run, channel, (joined) => ({
    ...joined,
    listing: joined.listing === undefined ? undefined : withoutListed(joined.listing, fold(nick)),
    members: withoutMember(joined.members, fold(nick)),
  }));
  pruneUsers(run, [fold(nick)]);
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

/** The most Channels kept that Self was put in without asking, when `CHANLIMIT` says no fewer. */
const maxUnwanted = 64;

const prefixOf = (name: string): string => String.fromCodePoint(name.codePointAt(0) ?? 0);

// Whether one more unwanted Channel may be modelled. `CHANLIMIT` counts by groups of
// prefixes, such as `#:1,&:1` or `#&:2`, so the Channels Self was put in without asking
// are counted within the incoming Channel's group alone. A prefix in no group, or a
// group with no limit, falls back to a fixed cap, counted the same way.
const admits = (run: Run, channel: string): boolean => {
  const limits = limitsOf(openOf(run.state)?.isupport.get("CHANLIMIT"));
  const groupOf = (name: string) => limits.find((each) => each.of.includes(prefixOf(name)));
  const group = groupOf(channel);

  const counted = [...run.state.channels.values()].filter(
    (each) => !each.wanted && groupOf(each.name)?.of === group?.of
  ).length;

  return counted < (group?.limit ?? maxUnwanted);
};

const joining = (run: Run, nick: string): Joined => ({
  _tag: "Joined",
  burst: true,
  listing: undefined,
  members: new Map([[folder(run.state)(nick), fresh(run, nick)]]),
  modes: { _tag: "Unknown" },
  queried: false,
  synced: false,
  topic: { _tag: "Unknown" },
});

const joinedSelf = (run: Run, channel: string): void => {
  const folded = folder(run.state)(channel);
  const self = sessionOf(run.state);
  const was = run.state.channels.get(folded);

  if (self === undefined || was?.phase._tag === "Joined") {
    return;
  }

  if (was !== undefined) {
    setChannel(run, folded, { ...was, attempt: 0, phase: joining(run, self.nick) });

    return;
  }

  // Self was put in a Channel without asking. It is modelled, up to a bound, and not
  // undone. A name that is no Channel by `CHANTYPES` is not one, and counts against nothing.
  const first = channel.codePointAt(0);
  const chantypes = chantypesOf(openOf(run.state)?.isupport.get("CHANTYPES"));

  if (first === undefined || !chantypes.includes(String.fromCodePoint(first))) {
    ignore(run, { _tag: "Malformed", command: "JOIN" });

    return;
  }

  if (!admits(run, channel)) {
    ignore(run, { _tag: "NotNow", input: "Received" });

    return;
  }

  setChannel(run, folded, {
    attempt: 0,
    key: undefined,
    name: channel,
    phase: joining(run, self.nick),
    wanted: false,
  });
};

// Applies membership mode changes, such as `+o peer`, to members.
const prefixed = (
  start: ReadonlyMap<string, Member>,
  changes: readonly ModeChange[],
  rules: ModeRules,
  at: Instant,
  fold: (name: string) => string
): ReadonlyMap<string, Member> => {
  let members = start;

  for (const change of changes) {
    const member = change.param === undefined ? undefined : members.get(fold(change.param));

    if (member !== undefined && rules.prefix.some((each) => each.mode === change.mode)) {
      members = withMember(members, fold(member.nick), {
        ...member,
        prefixes: changePrefix(member.prefixes, change, at),
      });
    }
  }

  return members;
};

// Self joined a Channel, or another User did, and is a member from now.
const memberJoined = (run: Run, channel: string, nick: string): void => {
  if (isSelf(run, nick)) {
    joinedSelf(run, channel);

    return;
  }

  const folded = folder(run.state)(nick);
  const member = fresh(run, nick);

  changeJoined(run, channel, (joined) => ({
    ...joined,
    listing:
      joined.listing === undefined
        ? undefined
        : changeListing(joined.listing, (listed) => withMember(listed, folded, member)),
    members: withMember(joined.members, folded, member),
  }));
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

  // An invitation, an answer to `OPER`, and what `MONITOR` tells change no Channel.
  if (changesNothingHere(activity)) {
    return;
  }

  switch (activity._tag) {
    // What the Network said of something sent, and a CTCP, change no Channel.
    case "StandardReply":
    case "CtcpRequest":
    case "CtcpReply":
    case "CtcpSent":
    case "CtcpUnsent": {
      return;
    }

    case "Joined": {
      memberJoined(run, activity.channel, activity.nick);

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
          listing: joined.listing === undefined ? undefined : withoutListed(joined.listing, folded),
          members: withoutMember(joined.members, folded),
        }));
      }

      pruneUsers(run, [folded]);

      return;
    }

    case "NickChanged": {
      const from = fold(activity.from);
      const to = fold(activity.to);

      for (const channel of run.state.channels.values()) {
        changeJoined(run, channel.name, (joined) => ({
          ...joined,
          listing:
            joined.listing === undefined || !inListing(joined.listing, from)
              ? joined.listing
              : changeListing(joined.listing, (listed) => renamed(listed, from, to, activity.to)),
          members: renamed(joined.members, from, to, activity.to),
        }));
      }

      updateOpen(run, (open) => {
        const seen = userIn(open.users, from);

        if (seen === undefined) {
          return open;
        }

        return {
          ...open,
          users: withUser(withoutUsers(open.users, [from]), to, { ...seen, nick: activity.to }),
        };
      });

      return;
    }

    case "ModeChanged": {
      if (!isChannel(activity.target)) {
        return;
      }

      changeJoined(run, activity.target, (joined) => {
        // A pending listing replaces the members when it ends, so it takes the change too.
        const members = prefixed(joined.members, activity.changes, rules, run.at, fold);

        const listing =
          joined.listing === undefined
            ? undefined
            : changeListing(joined.listing, (listed) =>
                prefixed(listed, activity.changes, rules, run.at, fold)
              );

        const modes: Fact<ReadonlyMap<string, string | null>> =
          joined.modes._tag === "Known"
            ? {
                _tag: "Known",
                at: run.at,
                from: "ircd",
                value: applyModes(joined.modes.value, activity.changes, rules),
              }
            : joined.modes;

        return { ...joined, listing, members, modes };
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
        away: { _tag: "Known", at: run.at, from: "ircd", value: activity.away },
      }));

      return;
    }

    case "AccountChanged": {
      const known = { _tag: "Known", at: run.at, from: "ircd", value: activity.account } as const;

      if (isSelf(run, activity.nick)) {
        updateOpen(run, (open) => ({ ...open, presence: { ...open.presence, account: known } }));
      } else {
        see(run, activity.nick, (seen) => ({ ...seen, account: known }));
      }

      return;
    }

    default: {
      activity satisfies never;
    }
  }
};

/** One `353`'s part of a listing: its members, keyed by folded nick. */
export type ListedPart = readonly (readonly [string, Member])[];

/**
 * The part of a listing one `353` gives.
 * @param run - The step.
 * @param members - Its members, as listed.
 * @param complete - Whether a Feature made a member's prefixes complete.
 * @returns The part.
 */
export const listedPart = (
  run: Run,
  members: readonly Listed[],
  complete: (nick: string) => boolean
): ListedPart => {
  const fold = folder(run.state);

  return members.map(
    (member) =>
      [
        fold(member.nick),
        { complete: complete(member.nick), nick: member.nick, prefixes: member.prefixes },
      ] as const
  );
};

/**
 * Folds part of a `NAMES` listing no Lookup took into a Channel Self is in. The listing
 * replaces the members when it ends.
 * @param run - The step.
 * @param channel - The Channel, as the listing names it.
 * @param part - What one `353` lists.
 */
export const foldListed = (run: Run, channel: string, part: ListedPart): void => {
  changeJoined(run, channel, (joined) => ({ ...joined, listing: listMore(joined.listing, part) }));
};

/**
 * A `NAMES` listing ended. Its members are now the Channel's, and the end of the replies
 * to our `JOIN` with no topic means the Channel has none. A Lookup's own listing ends by
 * its own `366`, after any part the Channel's listing held before the Lookup took the
 * rest, as when it was asked while the `JOIN`'s listing came.
 * @param run - The step.
 * @param channel - The Channel, as the end names it.
 * @param own - A `NAMES` Lookup's own listing, which this `366` ends.
 */
export const endOfNames = (run: Run, channel: string, own?: Listing): void => {
  changeJoined(run, channel, (joined) => {
    const listing =
      own === undefined ? joined.listing : listMore(joined.listing, [...listedMembers(own)]);

    return {
      ...joined,
      burst: false,
      listing: undefined,
      members: listing === undefined ? joined.members : listedMembers(listing),
      synced: true,
      topic:
        joined.burst && joined.topic._tag === "Unknown"
          ? { _tag: "Known", at: run.at, from: "ircd", value: null }
          : joined.topic,
    };
  });
  pruneUsers(run);
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
 * Folds every key again after the casemapping changed: Channels, their members, the
 * Users seen, and the Channels asked who is in them. Where two keys now fold together,
 * the first is kept.
 * @param run - The step.
 */
const refold = (run: Run): void => {
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
                  listing:
                    phase.listing === undefined
                      ? undefined
                      : { members: members(listedMembers(phase.listing)), parts: [] },
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
    users: usersFrom(once(usersOf(open.users).map(([, seen]) => [fold(seen.nick), seen] as const))),
    whoAsked: once([...open.whoAsked.values()].map((asked) => [fold(asked.name), asked] as const)),
  }));
};

/**
 * Takes another casemapping: every key is folded again, and the Channels are reconciled
 * with the Configuration, so a wanted Channel the new mapping tells apart from another
 * gets its own machine, and the first of any it merges is kept.
 * @param run - The step.
 * @param mapping - The casemapping now in force.
 */
export const remap = (run: Run, mapping: Casemapping): void => {
  run.state = { ...run.state, casemapping: mapping };
  refold(run);
  reconcile(run, run.state.configuration?.channels ?? [], false);
  joinWanted(run);
};
