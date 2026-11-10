/**
 * The pinned word characters: the table is what decides Highlights, so regenerating it
 * on a runtime of the same Unicode version must give it back exactly.
 */
import { describe, expect, it } from "vitest";

import { generateRanges, runtimeUnicode } from "../scripts/word-characters.ts";
import { isWordCharacter } from "./highlight.ts";
import { wordRanges, wordUnicode } from "./word-characters.ts";

describe("the pinned word characters", () => {
  // The table is authoritative. A runtime of another Unicode version would generate
  // another table, which says nothing about this one, so the check runs only where the
  // versions match.
  it.skipIf(runtimeUnicode() !== wordUnicode)(
    `are what the generator gives on a runtime of Unicode ${wordUnicode}`,
    () => {
      expect(generateRanges()).toStrictEqual(wordRanges);
    }
  );

  it("are ordered, inclusive ranges that neither overlap nor touch", () => {
    const pairs = wordRanges.flatMap((first, index) =>
      index % 2 === 0 ? [[first, wordRanges[index + 1] ?? -1] as const] : []
    );

    expect(wordRanges.length % 2).toBe(0);
    expect(
      pairs.every(
        ([first, last], index) =>
          first <= last && (index === 0 || first > (pairs[index - 1]?.[1] ?? 0) + 1)
      )
    ).toBeTruthy();
  });

  it.each<readonly [string, string, boolean]>([
    ["an ASCII letter", "a", true],
    ["an ASCII digit", "7", true],
    ["a nick's special", "[", true],
    ["a hyphen", "-", true],
    ["a combining acute accent", "́", true],
    ["a Devanagari vowel sign", "ि", true],
    ["an astral letter, Gothic ahsa", "\u{10330}", true],
    ["an astral letter, a CJK ideograph past the BMP", "\u{20000}", true],
    ["a Hebrew letter", "א", true],
    ["an Arabic letter", "ب", true],
    ["an Arabic-Indic digit", "٣", true],
    ["a Devanagari digit", "१", true],
    ["a fullwidth digit", "１", true],
    ["Georgian Mtavruli U+1C89", "Ᲊ", true],
    ["a space", " ", false],
    ["a colon", ":", false],
    ["a full stop", ".", false],
    ["an emoji", "\u{1F600}", false],
    ["a zero-width joiner", "‍", false],
    ["a variation selector", "️", true],
    ["a right-to-left mark", "‏", false],
    ["an unassigned code point", "\u{E0080}", false],
  ])("say whether %s stands inside a word", (_, character, inside) => {
    expect(isWordCharacter(character)).toBe(inside);
  });
});
