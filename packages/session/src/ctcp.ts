import type { Tuning } from "@iirc/lifecycle/tuning";
import { ctcpReply, ctcpText, parseCtcp, parseReplyTarget } from "@iirc/protocol/ctcp";
import type { Line } from "@iirc/protocol/line";
import type { OutboundLine } from "@iirc/protocol/outbound";
import { casefold, casemappingOf, initialState, nickOf } from "@iirc/state";
import type { Casemapping, IrcState } from "@iirc/state";
import { placeOf } from "@iirc/state/place";

import type { Entry } from "./entry.ts";
import type { Standing } from "./standing.ts";

// These are named here, not in `Tuning`: they bound what Standing holds, or what a reply
// can say, and none is a policy an Owner has a reason to change.

/** The cause a CTCP reply is recorded with (LOG-5). */
export const ctcpReplyCause = "ctcp-reply";

/** What CTCP `VERSION` is answered with (PROT-3). */
export const versionReply = "iirc";

/** Why a CTCP reply that waited in its lane past its window is Dropped (PROT-4). */
export const replyExpired = "the CTCP reply waited longer than the Network's CTCP window";

/**
 * The longest argument to CTCP `PING` that is echoed, in UTF-8 bytes. A `PING` carries a
 * timestamp, and anything longer gets no reply, so that the echo always fits in a Line
 * with the prefix an Ircd puts on it.
 */
export const longestPingArgument = 128;

/**
 * How many replies Standing holds for the Network. It is the most `ctcpNetworkLimit` may
 * be, and no more than the limit can be pending at once, so any limit is counted exactly
 * (PROT-4).
 */
export const heldReplyTimes = 100;

/**
 * How many Users Standing holds the last reply time of. Only a User whose interval has run
 * out is ever let go of, so while every one held is still inside theirs, a new User gets no
 * reply. With the default limits that takes 256 Users answered within 10 seconds, which the
 * Network's limit of 5 a minute never allows.
 */
export const heldRepliedUsers = 256;

/** One CTCP reply that counts against the Network's limit (PROT-4). */
export interface CtcpReplied {
  /** When it was sent, or, while it is pending, when it was decided. */
  readonly at: number;
  /**
   * The request it answers, when the Daemon decided it, which is what a host finds it by.
   * Otherwise the outbound `NOTICE` itself.
   */
  readonly sequence: number;
  /** Who it went to, or goes to, as spelled. */
  readonly to: string;
  /**
   * The `NOTICE` the Daemon decided to send and that is not yet recorded as sent or
   * Dropped. While it is here the reply counts, however long ago it was decided.
   */
  readonly pending?: OutboundLine;
}

/** When a User was last replied to, and their nick as spelled then. */
export interface RepliedUser {
  readonly at: number;
  readonly nick: string;
}

/**
 * The CTCP replies that count against the limits, which outlast every Connection, so that
 * neither a reconnect nor a restart resets a limit (PROT-4, HOST-3).
 *
 * A reply the Daemon decides on counts from that moment, so a flood in one read is limited
 * before anything is sent, and it keeps counting while it waits in the lane. Once it is
 * recorded as sent, it counts from then. One that waited past the window is Dropped when it
 * reaches the head of the lane, and one Dropped, or still queued when its Connection ended,
 * counts no more. So no more than the limit leave within any window. Any other CTCP `NOTICE`
 * Self sends, such as one the Owner sent raw, counts once it is recorded.
 */
export interface CtcpReplies {
  /** The mapping `byUser` is keyed under, which it is keyed under again when it changes. */
  readonly casemapping: Casemapping;
  /** Each User replied to, by nick casefolded under {@link casemapping}. */
  readonly byUser: ReadonlyMap<string, RepliedUser>;
  /** The latest replies, oldest first, at most {@link heldReplyTimes}. */
  readonly latest: readonly CtcpReplied[];
}

/** No reply yet. */
export const noCtcpReplies: CtcpReplies = {
  byUser: new Map(),
  casemapping: casemappingOf(initialState),
  latest: [],
};

/** A reply decided on, to send after its commit, and when it stops being worth sending. */
export interface DecidedReply {
  readonly decidedAt: number;
  readonly line: OutboundLine;
}

type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

type DroppedEntry = Extract<Entry, { readonly _tag: "Dropped" }>;

/**
 * The time at a moment, in UTC, as ISO 8601 to the second with `Z`. CTCP `TIME` gives this,
 * from the Entry's own time, so a replay says the same whatever the process's timezone, and
 * none is revealed (PROT-3).
 * @param at - Epoch milliseconds.
 * @returns Such as `2026-11-06T14:39:40Z`.
 */
export const utcTime = (at: number): string =>
  new Date(at).toISOString().replace(/\.\d{3}Z$/u, "Z");

const encoder = new TextEncoder();

// What an enabled command is answered with, or `undefined` for one that is not answered.
// Anything else, `CLIENTINFO`, `USERINFO`, `FINGER`, and `DCC` among them, has no answer,
// and its Activity row is all that is left of it (PROT-3, PROT-5).
const answerOf = (
  tuning: Tuning,
  command: string,
  args: string,
  at: number
): string | undefined => {
  switch (command) {
    case "VERSION": {
      return tuning.ctcpVersion ? versionReply : undefined;
    }

    case "PING": {
      return tuning.ctcpPing && encoder.encode(args).length <= longestPingArgument
        ? args
        : undefined;
    }

    case "TIME": {
      return tuning.ctcpTime ? utcTime(at) : undefined;
    }

    default: {
      return undefined;
    }
  }
};

// The replies keyed under the mapping in force, from each User's nick as spelled. Where
// two become one User, the later time stands (KNOW-3).
const under = (replies: CtcpReplies, casemapping: Casemapping): CtcpReplies => {
  if (casemapping === replies.casemapping) {
    return replies;
  }

  const byUser = new Map<string, RepliedUser>();
  const oldestFirst = [...replies.byUser.values()].toSorted((one, other) => one.at - other.at);

  for (const user of oldestFirst) {
    byUser.set(casefold(casemapping, user.nick), user);
  }

  return { ...replies, byUser, casemapping };
};

const keyOf = (replies: CtcpReplies, nick: string) => casefold(replies.casemapping, nick);

const isPendingTo = (replies: CtcpReplies, key: string) =>
  replies.latest.some(({ pending, to }) => pending !== undefined && keyOf(replies, to) === key);

// Whether a User is inside their interval at `at`: replied to within it, or with a reply
// still pending. A time after `at`, as a clock set back gives, is inside it.
const isHeldBack = (replies: CtcpReplies, tuning: Tuning, key: string, at: number) => {
  const last = replies.byUser.get(key);

  return (
    (last !== undefined && at < last.at + tuning.ctcpUserIntervalMillis) ||
    isPendingTo(replies, key)
  );
};

// Whether the Network has room for one more reply at `at`: fewer than the limit pending, or
// sent within the window.
const networkHasRoom = (replies: CtcpReplies, tuning: Tuning, at: number) => {
  const since = at - tuning.ctcpNetworkWindowMillis;
  let counted = 0;

  for (const { at: replied, pending } of replies.latest) {
    counted += pending !== undefined || replied > since ? 1 : 0;
  }

  return counted < tuning.ctcpNetworkLimit;
};

// The Users held, less those whose interval has run out at `at`.
const withoutExpired = (
  replies: CtcpReplies,
  tuning: Tuning | undefined,
  at: number
): ReadonlyMap<string, RepliedUser> => {
  if (tuning === undefined) {
    return replies.byUser;
  }

  const byUser = new Map(replies.byUser);

  for (const [key, user] of replies.byUser) {
    if (at >= user.at + tuning.ctcpUserIntervalMillis && !isPendingTo(replies, key)) {
      byUser.delete(key);
    }
  }

  return byUser;
};

// Whether a User not held yet could be, without letting go of one still inside their
// interval (PROT-4).
const hasRoomFor = (replies: CtcpReplies, tuning: Tuning, key: string, at: number) =>
  replies.byUser.has(key) ||
  replies.byUser.size < heldRepliedUsers ||
  withoutExpired(replies, tuning, at).size < heldRepliedUsers;

// The Tuning of the Connection a Line came on, while it is under way and nobody has begun
// to close it. A reply on one that is closing would only be Dropped.
const liveTuning = (standing: Standing, { connection }: LineEntry): Tuning | undefined =>
  standing.connection?.sequence === connection &&
  standing.connection.closing === undefined &&
  standing.attempt?.sequence === connection
    ? standing.attempt.tuning
    : undefined;

const tuningOf = (standing: Standing, connection: number): Tuning | undefined =>
  standing.attempt?.sequence === connection ? standing.attempt.tuning : undefined;

// Each request's sender as a User a reply can go to, and never a Channel or a mask (HOST-3).
const senderOf = (irc: IrcState, line: Line) => {
  const nick = nickOf(line.source);

  return nick === undefined ? undefined : parseReplyTarget(nick, irc.isupport);
};

/**
 * Whether to answer one inbound Line as a CTCP request, and with what (PROT-3, PROT-4,
 * HOST-3). Pure: it reads Standing as it was just before the Line, and the time is the
 * Entry's, so a replay decides the same. The answer is a `NOTICE` to the sender, and none
 * is given:
 *
 * - to anything but a `PRIVMSG`, so a `NOTICE` is never answered;
 * - to a Line the Network's Timeline takes (MSG-2): before the welcome, to `*` or `AUTH`,
 *   from a source that is not `nick!user@host`, or to a `$` mask;
 * - to a sender whose nick could name a Channel or a mask, as `parseReplyTarget` reads it,
 *   so a forged source cannot turn a reply on anyone else;
 * - to Self;
 * - to a command that is not enabled in the Connection's Tuning, and `PING` whose
 *   argument is longer than {@link longestPingArgument};
 * - to a User within `ctcpUserIntervalMillis` of their last reply, or with one pending;
 * - once `ctcpNetworkLimit` replies are pending or were sent within
 *   `ctcpNetworkWindowMillis`;
 * - to a new User while {@link heldRepliedUsers} are held and each is inside their interval;
 * - on a Connection that is closing, or is not the one under way.
 * @param standing - The Network's Standing just before the Line.
 * @param entry - The Line's Entry.
 * @param line - The Line, parsed.
 * @returns The reply to send, or `undefined` for none.
 */
export const ctcpAnswer = (
  standing: Standing,
  entry: LineEntry,
  line: Line
): OutboundLine | undefined => {
  const tuning = liveTuning(standing, entry);
  const [, text = ""] = line.params;

  if (entry.direction !== "inbound" || line.command !== "PRIVMSG" || tuning === undefined) {
    return undefined;
  }

  const { irc } = standing;
  const sender = senderOf(irc, line);
  const ctcp = parseCtcp(text);
  const casemapping = casemappingOf(irc);

  if (
    ctcp._tag !== "Other" ||
    sender === undefined ||
    placeOf(irc, line).place._tag === "Network" ||
    (irc.self !== undefined &&
      casefold(casemapping, sender.toString()) === casefold(casemapping, irc.self.nick))
  ) {
    return undefined;
  }

  const answer = answerOf(tuning, ctcp.command, ctcp.args, entry.at);
  const replies = under(standing.ctcp, casemapping);
  const key = keyOf(replies, sender.toString());

  if (
    answer === undefined ||
    isHeldBack(replies, tuning, key, entry.at) ||
    !networkHasRoom(replies, tuning, entry.at) ||
    !hasRoomFor(replies, tuning, key, entry.at)
  ) {
    return undefined;
  }

  const built = ctcpText(ctcp.command, answer);
  const notice = built._tag === "Safe" ? ctcpReply(sender, built.text) : undefined;

  return notice?._tag === "Safe" ? notice.line : undefined;
};

// Only what is pending is never let go of, and it is never more than the limit.
const trimmed = (latest: readonly CtcpReplied[]): readonly CtcpReplied[] => {
  const kept = [...latest];

  while (kept.length > heldReplyTimes) {
    const oldest = kept.findIndex(({ pending }) => pending === undefined);

    kept.splice(oldest === -1 ? 0 : oldest, 1);
  }

  return kept;
};

// The User held at a time, with room made by letting go of any whose interval has run out.
// A `NOTICE` already sent must be held even when none has, so the one held longest goes.
const withUser = (
  replies: CtcpReplies,
  tuning: Tuning | undefined,
  user: RepliedUser
): ReadonlyMap<string, RepliedUser> => {
  const key = keyOf(replies, user.nick);

  const byUser = new Map(
    replies.byUser.has(key) ? replies.byUser : withoutExpired(replies, tuning, user.at)
  );

  byUser.set(key, user);

  if (byUser.size > heldRepliedUsers) {
    const [longest] = [...byUser].toSorted(([, one], [, other]) => one.at - other.at);

    byUser.delete(longest?.[0] ?? key);
  }

  return byUser;
};

/**
 * Counts a reply the Daemon decided on for an inbound Line, if it decided on one, as
 * pending.
 * @param standing - Standing just before the Line.
 * @param entry - The Line's Entry.
 * @param line - The Line, parsed.
 * @returns The replies after it.
 */
export const afterCtcpRequest = (standing: Standing, entry: LineEntry, line: Line): CtcpReplies => {
  const pending = ctcpAnswer(standing, entry, line);
  const sender = senderOf(standing.irc, line)?.toString();

  if (pending === undefined || sender === undefined) {
    return standing.ctcp;
  }

  const replies = under(standing.ctcp, casemappingOf(standing.irc));
  const user = { at: entry.at, nick: sender };

  return {
    ...replies,
    byUser: withUser(replies, tuningOf(standing, entry.connection), user),
    latest: trimmed([
      ...replies.latest,
      { at: entry.at, pending, sequence: entry.sequence, to: sender },
    ]),
  };
};

const sameBytes = (one: Uint8Array, other: Uint8Array) =>
  one.length === other.length && one.every((byte, index) => byte === other[index]);

// Where the pending reply with these bytes is, the oldest if two are alike.
const pendingWith = (replies: CtcpReplies, bytes: Uint8Array) =>
  replies.latest.findIndex(
    ({ pending }) => pending !== undefined && sameBytes(pending.toBytes(), bytes)
  );

/**
 * Counts a CTCP `NOTICE` Self sent (PROT-4). The Daemon's own reply stops being pending and
 * counts from when it was sent, its User's interval too. Any other, such as the Owner's
 * own sent raw, counts once it is recorded.
 * @param standing - Standing just before the Line.
 * @param entry - The outbound Line's Entry.
 * @param line - The Line, parsed.
 * @returns The replies after it.
 */
export const afterCtcpSent = (standing: Standing, entry: LineEntry, line: Line): CtcpReplies => {
  const [target, text = ""] = line.params;

  if (line.command !== "NOTICE" || target === undefined || parseCtcp(text)._tag === "NotCtcp") {
    return standing.ctcp;
  }

  const replies = under(standing.ctcp, casemappingOf(standing.irc));
  const decided = entry.cause === ctcpReplyCause ? pendingWith(replies, entry.bytes) : -1;
  const sent: CtcpReplied = { at: entry.at, sequence: entry.sequence, to: target };
  const latest = [...replies.latest];

  if (decided === -1) {
    latest.push(sent);
  } else {
    latest[decided] = { ...sent, sequence: latest[decided]?.sequence ?? entry.sequence };
  }

  return {
    ...replies,
    byUser: withUser(replies, tuningOf(standing, entry.connection), {
      at: entry.at,
      nick: target,
    }),
    latest: trimmed(latest),
  };
};

/**
 * Lets go of a reply the Daemon decided on and that was Dropped, which never left, so it
 * counts no more against the Network (PROT-4). Its User stays inside their interval.
 * @param replies - The replies before the Entry.
 * @param entry - The Dropped Entry.
 * @returns The replies after it.
 */
export const afterCtcpDropped = (replies: CtcpReplies, entry: DroppedEntry): CtcpReplies => {
  const decided = entry.cause === ctcpReplyCause ? pendingWith(replies, entry.bytes) : -1;

  return decided === -1
    ? replies
    : { ...replies, latest: replies.latest.filter((_reply, index) => index !== decided) };
};

/**
 * Lets go of every reply still pending when a Connection ends, because nothing outlives
 * its Connection (SEND-4), whether or not its Dropped Entry was recorded, as after a kill.
 * @param replies - The replies before the end.
 * @returns The replies after it.
 */
export const withoutPending = (replies: CtcpReplies): CtcpReplies =>
  replies.latest.some(({ pending }) => pending !== undefined)
    ? { ...replies, latest: replies.latest.filter(({ pending }) => pending === undefined) }
    : replies;

/**
 * The replies the Daemon decided on for a run of Entries just recorded, in order, which a
 * host sends after the commit. Replay finds them too, and sends nothing, because only a
 * host acts on a commit (LOG-4).
 * @param standing - Standing after the Entries.
 * @param recorded - The Entries, in sequence order.
 * @returns Each reply to send, and when it was decided.
 */
export const ctcpRepliesIn = (
  standing: Standing,
  recorded: readonly Entry[]
): readonly DecidedReply[] => {
  const first = recorded.at(0)?.sequence;
  const last = recorded.at(-1)?.sequence;

  if (first === undefined || last === undefined) {
    return [];
  }

  return standing.ctcp.latest.flatMap(({ at, pending, sequence }) =>
    pending !== undefined && sequence >= first && sequence <= last
      ? [{ decidedAt: at, line: pending }]
      : []
  );
};
