/**
 * CTCP requests and replies, other than `ACTION`, which is a Message, and `DCC`, which is
 * dropped. A request is a CTCP in a `PRIVMSG`, and a reply one in a `NOTICE`. Each is
 * Activity, and Self answers a live request for `VERSION`, `PING`, `TIME`, or
 * `CLIENTINFO` with a `NOTICE` to the User who asked, never to a Channel, within a budget,
 * unless the Configuration turns answers off. Nothing is decided from the arguments, which
 * are only ever echoed back, by `PING`, and shown, but for a reply to a `PING` the Owner
 * sent, whose token tells its round trip.
 *
 * @packageDocumentation
 */
import { CtcpText, ctcpReply, ctcpText, parseCtcp, parseReplyTarget } from "@iirc/protocol/ctcp";
import { parseSource } from "@iirc/protocol/line";
import { Schema } from "effect";

import { fits } from "./acts.ts";
import type { Arrival } from "./feature.ts";
import { Instant } from "./ids.ts";
import { isSelf, namingNow, serverName } from "./meaning.ts";
import { parseNick, parseTargets } from "./names.ts";
import type { Ctcp, CtcpAnswer, Named, Unanswered, Where } from "./news.ts";
import type { Answers } from "./output.ts";
import type { Run } from "./run.ts";
import { folder, send, updateOpen } from "./run.ts";
import { maxActions } from "./state.ts";
import { openOf } from "./views.ts";
import { byPartner, isUser, named } from "./where.ts";

/**
 * How many answers may go at once. With {@link answerInterval}, a flood of requests sends
 * at most three answers and then one every ten seconds, a fifth of what the Outbox lets
 * leave, so answers never crowd out the Owner's own Lines or flood Self off.
 */
const answerBurst = 3;

/** How long, once the burst is spent, before another answer may go. */
const answerInterval = 10_000;

/** What Self says it is, and nothing of its version or where it runs. */
const version = "iirc";

/** The CTCP Self understands, which `CLIENTINFO` lists. */
const understood = ["ACTION", "CLIENTINFO", "PING", "TIME", "VERSION"] as const;

const weekdays = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"] as const;

const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const day = 86_400_000;

const two = (value: number): string => String(value).padStart(2, "0");

/**
 * An instant in UTC as HTTP's IMF-fixdate writes it, such as
 * `Thu, 01 Jan 2026 00:00:00 GMT`, the form the modern CTCP draft shows for `TIME`. It is
 * worked out by arithmetic alone, the civil date by Howard Hinnant's `civil_from_days`,
 * since the Client reads no clock, locale, or time zone.
 * @param at - The instant.
 * @returns The text.
 */
export const imfDate = (at: Instant): string => {
  const days = Math.floor(at / day);
  const seconds = Math.floor((at - days * day) / 1000);
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const ofEra = shifted - era * 146_097;

  const yearOfEra = Math.floor(
    (ofEra - Math.floor(ofEra / 1460) + Math.floor(ofEra / 36_524) - Math.floor(ofEra / 146_096)) /
      365
  );

  const ofYear =
    ofEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));

  const fromMarch = Math.floor((5 * ofYear + 2) / 153);
  const date = ofYear - Math.floor((153 * fromMarch + 2) / 5) + 1;
  const month = fromMarch < 10 ? fromMarch + 2 : fromMarch - 10;
  const year = yearOfEra + era * 400 + (month < 2 ? 1 : 0);
  const weekday = weekdays[((days % 7) + 7) % 7];
  const clock = `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;

  return `${weekday}, ${two(date)} ${months[month]} ${String(year).padStart(4, "0")} ${clock} GMT`;
};

/** What each request Self answers is answered with, from its arguments and the step. */
const answers: ReadonlyMap<string, (args: string, run: Run) => string> = new Map([
  ["CLIENTINFO", () => understood.join(" ")],
  ["PING", (args: string) => args],
  // When the Runtime stamped the request as it arrived, never the Ircd's `time` tag.
  ["TIME", (_args: string, run: Run) => imfDate(run.at)],
  ["VERSION", () => version],
]);

const unanswered = (reason: Unanswered): CtcpAnswer => ({ _tag: "Unanswered", reason });

/**
 * Remembers where the partner who asked for an answer is, by its number, as their Timeline
 * will follow their nick. It is by number, not by nick, since a later User of the old nick
 * may ask too, and each answer must follow its own partner. The oldest is forgotten past
 * the bound.
 * @param run - The step.
 * @param number - The answer's number.
 * @param nick - Who asked.
 * @returns What is remembered of answers, with this one.
 */
const remember = (run: Run, number: number, nick: string): ReadonlyMap<number, string | null> => {
  const answering = new Map(run.state.answering).set(number, nick);

  for (const oldest of answering.keys()) {
    if (answering.size <= maxActions) {
      break;
    }

    answering.delete(oldest);
  }

  return answering;
};

/**
 * The Channels a CTCP was sent to, once each, by the naming rules now.
 * @param run - The step.
 * @param target - The Target parameter, as said.
 * @returns Each Channel, by its key.
 */
const channelsIn = (run: Run, target: string): readonly Named[] => {
  const channels = new Map<string, Named>();

  for (const each of parseTargets(namingNow(run), target)) {
    if (each._tag === "Channel") {
      const channel = named(run, each.name);

      channels.set(channel.key, channel);
    }
  }

  return [...channels.values()];
};

const network: Where = { _tag: "Network" };

/**
 * Answers a request, if Self may, and says what became of it. It sends the answer and
 * spends the budget, so it is called once for each request, as it arrives.
 * @param run - The step.
 * @param arrival - The Line.
 * @param ctcp - The request.
 * @param fromUser - Whether a User sent it, rather than the Ircd or another server.
 * @returns The answer sent, or why none was.
 */
const answer = (run: Run, arrival: Arrival, ctcp: Ctcp, fromUser: boolean): CtcpAnswer => {
  const reply = answers.get(ctcp.command);

  if (!arrival.live) {
    return unanswered("History");
  }

  if (reply === undefined) {
    return unanswered("Unknown");
  }

  if (run.state.configuration?.answerCtcp !== true) {
    return unanswered("Off");
  }

  // A forged source such as `#victims!u@h` must not turn the answer into a `NOTICE` to a
  // Channel or a mask, and a server is no one to answer.
  const to = fromUser ? parseReplyTarget(ctcp.nick, namingNow(run)) : undefined;

  if (to === undefined) {
    return unanswered("Unreachable");
  }

  const text = reply(ctcp.args, run);
  const built = ctcpText(ctcp.command, text);
  const line = Schema.is(CtcpText)(built) ? ctcpReply(to, built) : undefined;

  // An answer the Ircd would cut short relaying it is not sent at all, never truncated.
  if (line === undefined || !fits(run, line)) {
    return unanswered("Unsendable");
  }

  const fullAt = Math.max(run.state.answersFullAt, run.at);

  if (fullAt - run.at > (answerBurst - 1) * answerInterval) {
    return unanswered("Limited");
  }

  // Where the request was placed is fixed now, as names, so a later `CHANTYPES` cannot
  // move an `Unsent` of the answer out of the Channel the request is shown in.
  const channels = channelsIn(run, ctcp.target).map(({ name }) => name);
  const number = run.state.answered;

  const request: Answers = {
    answer: number,
    channels,
    command: ctcp.command,
    nick: ctcp.nick,
    target: ctcp.target,
  };

  if (send(run, line, "NOTICE", undefined, request) === undefined) {
    return unanswered("Unsendable");
  }

  run.state = {
    ...run.state,
    answered: number + 1,
    answering: channels.length === 0 ? remember(run, number, ctcp.nick) : run.state.answering,
    answersFullAt: Instant.make(fullAt + answerInterval),
  };

  return { _tag: "Answered", text };
};

/**
 * Where a CTCP belongs: each Channel it was sent to, and otherwise the Network's own
 * Timeline, and the sender's Direct Messages too when they already exist. A request or a
 * reply is no reason to start a Direct Message Timeline, and is worth showing where Self
 * and the User talk.
 * @param run - The step.
 * @param ctcp - The CTCP.
 * @param fromUser - Whether a User sent it.
 * @returns The Timelines.
 */
const ctcpWhere = (run: Run, ctcp: Ctcp, fromUser: boolean): readonly Where[] => {
  const channels = channelsIn(run, ctcp.target);

  if (channels.length > 0) {
    return channels.map((channel) => ({ _tag: "Channel", ...channel }));
  }

  return fromUser && parseNick(namingNow(run), ctcp.nick) !== undefined
    ? byPartner(run, ctcp.nick)
    : [network];
};

/**
 * How long a reply to one of the Owner's `PING`s took: from the instant its request was
 * sent to this step's, both as the Runtime journaled them, in milliseconds. Only a live
 * reply from the User the `PING` went to, by the casemapping now, with its token, tells
 * one, and only once, since the `PING` is forgotten as it does.
 * @param run - The step.
 * @param ctcp - The reply.
 * @returns The round trip, or `null` for a reply to no `PING` Self remembers.
 */
const roundTripOf = (run: Run, ctcp: Ctcp): number | null => {
  const pings = openOf(run.state)?.pings ?? [];
  const fold = folder(run.state);

  const index =
    ctcp.command === "PING"
      ? pings.findIndex((ping) => ping.token === ctcp.args && fold(ping.nick) === fold(ctcp.nick))
      : -1;

  const ping = pings[index];

  if (ping === undefined) {
    return null;
  }

  updateOpen(run, (open) => ({ ...open, pings: open.pings.filter((_each, at) => at !== index) }));

  // The Runtime's clock is the wall clock, which may have been set back between the two.
  return Math.max(0, run.at - ping.at);
};

/**
 * Reads a CTCP request or reply from a `PRIVMSG` or `NOTICE`, reports it, and answers a
 * request Self may. `ACTION` is a Message, read elsewhere, and `DCC` is dropped. One Self
 * sent, such as the echo of an answer, is neither reported nor answered, so Self never
 * answers itself.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 */
export const heardCtcp = (run: Run, arrival: Arrival): void => {
  const { line } = arrival;
  const [target, text] = line.params;
  const request = line.command === "PRIVMSG";

  if ((!request && line.command !== "NOTICE") || target === undefined || text === undefined) {
    return;
  }

  const read = parseCtcp(text);

  if (read._tag !== "Other") {
    return;
  }

  const source = line.source === undefined ? undefined : parseSource(line.source);
  const fromUser = isUser(run, source);
  const nick = source?.nick ?? serverName(run);

  if (fromUser && isSelf(run, nick)) {
    return;
  }

  const ctcp: Ctcp = { args: read.args, command: read.command, nick, target };
  const where = ctcpWhere(run, ctcp, fromUser);

  run.news.push({
    _tag: "Activity",
    activity: request
      ? { _tag: "CtcpRequest", ...ctcp, answer: answer(run, arrival, ctcp, fromUser) }
      : {
          _tag: "CtcpReply",
          ...ctcp,
          roundTrip: arrival.live && fromUser ? roundTripOf(run, ctcp) : null,
        },
    at: arrival.time,
    id: arrival.id,
    live: arrival.live,
    where,
  });
};

/**
 * Where the Timelines a request was placed in stand now. Its Channels are the ones named as
 * it arrived, keyed by the casemapping now, as their Timelines are. A request placed by
 * who asked is placed by that partner's nick now, which follows a live rename as their
 * Timeline does, or in the Network's own Timeline alone once another User took it, so the
 * report never lands with someone else. An answer forgotten past the bound is placed the
 * same way, since its nick may be someone else's by now.
 * @param run - The step.
 * @param answers - The request the answer was for.
 * @returns The Timelines.
 */
const unsentWhere = (run: Run, answers: Answers): readonly Where[] => {
  const { answer: number, channels } = answers;

  if (channels.length > 0) {
    return channels.map((name) => ({ _tag: "Channel", ...named(run, name) }));
  }

  const partner = run.state.answering.get(number);

  return partner === undefined || partner === null ? [network] : byPartner(run, partner);
};

/**
 * Reports an answer that never left, where its request was, so a request reported as
 * `Answered` is not left standing alone. Nothing is sent, and the budget it spent stays
 * spent.
 * @param run - The step.
 * @param answers - The request the answer was for.
 */
export const answerUnsent = (run: Run, answers: Answers): void => {
  const where = unsentWhere(run, answers);
  const { answer: number, command, nick, target } = answers;

  if (run.state.answering.has(number)) {
    const answering = new Map(run.state.answering);

    answering.delete(number);
    run.state = { ...run.state, answering };
  }

  run.news.push({
    _tag: "Activity",
    activity: { _tag: "CtcpUnsent", command, nick, target },
    at: { _tag: "Known", at: run.at, from: "receipt", value: run.at },
    id: { _tag: "Unknown" },
    live: true,
    where,
  });
};
