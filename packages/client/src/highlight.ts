/**
 * Whether a Message is a Highlight: said live by a User other than Self, and naming Self's
 * nick, or one of the Owner's highlight words, as a whole word. It reads what the Client
 * knows as the step begins, as `where` does, so every Frontend agrees on which Messages
 * called for the Owner (ADR 0014).
 *
 * @packageDocumentation
 */
import { stripFormatting } from "@iirc/protocol/format";

import { isSelf } from "./meaning.ts";
import type { Run } from "./run.ts";
import { folder } from "./run.ts";
import { sessionOf } from "./views.ts";
import { wordRanges } from "./word-characters.ts";

// RFC 2812's specials, which a nick may hold beside letters and digits: `-`, `[`, `]`,
// `\`, the grave accent, `^`, `_`, `{`, `|`, and `}`.
const specials: ReadonlySet<number> = new Set([
  0x2d, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x7b, 0x7c, 0x7d,
]);

// Whether a code point lies in one of the pinned ranges, by binary search over the pairs.
const inRanges = (code: number): boolean => {
  let low = 0;
  let high = wordRanges.length / 2 - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const first = wordRanges[middle * 2] ?? 0;
    const last = wordRanges[middle * 2 + 1] ?? 0;

    if (code < first) {
      high = middle - 1;
    } else if (code > last) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
};

/**
 * Whether a character may stand inside a word: what RFC 2812's grammar lets a nick hold,
 * a letter, a digit, or one of its specials, with the letters, marks, and digits of any
 * script, as a Network that folds by `rfc8265` allows them. Letters, marks, and digits
 * are those of the Unicode version `word-characters.ts` pins, never the runtime's own
 * tables, so a Journal gives the same Highlights on every runtime. Anything else, such
 * as a space, a colon, a comma, a full stop, an apostrophe, an angle bracket, `@`, `/`,
 * an emoji, or a zero-width joiner, ends a word.
 * @param character - One code point, as a string.
 * @returns Whether it may.
 */
export const isWordCharacter = (character: string): boolean => {
  const code = character.codePointAt(0) ?? -1;

  return specials.has(code) || inRanges(code);
};

const ends = (character: string | undefined): boolean =>
  character === undefined || !isWordCharacter(character);

// For each prefix of the pattern, the length of its longest proper prefix that is also
// its suffix: the Knuth–Morris–Pratt failure table.
const failures = (pattern: readonly string[]): readonly number[] => {
  const table = [0];
  let matched = 0;

  for (let index = 1; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) {
      matched = table[matched - 1] ?? 0;
    }

    if (pattern[index] === pattern[matched]) {
      matched += 1;
    }

    table.push(matched);
  }

  return table;
};

/**
 * Whether the pattern occurs in the text as a whole word, found by Knuth–Morris–Pratt,
 * so the work is linear in the text and the pattern, however either repeats itself.
 * @param folded - The text, folded, one code point to each.
 * @param characters - The text as said, which each match's bounds are judged on.
 * @param pattern - The word, folded, one code point to each. Never empty.
 * @returns Whether it does.
 */
const occurs = (
  folded: readonly string[],
  characters: readonly string[],
  pattern: readonly string[]
): boolean => {
  const table = failures(pattern);
  let matched = 0;

  for (let index = 0; index < folded.length; index += 1) {
    while (matched > 0 && folded[index] !== pattern[matched]) {
      matched = table[matched - 1] ?? 0;
    }

    if (folded[index] === pattern[matched]) {
      matched += 1;
    }

    if (matched === pattern.length) {
      if (ends(characters[index - pattern.length]) && ends(characters[index + 1])) {
        return true;
      }

      matched = table[matched - 1] ?? 0;
    }
  }

  return false;
};

/**
 * Whether one of the words appears in the text as a whole word: bounded on each side by
 * the start or end of the text, or by a character that cannot stand inside a word, after
 * formatting codes are stripped, and compared by the fold given. The fold maps each code
 * point to one, as every casemapping does, so the folded text lines up with the text, and
 * a word's bounds are judged on the characters as said. The work is linear in the text's
 * length for each word.
 * @param fold - The casemapping in force, as a fold of a name.
 * @param text - What was said, with any formatting codes.
 * @param words - The words to look for. An empty one names nothing.
 * @returns Whether one is there.
 */
export const mentions = (
  fold: (name: string) => string,
  text: string,
  words: readonly string[]
): boolean => {
  // oxlint-disable-next-line typescript/no-misused-spread -- every casemapping folds per code point, so the text is compared per code point.
  const characters = [...stripFormatting(text)];
  const folded = characters.map(fold);

  return words.some((word) => {
    // oxlint-disable-next-line typescript/no-misused-spread -- compared per code point, as the text is.
    const pattern = [...fold(word)];

    return pattern.length > 0 && occurs(folded, characters, pattern);
  });
};

/**
 * Whether a Message read from a Line is a Highlight: live, said by a User who is not Self,
 * and naming Self's nick, while a Session gives one, or a highlight word, as a whole
 * word, compared by the Connection's casemapping, as Self's nick is. A Message from the
 * Ircd or another server is not, nor one from history, which does not call for the Owner
 * now. Whether it is a Direct Message does not matter here: a projection ranks those as
 * their own level.
 * @param run - The step, before the Message is folded in.
 * @param message - What was said, by whom, and whether it is happening now.
 * @param fromUser - Whether a User said it, rather than the Ircd or another server.
 * @returns Whether it is.
 */
export const isHighlight = (
  run: Run,
  message: { readonly live: boolean; readonly sender: string; readonly text: string },
  fromUser: boolean
): boolean => {
  if (!message.live || !fromUser || isSelf(run, message.sender)) {
    return false;
  }

  const nick = sessionOf(run.state)?.nick;
  const words = run.state.configuration?.highlights ?? [];

  return mentions(folder(run.state), message.text, nick === undefined ? words : [nick, ...words]);
};
