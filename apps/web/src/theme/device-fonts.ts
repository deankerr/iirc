/**
 * Whether this device has a font's family, as far as a browser can tell. A browser says
 * nothing of the fonts a device has, and `document.fonts.check` says yes to a family no
 * device has in several, so a family is found by drawing: text measured in the family,
 * ahead of each generic family, is drawn in that generic family alone when the device
 * lacks it, and so measures the same.
 *
 * @packageDocumentation
 */
import { isFontName } from "@iirc/api";
import type { FontFamily, FontShown } from "@iirc/api";

import { familyCss } from "./fonts.ts";

/** Text whose width differs between most fonts: wide letters, narrow ones, and digits. */
const sample = "mmmmmmmmmmlli1WQ@#0O";

/** The generic families measured against, each a different font on most devices. */
const generics = ["monospace", "serif", "sans-serif"] as const;

/** How wide the sample is drawn in a font's families, given as CSS. */
export type Measure = (font: string) => number;

/**
 * How the page measures the sample: in a canvas, or none in a browser with no canvas.
 * @returns The measure, or none.
 */
export const canvasMeasure = (): Measure | undefined => {
  const context = document.createElement("canvas").getContext("2d");

  return context === null
    ? undefined
    : (font) => {
        context.font = `72px ${font}`;

        return context.measureText(sample).width;
      };
};

/**
 * Of the fonts named, the families this device was found to lack: each whose sample
 * measures, ahead of every generic family, as that generic family alone. A font served by
 * name is never lacked, and with nothing to measure in, none is, since the browser cannot
 * tell.
 * @param fonts - The fonts, such as the one every device shares and this device's own.
 * @param measure - How the sample is measured, or none.
 * @returns The families lacked.
 */
export const familiesMissing = (
  fonts: readonly (FontShown | undefined)[],
  measure: Measure | undefined
): ReadonlySet<FontFamily> =>
  new Set(
    fonts.filter(
      (font): font is FontFamily =>
        measure !== undefined &&
        font !== undefined &&
        !isFontName(font) &&
        generics.every((generic) => measure(`${familyCss(font)}, ${generic}`) === measure(generic))
    )
  );
