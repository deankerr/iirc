/**
 * The pinned lower-case mapping: it decides what a search finds, so regenerating it on a
 * runtime of the same Unicode version must give it back exactly.
 */
import { describe, expect, it } from "vitest";

import { generateRuns, runtimeUnicode } from "../scripts/lower-case.ts";
import { lowerCaseRuns, lowerCaseUnicode } from "./lower-case.ts";
import { foldForSearch, searchFolding } from "./search.ts";

describe("the pinned lower-case mapping", () => {
  // The table is authoritative. A runtime of another Unicode version would generate
  // another table, which says nothing about this one, so the checks run only where the
  // versions match.
  it.skipIf(runtimeUnicode() !== lowerCaseUnicode)(
    `is what the generator gives on a runtime of Unicode ${lowerCaseUnicode}`,
    () => {
      expect(generateRuns()).toStrictEqual(lowerCaseRuns);
    }
  );

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

  it("is runs of four, each ordered and stepping forward", () => {
    expect(lowerCaseRuns.length % 4).toBe(0);
    expect(
      lowerCaseRuns.every(
        (each, index) =>
          (index % 4 !== 1 || each >= (lowerCaseRuns[index - 1] ?? 0)) &&
          (index % 4 !== 2 || each > 0)
      )
    ).toBeTruthy();
  });

  it("names its Unicode version in the folding a store keeps", () => {
    expect(searchFolding).toBe(`simple-lower/${lowerCaseUnicode}`);
  });
});
