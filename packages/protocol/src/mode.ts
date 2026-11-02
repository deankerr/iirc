/**
 * Which Channel mode letters take a parameter, and when, as `PREFIX` and `CHANMODES` from
 * `RPL_ISUPPORT` say (KNOW-2, KNOW-6).
 */
export interface ModeTypes {
  /** Letters that give a member a prefix, such as `o`. Each always takes a nick. */
  readonly prefix: string;
  /** `CHANMODES` type A: lists, such as `b`. Each always takes a parameter. */
  readonly list: string;
  /** Type B, such as `k`. Each always takes a parameter. */
  readonly always: string;
  /** Type C, such as `l`. Each takes a parameter only when it is set. */
  readonly whenSet: string;
  /** Type D: flags, which never take one. */
  readonly flags: string;
}

/** The two tokens as a Session last heard them, where `undefined` is never sent. */
export interface ModeTokens {
  readonly chanmodes?: string | undefined;
  readonly prefix?: string | undefined;
}

// KNOW-2's defaults, for a Network that never sends a token.
const defaultPrefix = "(ov)@+";
const defaultChanmodes = "beI,k,l";

const prefixModes = /^\((?<modes>[^)]*)\)/u;

// `PREFIX=` means no prefixes at all, which differs from no token (KNOW-2). A value that
// is neither has no letters to offer, so the default stands in for it.
const prefixLetters = (prefix: string) => {
  if (prefix === "") {
    return "";
  }

  return (
    prefixModes.exec(prefix)?.groups?.modes ?? prefixModes.exec(defaultPrefix)?.groups?.modes ?? ""
  );
};

/**
 * Reads which letters take parameters from `PREFIX` and `CHANMODES`, with KNOW-2's
 * defaults, `PREFIX=(ov)@+` and `CHANMODES=beI,k,l`, for a token never sent.
 * @param tokens - The values a Session last heard, if any.
 * @returns The letters of each kind.
 */
export const modeTypes = ({ chanmodes, prefix }: ModeTokens): ModeTypes => {
  const [list = "", always = "", whenSet = "", flags = ""] = (chanmodes ?? defaultChanmodes).split(
    ","
  );

  return { always, flags, list, prefix: prefixLetters(prefix ?? defaultPrefix), whenSet };
};

const tokenName = /^(?<removed>-?)(?<name>PREFIX|CHANMODES)(?:=(?<value>.*))?$/u;

/**
 * Applies the `PREFIX` and `CHANMODES` tokens of one `RPL_ISUPPORT` (KNOW-2). A token
 * with no value has an empty one, and `-TOKEN` removes it, so its default applies again.
 * @param current - The tokens so far in this Session.
 * @param params - The `005`'s parameters after its own Target, prose and all.
 * @returns The tokens after it.
 */
export const withModeTokens = (current: ModeTokens, params: readonly string[]): ModeTokens => {
  let { chanmodes, prefix } = current;

  for (const param of params) {
    const groups = tokenName.exec(param)?.groups;
    const value = groups?.removed === "-" ? undefined : (groups?.value ?? "");

    if (groups?.name === "PREFIX") {
      prefix = value;
    } else if (groups?.name === "CHANMODES") {
      chanmodes = value;
    }
  }

  return { chanmodes, prefix };
};

/** One letter of a `MODE`, set or unset, with the parameter it took if it took one. */
export interface ModeChange {
  readonly adding: boolean;
  readonly letter: string;
  readonly param?: string;
}

/**
 * What a `MODE`'s letters and parameters came to. `Uneven` is a `MODE` whose parameters
 * do not add up under the types in force, which KNOW-6 keeps raw, so nothing should act
 * on what it holds.
 */
export type ParsedModes =
  | { readonly _tag: "Parsed"; readonly changes: readonly ModeChange[] }
  | { readonly _tag: "Uneven"; readonly changes: readonly ModeChange[] };

const takesParam = (types: ModeTypes, letter: string, adding: boolean) =>
  types.prefix.includes(letter) ||
  types.list.includes(letter) ||
  types.always.includes(letter) ||
  (adding && types.whenSet.includes(letter));

// Ircds differ on whether an unset `k` carries the key, so one that finds nothing left
// takes nothing. Any other letter short of a parameter means the `MODE` does not add up.
const mayGoWithout = (types: ModeTypes, letter: string, adding: boolean) =>
  !adding && types.always.includes(letter);

/**
 * Parses a Channel `MODE`'s letters against its parameters, in order, so that
 * `+ok nick key` gives the nick to `o` and the key to `k` (KNOW-6). A letter the Network
 * never advertised takes no parameter.
 * @param params - The `MODE`'s parameters after its Target: the letters, then the rest.
 * @param types - Which letters take parameters, from {@link modeTypes}.
 * @returns Each change, and whether the parameters added up.
 */
export const parseModes = (params: readonly string[], types: ModeTypes): ParsedModes => {
  const [letters = "", ...rest] = params;
  const changes: ModeChange[] = [];
  let adding = true;
  let next = 0;
  let even = true;

  for (const letter of letters) {
    if (letter === "+" || letter === "-") {
      adding = letter === "+";
    } else if (!takesParam(types, letter, adding)) {
      changes.push({ adding, letter });
    } else if (next < rest.length) {
      changes.push({ adding, letter, param: rest[next] ?? "" });
      next += 1;
    } else {
      even &&= mayGoWithout(types, letter, adding);
      changes.push({ adding, letter });
    }
  }

  return even && next === rest.length ? { _tag: "Parsed", changes } : { _tag: "Uneven", changes };
};
