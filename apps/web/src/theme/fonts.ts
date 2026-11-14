/**
 * The fonts `ui.font` names, as the page draws them: each one's family as `fonts.css`
 * declares it, ahead of the device's own font of the same kind, monospace or sans, which
 * draws text while the font loads, if it never does, and wherever it lacks a glyph.
 *
 * @packageDocumentation
 */
import type { FontShown } from "@iirc/api";

/** What a font's glyphs share: every one as wide as the next, or not. */
type Kind = "mono" | "sans";

/** A font: its kind, and its family as `fonts.css` declares it, none for the device's own. */
interface Face {
  readonly family: string | undefined;
  readonly kind: Kind;
}

const fonts: Readonly<Record<FontShown, Face>> = {
  "atkinson-hyperlegible-mono": { family: "Atkinson Hyperlegible Mono Variable", kind: "mono" },
  "atkinson-hyperlegible-next": { family: "Atkinson Hyperlegible Next Variable", kind: "sans" },
  "commit-mono": { family: "Commit Mono", kind: "mono" },
  "ibm-plex-mono": { family: "IBM Plex Mono", kind: "mono" },
  "ibm-plex-sans": { family: "IBM Plex Sans Variable", kind: "sans" },
  inter: { family: "Inter Variable", kind: "sans" },
  "jetbrains-mono": { family: "JetBrains Mono Variable", kind: "mono" },
  "source-code-pro": { family: "Source Code Pro Variable", kind: "mono" },
  "source-sans-3": { family: "Source Sans 3 Variable", kind: "sans" },
  system: { family: undefined, kind: "mono" },
  "system-sans": { family: undefined, kind: "sans" },
};

/** The device's own font of each kind, as `theme.css` gives them. */
const deviceFonts: Readonly<Record<Kind, string>> = {
  mono: "var(--font-device)",
  sans: "var(--font-device-sans)",
};

/**
 * The fonts to draw text in, as `--font-text` takes them: the font's family, then the
 * device's own of its kind.
 * @param font - The font.
 * @returns The stack, as CSS.
 */
export const fontStack = (font: FontShown): string => {
  const { family, kind } = fonts[font];
  const device = deviceFonts[kind];

  return family === undefined ? device : `"${family}", ${device}`;
};

/**
 * The fonts to draw IRC's monospace formatting in, as `--font-mono` takes them: the font's
 * own stack when it is monospace, else the device's own monospace font, so text a sender
 * set apart as fixed pitch stays fixed pitch beside a sans font.
 * @param font - The font.
 * @returns The stack, as CSS.
 */
export const monoStack = (font: FontShown): string =>
  fonts[font].kind === "mono" ? fontStack(font) : deviceFonts.mono;
