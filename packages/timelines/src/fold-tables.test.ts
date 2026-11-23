/**
 * The pinned tables a search folds by: they decide what a search finds, so on a runtime of
 * the same Unicode version the fold must give what the runtime's own tables give.
 */
import { describe, expect, it } from "vitest";

import { runtimeBaseOf } from "../scripts/decompositions.ts";
import { runtimeUnicode } from "../scripts/lower-case.ts";
import { decompositionUnicode } from "./decompositions.ts";
import { lowerCaseUnicode } from "./lower-case.ts";
import { foldForSearch, searchFolding } from "./search.ts";

// The letters a search takes to a base of its own, which no runtime table gives.
const ownBases = new Map([
  ["ß", "ss"],
  ["æ", "ae"],
  ["ø", "o"],
  ["đ", "d"],
  ["ħ", "h"],
  ["ı", "i"],
  ["ł", "l"],
  ["œ", "oe"],
]);

describe("the pinned tables a search folds by", () => {
  // The tables are authoritative. A runtime of another Unicode version lower-cases and
  // decomposes otherwise, which says nothing about them, so the check runs only where the
  // versions match.
  it.skipIf(runtimeUnicode() !== lowerCaseUnicode)(
    "fold every code point as the runtime lower-cases it alone, but U+0130, simply, and decomposes that",
    () => {
      const differ: number[] = [];

      for (let code = 0; code <= 0x10_ff_ff; code += 1) {
        if (code >= 0xd8_00 && code <= 0xdf_ff) {
          continue;
        }

        const character = String.fromCodePoint(code);
        const lower = code === 0x1_30 ? "i" : character.toLowerCase();

        const expected = Array.from(
          String.fromCodePoint(...runtimeBaseOf(lower.codePointAt(0) ?? 0)),
          (each) => ownBases.get(each) ?? each
        ).join("");

        if (foldForSearch(character) !== expected) {
          differ.push(code);
        }
      }

      expect(differ).toStrictEqual([]);
    }
  );

  it("follow one Unicode version, which the folding a store keeps names", () => {
    expect([decompositionUnicode, searchFolding]).toStrictEqual([
      lowerCaseUnicode,
      `lower-base/${lowerCaseUnicode}`,
    ]);
  });
});
