/**
 * What an item shows, as data for a view to draw: a Message's text as runs of formatted
 * text and links, an Activity or a Session's start or end as a short description, and a
 * stable colour slot for each nick. Nothing here is markup: every string is text, for a
 * view to put in a text node.
 *
 * @packageDocumentation
 */
import type {
  ActionRequest,
  Activity,
  Answered,
  Attempted,
  Delivery as WireDelivery,
  EndReason,
  ItemContent,
  NetworkId,
  NickSpan,
} from "@iirc/api";
import type { IrcdAddress } from "@iirc/client/configuration";
import { casefold } from "@iirc/protocol/casemapping";
import { parseFormatting, stripFormatting } from "@iirc/protocol/format";
import type { Style } from "@iirc/protocol/format";
import { linkSchemes as schemes, linksInRun } from "@iirc/protocol/links";

import { churnNick, foldNick } from "./churn.ts";
import type { Churn } from "./churn.ts";
import { contained, embeddings, isolates, popEmbedding, popIsolate } from "./contained.ts";
import { optionName, showText } from "./options.ts";
import type { Kind } from "./options.ts";

export type { Colour, Style } from "@iirc/protocol/format";

export { contained } from "./contained.ts";

/**
 * A run of text in one style: plain text, text that names a User who counts, or a link a
 * view may open. A link's `href` is always `http`, `https`, `irc`, or `ircs`, as the URL
 * parser wrote it. A `Nick`'s `colour` is the slot of the nick as the whole text wrote it,
 * so the parts of one name that formatting splits share it.
 */
export type Inline =
  | { readonly _tag: "Text"; readonly text: string; readonly style: Style }
  | {
      readonly _tag: "Nick";
      readonly text: string;
      readonly style: Style;
      readonly colour: number;
    }
  | { readonly _tag: "Link"; readonly text: string; readonly href: string; readonly style: Style };

/** The schemes a link may have. Anything else stays text. */
export const linkSchemes: ReadonlySet<string> = new Set(schemes.map((scheme) => `${scheme}:`));

/** How many characters of text a notification shows, before it is cut short. */
export const plainLimit = 200;

const firstStrongIsolate = "\u2068";
const popDirectionalIsolate = "\u2069";

/**
 * Whether a character is dropped from plain text: a control, a bidirectional formatting
 * character or mark, or a lone surrogate. A line or paragraph separator becomes a space.
 * @param code - Its code point.
 * @returns Whether it is.
 */
const dropped = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0xd8_00 && code <= 0xdf_ff) ||
  code === 0x06_1c ||
  code === 0x20_0e ||
  code === 0x20_0f ||
  embeddings.has(code) ||
  code === popEmbedding ||
  isolates.has(code) ||
  code === popIsolate;

/** A character plain text keeps, and where it stood in the text with formatting stripped. */
export interface PlainCharacter {
  readonly character: string;
  /** Its UTF-16 offset in the stripped text. */
  readonly offset: number;
}

/**
 * The characters of text a Network sent, as plain text shows them, each with where it
 * stood: mIRC formatting stripped, every control, bidirectional formatting character, and
 * lone surrogate dropped, and line and paragraph separators made spaces. Each is one code
 * point.
 * @param text - The text, as the Network sent it.
 * @param limit - How many are needed: reading stops one past it.
 * @returns The characters.
 */
export const plainWithOffsets = (
  text: string,
  limit = Number.POSITIVE_INFINITY
): readonly PlainCharacter[] => {
  const kept: PlainCharacter[] = [];
  let offset = 0;

  for (const character of stripFormatting(text)) {
    const code = character.codePointAt(0) ?? 0;

    if (code === 0x20_28 || code === 0x20_29) {
      kept.push({ character: " ", offset });
    } else if (!dropped(code)) {
      kept.push({ character, offset });
    }

    offset += character.length;

    // One past the limit says it is cut, and nothing further is needed.
    if (kept.length > limit) {
      break;
    }
  }

  return kept;
};

/**
 * The characters of text a Network sent, as plain text shows them.
 * @param text - The text, as the Network sent it.
 * @param limit - How many are needed: reading stops one past it.
 * @returns The characters.
 */
export const plainCharacters = (
  text: string,
  limit = Number.POSITIVE_INFINITY
): readonly string[] => plainWithOffsets(text, limit).map(({ character }) => character);

/**
 * Text a Network sent as plain text for somewhere that shows no formatting, such as a
 * notification: its plain characters, cut to `limit` with an ellipsis, and the whole
 * isolated, so its direction cannot reorder what is around it.
 * @param text - The text, as the Network sent it.
 * @param limit - The most characters kept.
 * @returns The text, isolated.
 */
export const plainText = (text: string, limit = plainLimit): string => {
  const kept = plainCharacters(text, limit);

  const cut = kept.length > limit ? `${kept.slice(0, limit - 1).join("")}\u2026` : kept.join("");

  return `${firstStrongIsolate}${cut}${popDirectionalIsolate}`;
};

// Nick colours.

/** How many colour slots nicks are spread over. A theme gives each slot its colour. */
export const nickSlots = 16;

/**
 * The colour slot of a nick: a hash of the nick folded as RFC 1459 folds it, so the same
 * User gets the same slot whatever case they are written in, on every load.
 * @param nick - The nick.
 * @param slots - How many slots there are.
 * @returns A slot, from `0` to `slots - 1`.
 */
export const nickColour = (nick: string, slots = nickSlots): number => {
  // FNV-1a, 32 bits, over the folded nick's code points.
  let hash = 0x81_1c_9d_c5;

  for (const character of casefold("rfc1459", nick)) {
    // oxlint-disable-next-line no-bitwise -- FNV-1a is defined on bits
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  }

  return hash % slots;
};

/** A span of text that names a User, as the slot its nick as written is given. */
export interface NickRun {
  readonly start: number;
  readonly end: number;
  readonly colour: number;
}

/**
 * The spans a Client found in some text, ready to draw: each with the slot of the nick as
 * the text wrote it, in order and never overlapping, the Daemon being trusted to have
 * sent them so. A span past the end of the text is cut to it, and one that is empty, or
 * starts before the last one ended, is skipped.
 * @param text - The text, as it arrived.
 * @param nicks - The spans, as UTF-16 offsets into the text with formatting stripped.
 * @returns The spans, with their slots.
 */
const nickRuns = (text: string, nicks: readonly NickSpan[]): readonly NickRun[] => {
  if (nicks.length === 0) {
    return [];
  }

  const plain = stripFormatting(text);
  const runs: NickRun[] = [];
  let from = 0;

  for (const nick of nicks) {
    const end = Math.min(nick.end, plain.length);

    if (nick.start >= from && nick.start < end) {
      runs.push({ colour: nickColour(plain.slice(nick.start, end)), end, start: nick.start });
      from = end;
    }
  }

  return runs;
};

/**
 * Whether a mIRC colour covers text, which the sender chose and a nick's colour leaves
 * alone: a foreground or a background, or the reversal of the two.
 * @param style - The style in force.
 * @returns Whether it does.
 */
const coloured = (style: Style): boolean =>
  style.foreground !== undefined || style.background !== undefined || style.reverse;

/**
 * A piece of text as it is drawn, before it is made safe to show, and where it stood in the
 * text with formatting stripped.
 */
type Piece =
  | { readonly _tag: "Text"; readonly raw: string; readonly at: number; readonly style: Style }
  | {
      readonly _tag: "Nick";
      readonly raw: string;
      readonly at: number;
      readonly style: Style;
      readonly colour: number;
    }
  | {
      readonly _tag: "Link";
      readonly raw: string;
      readonly at: number;
      readonly style: Style;
      readonly href: string;
    };

/**
 * Some text of one run, split at the spans that name a User, which are `Nick`s unless a
 * mIRC colour covers them.
 * @param text - The part of the run to split.
 * @param style - The run's style.
 * @param at - Where `text` begins, as an offset into the stripped text.
 * @param nicks - The spans, as {@link nickRuns} gives them.
 * @returns Its pieces.
 */
const nicked = (
  text: string,
  style: Style,
  at: number,
  nicks: readonly NickRun[]
): readonly Piece[] => {
  const textOf = (from: number, to: number): Piece[] =>
    to > from ? [{ _tag: "Text", at: at + from, raw: text.slice(from, to), style }] : [];

  if (coloured(style)) {
    return textOf(0, text.length);
  }

  const pieces: Piece[] = [];
  let from = 0;

  for (const nick of nicks) {
    const start = Math.max(nick.start - at, from);
    const end = Math.min(nick.end - at, text.length);

    if (end > start) {
      pieces.push(...textOf(from, start), {
        _tag: "Nick",
        at: at + start,
        colour: nick.colour,
        raw: text.slice(start, end),
        style,
      });
      from = end;
    }
  }

  return [...pieces, ...textOf(from, text.length)];
};

/**
 * One run of formatted text, split into text, nicks, and links.
 * @param text - The run's text, with no formatting codes left.
 * @param style - Its style.
 * @param at - Where the run begins, as an offset into the stripped text.
 * @param nicks - The spans that name a User.
 * @returns Its pieces.
 */
const linked = (
  text: string,
  style: Style,
  at: number,
  nicks: readonly NickRun[]
): readonly Piece[] => {
  const pieces: Piece[] = [];
  let from = 0;

  const textUpTo = (end: number) => {
    if (end > from) {
      pieces.push(...nicked(text.slice(from, end), style, at + from, nicks));
    }
  };

  for (const link of linksInRun(text)) {
    textUpTo(link.index);
    pieces.push({ _tag: "Link", at: at + link.index, href: link.href, raw: link.text, style });
    from = link.index + link.text.length;
  }

  textUpTo(text.length);

  return pieces;
};

/**
 * Text split as it is drawn: each run of one style into text, nicks, and links.
 * @param text - The text, as it arrived.
 * @param nicks - The spans of it that name a User, with formatting stripped.
 * @returns Its pieces, in order.
 */
const piecesOf = (text: string, nicks: readonly NickSpan[]): readonly Piece[] => {
  const runs = nickRuns(text, nicks);
  let at = 0;

  return parseFormatting(text).flatMap((span) => {
    const pieces = linked(span.text, span.style, at, runs);

    at += span.text.length;

    return pieces;
  });
};

/**
 * Text a Network sent, as a view draws it: mIRC formatting read into styles, links found in
 * each run, control characters shown as symbols, and bidirectional formatting closed at
 * the end of each run. Links are found in each run of one style on its own, so a link
 * that formatting splits is a link only up to the split. A span that names a User is a
 * `Nick` in the colour of the nick as written, unless a link holds it, which stays a
 * link, or a mIRC colour covers it, which the sender chose.
 * @param text - The text, as it arrived.
 * @param nicks - The spans of it that name a User who counts, as UTF-16 offsets into the
 * text with formatting stripped.
 * @returns Its inlines, in order.
 */
export const formatted = (text: string, nicks: readonly NickSpan[] = []): readonly Inline[] =>
  piecesOf(text, nicks).map((piece): Inline => {
    switch (piece._tag) {
      case "Link": {
        return { _tag: "Link", href: piece.href, style: piece.style, text: piece.raw };
      }

      case "Nick": {
        return {
          _tag: "Nick",
          colour: piece.colour,
          style: piece.style,
          text: contained(piece.raw),
        };
      }

      case "Text": {
        return { _tag: "Text", style: piece.style, text: contained(piece.raw) };
      }

      default: {
        return piece satisfies never;
      }
    }
  });

/**
 * The parts of some text that {@link formatted} draws as a `Nick`: what a view shows in a
 * nick's colour, which is not what the Client found where a link holds it or a mIRC colour
 * covers it.
 * @param text - The text, as it arrived.
 * @param nicks - The spans of it that name a User who counts, as UTF-16 offsets into the
 * text with formatting stripped.
 * @returns Where each stood in the text with formatting stripped, in order, with its slot.
 */
export const drawnNicks = (text: string, nicks: readonly NickSpan[]): readonly NickRun[] =>
  // Text that names no one needs no formatting read nor links found.
  nicks.length === 0
    ? []
    : piecesOf(text, nicks).flatMap((piece) =>
        piece._tag === "Nick"
          ? [{ colour: piece.colour, end: piece.at + piece.raw.length, start: piece.at }]
          : []
      );

// Lines.

/**
 * A piece of a description: words of our own, a nick, a name a Network chose, such as a
 * Channel's or a mode's, or text a participant wrote, with its formatting.
 */
export type Part =
  | { readonly _tag: "Words"; readonly text: string }
  | { readonly _tag: "Nick"; readonly nick: string; readonly colour: number }
  | { readonly _tag: "Name"; readonly text: string }
  | { readonly _tag: "Said"; readonly inlines: readonly Inline[] }
  /** A command the Owner can type, as a view shows code. */
  | { readonly _tag: "Command"; readonly text: string }
  /**
   * An offer to join a Channel on a Network, which a view draws as a button. `channel` is
   * the name as the Network said it, which is what joining names.
   */
  | { readonly _tag: "Join"; readonly channel: string; readonly network: NetworkId };

/** Where one of our Messages stands with the Ircd, as shown. */
export type Delivery = "Pending" | "Unconfirmed" | "Confirmed" | "Unsent" | "Rejected";

/**
 * One item as a line: a Message, by its sender, with its text and, for one of ours, its
 * delivery, or a description of an Activity, a Session's start or end, or an action of
 * ours that was refused, whose tone is `Refused`, as a `FAIL`'s is, or an Ircd's message of
 * the day, which a view draws folded to one line and opens to its text, or a netsplit or
 * netjoin, which it draws folded to one line and opens to the nicks.
 */
export type Line =
  | {
      readonly _tag: "Message";
      readonly kind: "Privmsg" | "Notice" | "Action";
      readonly nick: string;
      readonly colour: number;
      /** Its sender said they are a bot, which a view marks beside their nick. */
      readonly bot: boolean;
      /**
       * The symbol of the prefix its sender held when it was said, contained, which a view
       * draws before their nick but never as part of it, or none.
       */
      readonly prefix: string | undefined;
      readonly text: readonly Inline[];
      /** The Channel a Direct Message is about, contained, when it names one. */
      readonly context: string | undefined;
      readonly delivery: Delivery | undefined;
      /** How its delivery stands in a few words, or none when there is nothing to say. */
      readonly delivered: string | undefined;
    }
  | {
      readonly _tag: "Description";
      /**
       * How it reads: `Activity`, a Session, or a refusal, each dim, or `Numeric`, an
       * Ircd's own words, as plain as a Message's beside its dim number.
       */
      readonly tone: "Activity" | "Session" | "Refused" | "Numeric";
      /**
       * What stands in the senders' column, where a Message's nick does, so the words line
       * up with a Message's text: `-->` for one who arrived, `<--` for one who left, `--`
       * for any other Activity, as WeeChat marks them, an Ircd's numeric by its number, and
       * none for a Session or a refusal.
       */
      readonly marker: Marker | undefined;
      readonly parts: readonly Part[];
    }
  | {
      readonly _tag: "Motd";
      /** `--`, as an Activity that is not a numeric is marked. */
      readonly marker: Marker;
      /** What the folded line says: that it is the message of the day, its lines, and if it was cut short. */
      readonly summary: string;
      /**
       * Each line of it, its RFC 2812 `- ` prefix dropped, as a Message's text is drawn, for
       * a view to show in monospace with every space kept and none wrapped.
       */
      readonly lines: readonly (readonly Inline[])[];
    }
  | {
      readonly _tag: "Split";
      /** `<--` for a netsplit, `-->` for a netjoin, as a quit and a join are marked. */
      readonly marker: Marker;
      /** What the folded line says: which two servers, and how many of the Channel's members. */
      readonly summary: readonly Part[];
      /** The members who went or came back, in order, each a `Nick` part, for a view to list opened. */
      readonly nicks: readonly Part[];
    };

/**
 * What marks an Activity in the senders' column: `-->` for arriving, `<--` for leaving, `--`
 * for anything else, or a numeric's own number, such as `251`.
 */
export type Marker = string;

const arriving: ReadonlySet<Activity["_tag"]> = new Set(["Joined", "CameOnline", "Netjoin"]);

const leaving: ReadonlySet<Activity["_tag"]> = new Set([
  "Parted",
  "Quit",
  "Kicked",
  "WentOffline",
  "Netsplit",
]);

/**
 * What marks an Activity that is not a numeric or the message of the day: `-->` for a join, a partner coming online, or a netjoin,
 * `<--` for a part, a quit, a kick, a partner going offline, or a netsplit, and `--` for anything else.
 * @param activity - The Activity.
 * @returns Its marker.
 */
const arrowOf = (activity: Exclude<Activity, { readonly _tag: "Numeric" | "Motd" }>): Marker => {
  if (arriving.has(activity._tag)) {
    return "-->";
  }

  return leaving.has(activity._tag) ? "<--" : "--";
};

/**
 * What marks an Activity: a numeric's number for a numeric, or an arrow or `--`.
 * @param activity - The Activity.
 * @returns Its marker.
 */
const markerOf = (activity: Activity): Marker => {
  if (activity._tag === "Numeric") {
    return activity.numeric;
  }

  return activity._tag === "Motd" ? "--" : arrowOf(activity);
};

const words = (text: string): Part => ({ _tag: "Words", text });

const nickPart = (nick: string): Part => ({
  _tag: "Nick",
  colour: nickColour(nick),
  nick: contained(nick),
});

const name = (text: string): Part => ({ _tag: "Name", text: contained(text) });

const said = (text: string): Part => ({ _tag: "Said", inlines: formatted(text) });

/**
 * A reason someone gave, in brackets, or nothing.
 * @param reason - The reason, if one was given.
 * @returns Its parts.
 */
const because = (reason: string | null): readonly Part[] =>
  reason === null || reason === "" ? [] : [words(" ("), said(reason), words(")")];

type CtcpAnswer = Extract<Activity, { readonly _tag: "CtcpRequest" }>["answer"];

/** Why a CTCP request went unanswered, in a few words. */
const unanswered: Readonly<
  Record<Extract<CtcpAnswer, { readonly _tag: "Unanswered" }>["reason"], string>
> = {
  History: "from history",
  Limited: "too many requests",
  Off: "answers are off",
  Unknown: "not understood",
  Unreachable: "no one to answer",
  Unsendable: "too long to send",
};

/**
 * A CTCP's command and its arguments, which are only ever shown as text.
 * @param command - The command.
 * @param args - Its arguments.
 * @param between - What goes between them.
 * @returns Their parts.
 */
const ctcpParts = (command: string, args: string, between: string): readonly Part[] => [
  name(command),
  ...(args === "" ? [] : [words(between), said(args)]),
];

/**
 * What became of a CTCP request: the answer sent, or why none was.
 * @param answer - The answer.
 * @returns Its parts.
 */
const answerParts = (answer: CtcpAnswer): readonly Part[] =>
  answer._tag === "Answered"
    ? [words(", answered "), name(answer.text)]
    : [words(`, not answered: ${unanswered[answer.reason]}`)];

/**
 * A round trip in seconds, to the millisecond, as `0.250 s`, worked out by arithmetic, so
 * no locale writes it.
 * @param milliseconds - The round trip.
 * @returns The words.
 */
const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(3)} s`;

type OperAnswer = Extract<Activity, { readonly _tag: "OperGranted" | "OperRefused" }>;

const isOperAnswer = (activity: Activity): activity is OperAnswer =>
  activity._tag === "OperGranted" || activity._tag === "OperRefused";

/**
 * An answer to Self's `OPER` in words: a refusal by the numeric that refused it, never its
 * text.
 * @param activity - The answer.
 * @returns Its parts.
 */
const describeOperAnswer = (activity: OperAnswer): readonly Part[] =>
  activity._tag === "OperGranted"
    ? [nickPart(activity.nick), words(" is now an IRC operator")]
    : [
        nickPart(activity.nick),
        words(" was refused as an IRC operator ("),
        name(activity.reply),
        words(")"),
      ];

/**
 * An invitation in words, with the offer to join the Channel it is to.
 * @param activity - The invitation.
 * @param network - The Network it came from, whose Configuration joining changes.
 * @returns Its parts.
 */
const describeInvitation = (
  activity: Extract<Activity, { readonly _tag: "Invited" }>,
  network: NetworkId
): readonly Part[] => [
  nickPart(activity.by),
  words(" invited you to "),
  name(activity.channel),
  words(" "),
  { _tag: "Join", channel: activity.channel, network },
];

type Presence = Extract<
  Activity,
  {
    readonly _tag:
      | "AccountChanged"
      | "AwayChanged"
      | "CameOnline"
      | "WentOffline"
      | "HostChanged"
      | "RealnameChanged";
  }
>;

const isPresence = (activity: Activity): activity is Presence =>
  activity._tag === "AccountChanged" ||
  activity._tag === "HostChanged" ||
  activity._tag === "RealnameChanged" ||
  activity._tag === "AwayChanged" ||
  activity._tag === "CameOnline" ||
  activity._tag === "WentOffline";

/**
 * A User's away, account, mask, real name, or presence changing, in words.
 * @param activity - The Activity.
 * @returns Its parts.
 */
const describePresence = (activity: Presence): readonly Part[] => {
  if (activity._tag === "CameOnline") {
    return [nickPart(activity.nick), words(" is online")];
  }

  if (activity._tag === "WentOffline") {
    return [nickPart(activity.nick), words(" went offline")];
  }

  if (activity._tag === "HostChanged") {
    return [nickPart(activity.nick), words(" is now "), name(`${activity.user}@${activity.host}`)];
  }

  if (activity._tag === "RealnameChanged") {
    return [nickPart(activity.nick), words(" set their real name to "), said(activity.realname)];
  }

  if (activity._tag === "AccountChanged") {
    return activity.account === null
      ? [nickPart(activity.nick), words(" logged out")]
      : [nickPart(activity.nick), words(" logged in as "), name(activity.account)];
  }

  return activity.away === null
    ? [nickPart(activity.nick), words(" is back")]
    : [
        nickPart(activity.nick),
        words(" is away"),
        ...(activity.away.message === "" ? [] : [words(": "), said(activity.away.message)]),
      ];
};

/**
 * Any other Activity in words.
 * @param activity - The Activity.
 * @returns Its parts.
 */
const describeOtherActivity = (
  activity: Exclude<
    Activity,
    OperAnswer | { readonly _tag: "Invited" | "Motd" | "Netsplit" | "Netjoin" }
  >
): readonly Part[] => {
  if (isPresence(activity)) {
    return describePresence(activity);
  }

  switch (activity._tag) {
    case "Joined": {
      return [nickPart(activity.nick), words(" joined "), name(activity.channel)];
    }

    case "Parted": {
      return [
        nickPart(activity.nick),
        words(" left "),
        name(activity.channel),
        ...because(activity.reason),
      ];
    }

    case "Quit": {
      return [nickPart(activity.nick), words(" quit"), ...because(activity.reason)];
    }

    case "Kicked": {
      return [
        nickPart(activity.by),
        words(" kicked "),
        nickPart(activity.nick),
        words(" from "),
        name(activity.channel),
        ...because(activity.reason),
      ];
    }

    // Another User's invitation, told to the Channel's members: no offer to join, which is
    // only for Self's own.
    case "UserInvited": {
      return [
        nickPart(activity.by),
        words(" invited "),
        nickPart(activity.nick),
        words(" to "),
        name(activity.channel),
      ];
    }

    case "NickChanged": {
      return [nickPart(activity.from), words(" is now "), nickPart(activity.to)];
    }

    case "TopicChanged": {
      return activity.topic === null || activity.topic.text === ""
        ? [nickPart(activity.by), words(" cleared the topic of "), name(activity.channel)]
        : [
            nickPart(activity.by),
            words(" set the topic of "),
            name(activity.channel),
            words(": "),
            said(activity.topic.text),
          ];
    }

    case "ModeChanged": {
      const modes = activity.changes
        .map(
          ({ mode, param, set }) => `${set ? "+" : "-"}${mode}${param === null ? "" : ` ${param}`}`
        )
        .join(" ");

      return [
        nickPart(activity.by),
        words(" set "),
        name(modes),
        words(" on "),
        name(activity.target),
      ];
    }

    // As the Network gave it: its kind, the command it is about, its code, its context, and
    // its description, each a field of its own.
    case "StandardReply": {
      return [
        words(`${activity.kind} `),
        name(activity.command),
        words(" "),
        name(activity.code),
        ...activity.context.flatMap((each) => [words(" "), name(each)]),
        ...(activity.description === "" ? [] : [words(": "), said(activity.description)]),
      ];
    }

    // The Ircd's own words, as one run of text, its number in the marker beside them.
    case "Numeric": {
      return [said(activity.params.join(" "))];
    }

    // Who asked for what, and the answer sent beside it, or why none was.
    case "CtcpRequest": {
      return [
        nickPart(activity.nick),
        words(" asked for "),
        ...ctcpParts(activity.command, activity.args, " "),
        ...answerParts(activity.answer),
      ];
    }

    // The request again, by who asked and for what, and that its answer never left.
    case "CtcpUnsent": {
      return [
        nickPart(activity.nick),
        words(" asked for "),
        name(activity.command),
        words(", the answer never left"),
      ];
    }

    // A reply to the Owner's own PING says how long it took, and not the token it echoed.
    case "CtcpReply": {
      return activity.roundTrip === null
        ? [
            nickPart(activity.nick),
            words(" replied to "),
            ...ctcpParts(activity.command, activity.args, ": "),
          ]
        : [
            nickPart(activity.nick),
            words(" replied to "),
            name(activity.command),
            words(` in ${seconds(activity.roundTrip)}`),
          ];
    }

    case "CtcpSent": {
      return [
        words("You asked "),
        nickPart(activity.nick),
        words(" for "),
        ...ctcpParts(activity.command, activity.args, " "),
      ];
    }

    default: {
      return activity satisfies never;
    }
  }
};

/**
 * An Activity in words.
 * @param activity - The Activity.
 * @param network - The Network it belongs to.
 * @returns Its parts.
 */
const describeActivity = (
  activity: Exclude<Activity, { readonly _tag: "Motd" | "Netsplit" | "Netjoin" }>,
  network: NetworkId
): readonly Part[] => {
  if (isOperAnswer(activity)) {
    return describeOperAnswer(activity);
  }

  return activity._tag === "Invited"
    ? describeInvitation(activity, network)
    : describeOtherActivity(activity);
};

/**
 * What an action asked for comes to, in short, as the Client says what an action tried:
 * its kind and the names it was given, a mode change by its signs and letters.
 * @param action - The action, as `act` takes it.
 * @returns What it tried.
 */
export const requested = (action: ActionRequest): Attempted => {
  switch (action._tag) {
    case "Topic": {
      return { _tag: "Topic", channel: action.channel };
    }

    case "Kick": {
      return { _tag: "Kick", channel: action.channel, nicks: action.nicks };
    }

    case "Part": {
      return { _tag: "Part", channel: action.channel };
    }

    case "Mode": {
      let modes = "";
      let sign: boolean | undefined;

      for (const change of action.changes) {
        modes += change.set === sign ? change.mode : `${change.set ? "+" : "-"}${change.mode}`;
        sign = change.set;
      }

      return { _tag: "Mode", modes, target: action.target };
    }

    case "Invite": {
      return { _tag: "Invite", channel: action.channel, nick: action.nick };
    }

    case "BanAccount": {
      return { _tag: "Mode", modes: "+b", target: action.channel };
    }

    case "Nick": {
      return { _tag: "Nick", nick: action.nick };
    }

    case "Away": {
      return { _tag: "Away", away: action.message !== null && action.message !== "" };
    }

    case "Raw": {
      const [command = ""] = action.line.replace(/^@\S*\s+/u, "").split(" ");

      return { _tag: "Raw", command: command === "" ? null : command.toUpperCase() };
    }

    case "Ctcp": {
      // As the Client upper-cases a CTCP command: ASCII letters alone.
      const command = action.command.replaceAll(/[a-z]/gu, (letter) => letter.toUpperCase());

      return { _tag: "Ctcp", command, nick: action.nick };
    }

    case "Ping": {
      return { _tag: "Ping", nick: action.nick };
    }

    case "Setname": {
      return { _tag: "Setname" };
    }

    default: {
      return action satisfies never;
    }
  }
};

/**
 * What an action tried, as parts: `your topic change for #iirc`.
 * @param attempted - What it tried.
 * @returns Its parts.
 */
const attemptedParts = (attempted: Attempted): readonly Part[] => {
  switch (attempted._tag) {
    case "Topic": {
      return [words("Your topic change for "), name(attempted.channel)];
    }

    case "Kick": {
      return [
        words("Your kick of "),
        ...attempted.nicks.flatMap((nick, index) =>
          index === 0 ? [nickPart(nick)] : [words(", "), nickPart(nick)]
        ),
        words(" from "),
        name(attempted.channel),
      ];
    }

    case "Part": {
      return [words("Your leaving of "), name(attempted.channel)];
    }

    case "Mode": {
      return [
        words("Your mode change "),
        name(attempted.modes),
        words(" on "),
        name(attempted.target),
      ];
    }

    case "Invite": {
      return [
        words("Your invite of "),
        nickPart(attempted.nick),
        words(" to "),
        name(attempted.channel),
      ];
    }

    case "Nick": {
      return [words("Your nick change to "), nickPart(attempted.nick)];
    }

    case "Away": {
      return [words(attempted.away ? "Marking you away" : "Marking you back")];
    }

    case "Raw": {
      return attempted.command === null
        ? [words("Your raw line")]
        : [words("Your raw "), name(attempted.command)];
    }

    case "Ctcp": {
      return [
        words("Your CTCP "),
        name(attempted.command),
        words(" to "),
        nickPart(attempted.nick),
      ];
    }

    case "Ping": {
      return [words("Your PING of "), nickPart(attempted.nick)];
    }

    case "Setname": {
      return [words("Your real name change")];
    }

    default: {
      return attempted satisfies never;
    }
  }
};

/**
 * What an action tried, as plain text, its names contained: `Your topic change for #iirc`.
 * @param attempted - What it tried.
 * @returns The words.
 */
export const attemptedText = (attempted: Attempted): string =>
  attemptedParts(attempted)
    .map((part) => {
      switch (part._tag) {
        case "Words":
        case "Name":
        case "Command": {
          return part.text;
        }

        case "Join": {
          return `join ${part.channel}`;
        }

        case "Nick": {
          return part.nick;
        }

        case "Said": {
          return part.inlines.map((inline) => inline.text).join("");
        }

        default: {
          return part satisfies never;
        }
      }
    })
    .join("");

const closeReasons: Readonly<Record<Extract<EndReason, { _tag: "Closed" }>["reason"], string>> = {
  Ended: "the Ircd closed the connection",
  HungUp: "we hung up",
  Refused: "the connection was refused",
  Reset: "the connection was reset",
  TimedOut: "the connection timed out",
  Tls: "TLS failed",
  Unreachable: "the Ircd could not be reached",
};

/**
 * Why a Session ended, or a Connection failed, in words. None of it is an Ircd's text.
 * @param reason - Why.
 * @returns The words.
 */
export const endReason = (reason: EndReason): string => {
  switch (reason._tag) {
    case "Closed": {
      return closeReasons[reason.reason];
    }

    case "Disabled": {
      return "the Network was disabled";
    }

    case "Error": {
      return "the Ircd sent ERROR";
    }

    case "LoginFailed": {
      return "logging in failed";
    }

    case "Restarted": {
      return "the Daemon restarted";
    }

    case "Silent": {
      return "the Ircd stopped answering";
    }

    case "Upgrading": {
      return `upgrading to TLS on port ${reason.port}`;
    }

    default: {
      return reason satisfies never;
    }
  }
};

/**
 * How one of our Messages stands, in a few words: nothing once the Ircd confirmed it, and
 * nothing while it cannot, since an Ircd with no `echo-message` never echoes one of ours,
 * so `Unconfirmed` is where every Message of ours there stays for good. Sending, not sent,
 * and a refusal with the Ircd's numeric or code, contained, never its text, are said.
 * @param delivery - How it stands.
 * @returns The words, or none.
 */
const deliveryWords = (delivery: WireDelivery): string | undefined => {
  switch (delivery._tag) {
    case "Pending": {
      return "sending";
    }

    case "Confirmed":
    case "Unconfirmed": {
      return undefined;
    }

    case "Unsent": {
      return "not sent";
    }

    case "Rejected": {
      return `refused: ${contained(delivery.reply)}`;
    }

    default: {
      return delivery satisfies never;
    }
  }
};

/** The port IANA registers for IRC over TLS (`ircs-u`), and the one plaintext IRC has long used. */
const ports = { plain: 6667, tls: 6697 } as const;

/**
 * The Ircd to try instead after a failed Connection, when its port and its TLS look
 * mismatched, decided from structure alone: a plaintext Connection to 6697 that was open,
 * so the Ircd was reached, and then ended before registration, as one speaking TLS ends a
 * plaintext one, or a TLS Connection to 6667 whose handshake failed. A Connection that was
 * never open, such as one whose connect timed out or was reset at a firewall, says nothing
 * of TLS, and neither does any other port.
 * @param failed - The failed Connection: its Ircd, whether it was open, and why it ended.
 * @returns The same host on the same port with TLS the other way, or none.
 */
export const mismatchedTls = (failed: {
  readonly ircd: IrcdAddress;
  readonly opened: boolean;
  readonly reason: EndReason;
}): IrcdAddress | undefined => {
  const { ircd, opened, reason } = failed;
  const closed = reason._tag === "Closed" ? reason.reason : undefined;

  if (!ircd.tls && ircd.port === ports.tls) {
    const reached =
      opened &&
      (reason._tag === "Silent" ||
        reason._tag === "Error" ||
        closed === "Ended" ||
        closed === "Reset" ||
        closed === "TimedOut" ||
        closed === "HungUp");

    return reached ? { ...ircd, tls: true } : undefined;
  }

  return ircd.tls && ircd.port === ports.plain && closed === "Tls"
    ? { ...ircd, tls: false }
    : undefined;
};

/**
 * A failed Connection, in words: the Ircd, why, and, when its port and TLS look
 * mismatched, the command that tries them the other way.
 * @param content - The failed Connection.
 * @param network - Its Network.
 * @returns The parts.
 */
const failedParts = (
  content: ItemContent & { readonly _tag: "ConnectionFailed" },
  network: NetworkId
): readonly Part[] => {
  const ircds: Kind = { _tag: "Ircds" };
  const instead = mismatchedTls(content);

  const failed = [
    words("Could not connect to "),
    { _tag: "Name", text: contained(showText(ircds, [content.ircd])) } as const,
    words(`: ${endReason(content.reason)}`),
  ];

  if (instead === undefined) {
    return failed;
  }

  const usually = instead.tls ? "TLS" : "plaintext";

  return [
    ...failed,
    words(`. Port ${instead.port} is usually ${usually}: try `),
    {
      _tag: "Command",
      text: contained(`/set ${optionName(network, ["ircds"])} ${showText(ircds, [instead])}`),
    },
  ];
};

/**
 * The Message a reply answers, as a short quotation above the reply: who said it, in their
 * colour, how, and its text as plain text for one line, which a view cuts to its width.
 */
export interface Quoted {
  readonly colour: number;
  readonly kind: "Privmsg" | "Notice" | "Action";
  readonly nick: string;
  /** Where it stands in the reply's Timeline, which a view goes to. */
  readonly position: Answered["position"];
  readonly text: string;
}

/**
 * What a reply answers, as a quotation.
 * @param answered - The Message it answers, as the Daemon resolved it.
 * @returns The quotation.
 */
export const quotedOf = (answered: Answered): Quoted => ({
  colour: nickColour(answered.sender),
  kind: answered.kind,
  nick: contained(answered.sender),
  position: answered.position,
  text: plainText(answered.text),
});

/**
 * How an Activity reads: a refusal as one, a numeric as the Ircd's own words, and the rest
 * as Activity.
 * @param activity - The Activity.
 * @returns Its tone.
 */
const toneOf = (activity: Activity): "Activity" | "Refused" | "Numeric" => {
  if (activity._tag === "Numeric") {
    return "Numeric";
  }

  return (activity._tag === "StandardReply" && activity.kind === "FAIL") ||
    activity._tag === "CtcpUnsent" ||
    activity._tag === "OperRefused"
    ? "Refused"
    : "Activity";
};

/**
 * How a netsplit or a netjoin reads folded: which two servers, as the batch named them, and
 * how many of the Channel's members went or came back.
 * @param split - The netsplit or netjoin.
 * @returns The parts.
 */
const splitSummary = (split: Extract<Activity, { readonly _tag: "Netsplit" | "Netjoin" }>) => [
  words(split._tag === "Netsplit" ? "netsplit " : "netjoin "),
  name(split.servers[0]),
  words(" <-> "),
  name(split.servers[1]),
  words(`: ${split.nicks.length} ${split._tag === "Netsplit" ? "quit" : "joined"}`),
];

/**
 * How the message of the day reads folded: that it is one, how many lines it has, and that
 * it was cut short, if it was.
 * @param motd - The message of the day.
 * @returns The words.
 */
const motdSummary = (motd: {
  readonly cut: boolean;
  readonly lines: readonly string[];
}): string => {
  const count = motd.lines.length;
  const lines = count === 1 ? "1 line" : `${count} lines`;

  return `Message of the day, ${lines}${motd.cut ? ", cut short" : ""}`;
};

/**
 * One line of the message of the day as drawn: without the `- ` RFC 2812 puts before each,
 * or all of a lone `-`, and as it came otherwise. Every other space is kept.
 * @param line - The text of a `372`.
 * @returns Its inlines.
 */
const motdLine = (line: string): readonly Inline[] => {
  if (line === "-") {
    return formatted("");
  }

  return formatted(line.startsWith("- ") ? line.slice(2) : line);
};

/** How a run's line counts each kind of churn. */
const churnWords = {
  Joined: "joined",
  NickChanged: "changed nick",
  Parted: "left",
  Quit: "quit",
} as const;

/** The most Users a folded run's line names, the rest counted. */
const churnNamed = 5;

/**
 * A run of joins, parts, quits, and changes of nick as one line: how many of each, in that
 * order and only those there were, then the Users, up to {@link churnNamed}, in the order
 * they first appear, a change of nick being of the nick it had, and how many more there were.
 * @param run - The run, oldest first.
 * @returns The line.
 */
export const churnLine = (
  run: readonly Churn[]
): Extract<Line, { readonly _tag: "Description" }> => {
  const counts = (["Joined", "Parted", "Quit", "NickChanged"] as const).flatMap((tag) => {
    const count = run.filter((one) => one._tag === tag).length;

    return count === 0 ? [] : [`${count} ${churnWords[tag]}`];
  });

  // Each User once, by their nick folded, as it was first written.
  const first = new Map<string, string>();

  for (const one of run) {
    const nick = churnNick(one);

    if (!first.has(foldNick(nick))) {
      first.set(foldNick(nick), nick);
    }
  }

  const users = [...first.values()];

  const more = users.length - churnNamed;

  return {
    _tag: "Description",
    marker: "--",
    parts: [
      words(`${counts.join(", ")}: `),
      ...users
        .slice(0, churnNamed)
        .flatMap((nick, index) => [...(index === 0 ? [] : [words(", ")]), nickPart(nick)]),
      ...(more > 0 ? [words(` and ${more} more`)] : []),
    ],
    tone: "Activity",
  };
};

/**
 * An item as a line.
 * @param content - What the item shows.
 * @param network - The Network it belongs to, which a command it suggests names.
 * @returns The line.
 */
export const lineOf = (content: ItemContent, network: NetworkId): Line => {
  switch (content._tag) {
    case "Message": {
      const delivery = content.ours?.delivery;

      // The Ircd's own text for one of ours it confirmed, which may differ from what we said.
      const { nicks, text } = delivery?._tag === "Confirmed" ? delivery : content;

      return {
        _tag: "Message",
        bot: content.bot,
        colour: nickColour(content.sender),
        context: content.context === null ? undefined : contained(content.context),
        delivered: delivery === undefined ? undefined : deliveryWords(delivery),
        delivery: delivery?._tag,
        kind: content.kind,
        nick: contained(content.sender),
        prefix: content.prefix === null ? undefined : contained(content.prefix),
        text: formatted(text, nicks),
      };
    }

    case "Activity": {
      const { activity } = content;

      if (activity._tag === "Motd") {
        return {
          _tag: "Motd",
          lines: activity.lines.map(motdLine),
          marker: markerOf(activity),
          summary: motdSummary(activity),
        };
      }

      if (activity._tag === "Netsplit" || activity._tag === "Netjoin") {
        return {
          _tag: "Split",
          marker: markerOf(activity),
          nicks: activity.nicks.map(nickPart),
          summary: splitSummary(activity),
        };
      }

      return {
        _tag: "Description",
        marker: markerOf(activity),
        parts: describeActivity(activity, network),
        tone: toneOf(activity),
      };
    }

    case "SessionBegan": {
      return {
        _tag: "Description",
        marker: undefined,
        parts: [words("Connected as "), nickPart(content.nick)],
        tone: "Session",
      };
    }

    case "SessionEnded": {
      return {
        _tag: "Description",
        marker: undefined,
        parts: [words(`Disconnected: ${endReason(content.reason)}`)],
        tone: "Session",
      };
    }

    case "ConnectionFailed": {
      return {
        _tag: "Description",
        marker: undefined,
        parts: failedParts(content, network),
        tone: "Session",
      };
    }

    case "ActionRefused": {
      const { reason } = content;

      return {
        _tag: "Description",
        marker: undefined,
        parts: [
          ...attemptedParts(content.attempted),
          words(
            reason._tag === "Rejected"
              ? ` was refused (${contained(reason.reply)})`
              : " was not sent: its connection ended first"
          ),
        ],
        tone: "Refused",
      };
    }

    default: {
      return content satisfies never;
    }
  }
};
