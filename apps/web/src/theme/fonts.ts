/**
 * The fonts `ui.font` names, as the page draws them: each one's family as `fonts.css`
 * declares it, ahead of the device's own monospace font, which draws text while the font
 * loads, if it never does, and wherever it lacks a glyph.
 *
 * @packageDocumentation
 */
import type { FontShown } from "@iirc/api";

/** Each font's family, as `fonts.css` declares it, and none for the device's own. */
const fontFamilies: Readonly<Record<FontShown, string | undefined>> = {
  "atkinson-hyperlegible-mono": "Atkinson Hyperlegible Mono Variable",
  "commit-mono": "Commit Mono",
  "ibm-plex-mono": "IBM Plex Mono",
  "jetbrains-mono": "JetBrains Mono Variable",
  "source-code-pro": "Source Code Pro Variable",
  system: undefined,
};

/**
 * The fonts to draw text in, as `--font-mono` takes them: the font's family, then the
 * device's own.
 * @param font - The font.
 * @returns The stack, as CSS.
 */
export const fontStack = (font: FontShown): string => {
  const family = fontFamilies[font];

  return family === undefined ? "var(--font-device)" : `"${family}", var(--font-device)`;
};
