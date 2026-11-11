/**
 * What an item is found by when Timelines are searched, and the text a search looks for.
 * Every store folds text this one way, so they all find the same items.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

import type { Content } from "./content.ts";
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
 * How a search folds text, which changes whenever folding does: the scheme, and the
 * Unicode version of the table it folds by. A store that keeps folded text keeps this with
 * it, and folds again what it kept under another.
 */
export const searchFolding = `simple-lower/${lowerCaseUnicode}`;

/**
 * Text as a search compares it: each code point lower-cased by Unicode's simple mapping,
 * one code point to one, from a table pinned to one Unicode version, never the runtime's
 * tables or a locale's. So `İ` folds to `i`, and folding keeps the count of code points.
 * Nothing is composed or decomposed: `é` written whole and `e` with a combining accent are
 * different text, and diacritics are kept, so `café` does not find `cafe`.
 * @param text - Any text.
 * @returns It folded.
 */
export const foldForSearch = (text: string): string => {
  let folded = "";

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const lower = lowerOf.get(code);

    folded += lower === undefined ? character : String.fromCodePoint(lower);
  }

  return folded;
};

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
  // Two code units are the most a code point takes, so longer text is refused unread.
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
 * What an item is found by: a Message's text, as the Ircd confirmed it when it did, and its
 * sender, each folded. Nothing else is searched.
 * @param content - The item's content.
 * @returns What it is found by, or `undefined` for anything but a Message.
 */
export const searchableOf = (content: Content): Searchable | undefined => {
  if (content._tag !== "Message") {
    return undefined;
  }

  const delivery = content.ours?.delivery;

  return {
    sender: foldForSearch(content.sender),
    text: foldForSearch(delivery?._tag === "Confirmed" ? delivery.text : content.text),
  };
};
