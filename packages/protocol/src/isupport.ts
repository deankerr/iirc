/**
 * `RPL_ISUPPORT` (`005`): its tokens, and readers for the values of the tokens whose
 * shape the protocol fixes. Which tokens a Session holds is the caller's to keep.
 *
 * @packageDocumentation
 */
import { utf8Lossy } from "./decode.ts";
import { upperCaseAscii } from "./line.ts";

/** One token of an `RPL_ISUPPORT`: a parameter set, with its value, or taken back. */
export type IsupportToken =
  | { readonly _tag: "Set"; readonly name: string; readonly value: string }
  | { readonly _tag: "Removed"; readonly name: string };

// A name is what the grammar allows, `1*20 (letter / digit / "." / "/")` in any position,
// widened to any length, and to `_` anywhere and `-` after the first character, so a
// token an Ircd misspells is still read. A `-` first takes the token back.
const token = /^(?<removed>-?)(?<name>[A-Za-z0-9./_][A-Za-z0-9./_-]*)(?:=(?<value>.*))?$/su;

const escape = /\\x(?<hex>[0-9A-Fa-f]{2})/gu;
const utf8 = new TextEncoder();

/**
 * Undoes `\xHH` escapes, which stand for bytes, so an escaped UTF-8 sequence reads as
 * the character it encodes. Bytes that are not UTF-8 read as U+FFFD.
 * @param value - A token's value, as sent.
 * @returns The value it stands for.
 */
export const unescapeValue = (value: string): string => {
  if (!value.includes("\\x")) {
    return value;
  }

  const parts: Uint8Array[] = [];
  let last = 0;

  for (const match of value.matchAll(escape)) {
    parts.push(
      utf8.encode(value.slice(last, match.index)),
      Uint8Array.of(Number.parseInt(match.groups?.hex ?? "0", 16))
    );
    last = match.index + match[0].length;
  }

  parts.push(utf8.encode(value.slice(last)));

  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  return utf8Lossy(bytes);
};

const tokenOf = (param: string): IsupportToken | undefined => {
  const parts = token.exec(param)?.groups;
  const name = parts?.name;

  if (name === undefined) {
    return undefined;
  }

  // `-NAME` never has a value, so one that does is no token.
  if (parts?.removed === "-") {
    return parts.value === undefined ? { _tag: "Removed", name } : undefined;
  }

  return { _tag: "Set", name, value: unescapeValue(parts?.value ?? "") };
};

/**
 * Reads the tokens of one `RPL_ISUPPORT`, in order. Its first parameter is Self and its
 * last is text for people, which is never read, whatever it says. What does not follow
 * the token grammar is skipped. A token sent with no value has the value `""`.
 * @param params - All the `005`'s parameters.
 * @returns Its tokens.
 */
export const isupportTokens = (params: readonly string[]): readonly IsupportToken[] =>
  params.slice(1, -1).flatMap((param) => {
    const parsed = tokenOf(param);

    return parsed === undefined ? [] : [parsed];
  });

const positive = /^[1-9]\d{0,8}$/u;

/**
 * Reads a positive whole number, as `NICKLEN`, `TOPICLEN`, and the other lengths are.
 * @param value - The token's value, or `undefined` if it was not sent.
 * @returns The number, or `undefined` if there is none.
 */
export const limitOf = (value: string | undefined): number | undefined =>
  value !== undefined && positive.test(value) ? Number(value) : undefined;

/** What modern IRC says to assume for `MODES` when it is not sent. */
export const defaultModes = 3;

/**
 * Reads `MODES`: how many modes with a parameter one `MODE` may carry.
 * @param value - The token's value, or `undefined` if it was not sent.
 * @returns The count, {@link defaultModes} if it was not sent or holds no count, or
 * `undefined` for no limit, which `MODES` with no value means.
 */
export const modesOf = (value: string | undefined): number | undefined =>
  value === "" ? undefined : (limitOf(value) ?? defaultModes);

/** What RFC 1459 says to assume for `CHANTYPES` when it is not sent. */
export const defaultChantypes = "#&";

/**
 * Reads `CHANTYPES`: what a Channel's name may start with.
 * @param value - The token's value, or `undefined` if it was not sent.
 * @returns The characters, where `""` means the Network has no Channels.
 */
export const chantypesOf = (value: string | undefined): string => value ?? defaultChantypes;

/**
 * Reads `STATUSMSG`: the prefixes a Message's Target may carry before a Channel's name,
 * such as `@` in `@#iirc`, to reach only the members holding that status or higher.
 * @param value - The token's value, or `undefined` if it was not sent.
 * @returns The characters, where `""`, as when it is not sent, means none.
 */
export const statusmsgOf = (value: string | undefined): string => value ?? "";

/** One membership prefix: the mode letter, and the symbol shown before a nick. */
export interface Membership {
  readonly mode: string;
  readonly symbol: string;
}

/** What modern IRC says to assume for `PREFIX` when it is not sent: `(ov)@+`. */
export const defaultPrefix: readonly Membership[] = [
  { mode: "o", symbol: "@" },
  { mode: "v", symbol: "+" },
];

// Whole characters, so a symbol past the Basic Multilingual Plane is one symbol.
const characters = (text: string) => {
  const all: string[] = [];

  for (const character of text) {
    all.push(character);
  }

  return all;
};

const prefixGrammar = /^\((?<modes>[^)]*)\)(?<symbols>.*)$/su;

/**
 * Reads `PREFIX`: the membership prefixes, from most privileged to least.
 * @param value - The token's value, or `undefined` if it was not sent.
 * @returns The prefixes, {@link defaultPrefix} if it was not sent, none for an empty
 * value, or `undefined` if the value does not pair each mode with one symbol, or repeats a
 * mode or a symbol, such as `(oov)@%+`.
 */
export const prefixOf = (value: string | undefined): readonly Membership[] | undefined => {
  if (value === undefined) {
    return defaultPrefix;
  }

  if (value === "") {
    return [];
  }

  const parts = prefixGrammar.exec(value)?.groups;
  const modes = characters(parts?.modes ?? "");
  const symbols = characters(parts?.symbols ?? "");

  // Each mode and each symbol names one rank, so one said twice leaves the order unclear.
  if (
    parts === undefined ||
    modes.length !== symbols.length ||
    new Set(modes).size !== modes.length ||
    new Set(symbols).size !== symbols.length
  ) {
    return undefined;
  }

  return modes.map((mode, index) => ({ mode, symbol: symbols[index] ?? "" }));
};

/**
 * The Channel modes by how they take a parameter. Prefix modes, from `PREFIX`, are apart.
 */
export interface ChannelModes {
  /** Type A: a list, such as bans, with a parameter whenever it is changed. */
  readonly list: string;
  /** Type B: a parameter whenever it is changed, such as a key. */
  readonly always: string;
  /** Type C: a parameter only when it is set, such as a limit. */
  readonly whenSet: string;
  /** Type D: never a parameter. */
  readonly flags: string;
}

/** What to assume for `CHANMODES` when it is not sent: the modes of RFC 1459 and 2812. */
export const defaultChannelModes: ChannelModes = {
  always: "k",
  flags: "imnpst",
  list: "beI",
  whenSet: "l",
};

/**
 * Reads `CHANMODES`. Groups past the fourth are left out, as their meaning is undefined,
 * and a missing group has no modes.
 * @param value - The token's value, or `undefined` if it was not sent.
 * @returns The modes, or {@link defaultChannelModes} if it was not sent.
 */
export const channelModesOf = (value: string | undefined): ChannelModes => {
  if (value === undefined) {
    return defaultChannelModes;
  }

  const [list = "", always = "", whenSet = "", flags = ""] = value.split(",");

  return { always, flags, list, whenSet };
};

/** One pair of a `CHANLIMIT` or `MAXLIST`: what it counts, and the limit, if any. */
export interface Limit {
  /** The Channel prefixes of a `CHANLIMIT`, or the list modes of a `MAXLIST`. */
  readonly of: string;
  /** The most, or `undefined` for no limit. */
  readonly limit: number | undefined;
}

const pairsOf = (value: string | undefined) =>
  (value ?? "").split(",").flatMap((pair) => {
    const separator = pair.lastIndexOf(":");
    const limit = pair.slice(separator + 1);

    return separator <= 0 || (limit !== "" && !positive.test(limit))
      ? []
      : [{ limit: limitOf(limit), of: pair.slice(0, separator) }];
  });

/**
 * Reads `CHANLIMIT` or `MAXLIST`: `<what>:[limit]` pairs. A limit is shared by
 * everything in its pair, so `MAXLIST=beI:100` is 100 of bans, exceptions, and invites
 * together. A pair that does not parse is left out.
 * @param value - The token's value, or `undefined` if it was not sent.
 * @returns The pairs, in order.
 */
export const limitsOf = (value: string | undefined): readonly Limit[] => pairsOf(value);

/**
 * Reads `TARGMAX`: how many targets each command takes. A command that is not listed
 * takes one, but for `JOIN` and `PART`.
 * @param value - The token's value, or `undefined` if it was not sent.
 * @returns Each command, upper-cased, with its limit, or `undefined` for no limit.
 */
export const targetLimitsOf = (
  value: string | undefined
): ReadonlyMap<string, number | undefined> =>
  new Map(pairsOf(value).map(({ limit, of }) => [upperCaseAscii(of), limit]));
