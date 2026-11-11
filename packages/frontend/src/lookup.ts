/**
 * Lookups: what `/whois` and `/whowas` ask, a card for each Pane showing what came back,
 * and that card as text for a view to draw. The runtime asks the Daemon, under an intent
 * it names, and folds each answer in. Every field a Network wrote comes back contained, as
 * text, and the time a User signed on is formatted by a function the caller gives, since
 * the core reads no clock, locale, or time zone.
 *
 * @packageDocumentation
 */
import type {
  ChannelHeader,
  LookResult,
  LookupRequest,
  NetworkId,
  Profile,
  Rank,
  TimelineId,
} from "@iirc/api";
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";

import type { Intent, Parsed } from "./commands.ts";
import { contained, nickColour } from "./render.ts";
import { opened, resolve } from "./timelines.ts";
import type { Timelines } from "./timelines.ts";

/** Which Lookup: `WHOIS`, what the Network says of a User now, or `WHOWAS`, who held a nick. */
export type LookupKind = LookupRequest["_tag"];

/**
 * Look a nick up on a Network, from a Timeline: the Daemon's `look`. Its card shows in the
 * Pane that has the Timeline open, with each Channel's prefixes shown by `ranks`.
 */
export interface Look {
  readonly _tag: "Look";
  readonly network: NetworkId;
  /** The Timeline it was asked from, which its card shows over. */
  readonly timeline: TimelineId;
  readonly lookup: LookupRequest;
  /** The Network's `PREFIX`, as the head of the Channel in focus read it, or RFC 1459's. */
  readonly ranks: readonly Rank[];
}

/** RFC 1459's membership prefixes, which stand in until a head says the Network's. */
export const rfcRanks: readonly Rank[] = [
  { mode: "o", symbol: "@" },
  { mode: "v", symbol: "+" },
];

/** What starts a Channel's name while the Network's `CHANTYPES` is unknown: RFC 2811's. */
const rfcChantypes = "#&+!";

const firstOf = (name: string): string => {
  const first = name.codePointAt(0);

  return first === undefined ? "" : String.fromCodePoint(first);
};

/**
 * The Network's rules a nick is read by: what starts a Channel's name, `CHANTYPES`, and the
 * symbols of its membership prefixes, `PREFIX`'s. The Client also reads `STATUSMSG`, which
 * no route gives a Frontend, so a nick here is read as the Client reads one given none.
 */
export interface NickRules {
  readonly chantypes: string;
  readonly symbols: string;
}

/**
 * The rules a nick is read by, from the head of the Channel in focus, or as the Client
 * reads them before an Ircd says: `CHANTYPES` `#&` and `PREFIX` `(ov)@+`.
 * @param head - The head of the Channel in focus, if read.
 * @returns The rules.
 */
export const nickRulesOf = (head: ChannelHeader | undefined): NickRules => ({
  chantypes: head?.chantypes ?? "#&",
  symbols: (head?.ranks ?? rfcRanks).map((rank) => rank.symbol).join(""),
});

// As the Client's `parseNick` reads a nick: a space or a comma ends one, `*` and `?` are
// masks, and `!` and `@` split a source, so none is in one, and none starts with `$`, a
// server mask, or `:`, the last parameter. Only U+0020 is a space here, as there.
const notInNicks = /[ ,*?!@]/u;
const notFirstInNicks = /^[$:]/u;

// What no Line can carry, which the API refuses before the Client reads a nick at all.
const unsendable = /[\0\r\n]/u;

/**
 * Whether a name is a nick a Lookup can be of: exactly as the Client's `parseNick` reads
 * one given no `STATUSMSG`, and holding no NUL, CR, or LF, which the API refuses first.
 * `fixtures/nicks/vectors.ts` holds both to the same cases.
 * @param rules - The Network's rules.
 * @param name - The name.
 * @returns Whether it is one.
 */
export const isLookupNick = (rules: NickRules, name: string): boolean => {
  const first = firstOf(name);

  return !(
    first === "" ||
    notInNicks.test(name) ||
    notFirstInNicks.test(name) ||
    unsendable.test(name) ||
    rules.chantypes.includes(first) ||
    rules.symbols.includes(first)
  );
};

/**
 * The nick a Lookup is of, the text after the command trimmed, read as `isLookupNick`
 * reads it, or why it is none, in words. What the Network refuses beyond that, as a name
 * starting with a character of its `STATUSMSG`, the Client refuses as `Unsendable`, and
 * the card says so.
 * @param kind - The Lookup, to name its usage.
 * @param args - The text after the command's name.
 * @param rules - The Network's rules.
 * @returns The nick, or why it is not one, in words.
 */
export const parseLookupNick = (
  kind: LookupKind,
  args: string,
  rules: NickRules
): Parsed<string> => {
  const usage = `/${kind.toLowerCase()} <nick>`;
  const nick = args.trim();
  const first = firstOf(nick);

  const invalid = (why: string): Parsed<string> => ({
    _tag: "Invalid",
    message: `${why} ${usage}`,
  });

  if (nick === "") {
    return invalid("Whom?");
  }

  if (/[ ,]/u.test(nick)) {
    return invalid("Give one nick.");
  }

  if (unsendable.test(nick)) {
    return invalid("A nick holds no line break or NUL.");
  }

  if (notInNicks.test(nick) || notFirstInNicks.test(nick)) {
    return invalid("A Lookup takes one nick, never a mask or a source.");
  }

  if (rules.chantypes.includes(first)) {
    return invalid("That is a Channel's name. A Lookup takes a nick.");
  }

  if (rules.symbols.includes(first)) {
    return invalid(`Leave off the prefix ${first}: a nick does not start with it.`);
  }

  return { _tag: "Parsed", value: nick };
};

/**
 * The intent `/whois` or `/whowas` comes to, once its nick is read.
 * @param kind - The Lookup.
 * @param nick - The nick.
 * @param network - The Network in focus.
 * @param timeline - The Timeline in focus.
 * @param head - The head of the Channel in focus, if read, whose ranks show prefixes.
 * @returns The intent.
 */
export const lookOf = (
  kind: LookupKind,
  nick: string,
  network: NetworkId,
  timeline: TimelineId,
  head: ChannelHeader | undefined
): Look => ({
  _tag: "Look",
  lookup: { _tag: kind, nick },
  network,
  ranks: head?.network === network && head.ranks.length > 0 ? head.ranks : rfcRanks,
  timeline,
});

/**
 * Why a Lookup came to nothing on the Frontend's side, before any result.
 *
 * - `UnknownNetwork`: the Daemon has no such Network.
 * - `Stopped`: the Network stopped, and the Daemon journaled no Lookup under its intent.
 * - `NoAnswer`: no result came within the time the runtime asks for.
 * - `Unexpected`: anything else.
 */
export type LookFailure = "UnknownNetwork" | "Stopped" | "NoAnswer" | "Unexpected";

/**
 * How a Lookup stands.
 *
 * - `Asking`: asked, with no answer yet.
 * - `Pending`: the Daemon had no result within its bound, and the runtime asks again.
 * - `Done`: its result.
 * - `Lost`: it came to nothing, and why.
 */
export type LookPhase =
  | { readonly _tag: "Asking" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Done"; readonly result: LookResult }
  | { readonly _tag: "Lost"; readonly failure: LookFailure };

/** One Pane's card: the Lookup it shows, how it stands, and how its Network folds names. */
export interface Card {
  /** Unique across the page, so an answer for a card replaced is ignored. */
  readonly id: number;
  readonly look: Look;
  readonly phase: LookPhase;
  /**
   * How the Network folds names and what starts a Channel's name, as `known` said, or none
   * until it is read or when it could not be: a Channel opens or joins only once known.
   */
  readonly naming: Naming | undefined;
}

/**
 * How a Network names Channels: the casemapping it last declared, `rfc1459` when none was,
 * as the Daemon keys Timelines, and its `CHANTYPES`, RFC 2811's while unsaid.
 */
export interface Naming {
  readonly casemapping: Casemapping;
  readonly chantypes: string;
}

/** Each Pane's card, at most one, by the Pane's id. */
export interface Lookups {
  readonly cards: ReadonlyMap<string, Card>;
  /** The id the next card takes. */
  readonly next: number;
}

export const initialLookups: Lookups = { cards: new Map(), next: 1 };

/**
 * What happened to the Lookups.
 *
 * - `Asked`: a Lookup was asked in a Pane, replacing its card.
 * - `Waited`: the Daemon answered `Pending`.
 * - `Answered`: its result came.
 * - `Failed`: it came to nothing.
 * - `Named`: how its Network names Channels, as `known` said: the casemapping it declared,
 *   `null` for none, and its `CHANTYPES`, `null` while unsaid.
 * - `Dismissed`: the Owner closed the Pane's card.
 * - `Kept`: the Panes there are now: the card of any other is let go of.
 * - `Cleared`: the page signed out, so every card is let go of.
 */
export type LookupsEvent =
  | { readonly _tag: "Asked"; readonly pane: string; readonly look: Look }
  | { readonly _tag: "Waited"; readonly id: number }
  | { readonly _tag: "Answered"; readonly id: number; readonly result: LookResult }
  | { readonly _tag: "Failed"; readonly id: number; readonly failure: LookFailure }
  | {
      readonly _tag: "Named";
      readonly id: number;
      readonly declared: Casemapping | null;
      readonly chantypes: string | null;
    }
  | { readonly _tag: "Dismissed"; readonly pane: string }
  | { readonly _tag: "Kept"; readonly panes: readonly string[] }
  | { readonly _tag: "Cleared" };

/**
 * The card with an id, and its Pane, while it is still a Pane's.
 * @param state - The Lookups.
 * @param id - The card's id.
 * @returns The Pane and the card, or none once it was replaced or dismissed.
 */
export const cardWithId = (
  state: Lookups,
  id: number
): { readonly pane: string; readonly card: Card } | undefined => {
  for (const [pane, card] of state.cards) {
    if (card.id === id) {
      return { card, pane };
    }
  }

  return undefined;
};

/**
 * The Lookups with one card changed, while it is still a Pane's.
 * @param state - The Lookups.
 * @param id - The card's id.
 * @param change - What becomes of it.
 * @returns The Lookups.
 */
const changing = (state: Lookups, id: number, change: (card: Card) => Card): Lookups => {
  const found = cardWithId(state, id);

  if (found === undefined) {
    return state;
  }

  const cards = new Map(state.cards);

  cards.set(found.pane, change(found.card));

  return { ...state, cards };
};

/**
 * Folds one event into the Lookups. An answer for a card no Pane holds any more changes
 * nothing, and a result, once it came, is never replaced.
 * @param state - The Lookups.
 * @param event - What happened.
 * @returns The Lookups.
 */
export const reduceLookups = (state: Lookups, event: LookupsEvent): Lookups => {
  switch (event._tag) {
    case "Asked": {
      const cards = new Map(state.cards);

      cards.set(event.pane, {
        id: state.next,
        look: event.look,
        naming: undefined,
        phase: { _tag: "Asking" },
      });

      return { cards, next: state.next + 1 };
    }

    case "Waited": {
      return changing(state, event.id, (card) =>
        card.phase._tag === "Asking" ? { ...card, phase: { _tag: "Pending" } } : card
      );
    }

    case "Answered": {
      return changing(state, event.id, (card) =>
        card.phase._tag === "Done"
          ? card
          : { ...card, phase: { _tag: "Done", result: event.result } }
      );
    }

    case "Failed": {
      return changing(state, event.id, (card) =>
        card.phase._tag === "Done"
          ? card
          : { ...card, phase: { _tag: "Lost", failure: event.failure } }
      );
    }

    case "Named": {
      return changing(state, event.id, (card) => ({
        ...card,
        naming: {
          casemapping: event.declared ?? defaultCasemapping,
          chantypes: event.chantypes ?? rfcChantypes,
        },
      }));
    }

    case "Dismissed": {
      if (!state.cards.has(event.pane)) {
        return state;
      }

      const cards = new Map(state.cards);

      cards.delete(event.pane);

      return { ...state, cards };
    }

    case "Kept": {
      const kept = new Set(event.panes);

      return [...state.cards.keys()].every((pane) => kept.has(pane))
        ? state
        : { ...state, cards: new Map([...state.cards].filter(([pane]) => kept.has(pane))) };
    }

    // The ids go on counting, so an answer for a card from before is never taken for one
    // made after.
    case "Cleared": {
      return state.cards.size === 0 ? state : { ...state, cards: new Map() };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The card a Pane shows: its own, while the Pane still has open the Timeline it was asked
 * from, so opening another there puts it away, and opening that one again shows it.
 * @param state - The Lookups.
 * @param timelines - The Timelines.
 * @param pane - The Pane's id.
 * @returns The card, or none.
 */
export const shownCard = (state: Lookups, timelines: Timelines, pane: string): Card | undefined => {
  const card = state.cards.get(pane);
  const shown = opened(timelines, pane);

  return card !== undefined &&
    shown._tag !== "Closed" &&
    shown.timeline === resolve(timelines, card.look.timeline)
    ? card
    : undefined;
};

/** A Channel a profile lists, as the card shows it. */
export interface ChannelShown {
  /** Its name, contained. */
  readonly name: string;
  /** The symbols of the prefixes the User holds there, most privileged first. */
  readonly symbols: string;
  /** What a screen reader hears, such as `#iirc, operator`. */
  readonly label: string;
  /**
   * What choosing it does: open its Timeline, or start `/join` in the composer when there is
   * none, or nothing until the Network's casemapping is known, or for a name that cannot be
   * a Channel's.
   */
  readonly choose: Intent | undefined;
}

/** A numeric the card reads nothing of, as its parameters, contained, for showing dimly. */
export interface OtherShown {
  readonly numeric: string;
  readonly text: string;
}

/** One User, as the card shows them: every text contained, and `undefined` where unsaid. */
export interface ProfileShown {
  readonly nick: string;
  readonly colour: number;
  /** `user@host`, or either alone, with `?` for the other. */
  readonly mask: string | undefined;
  readonly realname: string | undefined;
  readonly server: { readonly name: string; readonly info: string } | undefined;
  readonly operator: boolean;
  /** Humanised, such as `idle 3m`. */
  readonly idle: string | undefined;
  /** Such as `signed on 12 Nov 2026, 09:14`, by the caller's format. */
  readonly signon: string | undefined;
  readonly channels: readonly ChannelShown[];
  readonly away: string | undefined;
  readonly account: string | undefined;
  readonly secure: boolean;
  /** Where the User actually connects from: the mask, the IP address, or both, each contained. */
  readonly actual: string | undefined;
  /** The User's modes, such as `+Zi`, contained. */
  readonly modes: string | undefined;
  readonly other: readonly OtherShown[];
}

/**
 * A card as a view draws it: what was looked up, and how it stands.
 *
 * - `Waiting`: no result yet, in words.
 * - `Profiles`: each User described, with a note when the reply was cut short.
 * - `Said`: no User, in words.
 */
export interface CardShown {
  readonly kind: LookupKind;
  readonly nick: string;
  readonly colour: number;
  readonly body:
    | { readonly _tag: "Waiting"; readonly words: string }
    | {
        readonly _tag: "Profiles";
        readonly profiles: readonly ProfileShown[];
        readonly note: string | undefined;
      }
    | { readonly _tag: "Said"; readonly words: string };
}

/**
 * Seconds idle, humanised to its two largest units: `idle 42s`, `idle 3m`, `idle 2h 5m`,
 * `idle 3d 4h`. A negative count, which no Ircd means, says nothing.
 * @param seconds - Seconds idle.
 * @returns The words, or none.
 */
export const idleText = (seconds: number): string | undefined => {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return undefined;
  }

  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return hours % 24 === 0 ? `idle ${days}d` : `idle ${days}d ${hours % 24}h`;
  }

  if (hours > 0) {
    return minutes % 60 === 0 ? `idle ${hours}h` : `idle ${hours}h ${minutes % 60}m`;
  }

  return minutes > 0 ? `idle ${minutes}m` : `idle ${seconds}s`;
};

/** RFC 2811's names for the modes `o` and `v`, said for a screen reader. */
const rankNames: ReadonlyMap<string, string> = new Map([
  ["o", "operator"],
  ["v", "voice"],
]);

/**
 * Whether a name can be a Channel's, by RFC 2811's grammar and the Network's `CHANTYPES`,
 * so choosing it can only ever open or join that Channel: it starts with one, and holds no
 * space, comma, control, or bidirectional formatting, which the composer would show unseen.
 * @param naming - How the Network names Channels.
 * @param name - The name.
 * @returns Whether it can.
 */
const joinable = (naming: Naming, name: string): boolean =>
  naming.chantypes.includes(firstOf(name)) &&
  // oxlint-disable-next-line no-control-regex -- a control in a Channel's name is what this refuses.
  !/[\s,\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(name);

/**
 * What choosing a Channel does: opens its Timeline on the Network, keyed as the Daemon keyed
 * it, or starts `/join <name>` in the composer, for the Owner to send.
 * @param timelines - The Timelines.
 * @param card - The card.
 * @param name - The Channel's name, as the Network said it.
 * @returns The intent, or none.
 */
const choosing = (timelines: Timelines, card: Card, name: string): Intent | undefined => {
  const { naming } = card;

  if (naming === undefined || !joinable(naming, name)) {
    return undefined;
  }

  const key = casefold(naming.casemapping, name);

  const found = [...(timelines.networks.get(card.look.network)?.timelines.values() ?? [])].find(
    (one) => one.kind === "Channel" && one.key === key
  );

  return found === undefined
    ? { _tag: "FocusComposer", text: `/join ${name}` }
    : { _tag: "Open", timeline: found.id };
};

/**
 * One Channel a profile lists, with the symbols of the prefixes held there, by the ranks.
 * A mode the ranks do not name shows no symbol, and is said for a screen reader.
 * @param timelines - The Timelines.
 * @param card - The card.
 * @param channel - The Channel, as the reply said it.
 * @returns The Channel, as the card shows it.
 */
const channelShown = (
  timelines: Timelines,
  card: Card,
  channel: Profile["channels"][number]
): ChannelShown => {
  const { ranks } = card.look;
  const held = ranks.filter((rank) => channel.prefixes.includes(rank.mode));
  const name = contained(channel.name);

  const words = [
    ...held.map((rank) => rankNames.get(rank.mode) ?? `mode ${contained(rank.mode)}`),
    ...channel.prefixes
      .filter((mode) => !ranks.some((rank) => rank.mode === mode))
      .map((mode) => `mode ${contained(mode)}`),
  ];

  return {
    choose: choosing(timelines, card, channel.name),
    label: [name, ...words].join(", "),
    name,
    symbols: contained(held.map((rank) => rank.symbol).join("")),
  };
};

/**
 * Text a Network wrote, contained, or none when it said nothing or nothing but whitespace.
 * @param text - The text.
 * @returns The text to show, or none.
 */
const said = (text: string | null): string | undefined =>
  text === null || text.trim() === "" ? undefined : contained(text);

/**
 * When a User signed on, in words, or that it cannot be shown, as for an instant out of
 * any calendar's range, which a hostile Network can give.
 * @param formatted - The instant, as the caller formatted it, or none when it could not be.
 * @returns The words.
 */
const signonText = (formatted: string | undefined): string =>
  formatted === undefined ? "sign-on time unavailable" : `signed on ${formatted}`;

/**
 * One User, as the card shows them.
 * @param timelines - The Timelines.
 * @param card - The card.
 * @param profile - The User, as the reply described them.
 * @param time - Formats an instant, in milliseconds, as the Owner reads a date and time, or
 * gives none when it cannot be.
 * @returns The profile.
 */
export const profileShown = (
  timelines: Timelines,
  card: Card,
  profile: Profile,
  time: (instant: number) => string | undefined
): ProfileShown => {
  const { actual, host, user } = profile;
  const where = actual === null ? [] : [actual.mask, actual.ip].map(said);
  const connects = where.filter((one) => one !== undefined);

  return {
    account: said(profile.account),
    actual: connects.length === 0 ? undefined : connects.join(" "),
    away: said(profile.away),
    channels: profile.channels.map((channel) => channelShown(timelines, card, channel)),
    colour: nickColour(profile.nick),
    idle: profile.idle === null ? undefined : idleText(profile.idle),
    mask:
      user === null && host === null
        ? undefined
        : `${contained(user ?? "?")}@${contained(host ?? "?")}`,
    modes: said(profile.modes),
    nick: contained(profile.nick),
    operator: profile.operator,
    other: profile.other.map((one) => ({
      numeric: contained(one.numeric),
      text: one.params.map((param) => contained(param)).join(" "),
    })),
    realname: said(profile.realname),
    secure: profile.secure,
    server:
      profile.server === null
        ? undefined
        : { info: contained(profile.server.info), name: contained(profile.server.name) },
    signon: profile.signon === null ? undefined : signonText(time(profile.signon)),
  };
};

/** Why a reply was cut short, in words. */
const partialWords: Readonly<Record<"TimedOut" | "Ended" | "Bounded", string>> = {
  Bounded: "The reply ran longer than a Lookup keeps, so this is how it began.",
  Ended: "The connection ended before the reply did, so this is what had come.",
  TimedOut: "The Network had not finished replying after 30 seconds, so this is what had come.",
};

/** Why a Lookup was not sent, in words. */
const refusedWords: Readonly<Record<"Offline" | "Unsendable" | "Busy", string>> = {
  Busy: "Not looked up: too many Lookups are waiting on this Network. Try again in a moment.",
  Offline: "Not looked up: the Network is not connected.",
  Unsendable: "Not looked up: the Network cannot be asked about that nick.",
};

/** Why a Lookup came to nothing on the Frontend's side, in words. */
const lostWords: Readonly<Record<LookFailure, string>> = {
  NoAnswer: "No result came from the Daemon in time. Try again.",
  Stopped: "The Network stopped before it was looked up. Try again.",
  Unexpected: "The Daemon could not look it up.",
  UnknownNetwork: "The Daemon has no such Network.",
};

/**
 * What a result says of no User, in words.
 * @param kind - The Lookup.
 * @param nick - The nick, contained.
 * @param result - The result, of no User.
 * @returns The words.
 */
const noUser = (
  kind: LookupKind,
  nick: string,
  result: Exclude<LookResult, { readonly _tag: "Found" | "Partial" }>
): string => {
  switch (result._tag) {
    case "NotFound": {
      return kind === "Whois"
        ? `No one uses the nick ${nick} now (${contained(result.reply)}).`
        : `The Network remembers no one who used the nick ${nick} (${contained(result.reply)}).`;
    }

    case "Failed": {
      return `The Network refused the Lookup (${contained(result.reply)}).`;
    }

    case "Refused": {
      return refusedWords[result.reason];
    }

    case "Unsent": {
      return "Not looked up: the connection ended before it was sent.";
    }

    default: {
      return result satisfies never;
    }
  }
};

/**
 * A card as a view draws it.
 * @param timelines - The Timelines, for which Channels have a Timeline to open.
 * @param card - The card.
 * @param time - Formats an instant, in milliseconds, as the Owner reads a date and time, or
 * gives none when it cannot be.
 * @returns What it shows.
 */
export const cardShown = (
  timelines: Timelines,
  card: Card,
  time: (instant: number) => string | undefined
): CardShown => {
  const { lookup } = card.look;
  const nick = contained(lookup.nick);
  const head = { colour: nickColour(lookup.nick), kind: lookup._tag, nick };
  const { phase } = card;

  switch (phase._tag) {
    case "Asking": {
      return { ...head, body: { _tag: "Waiting", words: "Looking up…" } };
    }

    case "Pending": {
      return {
        ...head,
        body: { _tag: "Waiting", words: "Still waiting for the Network's reply…" },
      };
    }

    case "Lost": {
      return { ...head, body: { _tag: "Said", words: lostWords[phase.failure] } };
    }

    case "Done": {
      const { result } = phase;

      if (result._tag !== "Found" && result._tag !== "Partial") {
        return { ...head, body: { _tag: "Said", words: noUser(lookup._tag, nick, result) } };
      }

      const note = result._tag === "Partial" ? partialWords[result.reason] : undefined;

      if (result.profiles.length === 0) {
        return {
          ...head,
          body: { _tag: "Said", words: note ?? `Nothing came back about ${nick}.` },
        };
      }

      return {
        ...head,
        body: {
          _tag: "Profiles",
          note,
          profiles: result.profiles.map((profile) => profileShown(timelines, card, profile, time)),
        },
      };
    }

    default: {
      return phase satisfies never;
    }
  }
};
