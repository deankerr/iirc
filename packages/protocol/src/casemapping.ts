/**
 * How a Network compares nicks and Channel names, from ISUPPORT's `CASEMAPPING` and
 * `UTF8MAPPING`.
 *
 * @packageDocumentation
 */

/**
 * A mapping this module knows. `rfc8265` is PRECIS, which Ergo announces as
 * `CASEMAPPING=rfc8265`, or as `UTF8MAPPING=rfc8265` beside `CASEMAPPING=ascii`.
 */
export type Casemapping = "ascii" | "rfc1459" | "rfc1459-strict" | "rfc8265";

/** What RFC 1459 and modern IRC say holds when an Ircd sends no `CASEMAPPING`. */
export const defaultCasemapping: Casemapping = "rfc1459";

/**
 * Reads the mapping a Network announced.
 * @param casemapping - The value of `CASEMAPPING`, or `undefined` if it was not sent.
 * @param utf8mapping - The value of `UTF8MAPPING`, or `undefined` if it was not sent.
 * @returns The mapping, {@link defaultCasemapping} when neither token was sent, or
 * `undefined` when the Network named one this module does not know. A caller that
 * must still compare names should then use `ascii`, which can split one name into two,
 * but never merges two names into one.
 */
export const casemappingOf = (
  casemapping: string | undefined,
  utf8mapping: string | undefined
): Casemapping | undefined => {
  if (utf8mapping !== undefined) {
    return utf8mapping === "rfc8265" ? "rfc8265" : undefined;
  }

  switch (casemapping) {
    case undefined: {
      return defaultCasemapping;
    }

    case "ascii":
    case "rfc1459":
    case "rfc8265": {
      return casemapping;
    }

    case "rfc1459-strict":
    case "strict-rfc1459": {
      return "rfc1459-strict";
    }

    default: {
      return undefined;
    }
  }
};

const upperA = 0x41;
const upperZ = 0x5a;
const toLower = 0x20;

// `[`, `\`, `]`, and `~` are the upper case of `{`, `|`, `}`, and `^` under `rfc1459`.
const openBracket = 0x5b;
const closeBracket = 0x5d;
const tilde = 0x7e;
const caret = 0x5e;

const lowerCode = (casemapping: Casemapping, code: number) => {
  if (code >= upperA && code <= upperZ) {
    return code + toLower;
  }

  if (casemapping !== "rfc1459" && casemapping !== "rfc1459-strict") {
    return code;
  }

  if (code >= openBracket && code <= closeBracket) {
    return code + toLower;
  }

  return casemapping === "rfc1459" && code === tilde ? caret : code;
};

/**
 * The form a name is compared in. `ascii` lower-cases `A` to `Z`, `rfc1459` also takes
 * `[]\~` to `{}|^`, and `rfc1459-strict` does but for `~`. It reads one character at a
 * time and touches nothing past ASCII, so it does not depend on the locale or on the
 * runtime's Unicode tables.
 *
 * `rfc8265` folds ASCII only. Its full mapping lower-cases all of Unicode, which would
 * need a Unicode table pinned in this module, so two names that differ only in the case
 * of a letter past ASCII stay two names. That splits names, but never merges two.
 * @param casemapping - The mapping in force.
 * @param name - A nick or Channel name, as spelled anywhere.
 * @returns What every spelling of it shares.
 */
export const casefold = (casemapping: Casemapping, name: string): string => {
  let folded = "";
  let changed = false;

  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    const lower = lowerCode(casemapping, code);

    changed ||= lower !== code;
    folded += lower === code ? character : String.fromCodePoint(lower);
  }

  return changed ? folded : name;
};

/**
 * Whether two names are one under a mapping.
 * @param casemapping - The mapping in force.
 * @param left - One name.
 * @param right - The other.
 * @returns Whether they fold to the same form.
 */
export const sameName = (casemapping: Casemapping, left: string, right: string): boolean =>
  left === right || casefold(casemapping, left) === casefold(casemapping, right);
