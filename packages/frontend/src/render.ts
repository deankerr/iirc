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
  Attempted,
  Delivery as WireDelivery,
  EndReason,
  ItemContent,
  NetworkId,
} from "@iirc/api";
import type { IrcdAddress } from "@iirc/client/configuration";
import { casefold } from "@iirc/protocol/casemapping";
import { parseFormatting, stripFormatting } from "@iirc/protocol/format";
import type { Style } from "@iirc/protocol/format";

import { optionName, showText } from "./options.ts";
import type { Kind } from "./options.ts";

export type { Colour, Style } from "@iirc/protocol/format";

/**
 * A run of text in one style: plain text, or a link a view may open. A link's `href` is
 * always `http`, `https`, `irc`, or `ircs`, as the URL parser wrote it.
 */
export type Inline =
  | { readonly _tag: "Text"; readonly text: string; readonly style: Style }
  | { readonly _tag: "Link"; readonly text: string; readonly href: string; readonly style: Style };

/** The schemes a link may have. Anything else stays text. */
export const linkSchemes: ReadonlySet<string> = new Set(["http:", "https:", "irc:", "ircs:"]);

// The bidirectional formatting characters: embeddings and overrides, their pop, isolates,
// their pop, and the marks.
const embeddings = new Set([0x20_2a, 0x20_2b, 0x20_2d, 0x20_2e]);
const popEmbedding = 0x20_2c;
const isolates = new Set([0x20_66, 0x20_67, 0x20_68]);
const popIsolate = 0x20_69;

/**
 * A control character as a symbol a reader can see: C0 controls and DEL as their Control
 * Pictures, C1 controls and lone surrogates as the replacement character, and the line and
 * paragraph separators as the newline symbol. Anything else is itself.
 * @param character - One code point, as a string.
 * @returns What to show for it.
 */
const visible = (character: string): string => {
  const code = character.codePointAt(0) ?? 0;

  if (code < 0x20) {
    return String.fromCodePoint(0x24_00 + code);
  }

  if (code === 0x7f) {
    return "\u2421";
  }

  if ((code >= 0x80 && code <= 0x9f) || (code >= 0xd8_00 && code <= 0xdf_ff)) {
    return "\uFFFD";
  }

  // A line or paragraph separator would start a new line, or a new bidirectional paragraph.
  if (code === 0x20_28 || code === 0x20_29) {
    return "\u2424";
  }

  return character;
};

/**
 * Text made safe to put beside other text: every control character shown as a symbol, and
 * every bidirectional embedding, override, or isolate it opens closed at its end, so it
 * cannot reorder what follows it. A view also isolates each run, and this holds without.
 * @param text - Text a Network sent, with no formatting codes left.
 * @returns The text to show.
 */
export const contained = (text: string): string => {
  const open: number[] = [];
  // How many isolates are open, so a pop with none skips the search, and each search
  // drops what it passes over: the work is linear however the text nests.
  let isolating = 0;
  let shown = "";

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (embeddings.has(code) || isolates.has(code)) {
      open.push(code);
      isolating += isolates.has(code) ? 1 : 0;
    } else if (code === popEmbedding) {
      if (open.length > 0 && embeddings.has(open.at(-1) ?? 0)) {
        open.pop();
      }
    } else if (code === popIsolate && isolating > 0) {
      open.length = open.findLastIndex((opened) => isolates.has(opened));
      isolating -= 1;
    }

    shown += visible(character);
  }

  return (
    shown +
    open
      .toReversed()
      .map((code) => String.fromCodePoint(isolates.has(code) ? popIsolate : popEmbedding))
      .join("")
  );
};

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

/**
 * The characters of text a Network sent, as plain text shows them: mIRC formatting
 * stripped, every control, bidirectional formatting character, and lone surrogate dropped,
 * and line and paragraph separators made spaces. Each is one code point.
 * @param text - The text, as the Network sent it.
 * @param limit - How many are needed: reading stops one past it.
 * @returns The characters.
 */
export const plainCharacters = (
  text: string,
  limit = Number.POSITIVE_INFINITY
): readonly string[] => {
  const kept: string[] = [];

  for (const character of stripFormatting(text)) {
    const code = character.codePointAt(0) ?? 0;

    if (code === 0x20_28 || code === 0x20_29) {
      kept.push(" ");
    } else if (!dropped(code)) {
      kept.push(character);
    }

    // One past the limit says it is cut, and nothing further is needed.
    if (kept.length > limit) {
      break;
    }
  }

  return kept;
};

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

// A link starts at a scheme we allow and runs to whitespace, a control, a bidirectional
// formatting character, or a character a URL never holds unescaped.
const linkPattern =
  // oxlint-disable-next-line no-control-regex -- control characters end a link, so the pattern names them
  /\b(?:https?|ircs?):\/\/[^\s<>"`{}|\\^\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/giu;

const trailing = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*"]);

const closers: ReadonlyMap<string, string> = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

const openers: ReadonlySet<string> = new Set(closers.values());

/**
 * A link candidate without the punctuation that ends a sentence around it: trailing stops
 * and quotes, and a closing bracket the link did not open.
 * @param candidate - What the pattern matched.
 * @returns The link's text.
 */
const trimmed = (candidate: string): string => {
  // Each bracket counted once, and the counts kept as the end moves, so hostile text of
  // many brackets is trimmed in one pass.
  const counts = new Map<string, number>();

  for (const character of candidate) {
    if (closers.has(character) || openers.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
  }

  let end = candidate.length;

  for (;;) {
    const last = candidate.charAt(end - 1);
    const opener = closers.get(last);

    const unbalanced = opener !== undefined && (counts.get(opener) ?? 0) < (counts.get(last) ?? 0);

    if (end > 0 && (trailing.has(last) || unbalanced)) {
      if (opener !== undefined) {
        counts.set(last, (counts.get(last) ?? 0) - 1);
      }

      end -= 1;
    } else {
      return candidate.slice(0, end);
    }
  }
};

/**
 * The link a candidate is, if the URL parser reads it and its scheme is allowed.
 * @param text - The candidate's text.
 * @returns Its `href`, as the parser wrote it, or `undefined`.
 */
const hrefOf = (text: string): string | undefined => {
  const url = URL.parse(text);

  return url !== null && linkSchemes.has(url.protocol) && url.host !== "" ? url.href : undefined;
};

/**
 * One run of formatted text, split into text and links.
 * @param text - The run's text, with no formatting codes left.
 * @param style - Its style.
 * @returns Its inlines.
 */
const linked = (text: string, style: Style): readonly Inline[] => {
  const inlines: Inline[] = [];
  let from = 0;

  const textUpTo = (end: number) => {
    if (end > from) {
      inlines.push({ _tag: "Text", style, text: contained(text.slice(from, end)) });
    }
  };

  for (const match of text.matchAll(linkPattern)) {
    const candidate = trimmed(match[0]);
    const href = hrefOf(candidate);

    if (href !== undefined && candidate.length > 0) {
      textUpTo(match.index);
      inlines.push({ _tag: "Link", href, style, text: candidate });
      from = match.index + candidate.length;
    }
  }

  textUpTo(text.length);

  return inlines;
};

/**
 * Text a Network sent, as a view draws it: mIRC formatting read into styles, links found in
 * each run, control characters shown as symbols, and bidirectional formatting closed at
 * the end of each run. A link inside a run of one style is found, and one that formatting
 * splits is shown as text.
 * @param text - The text, as it arrived.
 * @returns Its inlines, in order.
 */
export const formatted = (text: string): readonly Inline[] =>
  parseFormatting(text).flatMap((span) => linked(span.text, span.style));

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
  | { readonly _tag: "Command"; readonly text: string };

/** Where one of our Messages stands with the Ircd, as shown. */
export type Delivery = "Pending" | "Unconfirmed" | "Confirmed" | "Unsent" | "Rejected";

/**
 * One item as a line: a Message, by its sender, with its text and, for one of ours, its
 * delivery, or a description of an Activity, a Session's start or end, or an action of
 * ours that was refused, whose tone is `Refused`.
 */
export type Line =
  | {
      readonly _tag: "Message";
      readonly kind: "Privmsg" | "Notice" | "Action";
      readonly nick: string;
      readonly colour: number;
      readonly text: readonly Inline[];
      readonly delivery: Delivery | undefined;
      /** How its delivery stands in a few words, or none when there is nothing to say. */
      readonly delivered: string | undefined;
    }
  | {
      readonly _tag: "Description";
      readonly tone: "Activity" | "Session" | "Refused";
      readonly parts: readonly Part[];
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

/**
 * An Activity in words.
 * @param activity - The Activity.
 * @returns Its parts.
 */
const describeActivity = (activity: Activity): readonly Part[] => {
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

    case "AwayChanged": {
      return activity.away === null
        ? [nickPart(activity.nick), words(" is back")]
        : [
            nickPart(activity.nick),
            words(" is away"),
            ...(activity.away.message === "" ? [] : [words(": "), said(activity.away.message)]),
          ];
    }

    default: {
      return activity satisfies never;
    }
  }
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
 * a refusal with the Ircd's numeric or code, contained, never its text.
 * @param delivery - How it stands.
 * @returns The words, or none.
 */
const deliveryWords = (delivery: WireDelivery): string | undefined => {
  switch (delivery._tag) {
    case "Pending": {
      return "sending";
    }

    case "Unconfirmed": {
      return "unconfirmed";
    }

    case "Unsent": {
      return "not sent";
    }

    case "Rejected": {
      return `refused: ${contained(delivery.reply)}`;
    }

    case "Confirmed": {
      return undefined;
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
      const text = delivery?._tag === "Confirmed" ? delivery.text : content.text;

      return {
        _tag: "Message",
        colour: nickColour(content.sender),
        delivered: delivery === undefined ? undefined : deliveryWords(delivery),
        delivery: delivery?._tag,
        kind: content.kind,
        nick: contained(content.sender),
        text: formatted(text),
      };
    }

    case "Activity": {
      return { _tag: "Description", parts: describeActivity(content.activity), tone: "Activity" };
    }

    case "SessionBegan": {
      return {
        _tag: "Description",
        parts: [words("Connected as "), nickPart(content.nick)],
        tone: "Session",
      };
    }

    case "SessionEnded": {
      return {
        _tag: "Description",
        parts: [words(`Disconnected: ${endReason(content.reason)}`)],
        tone: "Session",
      };
    }

    case "ConnectionFailed": {
      return {
        _tag: "Description",
        parts: failedParts(content, network),
        tone: "Session",
      };
    }

    case "ActionRefused": {
      const { reason } = content;

      return {
        _tag: "Description",
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
