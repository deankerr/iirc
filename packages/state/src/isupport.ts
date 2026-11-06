import type { Casemapping } from "./casemapping.ts";
import type { ModeTypes } from "./modes.ts";

/**
 * The `RPL_ISUPPORT` tokens a Session holds, as they stand now (KNOW-2). `tokens` is every
 * token as sent, and the rest is read from it, with the defaults KNOW-2 gives for a token
 * never sent or taken back.
 */
export interface Isupport {
  /** From `CASEMAPPING` and `UTF8MAPPING` together (KNOW-3). */
  readonly casemapping: Casemapping;
  /**
   * The token whose mapping was not recognised, such as `CASEMAPPING=precis`, which made
   * `casemapping` fall back to `ascii`. `undefined` when nothing fell back.
   */
  readonly unknownCasemapping: string | undefined;
  /** `CHANTYPES`: the characters a Channel name can begin with. `#&` by default. */
  readonly chantypes: string;
  /** `MODES`: how many parameterised modes one `MODE` may carry, or `undefined` for no limit. */
  readonly maxModes: number | undefined;
  /** Which Channel mode letters take parameters, from `PREFIX` and `CHANMODES`. */
  readonly modes: ModeTypes;
  /** `NETWORK`, the Network's own name for itself, if it said. */
  readonly network: string | undefined;
  /** `NICKLEN`, the longest nick the Ircd accepts, if it said a usable one. */
  readonly nickLength: number | undefined;
  /** `PREFIX`'s symbols, each the symbol for the letter at its place in `modes.prefix`. */
  readonly prefixSymbols: string;
  /** `STATUSMSG`: prefixes that address a Message to some members of a Channel. */
  readonly statusmsg: string;
  /**
   * Every token in force, by name, with `\xHH` escapes decoded. A token sent with no value
   * holds `""`. Bounded: see {@link heldTokens}.
   */
  readonly tokens: ReadonlyMap<string, string>;
  /** Some tokens were not held, because {@link heldTokens} were already. */
  readonly tokensDropped: boolean;
}

/**
 * The most tokens held. Real Ircds send about 40. Past this, a new token is not held and
 * `tokensDropped` says so, but the tokens read into fields above are always held.
 */
export const heldTokens = 256;

// KNOW-2's defaults, for a Network that never sends a token, or takes one back.
const defaultCasemapping: Casemapping = "rfc1459";

const defaultPrefix = "(ov)@+";

const defaultChanmodes = "beI,k,l";

const defaultChantypes = "#&";

const defaultMaxModes = 3;

const readTokens: ReadonlySet<string> = new Set([
  "CASEMAPPING",
  "CHANMODES",
  "CHANTYPES",
  "MODES",
  "NETWORK",
  "NICKLEN",
  "PREFIX",
  "STATUSMSG",
  "UTF8MAPPING",
]);

// The grammar of a token (KNOW-2): a name of up to 20 letters, digits, `.` and `/`, and a
// value with no space.
const tokenGrammar = /^(?<removed>-?)(?<name>[A-Za-z0-9./]{1,20})(?:=(?<value>\S*))?$/u;

const escape = /\\x(?<hex>[0-9A-Fa-f]{2})/gu;

const prefixGrammar = /^\((?<letters>[^)]*)\)(?<symbols>.*)$/u;

const positive = /^[1-9]\d{0,8}$/u;

const unescaped = (value: string) =>
  value.replaceAll(escape, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));

const casemappingOf = (
  tokens: ReadonlyMap<string, string>
): Pick<Isupport, "casemapping" | "unknownCasemapping"> => {
  const utf8 = tokens.get("UTF8MAPPING");
  const value = tokens.get("CASEMAPPING");

  if (utf8 === "rfc8265" || value === "rfc8265") {
    return { casemapping: "rfc8265", unknownCasemapping: undefined };
  }

  if (utf8 !== undefined) {
    return { casemapping: "ascii", unknownCasemapping: `UTF8MAPPING=${utf8}` };
  }

  switch (value) {
    case undefined: {
      return { casemapping: defaultCasemapping, unknownCasemapping: undefined };
    }

    case "ascii":
    case "rfc1459": {
      return { casemapping: value, unknownCasemapping: undefined };
    }

    case "rfc1459-strict":
    case "strict-rfc1459": {
      return { casemapping: "rfc1459-strict", unknownCasemapping: undefined };
    }

    default: {
      return { casemapping: "ascii", unknownCasemapping: `CASEMAPPING=${value}` };
    }
  }
};

// `PREFIX=` means no prefixes at all, which differs from no token (KNOW-2). A value that is
// neither, or pairs letters with symbols unevenly, has nothing to offer, so the default
// stands in for it.
interface Prefix {
  readonly letters: string;
  readonly symbols: string;
}

const prefixOf = (value: string | undefined): Prefix => {
  if (value === "") {
    return { letters: "", symbols: "" };
  }

  const parts = prefixGrammar.exec(value ?? defaultPrefix)?.groups;

  if (parts?.letters === undefined || parts.letters.length !== parts.symbols?.length) {
    return { letters: "ov", symbols: "@+" };
  }

  return { letters: parts.letters, symbols: parts.symbols };
};

// A `CHANMODES` short of groups has none of the missing kinds.
const chanmodesOf = (prefix: string, value: string | undefined): ModeTypes => {
  const [list = "", always = "", whenSet = "", flags = ""] = (value ?? defaultChanmodes).split(",");

  return { always, flags, list, prefix, whenSet };
};

// `MODES` with no value means no limit, and one that is no count is as if never sent.
const maxModesOf = (value: string | undefined): number | undefined => {
  if (value === "") {
    return undefined;
  }

  return value !== undefined && positive.test(value) ? Number(value) : defaultMaxModes;
};

const isupportOf = (tokens: ReadonlyMap<string, string>, tokensDropped: boolean): Isupport => {
  const prefix = prefixOf(tokens.get("PREFIX"));
  const nickLength = tokens.get("NICKLEN");

  return {
    ...casemappingOf(tokens),
    chantypes: tokens.get("CHANTYPES") ?? defaultChantypes,
    maxModes: maxModesOf(tokens.get("MODES")),
    modes: chanmodesOf(prefix.letters, tokens.get("CHANMODES")),
    network: tokens.get("NETWORK"),
    nickLength:
      nickLength !== undefined && positive.test(nickLength) ? Number(nickLength) : undefined,
    prefixSymbols: prefix.symbols,
    statusmsg: tokens.get("STATUSMSG") ?? "",
    tokens,
    tokensDropped,
  };
};

interface Token {
  readonly name: string;
  /** `undefined` for a token taken back. */
  readonly value: string | undefined;
}

// One parameter of a `005` as a token, if it is one. A removal never carries a value, so
// one that does is no token (KNOW-2).
const tokenOf = (param: string): Token | undefined => {
  const parts = tokenGrammar.exec(param)?.groups;
  const name = parts?.name;

  if (name === undefined) {
    return undefined;
  }

  if (parts?.removed === "-") {
    return parts.value === undefined ? { name, value: undefined } : undefined;
  }

  return { name, value: unescaped(parts?.value ?? "") };
};

/** What a Session holds before any `RPL_ISUPPORT`. */
export const defaultIsupport: Isupport = isupportOf(new Map(), false);

/**
 * Applies the tokens of one `RPL_ISUPPORT`, in order. `-TOKEN` takes a token back, so its
 * default applies again, and what does not follow the token grammar is not a token.
 * @param current - The tokens so far in this Session.
 * @param params - The `005`'s parameters after its own Target: the tokens, then the text
 * that always ends it, which is never read, even when it looks like a token.
 * @returns The tokens after it, and the very same value when no token moved.
 */
export const withIsupport = (current: Isupport, params: readonly string[]): Isupport => {
  const tokens = new Map(current.tokens);
  let { tokensDropped } = current;
  let moved = false;

  // A `005` is its Target, its tokens, then text for people, which is never read, whatever
  // it says, so no text an Ircd sends can change what the Session does.
  for (const param of params.slice(0, -1)) {
    const token = tokenOf(param);

    if (token?.value === undefined) {
      moved = (token !== undefined && tokens.delete(token.name)) || moved;
    } else if (tokens.get(token.name) !== token.value) {
      const fits = tokens.has(token.name) || tokens.size < heldTokens || readTokens.has(token.name);

      if (fits) {
        tokens.set(token.name, token.value);
      }

      moved ||= fits;
      tokensDropped ||= !fits;
    }
  }

  if (!moved) {
    return tokensDropped === current.tokensDropped ? current : { ...current, tokensDropped };
  }

  return isupportOf(tokens, tokensDropped);
};
