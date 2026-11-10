/**
 * Which Timelines a Message or an Activity belongs to. It is worked out from what the
 * Client knows as the step begins to fold it in: Self's nick, `CHANTYPES`, `PREFIX`,
 * `STATUSMSG`, and who shares which Channel with Self. Each rule reads the protocol's
 * structure, never an Ircd's text. Keys are folded by the casemapping the Network last
 * declared, which outlives Connections, so a Timeline keeps its key across them.
 *
 * @packageDocumentation
 */
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import type { Source } from "@iirc/protocol/line";

import { isHighlight } from "./highlight.ts";
import { isSelf, namingNow, serverName } from "./meaning.ts";
import { inListing } from "./members.ts";
import type { Naming, Target } from "./names.ts";
import { parseChannel, parseNick, parseTargets } from "./names.ts";
import type { Activity, Marked, Named, News, Unrouted, Where } from "./news.ts";
import type { Run } from "./run.ts";
import { folder } from "./run.ts";

type MessageNews = Extract<News, { readonly _tag: "Message" }>;

type ActivityNews = Extract<News, { readonly _tag: "Activity" }>;

const network: Where = { _tag: "Network" };

/**
 * A name, keyed by the casemapping the Network last declared.
 * @param run - The step.
 * @param name - The name, as said.
 * @returns The name and its key.
 */
const named = (run: Run, name: string): Named => ({
  key: casefold(run.state.declared ?? defaultCasemapping, name),
  name,
});

const channel = (run: Run, name: string): Where => ({ _tag: "Channel", ...named(run, name) });

const direct = (run: Run, nick: string, existing: boolean): Where => ({
  _tag: "Direct",
  existing,
  ...named(run, nick),
});

// A server's name is a host name, which compares without regard to ASCII case.
const sameServer = (name: string, server: string): boolean =>
  casefold("ascii", name) === casefold("ascii", server);

/**
 * Whether a source is a User rather than the Ircd or another server: it has a user or a
 * host, as only a User's does, so a nick may hold a `.` there, or a bare name that is not
 * the Ircd's, in any case, and has no `.`, which a server's name has once it is more than
 * one label.
 * @param run - The step.
 * @param source - The Line's source, or `undefined` when it has none.
 * @returns Whether it is.
 */
const isUser = (run: Run, source: Source | undefined): boolean =>
  source !== undefined &&
  (source.user !== undefined ||
    source.host !== undefined ||
    (source.nick !== "" &&
      !source.nick.includes(".") &&
      !sameServer(source.nick, serverName(run))));

/**
 * The Channels Self is in.
 * @param run - The step.
 * @returns Each, by its key.
 */
const ownChannels = (run: Run): readonly Where[] =>
  [...run.state.channels.values()].flatMap(({ name, phase }) =>
    phase._tag === "Joined" ? [channel(run, name)] : []
  );

/**
 * The Channels a User shares with Self now, counting a listing still being read.
 * @param run - The step.
 * @param nick - The User.
 * @returns Each, by its key.
 */
const sharedChannels = (run: Run, nick: string): readonly Where[] => {
  const folded = folder(run.state)(nick);

  return [...run.state.channels.values()].flatMap(({ name, phase }) =>
    phase._tag === "Joined" &&
    (phase.members.has(folded) || (phase.listing !== undefined && inListing(phase.listing, folded)))
      ? [channel(run, name)]
      : []
  );
};

/**
 * Where a Message to one Target belongs. A Channel's, whoever said it. Otherwise a Direct
 * Message's, kept by the other participant: the sender's when it is to Self from a User,
 * the Target's when Self said it to a User. Anything else, such as a notice from the Ircd
 * or a Message to `*` or a `$mask`, is the Network's.
 * @param run - The step.
 * @param sender - The sender's nick, when a User whose name is a nick said it, else
 * `undefined`.
 * @param target - The Target, as said.
 * @returns The Timeline.
 */
const targetWhere = (run: Run, sender: string | undefined, target: Target): Where => {
  if (target._tag === "Channel") {
    return channel(run, target.name);
  }

  if (sender === undefined || target._tag === "Other") {
    return network;
  }

  if (isSelf(run, sender)) {
    return direct(run, target.nick, false);
  }

  return isSelf(run, target.nick) ? direct(run, sender, false) : network;
};

const sameWhere = (left: Where, right: Where): boolean =>
  left._tag === right._tag &&
  (left._tag === "Network" || ("key" in right && left.key === right.key));

/**
 * Each Timeline once, the first kept, and never none: what touches no Timeline belongs
 * to the Network's. Two names Knowledge tells apart can share a key in `where` while
 * the Connection and the Network fold differently.
 * @param where - The Timelines, in order.
 * @returns Them, each once.
 */
const placed = (where: readonly Where[]): readonly Where[] => {
  const once: Where[] = [];

  for (const each of where) {
    if (!once.some((kept) => sameWhere(kept, each))) {
      once.push(each);
    }
  }

  return once.length === 0 ? [network] : once;
};

/**
 * Where a Message belongs: where each of its Targets does, once each, in order. A Target
 * may be a list, as `#a,#b`, and no list is ever one Timeline.
 * @param run - The step.
 * @param sender - Who said it, by nick, or the Ircd's name.
 * @param fromUser - Whether a User said it, rather than the Ircd or another server.
 * @param targets - The Target parameter, as said.
 * @returns The Timelines.
 */
const messageWhere = (
  run: Run,
  sender: string,
  fromUser: boolean,
  targets: string
): readonly Where[] => {
  const naming = namingNow(run);
  const nick = fromUser ? parseNick(naming, sender) : undefined;

  return placed(parseTargets(naming, targets).map((target) => targetWhere(run, nick, target)));
};

/**
 * The Direct Message Timeline that follows a User's nick, when both nicks are nicks.
 * @param run - The step.
 * @param naming - The Network's naming rules.
 * @param from - The old nick.
 * @param to - The new nick.
 * @returns The move, or none when either is not a nick.
 */
const renamedDirect = (run: Run, naming: Naming, from: string, to: string): readonly Where[] =>
  parseNick(naming, from) === undefined || parseNick(naming, to) === undefined
    ? []
    : [{ _tag: "DirectRenamed", ...named(run, from), to: named(run, to) }];

/**
 * The Timelines an Activity touches, before {@link placed}.
 * @param run - The step, before the Activity is folded in.
 * @param naming - The Network's naming rules.
 * @param activity - The Activity.
 * @param live - Whether it is happening now, rather than read from history.
 * @returns The Timelines.
 */
const activityTimelines = (
  run: Run,
  naming: Naming,
  activity: Activity,
  live: boolean
): readonly Where[] => {
  // Another User's Direct Messages, when their name is a nick, as a Message's sender is.
  const theirs = (nick: string): readonly Where[] =>
    parseNick(naming, nick) === undefined ? [] : [direct(run, nick, true)];

  switch (activity._tag) {
    case "Joined":
    case "Parted":
    case "Kicked":
    case "TopicChanged": {
      return [channel(run, activity.channel)];
    }

    case "ModeChanged": {
      return parseChannel(naming, activity.target) === undefined
        ? [network]
        : [channel(run, activity.target)];
    }

    case "Quit": {
      return isSelf(run, activity.nick)
        ? [network, ...ownChannels(run)]
        : [...sharedChannels(run, activity.nick), ...theirs(activity.nick)];
    }

    case "NickChanged": {
      if (isSelf(run, activity.from)) {
        return [network, ...ownChannels(run)];
      }

      // Only a rename that is happening now moves a Timeline. From history, the old nick may
      // be someone else's by now, so it is shown where it belongs and moves nothing.
      const renamed = live
        ? renamedDirect(run, naming, activity.from, activity.to)
        : theirs(activity.from);

      return [...sharedChannels(run, activity.from), ...renamed];
    }

    case "AwayChanged": {
      return isSelf(run, activity.nick) ? [network] : theirs(activity.nick);
    }

    default: {
      return activity satisfies never;
    }
  }
};

/**
 * Where an Activity belongs.
 * @param run - The step, before the Activity is folded in.
 * @param activity - The Activity.
 * @param live - Whether it is happening now, rather than read from history.
 * @returns The Timelines.
 */
const activityWhere = (run: Run, activity: Activity, live: boolean): readonly Where[] =>
  placed(activityTimelines(run, namingNow(run), activity, live));

/**
 * A Message read from a Line, with where it belongs.
 * @param run - The step, before the Message is folded in.
 * @param message - The Message.
 * @param source - The Line's source, or `undefined` when it has none.
 * @returns The Message, routed.
 */
export const routeMessage = (
  run: Run,
  message: Unrouted<MessageNews>,
  source: Source | undefined
): MessageNews => {
  const fromUser = isUser(run, source);

  return {
    ...message,
    highlight: isHighlight(run, message, fromUser),
    self: fromUser && isSelf(run, message.sender),
    where: messageWhere(run, message.sender, fromUser, message.target),
  };
};

/**
 * A Message Self said, as the Owner's intent, with where it belongs.
 * @param run - The step.
 * @param message - The Message.
 * @returns The Message, routed.
 */
export const routeOurs = (run: Run, message: Unrouted<MessageNews>): MessageNews => ({
  ...message,
  highlight: false,
  self: true,
  where: messageWhere(run, message.sender, true, message.target),
});

/**
 * The Timeline an Owner's `Read` marks: the Network's own for no Target, else the one
 * Target's, read as a `Say`'s is, with a Direct Message partner's `existing`, since
 * marking read starts no Timeline. A list, a mask, or anything else that names no one
 * Timeline marks none. Any `,` makes a list, before any item is read, so `#a,`, `,#a`,
 * and `#a,,` name no one Timeline, though only `#a` is in each.
 * @param run - The step.
 * @param target - The Target, as the Owner named it, or `null` for the Network's own.
 * @returns The Timeline, or `undefined` for none.
 */
export const markedBy = (run: Run, target: string | null): Marked | undefined => {
  if (target === null) {
    return { _tag: "Network" };
  }

  if (target.includes(",")) {
    return undefined;
  }

  const [only] = parseTargets(namingNow(run), target);

  if (only === undefined || only._tag === "Other") {
    return undefined;
  }

  return only._tag === "Channel"
    ? { _tag: "Channel", ...named(run, only.name) }
    : { _tag: "Direct", existing: true, ...named(run, only.nick) };
};

/**
 * An Activity, with where it belongs.
 * @param run - The step, before the Activity is folded in.
 * @param activity - The Activity.
 * @returns The Activity, routed.
 */
export const routeActivity = (run: Run, activity: Unrouted<ActivityNews>): ActivityNews => ({
  ...activity,
  where: activityWhere(run, activity.activity, activity.live),
});
