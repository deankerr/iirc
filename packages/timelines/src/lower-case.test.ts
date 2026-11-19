/**
 * The pinned lower-case mapping: it decides what a search finds, so on a runtime of the
 * same Unicode version it must fold exactly as the runtime lower-cases.
 */
import { describe, expect, it } from "vitest";

import { runtimeUnicode } from "../scripts/lower-case.ts";
import { lowerCaseUnicode } from "./lower-case.ts";
import { foldForSearch, searchFolding } from "./search.ts";

describe("the pinned lower-case mapping", () => {
  // The table is authoritative. A runtime of another Unicode version lower-cases
  // otherwise, which says nothing about this table, so the check runs only where the
  // versions match.
  it.skipIf(runtimeUnicode() !== lowerCaseUnicode)(
    "folds every code point as the runtime lower-cases it alone, but U+0130, simply",
    () => {
      const differ: number[] = [];

      for (let code = 0; code <= 0x10_ff_ff; code += 1) {
        if (code >= 0xd8_00 && code <= 0xdf_ff) {
          continue;
        }

        const character = String.fromCodePoint(code);
        const expected = code === 0x1_30 ? "i" : character.toLowerCase();

        if (foldForSearch(character) !== expected) {
          differ.push(code);
        }
      }

      expect(differ).toStrictEqual([]);
    }
  );

  it("names its Unicode version in the folding a store keeps", () => {
    expect(searchFolding).toBe(`simple-lower/${lowerCaseUnicode}`);
  });
});
