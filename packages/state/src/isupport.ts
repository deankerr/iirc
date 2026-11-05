import type { ModeTypes } from "./modes.ts";

/**
 * How a Network compares nicks and Channel names, from `CASEMAPPING` (KNOW-3). Anything
 * unrecognised is `ascii`, which splits names rather than merging them.
 */
export type Casemapping = "ascii" | "rfc1459" | "rfc1459-strict";

/** The `RPL_ISUPPORT` tokens a Session holds, already read, as they stand now (KNOW-2). */
export interface Isupport {
  readonly casemapping: Casemapping;
  /** Which Channel mode letters take parameters, from `PREFIX` and `CHANMODES`. */
  readonly modes: ModeTypes;
  /** `NICKLEN`, the longest nick the Ircd accepts, if it said (KNOW-2). */
  readonly nickLength: number | undefined;
}

// KNOW-2's defaults, for a Network that never sends a token, or takes one back.
const defaultCasemapping: Casemapping = "rfc1459";

const defaultPrefixLetters = "ov";

const defaultChanmodes = "beI,k,l";

const prefixModes = /^\((?<modes>[^)]*)\)/u;

const tokenParts = /^(?<removed>-?)(?<name>[^=]*)(?:=(?<value>.*))?$/u;

const positive = /^[1-9]\d*$/u;

const upper = /[A-Z]/gu;

const rfc1459Extras = /[[\]\\~]/gu;

const strictExtras = /[[\]\\]/gu;

const extraLower: ReadonlyMap<string, string> = new Map([
  ["[", "{"],
  ["\\", "|"],
  ["]", "}"],
  ["~", "^"],
]);

const lowerLetter = (letter: string) => letter.toLowerCase();

const lowerExtra = (character: string) => extraLower.get(character) ?? character;

/**
 * The form a name is compared in under a mapping (KNOW-3). `ascii` lower-cases `A` to `Z`,
 * and `rfc1459` also takes `[]\~` to `{}|^`, which `rfc1459-strict` does but for `~`.
 * @param casemapping - The mapping in force.
 * @param name - A nick or Channel name, as spelled anywhere.
 * @returns What every spelling of it shares.
 */
export const casefold = (casemapping: Casemapping, name: string): string => {
  const lowered = name.replaceAll(upper, lowerLetter);

  switch (casemapping) {
    case "ascii": {
      return lowered;
    }

    case "rfc1459": {
      return lowered.replaceAll(rfc1459Extras, lowerExtra);
    }

    case "rfc1459-strict": {
      return lowered.replaceAll(strictExtras, lowerExtra);
    }

    default: {
      return casemapping satisfies never;
    }
  }
};

const casemappingOf = (value: string | undefined): Casemapping => {
  switch (value) {
    case undefined: {
      return defaultCasemapping;
    }

    case "rfc1459": {
      return "rfc1459";
    }

    case "rfc1459-strict":
    case "strict-rfc1459": {
      return "rfc1459-strict";
    }

    default: {
      return "ascii";
    }
  }
};

// `PREFIX=` means no prefixes at all, which differs from no token (KNOW-2). A value that
// is neither has no letters to offer, so the default stands in for it.
const prefixLettersOf = (value: string | undefined) => {
  if (value === undefined) {
    return defaultPrefixLetters;
  }

  return value === "" ? "" : (prefixModes.exec(value)?.groups?.modes ?? defaultPrefixLetters);
};

// A `CHANMODES` short of groups has none of the missing kinds.
const chanmodesOf = (modes: ModeTypes, value: string | undefined): ModeTypes => {
  const [list = "", always = "", whenSet = "", flags = ""] = (value ?? defaultChanmodes).split(",");

  return { ...modes, always, flags, list, whenSet };
};

/** What a Session holds before any `RPL_ISUPPORT`. */
export const defaultIsupport: Isupport = {
  casemapping: defaultCasemapping,
  modes: chanmodesOf(
    { always: "", flags: "", list: "", prefix: defaultPrefixLetters, whenSet: "" },
    undefined
  ),
  nickLength: undefined,
};

// A token with no value has an empty one, and `-TOKEN` takes it back, so its default
// applies again. Only a usable `NICKLEN` counts, and anything else leaves it as it was.
const withToken = (isupport: Isupport, token: string): Isupport => {
  const { name = "", removed, value: given } = tokenParts.exec(token)?.groups ?? {};
  const value = removed === "-" ? undefined : (given ?? "");

  switch (name) {
    case "CASEMAPPING": {
      return { ...isupport, casemapping: casemappingOf(value) };
    }

    case "CHANMODES": {
      return { ...isupport, modes: chanmodesOf(isupport.modes, value) };
    }

    case "PREFIX": {
      return { ...isupport, modes: { ...isupport.modes, prefix: prefixLettersOf(value) } };
    }

    case "NICKLEN": {
      if (removed === "-") {
        return given === undefined ? { ...isupport, nickLength: undefined } : isupport;
      }

      return value !== undefined && positive.test(value)
        ? { ...isupport, nickLength: Number(value) }
        : isupport;
    }

    default: {
      return isupport;
    }
  }
};

const sameModes = (one: ModeTypes, other: ModeTypes) =>
  one.prefix === other.prefix &&
  one.list === other.list &&
  one.always === other.always &&
  one.whenSet === other.whenSet &&
  one.flags === other.flags;

/**
 * Applies the tokens of one `RPL_ISUPPORT`, in order.
 * @param current - The tokens so far in this Session.
 * @param tokens - The `005`'s parameters after its own Target. Tokens run to the last,
 * which is usually prose and never looks like one.
 * @returns The tokens after it, and the very same value when nothing it holds moved.
 */
export const withIsupport = (current: Isupport, tokens: readonly string[]): Isupport => {
  let next = current;

  for (const token of tokens) {
    next = withToken(next, token);
  }

  return next.casemapping === current.casemapping &&
    next.nickLength === current.nickLength &&
    sameModes(next.modes, current.modes)
    ? current
    : next;
};
