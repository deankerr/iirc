/**
 * Masks that pick Users out by who they are, as `nick!user@host`, with `*` for any run of
 * characters and `?` for any one.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

import { casefold } from "./casemapping.ts";
import type { Casemapping } from "./casemapping.ts";

// The most characters a mask may have, which bounds the work of matching it.
const maxMaskLength = 255;

const space = 0x20;
const delete_ = 0x7f;

// A text as its code points, so `?` stands for one character however it is written.
const characters = (text: string): readonly string[] => {
  const each: string[] = [];

  for (const character of text) {
    each.push(character);
  }

  return each;
};

// Whether a mask holds a character that cannot be part of one: a control, a space, or a
// comma, which separates masks in a list.
const isUnsafe = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;

  return code <= space || code === delete_ || character === ",";
};

// A mask is a nick, then a user, then a host, each non-empty, joined by exactly one `!`
// and exactly one `@`, in that order.
const hasThreeParts = (text: string): boolean => {
  const [nick, rest, ...extra] = text.split("!");
  const [user, host, ...more] = (rest ?? "").split("@");

  return (
    extra.length === 0 &&
    more.length === 0 &&
    nick !== undefined &&
    nick !== "" &&
    !nick.includes("@") &&
    user !== undefined &&
    user !== "" &&
    host !== undefined &&
    host !== ""
  );
};

const isMask = (text: string): boolean =>
  text.length <= maxMaskLength && !characters(text).some(isUnsafe) && hasThreeParts(text);

/**
 * A mask of `nick!user@host`: three non-empty parts, joined by exactly one `!` and then
 * exactly one `@`, of at most 255 characters, with no space, comma, or control character.
 * `*` and `?` are wildcards, and every other character stands for itself. A mask that
 * exists can be matched.
 */
export const IgnoreMask = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isMask, {
      expected: "a mask of nick!user@host, of at most 255 characters, with no space or comma",
    })
  ),
  Schema.brand("IgnoreMask")
);

/** The decoded form of {@link IgnoreMask}. */
export type IgnoreMask = typeof IgnoreMask.Type;

/**
 * The form a mask is compared in: the mask folded by the Network's casemapping, which
 * every spelling of it shares. A folded mask is still a mask.
 * @param casemapping - The mapping in force.
 * @param mask - A mask, as the Owner wrote it.
 * @returns The mask folded.
 */
export const canonicalMask = (casemapping: Casemapping, mask: IgnoreMask): IgnoreMask =>
  IgnoreMask.make(casefold(casemapping, mask));

// Whether a text matches a pattern whole, by the two-pointer walk that remembers only the
// last `*`, so the work is at most the pattern times the text, with no recursion.
const globs = (pattern: readonly string[], text: readonly string[]): boolean => {
  let at = 0;
  let from = 0;
  let star = -1;
  let resume = 0;

  while (from < text.length) {
    const wanted = pattern[at];

    if (wanted === "*") {
      star = at;
      resume = from;
      at += 1;
    } else if (wanted !== undefined && (wanted === "?" || wanted === text[from])) {
      at += 1;
      from += 1;
    } else if (star === -1) {
      return false;
    } else {
      at = star + 1;
      resume += 1;
      from = resume;
    }
  }

  while (pattern[at] === "*") {
    at += 1;
  }

  return at === pattern.length;
};

/**
 * Whether a glob, with `*` for any run of characters and `?` for any one, matches a text
 * whole, each as given: a caller folds both first where case does not count.
 * @param pattern - The glob.
 * @param text - The text.
 * @returns Whether it matches.
 */
export const globMatches = (pattern: string, text: string): boolean =>
  globs(characters(pattern), characters(text));

/** Who a mask is tried on: a Line's source, split as `parseSource` splits it. */
export interface Matchable {
  readonly nick: string;
  readonly user: string | undefined;
  readonly host: string | undefined;
}

/**
 * Whether a mask matches a User, both sides folded by the casemapping, the whole of
 * `nick!user@host` at once. A missing user or host is empty.
 * @param casemapping - The mapping in force.
 * @param mask - The mask.
 * @param who - The User's nick, user, and host, as a Line's source gave them.
 * @returns Whether it matches.
 */
export const matches = (casemapping: Casemapping, mask: IgnoreMask, who: Matchable): boolean =>
  globs(
    characters(casefold(casemapping, mask)),
    characters(casefold(casemapping, `${who.nick}!${who.user ?? ""}@${who.host ?? ""}`))
  );
