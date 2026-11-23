import { casefold } from "@iirc/protocol/casemapping";
/**
 * What an item is found by when Timelines are searched, and the text a search looks for.
 * Every store folds text this one way, so they all find the same items.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

import type { Content } from "./content.ts";
import { decompositionEntries } from "./decompositions.ts";
import { lowerCaseRuns, lowerCaseUnicode } from "./lower-case.ts";

// Each code point that lower-cases to another, and what to. Built once from the pinned runs.
const lowerOf = new Map<number, number>();

for (let index = 0; index + 3 < lowerCaseRuns.length; index += 4) {
  const [first = 0, last = -1, step = 1, delta = 0] = lowerCaseRuns.slice(index, index + 4);

  for (let code = first; code <= last; code += step) {
    lowerOf.set(code, code + delta);
  }
}

/**
 * The letters a search takes to a base of its own, which no decomposition gives: a letter
 * with a stroke to the letter, and a ligature to its letters. Each is lower-case, as a
 * search lower-cases first, so its capital folds the same way.
 */
const ownBases = new Map([
  ["\u00F8", "o"],
  ["\u0142", "l"],
  ["\u0111", "d"],
  ["\u0127", "h"],
  ["\u0131", "i"],
  ["\u00E6", "ae"],
  ["\u0153", "oe"],
  ["\u00DF", "ss"],
]);

// Each code point a search takes to something other than itself once lower-cased, and
// what to. Built once from the pinned entries, and the letters of our own after them.
const baseOf = new Map<number, string>();

for (let index = 0; index + 1 < decompositionEntries.length;) {
  const [code = 0, count = 0] = decompositionEntries.slice(index, index + 2);
  const base = String.fromCodePoint(...decompositionEntries.slice(index + 2, index + 2 + count));

  baseOf.set(code, Array.from(base, (each) => ownBases.get(each) ?? each).join(""));
  index += 2 + count;
}

for (const [letter, base] of ownBases) {
  baseOf.set(letter.codePointAt(0) ?? 0, base);
}

/**
 * How a search folds text, which changes whenever folding does: the scheme, and the
 * Unicode version of the tables it folds by. A store that keeps folded text keeps this
 * with it, and folds again what it kept under another.
 */
export const searchFolding = `lower-base/${lowerCaseUnicode}`;

/**
 * Text as a search compares it, from tables pinned to one Unicode version, never the
 * runtime's tables or a locale's. Each code point is lower-cased by Unicode's simple
 * mapping, so `İ` folds to `i`, then decomposed by its canonical decomposition, with every
 * mark of the Combining Diacritical Marks block dropped, so `é` written whole and `e` with
 * a combining accent both fold to `e`. A letter with a stroke folds to its letter, and
 * `æ`, `œ` and `ß` to `ae`, `oe` and `ss`. Nothing else is taken off: a mark of another
 * block is kept, and a compatibility decomposition, or a Hangul syllable's, is not
 * followed. Text folds a code point at a time, so the fold of text is the folds of its
 * code points, joined, though not one code point to one.
 * @param text - Any text.
 * @returns It folded.
 */
export const foldForSearch = (text: string): string => {
  let folded = "";

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const lower = lowerOf.get(code) ?? code;

    folded += baseOf.get(lower) ?? String.fromCodePoint(lower);
  }

  return folded;
};

/**
 * A nick as a search kept to one sender compares it: folded by {@link foldForSearch}, and
 * then by `rfc1459`'s mapping, whatever the Network's own, so `[a` finds `{a`.
 * @param nick - A nick, as said or as sought.
 * @returns It folded.
 */
export const foldSenderForSearch = (nick: string): string =>
  casefold("rfc1459", foldForSearch(nick));

// How many code points text holds.
const codePointsIn = (text: string): number => text.match(/./gsu)?.length ?? 0;

/**
 * The fewest characters, by code point, that a search's text holds once folded. A store
 * finds text by its runs of three characters, so a shorter one finds nothing by its index.
 */
export const searchTextMinimum = 3;

/** The most characters, by code point, a search's text holds once folded, as no Line could carry more. */
export const searchTextMaximum = 510;

/**
 * The text a search looks for, as given: one run of characters, found anywhere in a
 * Message's text, whatever the case of either. It holds no line break or NUL, which no
 * Message can, no lone surrogate, and {@link searchTextMinimum} to
 * {@link searchTextMaximum} code points once folded.
 */
export const SearchText = Schema.String.check(
  // No Line carries more than 510 bytes, and a code unit takes at least one, so no Message
  // holds longer text, and it is refused unread, however short it folds.
  Schema.isMaxLength(searchTextMaximum * 2),
  Schema.makeFilter(
    (text: string) => !/[\0\r\n]/u.test(text) || "must not hold a line break or NUL"
  ),
  // A lone surrogate is no character, and no Message decoded from bytes holds one.
  Schema.makeFilter((text: string) => text.isWellFormed() || "must be well-formed Unicode"),
  Schema.makeFilter((text: string) => {
    const count = codePointsIn(foldForSearch(text));

    return (
      (count >= searchTextMinimum && count <= searchTextMaximum) ||
      `must hold ${searchTextMinimum} to ${searchTextMaximum} characters`
    );
  })
).pipe(Schema.brand("SearchText"));

/** The decoded form of {@link SearchText}. */
export type SearchText = typeof SearchText.Type;

/** What an item is found by, folded: its text, and who said it. */
export interface Searchable {
  readonly text: string;
  readonly sender: string;
}

/**
 * What an item is found by: a Message's text, as the Ircd confirmed it when it did, folded
 * by {@link foldForSearch}, and its sender, folded by {@link foldSenderForSearch}. Nothing else is searched.
 * @param content - The item's content.
 * @returns What it is found by, or `undefined` for anything but a Message.
 */
export const searchableOf = (content: Content): Searchable | undefined => {
  if (content._tag !== "Message") {
    return undefined;
  }

  const delivery = content.ours?.delivery;

  return {
    sender: foldSenderForSearch(content.sender),
    text: foldForSearch(delivery?._tag === "Confirmed" ? delivery.text : content.text),
  };
};
