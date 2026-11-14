/**
 * The fonts `ui.font` names, as the page draws them: each one's family as `fonts.css`
 * declares it, ahead of the device's own font of the same kind, monospace or sans, which
 * draws text while the font loads, if it never does, and wherever it lacks a glyph. A family
 * the device has is drawn by its name, ahead of the device's own monospace font, which
 * draws text if the device lacks it. This is the one place a family the Owner named
 * becomes CSS.
 *
 * @packageDocumentation
 */
import { isFontName } from "@iirc/api";
import type { FontFamily, FontName, FontShown } from "@iirc/api";

/** What a font's glyphs share: every one as wide as the next, or not. */
type Kind = "mono" | "sans";

/**
 * A font: its kind, and its family as CSS names it, none for the device's own.
 */
interface Face {
  readonly family: string | undefined;
  readonly kind: Kind;
}

const fonts: Readonly<Record<FontName, Face>> = {
  "atkinson-hyperlegible-mono": { family: '"Atkinson Hyperlegible Mono Variable"', kind: "mono" },
  "atkinson-hyperlegible-next": { family: '"Atkinson Hyperlegible Next Variable"', kind: "sans" },
  "commit-mono": { family: '"Commit Mono"', kind: "mono" },
  "ibm-plex-mono": { family: '"IBM Plex Mono"', kind: "mono" },
  "ibm-plex-sans": { family: '"IBM Plex Sans Variable"', kind: "sans" },
  inter: { family: '"Inter Variable"', kind: "sans" },
  "jetbrains-mono": { family: '"JetBrains Mono Variable"', kind: "mono" },
  "source-code-pro": { family: '"Source Code Pro Variable"', kind: "mono" },
  "source-sans-3": { family: '"Source Sans 3 Variable"', kind: "sans" },
  system: { family: undefined, kind: "mono" },
  "system-sans": { family: undefined, kind: "sans" },
};

/** The device's own font of each kind, as `theme.css` gives them. */
const deviceFonts: Readonly<Record<Kind, string>> = {
  mono: "var(--font-device)",
  sans: "var(--font-device-sans)",
};

/**
 * A family the device has, as CSS names it: between double quotes, which is exactly one
 * family, since a family holds no `"`, `\`, or control character.
 * @param family - The family.
 * @returns The family, as CSS.
 */
export const familyCss = (family: FontFamily): string => `"${family}"`;

/**
 * A font as `fonts.css` serves it, or, for a family the device has, the family by its name.
 * We cannot know a family's kind, so a glyph it lacks, or the whole of it when the device
 * lacks it, is drawn in the device's own monospace font, as `system` draws it.
 * @param font - The font.
 * @returns Its face.
 */
const faceOf = (font: FontShown): Face =>
  isFontName(font) ? fonts[font] : { family: familyCss(font), kind: "mono" };

/**
 * The fonts to draw text in, as `--font-text` takes them: the font's family, then the
 * device's own of its kind.
 * @param font - The font.
 * @returns The stack, as CSS.
 */
export const fontStack = (font: FontShown): string => {
  const { family, kind } = faceOf(font);
  const device = deviceFonts[kind];

  return family === undefined ? device : `${family}, ${device}`;
};

/**
 * The fonts to draw IRC's monospace formatting in, as `--font-mono` takes them: the font's
 * own stack when it is monospace, else the device's own monospace font, so text a sender
 * set apart as fixed pitch stays fixed pitch beside a sans font, or a family whose pitch
 * we cannot know.
 * @param font - The font.
 * @returns The stack, as CSS.
 */
export const monoStack = (font: FontShown): string =>
  isFontName(font) && fonts[font].kind === "mono" ? fontStack(font) : deviceFonts.mono;
