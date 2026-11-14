import { FontFamily } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { familiesMissing } from "./device-fonts.ts";

const family = Schema.decodeSync(FontFamily);

/**
 * How a device that has these families measures: a font is as wide as the name of the
 * first of its families the device has, a generic family always among them.
 * @param has - The families the device has.
 * @returns The measure.
 */
const measureWith = (has: readonly string[]) => (font: string) =>
  font.split(", ").find((one) => !one.startsWith('"') || has.includes(one.slice(1, -1)))?.length ??
  0;

describe("the families this device lacks", () => {
  it("are those that measure as each generic family alone, never a font served by name", () => {
    expect([
      ...familiesMissing(
        [family("Fira Code"), family("No Such Font"), "inter", "system", undefined],
        measureWith(["Fira Code"])
      ),
    ]).toStrictEqual(["No Such Font"]);
  });

  it("are none where nothing can measure, since the browser cannot tell", () => {
    expect(familiesMissing([family("No Such Font")], undefined).size).toBe(0);
  });
});
