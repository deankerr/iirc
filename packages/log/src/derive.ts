import { parseCtcp } from "@iirc/protocol/ctcp";
import type { Line } from "@iirc/protocol/line";
import { parseStandardReply } from "@iirc/protocol/replies";
import type { Entry } from "@iirc/session/entry";
import type { StandingStep } from "@iirc/session/standing";
import { casemappingOf, messageOf, nickOf } from "@iirc/state";
import type { IrcState, StateChange } from "@iirc/state";
import { channelPlace, networkPlace, placeOf, placeOfSent, userPlace } from "@iirc/state/place";
import type { Place } from "@iirc/state/place";

import type { LoggedActivity, LoggedMessage } from "./fold.ts";
import type { Partners } from "./partners.ts";
import type { ActivityDetails } from "./rows.ts";

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

/** What one Line gives the derived tables, and the partners after it. */
interface Derived {
  readonly activity: readonly LoggedActivity[];
  readonly message: LoggedMessage | undefined;
  readonly partners: Partners;
}

// Every command PROT-1 and PROT-6 say the Daemon handles, beside the numerics. A Line of
// any other is an unknown Line.
const handled: ReadonlySet<string> = new Set([
  "AWAY",
  "ERROR",
  "FAIL",
  "INVITE",
  "JOIN",
  "KICK",
  "MODE",
  "NICK",
  "NOTE",
  "NOTICE",
  "PART",
  "PING",
  "PONG",
  "PRIVMSG",
  "QUIT",
  "TOPIC",
  "WARN",
]);

const numeric = /^\d{3}$/u;

// A Connection's heartbeat, which lag and silence already account for (LIVE-1 to LIVE-3).
// It says nothing of the Network, so it is in `/entries` and in no Timeline.
const heartbeat: ReadonlySet<string> = new Set(["PING", "PONG"]);

// The Activity of one Entry, numbered in the order they are added.
const activityOf = ({ at, network, sequence }: LineEntry) => {
  const rows: LoggedActivity[] = [];

  const add = (place: Place, details: ActivityDetails, actor: string | undefined) => {
    rows.push({
      ...(actor !== undefined && { actor }),
      at,
      details,
      network,
      ordinal: rows.length,
      place,
      sequence,
    });
  };

  return { add, rows };
};

type Add = ReturnType<typeof activityOf>["add"];

const withReason = (reason: string | undefined) => (reason === undefined ? {} : { reason });

interface ChangeContext {
  readonly add: Add;
  /** Who the Line is from, as its source gives them. */
  readonly actor: string | undefined;
  /** The Session's state before the Line, whose mapping names every place. */
  readonly irc: IrcState;
  readonly line: Line;
  /** The Network's partners, keyed under the mapping in force. */
  readonly partners: () => Partners;
}

// A partner's own Timeline, if they have one: someone with a place in the Log (KNOW-8).
const partnerPlaces = ({ irc, partners }: ChangeContext, nicks: readonly string[]) => {
  const places = new Map<string, Place>();

  for (const nick of nicks) {
    const place = userPlace(irc, nick);

    if (partners().has(place.key)) {
      places.set(place.key, place);
    }
  }

  return [...places.values()];
};

// A `QUIT` or `NICK` names no Channel, so it belongs to each Channel shared just before it
// and each partner's Timeline it concerns (KNOW-8), or, with neither, to the Network's.
const spread = (
  context: ChangeContext,
  channels: readonly string[],
  nicks: readonly string[],
  details: ActivityDetails,
  actor: string
) => {
  const places = [
    ...channels.map((channel) => channelPlace(context.irc, channel)),
    ...partnerPlaces(context, nicks),
  ];

  for (const place of places.length === 0 ? [networkPlace] : places) {
    context.add(place, details, actor);
  }
};

type ChannelChange = Extract<
  StateChange,
  {
    readonly _tag:
      | "Joined"
      | "Kicked"
      | "MemberJoined"
      | "MemberKicked"
      | "MemberParted"
      | "ModesChanged"
      | "Parted"
      | "TopicChanged";
  }
>;

// Every change in one Channel, named once each, so the guard below cannot miss one.
const channelChanges: Readonly<Record<ChannelChange["_tag"], true>> = {
  Joined: true,
  Kicked: true,
  MemberJoined: true,
  MemberKicked: true,
  MemberParted: true,
  ModesChanged: true,
  Parted: true,
  TopicChanged: true,
};

const isChannelChange = (change: StateChange): change is ChannelChange =>
  Object.hasOwn(channelChanges, change._tag);

// What a change in one Channel says, from `@iirc/state`'s one interpretation of the Line.
const inChannel = ({ actor, irc, line }: ChangeContext, change: ChannelChange) => {
  switch (change._tag) {
    case "Joined": {
      return { actor, details: { kind: "join" } } as const;
    }

    case "MemberJoined": {
      const { host, nick, user } = change;
      const mask = { ...(host !== undefined && { host }), ...(user !== undefined && { user }) };

      return { actor: nick, details: { kind: "join", ...mask } } as const;
    }

    case "Parted": {
      return { actor, details: { kind: "part", ...withReason(change.reason) } } as const;
    }

    case "MemberParted": {
      return {
        actor: change.nick,
        details: { kind: "part", ...withReason(change.reason) },
      } as const;
    }

    case "Kicked": {
      const nick = irc.self?.nick ?? "";

      return {
        actor: change.by,
        details: { kind: "kick", nick, ...withReason(change.reason) },
      } as const;
    }

    case "MemberKicked": {
      const { by, nick, reason } = change;

      return { actor: by, details: { kind: "kick", nick, ...withReason(reason) } } as const;
    }

    case "TopicChanged": {
      return { actor: change.by, details: { kind: "topic", topic: change.topic } } as const;
    }

    case "ModesChanged": {
      const { by, changes } = change;

      return {
        actor: by,
        details: { changes, kind: "mode", params: line.params.slice(1) },
      } as const;
    }

    default: {
      return change satisfies never;
    }
  }
};

// What a change says as Activity. Every tag is named, so a new change cannot compile until
// it says what it is.
const applied = (context: ChangeContext, change: StateChange) => {
  const { actor, add, irc, line } = context;

  if (isChannelChange(change)) {
    const { actor: by, details } = inChannel(context, change);

    add(channelPlace(irc, change.channel), details, by);

    return;
  }

  switch (change._tag) {
    case "UserQuit": {
      const { channels, nick, reason } = change;

      spread(context, channels, [nick], { kind: "quit", ...withReason(reason) }, nick);
      break;
    }

    case "NickChanged":
    case "UserRenamed": {
      const { channels, from, to } = change;

      spread(context, channels, [from, to], { from, kind: "nick", to }, from);
      break;
    }

    case "SelfModesChanged": {
      add(networkPlace, { kind: "mode", params: line.params.slice(1) }, actor);
      break;
    }

    // Not Activity: reads of state, or what a Session knows, which their numeric Line shows
    // on the Network's Timeline. A `MODE` that did not add up is one of its own: `uneven`.
    case "ChannelRead":
    case "ChannelUncertain":
    case "Forwarded":
    case "IsupportChanged":
    case "JoinRefused":
    case "NamesReplaced":
    case "PrefixRemoved":
    case "SelfAwayChanged":
    case "SelfMaskChanged":
    case "UserSeen":
    case "Welcomed": {
      break;
    }

    default: {
      change satisfies never;
    }
  }
};

// A Channel's `MODE` that did not add up names no `ModesChanged`, only that the Channel is
// uncertain (KNOW-6), and is still a change of modes in that Channel, kept raw.
const uneven = (context: ChangeContext, changes: readonly StateChange[]) => {
  if (context.line.command !== "MODE" || changes.some(({ _tag }) => _tag === "ModesChanged")) {
    return;
  }

  const uncertain = changes.find((change) => change._tag === "ChannelUncertain");

  if (uncertain !== undefined) {
    context.add(
      channelPlace(context.irc, uncertain.channel),
      { kind: "mode", params: context.line.params.slice(1) },
      context.actor
    );
  }
};

// A Line with nothing else to say is still on the Network's Timeline, so nothing the
// Network sends is invisible (MSG-6, PROT-1).
const asLine = ({ command, params }: Line): ActivityDetails => ({
  command,
  kind: handled.has(command) || numeric.test(command) ? "line" : "unknown",
  params,
});

// A `PRIVMSG` or `NOTICE` from someone: a Message, an `ACTION`, or CTCP (PROT-2, PROT-5).
const said = (
  entry: LineEntry,
  irc: IrcState,
  line: Line,
  add: Add
): LoggedMessage | undefined | "unsaid" => {
  const message = messageOf(line);

  if (message === undefined) {
    return "unsaid";
  }

  const { place, statusmsg } = placeOf(irc, line);
  const ctcp = parseCtcp(message.text);
  const actor = message.sender;

  switch (ctcp._tag) {
    case "NotCtcp":
    case "Action": {
      return {
        at: entry.at,
        kind: ctcp._tag === "Action" ? "ACTION" : message.kind,
        network: entry.network,
        place,
        sender: message.sender,
        sequence: entry.sequence,
        ...(statusmsg !== undefined && { statusmsg }),
        target: message.target,
        text: ctcp._tag === "Action" ? ctcp.text : message.text,
      };
    }

    case "Dcc": {
      add(place, { args: ctcp.args, kind: "dcc", subcommand: ctcp.subcommand }, actor);

      return undefined;
    }

    case "Other": {
      const reply = message.kind === "NOTICE";

      add(place, { args: ctcp.args, command: ctcp.command, kind: "ctcp", reply }, actor);

      return undefined;
    }

    default: {
      return ctcp satisfies never;
    }
  }
};

// Self's own `PRIVMSG` or `NOTICE`, by who Self was before it, placed by its Target. Self
// sent it whatever the Line claims, and only Ircds move state. A CTCP request of Self's is
// no Message, and the Activity a Timeline shows is what the Network says.
const sentMessage = (entry: LineEntry, irc: IrcState, line: Line): LoggedMessage | undefined => {
  const message = messageOf({ ...line, source: undefined }, irc.self?.nick);

  if (message === undefined) {
    return undefined;
  }

  const ctcp = parseCtcp(message.text);

  if (ctcp._tag !== "NotCtcp" && ctcp._tag !== "Action") {
    return undefined;
  }

  const { place, statusmsg } = placeOfSent(irc, line);

  return {
    at: entry.at,
    kind: ctcp._tag === "Action" ? "ACTION" : message.kind,
    network: entry.network,
    place,
    sender: message.sender,
    sequence: entry.sequence,
    ...(statusmsg !== undefined && { statusmsg }),
    target: message.target,
    text: ctcp._tag === "Action" ? ctcp.text : message.text,
  };
};

// What an inbound Line says, other than through `@iirc/state`'s changes.
const heard = (
  entry: LineEntry,
  irc: IrcState,
  line: Line,
  add: Add
): LoggedMessage | undefined | "unsaid" => {
  const actor = nickOf(line.source);

  switch (line.command) {
    case "PRIVMSG":
    case "NOTICE": {
      return said(entry, irc, line, add);
    }

    case "INVITE": {
      const [nick, channel] = line.params;

      if (nick === undefined || channel === undefined) {
        return "unsaid";
      }

      add(placeOf(irc, line).place, { channel, kind: "invite", nick }, actor);

      return undefined;
    }

    case "FAIL":
    case "WARN":
    case "NOTE": {
      const reply = parseStandardReply(line);

      if (reply === undefined) {
        return "unsaid";
      }

      const { code, command, context, description, kind } = reply;

      add(networkPlace, { code, command, context, description, kind: "reply", reply: kind }, actor);

      return undefined;
    }

    default: {
      return "unsaid";
    }
  }
};

// Each row placed in a User's Timeline makes them a partner, or keeps them one, keyed under
// the mapping the place was.
const partnersAfter = (
  partners: () => Partners,
  message: LoggedMessage | undefined,
  activity: readonly LoggedActivity[]
) => {
  let after: Partners | undefined;

  for (const { place } of message === undefined ? activity : [message, ...activity]) {
    after = place._tag === "User" ? (after ?? partners()).with(place.key, place.name) : after;
  }

  return after;
};

/**
 * What one Line Entry gives the derived tables: at most one Message, any number of
 * Activity rows, and the partners after them. Decided from the state before the Line,
 * which names every place, and from `@iirc/state`'s changes, so that it is the one
 * interpretation of what the Line meant.
 * @param step - The Standing before and after the Line, and what it changed.
 * @param entry - The Line Entry.
 * @param line - What it says, parsed.
 * @param partners - The Network's Direct Message partners before it.
 * @returns What it derives.
 */
export const derivedFrom = (
  { before, changes }: StandingStep,
  entry: LineEntry,
  line: Line,
  partners: Partners
): Derived => {
  const { irc } = before;

  // Partners are keyed under the mapping in force, which a new `CASEMAPPING` or a new
  // Session can change, so they are keyed again before a Line that reads or adds one. Only
  // such a Line pays for it, and only once for each change of mapping.
  let keyed: Partners | undefined;

  const partnersNow = () => {
    keyed ??= partners.under(casemappingOf(irc));

    return keyed;
  };

  if (entry.direction === "outbound") {
    const message = sentMessage(entry, irc, line);

    return { activity: [], message, partners: partnersAfter(partnersNow, message, []) ?? partners };
  }

  if (heartbeat.has(line.command)) {
    return { activity: [], message: undefined, partners };
  }

  const { add, rows } = activityOf(entry);
  const told = heard(entry, irc, line, add);
  const message = told === "unsaid" ? undefined : told;

  if (told === "unsaid") {
    const context = { actor: nickOf(line.source), add, irc, line, partners: partnersNow };

    for (const change of changes) {
      applied(context, change);
    }

    uneven(context, changes);
  }

  if (message === undefined && rows.length === 0) {
    add(networkPlace, asLine(line), nickOf(line.source));
  }

  return {
    activity: rows,
    message,
    partners: partnersAfter(partnersNow, message, rows) ?? keyed ?? partners,
  };
};
