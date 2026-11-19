/**
 * Lookups: what `/whois`, `/whowas`, `/names`, `/who`, `/list`, and the commands of a Channel's
 * lists ask, a card for each Pane showing what came back, and that card as text for a view to
 * draw. The runtime
 * asks the Daemon, under an intent it names, and folds each answer in. Every field a
 * Network wrote comes back contained, as text, and a time is formatted by a function the
 * caller gives, since the core reads no clock, locale, or time zone.
 *
 * @packageDocumentation
 */
import type {
  ChannelEntry,
  ChannelHeader,
  LookResult,
  LookupRequest,
  MaskEntry,
  NamesEntry,
  NetworkId,
  Profile,
  Rank,
  StandardReply,
  TimelineChange,
  TimelineId,
  WhoEntry,
} from "@iirc/api";
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";

import { mayOperate } from "./channel.ts";
import type { Act, Intent, Parsed } from "./commands.ts";
import { contained, nickColour } from "./render.ts";
import { opened, resolve } from "./timelines.ts";
import type { Timelines } from "./timelines.ts";

/**
 * Which Lookup: `WHOIS`, what the Network says of a User now, `WHOWAS`, who held a nick,
 * `NAMES`, a Channel's members, `WHO`, the Users a mask matches, `LIST`, the Network's
 * Channels, or one of a Channel's lists.
 */
export type LookupKind = LookupRequest["_tag"];

/** A Lookup of a User. */
export type UserKind = Extract<LookupKind, "Whois" | "Whowas">;

/** A Lookup of a Channel's list of masks: its bans, ban exceptions, or invitation masks. */
export type ListKind = Extract<LookupKind, "Bans" | "Exceptions" | "Invitations">;

/** A Lookup of a Channel: its members, or one of its lists. */
export type ChannelKind = ListKind | "Names";

/** Where a Channel's head says the mode of each list, by its kind. */
const listKeys: Readonly<Record<ListKind, "bans" | "exceptions" | "invitations">> = {
  Bans: "bans",
  Exceptions: "exceptions",
  Invitations: "invitations",
};

/** Each list, in words, as a sentence names it. */
export const listWords: Readonly<Record<ListKind, string>> = {
  Bans: "bans",
  Exceptions: "ban exceptions",
  Invitations: "invitation masks",
};

/**
 * Whether a Lookup is of a Channel's list.
 * @param lookup - The Lookup.
 * @returns Whether it is.
 */
export const isListLookup = (
  lookup: LookupRequest
): lookup is Extract<LookupRequest, { readonly _tag: ListKind }> =>
  lookup._tag === "Bans" || lookup._tag === "Exceptions" || lookup._tag === "Invitations";

/**
 * The mode of a list as a Channel's head says the Network keeps it: a letter, `null` for a
 * list it does not keep, or `undefined` when the head is not read.
 * @param head - The head of a Channel on the Network, if read.
 * @param kind - The list.
 * @returns The mode, `null`, or `undefined`.
 */
export const listMode = (
  head: ChannelHeader | undefined,
  kind: ListKind
): string | null | undefined =>
  head?.lists === null || head?.lists === undefined ? undefined : head.lists[listKeys[kind]];

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
export const parseLookupNick = (kind: UserKind, args: string, rules: NickRules): Parsed<string> => {
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

/** The command of each Lookup of a Channel, without its `/`. */
export const listCommandNames: Readonly<Record<ChannelKind, string>> = {
  Bans: "bans",
  Exceptions: "exceptions",
  Invitations: "invexes",
  Names: "names",
};

/**
 * The Channel a command of a Channel is of: the one named, or the Channel in focus when none is,
 * as one name the Client could take for a Channel's, or why it is not one, in words.
 * Whether the Network has such a Channel, or keeps the list, the Client and the Network
 * decide.
 * @param kind - The Lookup, to name its command.
 * @param args - The text after the command's name.
 * @param focus - The kind and name of the Timeline in focus.
 * @param chantypes - What starts a Channel's name on the Network, if the head says; unsaid, the Client decides.
 * @returns The Channel's name, or why there is none, in words.
 */
export const parseListChannel = (
  kind: ChannelKind,
  args: string,
  focus: { readonly kind: "Network" | "Channel" | "Direct"; readonly name: string },
  chantypes: string | undefined
): Parsed<string> => {
  const usage = `/${listCommandNames[kind]} [channel]`;

  const name = args.trim();

  const invalid = (why: string): Parsed<string> => ({
    _tag: "Invalid",
    message: `${why} ${usage}`,
  });

  if (name === "") {
    return focus.kind === "Channel"
      ? { _tag: "Parsed", value: focus.name }
      : invalid("Of which Channel? Open it, or name it:");
  }

  if (/[\s,]/u.test(name) || unsendable.test(name)) {
    return invalid("Give one Channel.");
  }

  // While no head says the Network's `CHANTYPES`, any prefix may start a Channel's name
  // there, so the Client, which knows it, decides.
  return chantypes === undefined || chantypes.includes(firstOf(name))
    ? { _tag: "Parsed", value: name }
    : invalid(`${name} is no Channel's name.`);
};

/**
 * The intent a command of a Channel comes to, once its Channel is read.
 * @param kind - The Lookup.
 * @param channel - The Channel's name.
 * @param network - The Network in focus.
 * @param timeline - The Timeline in focus.
 * @returns The intent.
 */
export const listLookOf = (
  kind: ListKind,
  channel: string,
  network: NetworkId,
  timeline: TimelineId
): Look => ({
  _tag: "Look",
  lookup: { _tag: kind, channel },
  network,
  ranks: rfcRanks,
  timeline,
});

/**
 * The ranks a card shows prefixes by: the Network's `PREFIX`, as the head of the Channel in
 * focus read it, or RFC 1459's.
 * @param head - The head of the Channel in focus, if read.
 * @param network - The Network the Lookup is on.
 * @returns The ranks.
 */
const ranksOf = (head: ChannelHeader | undefined, network: NetworkId): readonly Rank[] =>
  head?.network === network && head.ranks.length > 0 ? head.ranks : rfcRanks;

/**
 * The intent `/names` comes to, once its Channel is read: its members shown with the
 * Network's prefix symbols.
 * @param channel - The Channel's name.
 * @param network - The Network in focus.
 * @param timeline - The Timeline in focus.
 * @param head - The head of the Channel in focus, if read, whose ranks show prefixes.
 * @returns The intent.
 */
export const namesLookOf = (
  channel: string,
  network: NetworkId,
  timeline: TimelineId,
  head: ChannelHeader | undefined
): Look => ({
  _tag: "Look",
  lookup: { _tag: "Names", channel },
  network,
  ranks: ranksOf(head, network),
  timeline,
});

/**
 * The intent `/who` comes to, once its mask is read.
 * @param mask - The mask.
 * @param network - The Network in focus.
 * @param timeline - The Timeline in focus.
 * @returns The intent.
 */
export const whoLookOf = (mask: string, network: NetworkId, timeline: TimelineId): Look => ({
  _tag: "Look",
  lookup: { _tag: "Who", mask },
  network,
  ranks: rfcRanks,
  timeline,
});

/**
 * The mask `/who` is of, the text after the command trimmed: one word the Client can send,
 * or why it is none, in words. Whether the Network accepts it, the Client and the Network
 * decide.
 * @param args - The text after the command's name.
 * @returns The mask, or why there is none, in words.
 */
export const parseWhoMask = (args: string): Parsed<string> => {
  const usage = "/who <mask>";
  const mask = args.trim();

  if (mask === "") {
    return { _tag: "Invalid", message: `Which mask? ${usage}` };
  }

  if (/\s/u.test(mask) || unsendable.test(mask)) {
    return { _tag: "Invalid", message: `Give one mask. ${usage}` };
  }

  return { _tag: "Parsed", value: mask };
};

/** What `/list` asks of the Network's Channels: a mask of their names, and a least number of members. */
export type Conditions = Omit<Extract<LookupRequest, { readonly _tag: "Channels" }>, "_tag">;

/**
 * The conditions of `/list`, with a key only for each given.
 * @param mask - The mask, if given.
 * @param least - The least number of members, if given.
 * @returns The conditions.
 */
const conditionsOf = (mask: string | undefined, least: number | undefined): Conditions => {
  if (mask !== undefined && least !== undefined) {
    return { least, mask };
  }

  if (mask !== undefined) {
    return { mask };
  }

  return least === undefined ? {} : { least };
};

/**
 * What `/list` asks, the text after the command: at most one mask and one least number of
 * members, in either order, where a word of digits alone is the least and any other the
 * mask, or why it cannot be read, in words. Whether the Network applies them, the Client
 * decides.
 * @param args - The text after the command's name.
 * @returns The conditions, or why there are none, in words.
 */
export const parseConditions = (args: string): Parsed<Conditions> => {
  const usage = "/list [mask] [least]";
  const words = args.trim() === "" ? [] : args.trim().split(/\s+/u);

  const invalid = (why: string): Parsed<Conditions> => ({
    _tag: "Invalid",
    message: `${why} ${usage}`,
  });

  if (words.length > 2) {
    return invalid("Give a mask, a least number of members, or both.");
  }

  const leasts = words.filter((word) => /^\d+$/u.test(word));
  const masks = words.filter((word) => !/^\d+$/u.test(word));

  if (leasts.length > 1) {
    return invalid("Give one least number of members.");
  }

  if (masks.length > 1) {
    return invalid("Give one mask.");
  }

  const [mask] = masks;
  const least = leasts[0] === undefined ? undefined : Number(leasts[0]);

  if (mask !== undefined && (mask.includes(",") || unsendable.test(mask))) {
    return invalid(
      mask.includes(",") ? "A mask holds no comma." : "A mask holds no line break or NUL."
    );
  }

  if (least !== undefined && !Number.isSafeInteger(least)) {
    return invalid("No Channel has that many members.");
  }

  if (least !== undefined && least < 1) {
    return invalid("A Channel listed has at least 1 member.");
  }

  return { _tag: "Parsed", value: conditionsOf(mask, least) };
};

/**
 * The intent `/list` comes to, once its conditions are read.
 * @param conditions - The mask and least number of members, each where given.
 * @param network - The Network in focus.
 * @param timeline - The Timeline in focus.
 * @returns The intent.
 */
export const directoryLookOf = (
  conditions: Conditions,
  network: NetworkId,
  timeline: TimelineId
): Look => ({
  _tag: "Look",
  lookup: { _tag: "Channels", ...conditions },
  network,
  ranks: rfcRanks,
  timeline,
});

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
  kind: UserKind,
  nick: string,
  network: NetworkId,
  timeline: TimelineId,
  head: ChannelHeader | undefined
): Look => ({
  _tag: "Look",
  lookup: { _tag: kind, nick },
  network,
  ranks: ranksOf(head, network),
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
   * The masks of a list the Owner is removing from this card, by the intent of the act that
   * unsets each, which the card does not show unless that act is refused or never leaves.
   */
  readonly removing: ReadonlyMap<string, string>;
  /**
   * How the Network folds names and what starts a Channel's name, as `known` said, or none
   * until it is read or when it could not be: a Channel opens or joins only once known.
   */
  readonly naming: Naming | undefined;
  /** The intent its Lookup was asked under, once it was, by which a later page is read. */
  readonly intent: string | undefined;
  /** Where the page of the Network's Channels being read begins, while one is. */
  readonly reading: number | undefined;
}

/**
 * How a Network names Channels: the casemapping it last declared, `rfc1459` when none was,
 * as the Daemon keys Timelines, and its `CHANTYPES`, RFC 2811's while unsaid.
 */
export interface Naming {
  readonly casemapping: Casemapping;
  readonly chantypes: string;
  /** The Channels Self is in now, as `known` said, each folded by `casemapping`. */
  readonly joined: ReadonlySet<string>;
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
 * - `Sent`: its Lookup was asked of the Daemon under `intent`.
 * - `Reading`: a page of the Network's Channels from `offset` is being read.
 * - `Paged`: a page of the Network's Channels came, which follows on from those held only
 *   when it begins where they end.
 * - `PageFailed`: the page being read came to nothing, so it can be asked for again.
 * - `Removing`: the Owner is removing a mask of a card's list, by an act under `intent`.
 * - `Restored`: the act under `intent` was refused, or never left, so its mask shows again.
 * - `Changed`: a step of the changes stream, whose refused actions restore their masks.
 * - `Missed`: the changes stream overflowed or was reset, so a refusal may have gone
 *   unseen: every mask being removed shows again, since one hidden but still set is worse
 *   than one shown but gone.
 * - `Waited`: the Daemon answered `Pending`.
 * - `Answered`: its result came.
 * - `Failed`: it came to nothing.
 * - `Named`: how its Network names Channels, as `known` said: the casemapping it declared,
 *   `null` for none, its `CHANTYPES`, `null` while unsaid, and the names of the Channels
 *   Self is in now.
 * - `Dismissed`: the Owner closed the Pane's card.
 * - `Kept`: the Panes there are now: the card of any other is let go of.
 * - `Cleared`: the page signed out, so every card is let go of.
 */
export type LookupsEvent =
  | { readonly _tag: "Asked"; readonly pane: string; readonly look: Look }
  | { readonly _tag: "Sent"; readonly id: number; readonly intent: string }
  | { readonly _tag: "Reading"; readonly id: number; readonly offset: number }
  | { readonly _tag: "Paged"; readonly id: number; readonly result: LookResult }
  | { readonly _tag: "PageFailed"; readonly id: number }
  | { readonly _tag: "Waited"; readonly id: number }
  | {
      readonly _tag: "Removing";
      readonly id: number;
      readonly mask: string;
      readonly intent: string;
    }
  | { readonly _tag: "Restored"; readonly intent: string }
  | { readonly _tag: "Changed"; readonly change: TimelineChange }
  | { readonly _tag: "Missed" }
  | { readonly _tag: "Answered"; readonly id: number; readonly result: LookResult }
  | { readonly _tag: "Failed"; readonly id: number; readonly failure: LookFailure }
  | {
      readonly _tag: "Named";
      readonly id: number;
      readonly declared: Casemapping | null;
      readonly chantypes: string | null;
      readonly joined: readonly string[];
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
 * The Lookups with the masks being removed under some intents shown again.
 * @param state - The Lookups.
 * @param intents - The intents whose acts were refused or never left.
 * @returns The Lookups, the same when no card was removing under one.
 */
const restoring = (state: Lookups, intents: ReadonlySet<string>): Lookups => {
  const touched = [...state.cards.values()].some((card) =>
    [...card.removing.values()].some((intent) => intents.has(intent))
  );

  if (!touched) {
    return state;
  }

  const cards = new Map(
    [...state.cards].map(([pane, card]): [string, Card] => [
      pane,
      {
        ...card,
        removing: new Map([...card.removing].filter(([, intent]) => !intents.has(intent))),
      },
    ])
  );

  return { ...state, cards };
};

/** How many of the Network's Channels a page holds. */
export const pageLimit = 100;

/** The page of a card's Channels to read next: by its Lookup's intent, from `offset`. */
export interface Page {
  readonly intent: string;
  readonly offset: number;
  readonly limit: number;
}

/**
 * The Network's Channels a card holds so far, once its first page came.
 * @param card - The card.
 * @returns Them, or none.
 */
const directoryOf = (card: Card) =>
  card.phase._tag === "Done" && card.phase.result._tag === "Channels"
    ? card.phase.result
    : undefined;

/**
 * The page of the Network's Channels a card reads next: the one after those it holds, while
 * the Daemon kept more than that, its intent is known, and no page is being read.
 * @param card - The card.
 * @returns The page, or none.
 */
export const nextPage = (card: Card): Page | undefined => {
  const held = directoryOf(card);

  if (held === undefined || card.intent === undefined || card.reading !== undefined) {
    return undefined;
  }

  const offset = held.offset + held.channels.length;

  return offset < held.total ? { intent: card.intent, limit: pageLimit, offset } : undefined;
};

/**
 * A card with a page of the Network's Channels folded in after those it holds, where it
 * begins where they end, and no page being read any more.
 * @param card - The card.
 * @param page - The page.
 * @returns The card.
 */
const paged = (card: Card, page: LookResult): Card => {
  const held = directoryOf(card);

  if (
    held === undefined ||
    page._tag !== "Channels" ||
    page.offset !== held.offset + held.channels.length
  ) {
    return { ...card, reading: undefined };
  }

  return {
    ...card,
    phase: {
      _tag: "Done",
      result: { ...held, channels: [...held.channels, ...page.channels] },
    },
    reading: undefined,
  };
};

/** What happened to a card's Lookup's intent and the pages of its Channels. */
type PagingEvent = Extract<
  LookupsEvent,
  { readonly _tag: "Sent" | "Reading" | "Paged" | "PageFailed" }
>;

const pagingTags: ReadonlySet<LookupsEvent["_tag"]> = new Set([
  "Sent",
  "Reading",
  "Paged",
  "PageFailed",
]);

/**
 * Whether an event is of a card's intent or the pages of its Channels.
 * @param event - What happened.
 * @returns Whether it is.
 */
const isPaging = (event: LookupsEvent): event is PagingEvent => pagingTags.has(event._tag);

/**
 * Folds into a card what happened to its Lookup's intent and the pages of its Channels.
 * @param card - The card.
 * @param event - What happened.
 * @returns The card.
 */
const paging = (card: Card, event: PagingEvent): Card => {
  switch (event._tag) {
    case "Sent": {
      return { ...card, intent: event.intent };
    }

    case "Reading": {
      return nextPage(card)?.offset === event.offset ? { ...card, reading: event.offset } : card;
    }

    case "Paged": {
      return paged(card, event.result);
    }

    case "PageFailed": {
      return { ...card, reading: undefined };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Folds into the Lookups an event of the cards themselves, rather than of a card's pages.
 * @param state - The Lookups.
 * @param event - What happened.
 * @returns The Lookups.
 */
const reduceCards = (state: Lookups, event: Exclude<LookupsEvent, PagingEvent>): Lookups => {
  switch (event._tag) {
    case "Asked": {
      const cards = new Map(state.cards);

      cards.set(event.pane, {
        id: state.next,
        intent: undefined,
        look: event.look,
        naming: undefined,
        phase: { _tag: "Asking" },
        reading: undefined,
        removing: new Map(),
      });

      return { cards, next: state.next + 1 };
    }

    case "Waited": {
      return changing(state, event.id, (card) =>
        card.phase._tag === "Asking" ? { ...card, phase: { _tag: "Pending" } } : card
      );
    }

    case "Removing": {
      return changing(state, event.id, (card) => ({
        ...card,
        removing: new Map([...card.removing, [event.mask, event.intent]]),
      }));
    }

    case "Restored": {
      return restoring(state, new Set([event.intent]));
    }

    case "Changed": {
      const refused = event.change.items.flatMap((item) =>
        item.content._tag === "ActionRefused" ? [item.content.intent] : []
      );

      return refused.length === 0 ? state : restoring(state, new Set(refused));
    }

    case "Missed": {
      return restoring(
        state,
        new Set([...state.cards.values()].flatMap((card) => [...card.removing.values()]))
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
      const casemapping = event.declared ?? defaultCasemapping;

      return changing(state, event.id, (card) => ({
        ...card,
        naming: {
          casemapping,
          chantypes: event.chantypes ?? rfcChantypes,
          joined: new Set(event.joined.map((name) => casefold(casemapping, name))),
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
 * Folds one event into the Lookups. An answer for a card no Pane holds any more changes
 * nothing, and a result, once it came, is never replaced.
 * @param state - The Lookups.
 * @param event - What happened.
 * @returns The Lookups.
 */
export const reduceLookups = (state: Lookups, event: LookupsEvent): Lookups =>
  isPaging(event)
    ? changing(state, event.id, (card) => paging(card, event))
    : reduceCards(state, event);

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
    "timeline" in shown &&
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

/** One mask of a Channel's list, as the card shows it. */
export interface MaskShown {
  /** The mask, contained. */
  readonly mask: string;
  /** Who set it, contained, where the Ircd said. */
  readonly setBy: string | undefined;
  /** When it was set, by the caller's format, where the Ircd said. */
  readonly setAt: string | undefined;
  /**
   * Removing it from the list, while Self may, by the head of the Channel the card's Pane
   * shows, and the Network keeps the list: the act that unsets it, and the mask as the
   * reply gave it, which the card is told it no longer shows.
   */
  readonly remove: { readonly act: Act; readonly mask: string } | undefined;
}

/** One member of a Channel, as the card shows them. */
export interface MemberShown {
  /** The nick, contained. */
  readonly nick: string;
  readonly colour: number;
  /** The symbols of the prefixes they hold, most privileged first, by the Network's `PREFIX`. */
  readonly symbols: string;
  /** What a screen reader hears, such as `peer, operator`. */
  readonly label: string;
}

/** One User a `WHO` listed, as the card shows them: every text contained. */
export interface UserShown {
  readonly nick: string;
  readonly colour: number;
  /** `user@host`. */
  readonly mask: string;
  /** Whether the reply said they are away. Unsaid shows as not away. */
  readonly away: boolean;
  readonly realname: string | undefined;
}

/** One of the Network's Channels, as the card shows it. */
export interface ListedShown {
  /** Its name, contained. */
  readonly name: string;
  /** How many members the Network said it has, its digits grouped. */
  readonly members: string;
  /** Its topic, contained, or none when the Network gave none. */
  readonly topic: string | undefined;
  /** What a screen reader hears, such as `#iirc, 12 members`. */
  readonly label: string;
  /** What choosing it does, as for a Channel in a profile. */
  readonly choose: Intent | undefined;
}

/**
 * What was looked up: a nick, in its colour, a Channel, by its name, a mask, or the
 * conditions the Network's Channels were listed by, in words.
 */
export type SubjectShown =
  | { readonly _tag: "Nick"; readonly nick: string; readonly colour: number }
  | { readonly _tag: "Channel"; readonly name: string }
  | { readonly _tag: "Mask"; readonly mask: string }
  | { readonly _tag: "Directory"; readonly words: string };

/**
 * A card as a view draws it: what was looked up, and how it stands.
 *
 * - `Waiting`: no result yet, in words.
 * - `Profiles`: each User described, with a note when the reply was cut short.
 * - `Masks`: a Channel's list, but the masks removed from the card, with a note when the
 *   reply was cut short.
 * - `Members`: a Channel's members, in the order the reply gave them, with a note when it was
 *   cut short.
 * - `Users`: the Users a mask matched, in the order the reply gave them, with a note when it
 *   was cut short.
 * - `Directory`: the Network's Channels, most members first, as many as were read, with a
 *   note when the reply was cut short, and `more` while the Daemon kept more: how many of
 *   them are shown, and whether the next page is being read.
 * - `Said`: no User, no mask, no member, no match, or no Channel, in words.
 *
 * `notes` are the `WARN` and `NOTE` replies the Network gave with its result, each as its
 * kind, command, code, context, and description, contained.
 */
export interface CardShown {
  readonly kind: LookupKind;
  readonly subject: SubjectShown;
  readonly notes: readonly string[];
  readonly body:
    | { readonly _tag: "Waiting"; readonly words: string }
    | {
        readonly _tag: "Profiles";
        readonly profiles: readonly ProfileShown[];
        readonly note: string | undefined;
      }
    | {
        readonly _tag: "Masks";
        readonly masks: readonly MaskShown[];
        readonly note: string | undefined;
      }
    | {
        readonly _tag: "Members";
        readonly members: readonly MemberShown[];
        readonly note: string | undefined;
      }
    | {
        readonly _tag: "Users";
        readonly users: readonly UserShown[];
        readonly note: string | undefined;
      }
    | {
        readonly _tag: "Directory";
        readonly channels: readonly ListedShown[];
        readonly note: string | undefined;
        readonly more: { readonly words: string; readonly reading: boolean } | undefined;
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
 * The Timeline of a Channel on the card's Network, keyed as the Daemon keyed it, once the
 * Network's naming is known.
 * @param timelines - The Timelines.
 * @param card - The card.
 * @param name - The Channel's name.
 * @returns Its Timeline, or none.
 */
const channelTimeline = (
  timelines: Timelines,
  card: Card,
  name: string
): TimelineId | undefined => {
  const { naming } = card;

  if (naming === undefined) {
    return undefined;
  }

  const key = casefold(naming.casemapping, name);

  return [...(timelines.networks.get(card.look.network)?.timelines.values() ?? [])].find(
    (one) => one.kind === "Channel" && one.key === key
  )?.id;
};

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

  const found = channelTimeline(timelines, card, name);

  return found === undefined
    ? { _tag: "FocusComposer", text: `/join ${name}` }
    : { _tag: "Open", timeline: found };
};

/**
 * What choosing one of the Network's Channels does: opens its Timeline while Self is in it,
 * or starts `/join <name>` in the composer, though a Timeline kept from before shows it.
 * @param timelines - The Timelines.
 * @param card - The card.
 * @param name - The Channel's name, as the Network said it.
 * @returns The intent, or none.
 */
const joining = (timelines: Timelines, card: Card, name: string): Intent | undefined => {
  const { naming } = card;

  if (naming === undefined || !joinable(naming, name)) {
    return undefined;
  }

  const found = naming.joined.has(casefold(naming.casemapping, name))
    ? channelTimeline(timelines, card, name)
    : undefined;

  return found === undefined
    ? { _tag: "FocusComposer", text: `/join ${name}` }
    : { _tag: "Open", timeline: found };
};

/**
 * The Timeline of the Channel whose list a card is, whose head says whether Self may remove
 * a mask, or none for a Lookup of a User, or until the Network's naming is known.
 * @param timelines - The Timelines.
 * @param card - The card.
 * @returns Its Timeline, or none.
 */
export const listTimeline = (timelines: Timelines, card: Card): TimelineId | undefined =>
  isListLookup(card.look.lookup)
    ? channelTimeline(timelines, card, card.look.lookup.channel)
    : undefined;

/**
 * The Channels whose lists the cards are, each once, with their Timelines, so their heads
 * are followed as a Pane's Channel's are, whether or not a Pane shows them.
 * @param state - The Lookups.
 * @param timelines - The Timelines.
 * @returns The Channels.
 */
export const listedChannels = (
  state: Lookups,
  timelines: Timelines
): readonly { readonly network: NetworkId; readonly timeline: TimelineId }[] => {
  const found = new Map<TimelineId, NetworkId>();

  for (const card of state.cards.values()) {
    const timeline = listTimeline(timelines, card);

    if (timeline !== undefined) {
      found.set(timeline, card.look.network);
    }
  }

  return [...found].map(([timeline, network]) => ({ network, timeline }));
};

/**
 * Text a Network wrote, contained, or none when it said nothing or nothing but whitespace.
 * @param text - The text.
 * @returns The text to show, or none.
 */
const said = (text: string | null): string | undefined =>
  text === null || text.trim() === "" ? undefined : contained(text);

/**
 * The prefixes a User holds in a Channel, by the ranks: their symbols, and each in words for
 * a screen reader. A mode the ranks do not name shows no symbol.
 * @param ranks - The Network's `PREFIX`.
 * @param prefixes - The membership modes held.
 * @returns The symbols, contained, and the words.
 */
const prefixesShown = (ranks: readonly Rank[], prefixes: readonly string[]) => {
  const held = ranks.filter((rank) => prefixes.includes(rank.mode));

  return {
    symbols: contained(held.map((rank) => rank.symbol).join("")),
    words: [
      ...held.map((rank) => rankNames.get(rank.mode) ?? `mode ${contained(rank.mode)}`),
      ...prefixes.flatMap((mode) =>
        ranks.some((rank) => rank.mode === mode) ? [] : [`mode ${contained(mode)}`]
      ),
    ],
  };
};

/**
 * One member a `NAMES` reply listed.
 * @param card - The card.
 * @param entry - The member, as the reply gave them.
 * @returns The member, as the card shows them.
 */
const memberShown = (card: Card, entry: NamesEntry): MemberShown => {
  const nick = contained(entry.nick);
  const { symbols, words } = prefixesShown(card.look.ranks, entry.prefixes);

  return {
    colour: nickColour(entry.nick),
    label: [nick, ...words].join(", "),
    nick,
    symbols,
  };
};

/**
 * One User a `WHO` reply listed.
 * @param entry - The User, as the reply gave them.
 * @returns The User, as the card shows them.
 */
const userShown = (entry: WhoEntry): UserShown => ({
  away: entry.away === true,
  colour: nickColour(entry.nick),
  mask: `${contained(entry.user)}@${contained(entry.host)}`,
  nick: contained(entry.nick),
  realname: said(entry.realname),
});

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
  const name = contained(channel.name);
  const { symbols, words } = prefixesShown(card.look.ranks, channel.prefixes);

  return {
    choose: choosing(timelines, card, channel.name),
    label: [name, ...words].join(", "),
    name,
    symbols,
  };
};

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

/** Why a Lookup was not sent, in words, but for a name it cannot be asked of. */
const refusedWords: Readonly<Record<"Offline" | "Busy" | "NotOffered", string>> = {
  Busy: "Not looked up: too many Lookups are waiting on this Network. Try again in a moment.",
  NotOffered: "Not looked up: the Network keeps no such list, by its ISUPPORT.",
  Offline: "Not looked up: the Network is not connected.",
};

/** Why `/list` was not sent while an earlier one is still being answered, in words. */
const busyListing =
  "Not looked up: the Network is still listing its Channels for an earlier /list. Try again once it has.";

/** Why a Lookup came to nothing on the Frontend's side, in words. */
const lostWords: Readonly<Record<LookFailure, string>> = {
  NoAnswer: "No result came from the Daemon in time. Try again.",
  Stopped: "The Network stopped before it was looked up. Try again.",
  Unexpected: "The Daemon could not look it up.",
  UnknownNetwork: "The Daemon has no such Network.",
};

/**
 * What a result says of no User, or no list, in words.
 * @param kind - The Lookup.
 * @param name - The nick or the Channel's name, contained.
 * @param result - The result, of no User or list.
 * @returns The words.
 */
const nothingFound = (
  kind: LookupKind,
  name: string,
  result: Exclude<
    LookResult,
    { readonly _tag: "Found" | "Partial" | "Listed" | "Members" | "Users" | "Channels" }
  >
): string => {
  switch (result._tag) {
    case "NotFound": {
      const reply = contained(result.reply);

      if (kind === "Whois") {
        return `No one uses the nick ${name} now (${reply}).`;
      }

      if (kind === "Whowas") {
        return `The Network remembers no one who used the nick ${name} (${reply}).`;
      }

      if (kind === "Channels") {
        return `The Network listed no Channels (${reply}).`;
      }

      return kind === "Who"
        ? `The Network has no one matching ${name} (${reply}).`
        : `The Network has no Channel ${name} (${reply}).`;
    }

    case "Failed": {
      return `The Network refused the Lookup (${contained(result.reply)}).`;
    }

    case "Refused": {
      if (kind === "Channels" && result.reason === "Busy") {
        return busyListing;
      }

      if (result.reason !== "Unsendable") {
        return refusedWords[result.reason];
      }

      if (kind === "Whois" || kind === "Whowas") {
        return "Not looked up: the Network cannot be asked about that nick.";
      }

      return kind === "Who" || kind === "Channels"
        ? "Not looked up: the Network cannot be asked about that mask."
        : "Not looked up: the Network cannot be asked about that Channel.";
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
 * A `WARN` or `NOTE` of a Lookup's reply, as a line of text: its kind, command, code,
 * context, and description, every field the Network wrote contained.
 * @param note - The reply.
 * @returns The text.
 */
const noteText = (note: StandardReply): string => {
  const fields = [note.kind, note.command, note.code, ...note.context].map((each) =>
    contained(each)
  );

  return note.description === ""
    ? fields.join(" ")
    : `${fields.join(" ")}: ${contained(note.description)}`;
};

/**
 * The act that removes a mask from a card's list, while the head of that list's own Channel,
 * as held live, says Self may, and gives the list's mode. A head of any other Channel says
 * nothing of it.
 * @param card - The card.
 * @param live - The head of the list's Channel as held live, if read.
 * @returns How each mask is removed, or none.
 */
const removing = (
  card: Card,
  live: ChannelHeader | undefined
): ((mask: string) => Act) | undefined => {
  const { lookup, network } = card.look;

  if (!isListLookup(lookup)) {
    return undefined;
  }

  const casemapping = card.naming?.casemapping ?? defaultCasemapping;
  const channel = casefold(casemapping, lookup.channel);

  const head =
    live?.network === network && casefold(casemapping, live.name) === channel ? live : undefined;

  const mode = listMode(head, lookup._tag);

  return head === undefined || mode === null || mode === undefined || !mayOperate(head)
    ? undefined
    : (mask) => ({
        _tag: "Act",
        action: {
          _tag: "Mode",
          changes: [{ mode, param: mask, set: false }],
          target: lookup.channel,
        },
        network,
      });
};

/**
 * One mask of a list, as the card shows it.
 * @param entry - The mask, as the reply gave it.
 * @param remove - How a mask is removed, while Self may.
 * @param time - Formats an instant.
 * @returns The mask.
 */
const maskShown = (
  entry: MaskEntry,
  remove: ((mask: string) => Act) | undefined,
  time: (instant: number) => string | undefined
): MaskShown => ({
  mask: contained(entry.mask),
  remove: remove === undefined ? undefined : { act: remove(entry.mask), mask: entry.mask },
  setAt: entry.setAt === null ? undefined : (time(entry.setAt) ?? "time unavailable"),
  setBy: said(entry.setBy),
});

/**
 * The body of a card whose result listed people: a Channel's members, or the Users a mask
 * matched, or in words when the list is empty.
 * @param card - The card.
 * @param name - What was looked up, contained.
 * @param result - The result.
 * @returns The body.
 */
const peopleBody = (
  card: Card,
  name: string,
  result: Extract<LookResult, { readonly _tag: "Members" | "Users" }>
): CardShown["body"] => {
  const note = result.cut === null ? undefined : partialWords[result.cut];

  if (result._tag === "Members") {
    return result.members.length === 0
      ? { _tag: "Said", words: note ?? `${name} has no members.` }
      : {
          _tag: "Members",
          members: result.members.map((entry) => memberShown(card, entry)),
          note,
        };
  }

  return result.users.length === 0
    ? { _tag: "Said", words: note ?? `No one matches ${name}.` }
    : { _tag: "Users", note, users: result.users.map((entry) => userShown(entry)) };
};

/**
 * A count with its digits grouped in threes by a narrow no-break space, as `23 412`, the same
 * in every locale, since the core reads none.
 * @param count - The count.
 * @returns The digits.
 */
export const counted = (count: number): string =>
  String(count).replaceAll(/\B(?=(?:\d{3})+$)/gu, "\u202F");

/**
 * The conditions `/list` asked, in words, such as "matching #linux* with at least 10
 * members", or none for none.
 * @param conditions - The conditions.
 * @returns The words, the mask as given, which the caller contains.
 */
const conditionWords = (conditions: Conditions): string =>
  [
    conditions.mask === undefined ? undefined : `matching ${conditions.mask}`,
    conditions.least === undefined
      ? undefined
      : `with at least ${counted(conditions.least)} members`,
  ]
    .filter((one) => one !== undefined)
    .join(" ");

/**
 * One of the Network's Channels, as the card shows it.
 * @param timelines - The Timelines.
 * @param card - The card.
 * @param entry - The Channel, as the reply gave it.
 * @returns The Channel.
 */
const listedShown = (timelines: Timelines, card: Card, entry: ChannelEntry): ListedShown => {
  const name = contained(entry.channel);
  const members = counted(entry.members);

  return {
    choose: joining(timelines, card, entry.channel),
    label: `${name}, ${members} ${entry.members === 1 ? "member" : "members"}`,
    members,
    name,
    topic: said(entry.topic),
  };
};

/**
 * Why a reply of the Network's Channels was cut short, in words: for one longer than a Lookup
 * keeps, how many of how many it shows.
 * @param result - The Channels.
 * @returns The words, or none when it was not.
 */
const directoryNote = (
  result: Extract<LookResult, { readonly _tag: "Channels" }>
): string | undefined => {
  if (result.cut === "Bounded") {
    return `These are the ${counted(result.total)} largest of the ${counted(result.seen)} Channels the Network listed, as many as a Lookup keeps.`;
  }

  return result.cut === null ? undefined : partialWords[result.cut];
};

/**
 * The body of a card of the Network's Channels: those read so far, why the reply was cut
 * short, and how many more the Daemon kept, or in words when it listed none.
 * @param timelines - The Timelines.
 * @param card - The card.
 * @param name - The conditions it was listed by, in words, contained.
 * @param result - Its Channels so far.
 * @returns The body.
 */
const directoryBody = (
  timelines: Timelines,
  card: Card,
  name: string,
  result: Extract<LookResult, { readonly _tag: "Channels" }>
): CardShown["body"] => {
  const note = directoryNote(result);

  if (result.channels.length === 0) {
    return {
      _tag: "Said",
      words:
        note ??
        (name === ""
          ? "The Network listed no Channels."
          : `The Network listed no Channels ${name}.`),
    };
  }

  const shown = result.offset + result.channels.length;

  return {
    _tag: "Directory",
    channels: result.channels.map((entry) => listedShown(timelines, card, entry)),
    more:
      shown < result.total && card.intent !== undefined
        ? {
            reading: card.reading !== undefined,
            words: `${counted(shown)} of ${counted(result.total)}`,
          }
        : undefined,
    note,
  };
};

/**
 * What a Lookup is of, as the Owner gave it: a nick, a Channel's name, or a mask.
 * @param lookup - The Lookup.
 * @returns The text.
 */
const subjectName = (lookup: LookupRequest): string => {
  switch (lookup._tag) {
    case "Whois":
    case "Whowas": {
      return lookup.nick;
    }

    case "Who": {
      return lookup.mask;
    }

    case "Channels": {
      return conditionWords(lookup);
    }

    case "Bans":
    case "Exceptions":
    case "Invitations":
    case "Names": {
      return lookup.channel;
    }

    default: {
      return lookup satisfies never;
    }
  }
};

/**
 * What a card says it looked up.
 * @param lookup - The Lookup.
 * @param name - What it is of, contained.
 * @returns The subject.
 */
const subjectOf = (lookup: LookupRequest, name: string): SubjectShown => {
  switch (lookup._tag) {
    case "Whois":
    case "Whowas": {
      return { _tag: "Nick", colour: nickColour(lookup.nick), nick: name };
    }

    case "Who": {
      return { _tag: "Mask", mask: name };
    }

    case "Channels": {
      return { _tag: "Directory", words: name };
    }

    case "Bans":
    case "Exceptions":
    case "Invitations":
    case "Names": {
      return { _tag: "Channel", name };
    }

    default: {
      return lookup satisfies never;
    }
  }
};

/**
 * The body of a card of a Channel's list: its masks, but those being removed, or in words
 * when none is left.
 * @param card - The card.
 * @param name - The Channel's name, contained.
 * @param result - The list.
 * @param time - Formats an instant.
 * @param head - The head of the list's Channel, as held live, if read.
 * @returns The body.
 */
const masksBody = (
  card: Card,
  name: string,
  result: Extract<LookResult, { readonly _tag: "Listed" }>,
  time: (instant: number) => string | undefined,
  head: ChannelHeader | undefined
): CardShown["body"] => {
  const { lookup } = card.look;
  const note = result.cut === null ? undefined : partialWords[result.cut];
  const remove = removing(card, head);
  const masks = result.masks.filter((entry) => !card.removing.has(entry.mask));
  const kind = isListLookup(lookup) ? listWords[lookup._tag] : "masks";

  return masks.length === 0
    ? { _tag: "Said", words: note ?? `${name} has no ${kind}.` }
    : { _tag: "Masks", masks: masks.map((entry) => maskShown(entry, remove, time)), note };
};

/**
 * A card as a view draws it.
 * @param timelines - The Timelines, for which Channels have a Timeline to open.
 * @param card - The card.
 * @param time - Formats an instant, in milliseconds, as the Owner reads a date and time, or
 * gives none when it cannot be.
 * @param head - The head of the Channel whose list it is, as held live for its Timeline, if
 * read, which says whether Self may remove a mask.
 * @returns What it shows.
 */
export const cardShown = (
  timelines: Timelines,
  card: Card,
  time: (instant: number) => string | undefined,
  head?: ChannelHeader
): CardShown => {
  const { lookup } = card.look;
  const name = contained(subjectName(lookup));
  const { phase } = card;
  const result = phase._tag === "Done" ? phase.result : undefined;
  const notes = result !== undefined && "notes" in result ? result.notes.map(noteText) : [];

  const subject = subjectOf(lookup, name);

  const shown = { kind: lookup._tag, notes, subject };

  switch (phase._tag) {
    case "Asking": {
      return { ...shown, body: { _tag: "Waiting", words: "Looking up…" } };
    }

    case "Pending": {
      return {
        ...shown,
        body: { _tag: "Waiting", words: "Still waiting for the Network's reply…" },
      };
    }

    case "Lost": {
      return { ...shown, body: { _tag: "Said", words: lostWords[phase.failure] } };
    }

    case "Done": {
      const { result } = phase;

      if (result._tag === "Listed") {
        return { ...shown, body: masksBody(card, name, result, time, head) };
      }

      if (result._tag === "Members" || result._tag === "Users") {
        return { ...shown, body: peopleBody(card, name, result) };
      }

      if (result._tag === "Channels") {
        return { ...shown, body: directoryBody(timelines, card, name, result) };
      }

      if (result._tag !== "Found" && result._tag !== "Partial") {
        return {
          ...shown,
          body: { _tag: "Said", words: nothingFound(lookup._tag, name, result) },
        };
      }

      const note = result._tag === "Partial" ? partialWords[result.reason] : undefined;

      if (result.profiles.length === 0) {
        return {
          ...shown,
          body: { _tag: "Said", words: note ?? `Nothing came back about ${name}.` },
        };
      }

      return {
        ...shown,
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
