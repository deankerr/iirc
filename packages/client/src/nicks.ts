/**
 * Which spans of a Message's text name a User who counts: each maximal run of word
 * characters that is the nick of one, compared by the Network's casemapping. It is worked
 * out in the step that folds the Message in, from what the Client knows as it begins, as
 * a Highlight is, so every Frontend agrees on which words name someone and a replay of
 * the Journal gives the same spans.
 *
 * A word is what a Highlight reads as one, `isWordCharacter`, and RFC 2812's grammar lets
 * a nick hold only word characters, so a nick that holds a character which ends a word,
 * as `.` does, is never found. There is no list of words to skip: a User called `so`
 * names each standalone `so`.
 *
 * @packageDocumentation
 */
import { stripFormatting } from "@iirc/protocol/format";

import { isWordCharacter } from "./highlight.ts";
import type { NickSpan } from "./news.ts";

/**
 * The spans of a text that name a User who counts, in order, none overlapping. The work
 * is linear in the text: each word is looked up once.
 * @param fold - The casemapping in force, as a fold of a name.
 * @param text - What was said, with any formatting codes.
 * @param counts - Whether a User counts, by their folded nick.
 * @returns Each span, as UTF-16 offsets into the text with its formatting stripped, `start`
 * inclusive and `end` exclusive.
 */
export const nickSpans = (
  fold: (name: string) => string,
  text: string,
  counts: (folded: string) => boolean
): readonly NickSpan[] => {
  const spans: NickSpan[] = [];
  const plain = stripFormatting(text);
  let start = 0;
  let offset = 0;
  let word = "";

  // A word ends where a character that cannot stand inside one begins, or at the end.
  const end = (): void => {
    if (word !== "" && counts(fold(word))) {
      spans.push({ end: offset, start });
    }

    word = "";
  };

  // oxlint-disable-next-line typescript/no-misused-spread -- a word is read per code point, as a Highlight reads it.
  for (const character of plain) {
    if (isWordCharacter(character)) {
      if (word === "") {
        start = offset;
      }

      word += character;
    } else {
      end();
    }

    offset += character.length;
  }

  end();

  return spans;
};
