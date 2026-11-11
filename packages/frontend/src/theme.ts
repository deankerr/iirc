/**
 * Themes as data: every colour a Frontend draws, derived from a terminal's palette, which
 * themes are built in and which the Owner imported, and which one is in effect. Each colour
 * that text is drawn in keeps at least a floor of contrast against what it is drawn on, by
 * moving its lightness in OKLCH and keeping its hue, so no palette, however ugly or hostile,
 * makes text unreadable. The contrast is WCAG 2's ratio: a standard every browser's tools
 * report and anyone can check, free to use, and simple enough to search exactly. APCA
 * judges dark themes better, but it is still a draft, and its licence restricts its use.
 *
 * @packageDocumentation
 */
import {
  ThemeName,
  ansiCount,
  builtInThemeNames,
  themeCommandWords,
  themesCap,
} from "@iirc/api/ui";
import type { Colour, ColoursShown, Palette, Theme } from "@iirc/api/ui";
import type { Colour as RunColour, Style } from "@iirc/protocol/format";
import { Option, Schema } from "effect";

import { builtInThemes } from "./builtin-themes.ts";
import { contrast, fromLch, lchOf, mix, readable, rgbOf } from "./colour.ts";
import type { Lch } from "./colour.ts";
import type { Parsed } from "./commands.ts";
import { nickSlots } from "./render.ts";

/** The least contrast text has against what it is drawn on: WCAG 2's AA for body text. */
export const textFloor = 4.5;

/**
 * The least contrast dim text and the focus ring have: WCAG 2's AA for large text and for
 * what is not text, so dim text stays calm but never vanishes.
 */
export const dimFloor = 3;

/**
 * mIRC's 99 colours as https://modern.ircdocs.horse/formatting#colors gives them: the 16
 * a sender names most, then 83 more. Colour 99 is the default, which is no colour.
 */
export const mircColours: readonly Colour[] = [
  "#ffffff",
  "#000000",
  "#00007f",
  "#009300",
  "#ff0000",
  "#7f0000",
  "#9c009c",
  "#fc7f00",
  "#ffff00",
  "#00fc00",
  "#009393",
  "#00ffff",
  "#0000fc",
  "#ff00ff",
  "#7f7f7f",
  "#d2d2d2",
  ...[
    "470000",
    "472100",
    "474700",
    "324700",
    "004700",
    "00472c",
    "004747",
    "002747",
    "000047",
    "2e0047",
    "470047",
    "47002a",
    "740000",
    "743a00",
    "747400",
    "517400",
    "007400",
    "007449",
    "007474",
    "004074",
    "000074",
    "4b0074",
    "740074",
    "740045",
    "b50000",
    "b56300",
    "b5b500",
    "7db500",
    "00b500",
    "00b571",
    "00b5b5",
    "0063b5",
    "0000b5",
    "7500b5",
    "b500b5",
    "b5006b",
    "ff0000",
    "ff8c00",
    "ffff00",
    "b2ff00",
    "00ff00",
    "00ffa0",
    "00ffff",
    "008cff",
    "0000ff",
    "a500ff",
    "ff00ff",
    "ff0098",
    "ff5959",
    "ffb459",
    "ffff71",
    "cfff60",
    "6fff6f",
    "65ffc9",
    "6dffff",
    "59b4ff",
    "5959ff",
    "c459ff",
    "ff66ff",
    "ff59bc",
    "ff9c9c",
    "ffd39c",
    "ffff9c",
    "e2ff9c",
    "9cff9c",
    "9cffdb",
    "9cffff",
    "9cd3ff",
    "9c9cff",
    "dc9cff",
    "ff9cff",
    "ff94d3",
    "000000",
    "131313",
    "282828",
    "363636",
    "4d4d4d",
    "656565",
    "818181",
    "9f9f9f",
    "bcbcbc",
    "e2e2e2",
    "ffffff",
  ].map((hex) => `#${hex}`),
];

/**
 * Which ANSI colour each of mIRC's first 16 takes under `theme`, as terminal IRC clients
 * such as WeeChat and irssi draw them: white the bright white, black the black, navy the
 * blue, green the green, red the bright red, brown the red, purple the magenta, orange the
 * yellow, yellow the bright yellow, light green the bright green, teal the cyan, light cyan
 * the bright cyan, light blue the bright blue, pink the bright magenta, grey the bright
 * black, and light grey the white.
 */
export const mircOnAnsi: readonly number[] = [15, 0, 4, 2, 9, 1, 5, 3, 11, 10, 6, 14, 12, 13, 8, 7];

/** Every colour a Frontend draws in, besides nicks' and mIRC's. */
export interface Tokens {
  readonly background: Colour;
  /** A raised surface: the composer, a header. */
  readonly surface: Colour;
  readonly text: Colour;
  /** Dim text: times, Activity, descriptions. */
  readonly muted: Colour;
  readonly border: Colour;
  readonly accent: Colour;
  /** Text drawn on the accent. */
  readonly onAccent: Colour;
  readonly danger: Colour;
  readonly ok: Colour;
  readonly focus: Colour;
  /** What calls for the Owner most: a Highlight. */
  readonly highlight: Colour;
  /** A Highlight's line's tint. */
  readonly highlightSurface: Colour;
  /** Behind text the Owner selected. */
  readonly selection: Colour;
  /** Over the page behind a dialog, as CSS. */
  readonly scrim: string;
  /** A dialog's shadow, as CSS. */
  readonly shadow: string;
}

/** A theme drawn: whether it is light or dark, and every colour derived from its palette. */
export interface Drawn {
  readonly scheme: "light" | "dark";
  readonly tokens: Tokens;
  /** The colour of each nick slot, readable. */
  readonly nicks: readonly Colour[];
  /** mIRC's 99 colours as text, readable on the background. */
  readonly irc: readonly Colour[];
  /** mIRC's 99 colours as a run's background, as they are. */
  readonly ircGrounds: readonly Colour[];
}

const ansiOf = (palette: Palette, index: number): Colour =>
  palette.ansi[index] ?? palette.foreground;

/**
 * mIRC's colours as `colours` says: the first 16 on the palette's ANSI colours under
 * `theme`, or mIRC's own under `raw`, and the other 83 mIRC's own either way.
 * @param palette - The palette.
 * @param colours - How colours a Message asks for are drawn.
 * @returns The 99 colours.
 */
const mircOf = (palette: Palette, colours: ColoursShown): readonly Colour[] =>
  mircColours.map((colour, index) => {
    const ansi = mircOnAnsi[index];

    return colours === "theme" && ansi !== undefined ? ansiOf(palette, ansi) : colour;
  });

/** How far apart two colours' hues and chromas may be and still count as one, in OKLab. */
const sameColour = 0.02;

/** The least chroma a colour has to count as a hue at all, not a grey. */
const chromatic = 0.03;

/**
 * How far apart two colours are in OKLab.
 * @param one - One colour.
 * @param other - The other.
 * @returns The distance.
 */
const distance = (one: Lch, other: Lch) => {
  const radians = Math.PI / 180;

  return Math.hypot(
    one.l - other.l,
    one.c * Math.cos(one.h * radians) - other.c * Math.cos(other.h * radians),
    one.c * Math.sin(one.h * radians) - other.c * Math.sin(other.h * radians)
  );
};

/**
 * The colours nicks are drawn from: the palette's chromatic ANSI colours, normal then
 * bright, each once, in hue order. A palette with fewer than three, as a monochrome one,
 * gives six evenly spaced hues at its text's lightness instead.
 * @param palette - The palette.
 * @returns The colours, in OKLCH.
 */
const nickBases = (palette: Palette): readonly Lch[] => {
  const kept: Lch[] = [];

  for (const index of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]) {
    const lch = lchOf(ansiOf(palette, index));
    const near = kept.some((one) => distance(one, lch) < sameColour);

    if (lch.c >= chromatic && !near) {
      kept.push(lch);
    }
  }

  if (kept.length >= 3) {
    return kept.toSorted((one, other) => one.h - other.h);
  }

  const { l } = lchOf(palette.foreground);

  return [30, 90, 150, 210, 270, 330].map((h) => ({ c: 0.12, h, l }));
};

/**
 * The 16 nick slots, spread evenly around the palette's own hues: each slot lies at its
 * share of the way round the bases, in hue order, between the two it falls between,
 * blended in OKLCH, so each hue comes from the palette and every base is a slot. Each is
 * readable on the grounds.
 * @param palette - The palette.
 * @param grounds - What nicks are drawn on.
 * @returns The slots' colours.
 */
const nickColours = (palette: Palette, grounds: readonly Colour[]): readonly Colour[] => {
  const bases = nickBases(palette);

  return Array.from({ length: nickSlots }, (_, slot) => {
    const along = (slot * bases.length) / nickSlots;
    const index = Math.floor(along);
    const share = along - index;
    const from = bases[index] ?? bases[0];
    const to = bases[(index + 1) % bases.length] ?? from;

    if (from === undefined || to === undefined) {
      return palette.foreground;
    }

    const turn = (((to.h - from.h) % 360) + 360) % 360;

    const lch: Lch = {
      c: from.c + (to.c - from.c) * share,
      h: (from.h + turn * share) % 360,
      l: from.l + (to.l - from.l) * share,
    };

    return readable(fromLch(lch), grounds, textFloor);
  });
};

/**
 * A surface behind text moved towards the background until the text reads on it.
 * @param surface - The surface wanted.
 * @param background - The background, which the text reads on.
 * @param text - The text.
 * @returns The surface.
 */
const behind = (surface: Colour, background: Colour, text: Colour): Colour => {
  if (contrast(surface, text) >= textFloor) {
    return surface;
  }

  let near = 0;
  let far = 1;

  for (let step = 0; step < 24; step += 1) {
    const middle = (near + far) / 2;

    if (contrast(mix(surface, background, middle), text) >= textFloor) {
      far = middle;
    } else {
      near = middle;
    }
  }

  return mix(surface, background, far);
};

/**
 * A colour as CSS with an alpha.
 * @param colour - The colour.
 * @param alpha - Its alpha, as a percentage.
 * @returns The CSS.
 */
const translucent = (colour: Colour, alpha: number) => {
  const { b, g, r } = rgbOf(colour);

  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)} / ${alpha}%)`;
};

/**
 * Every colour a theme draws in, from its palette. It is light or dark by which of white
 * and black reads better on its background, which is the palette's own. The surface and
 * the border lie a little way from the background towards the text, dim text further, the
 * accent is the cyan, danger the red, success the green, and a Highlight the yellow, each
 * made readable on the background, the surface, and a Highlight's tint. Nicks and mIRC's
 * colours are readable on those too, and the selection is moved back towards the
 * background until the text reads on it.
 * @param palette - The palette.
 * @param colours - How colours a Message asks for are drawn.
 * @returns The theme, drawn.
 */
export const drawn = (palette: Palette, colours: ColoursShown): Drawn => {
  const { background, foreground } = palette;
  const dark = contrast("#ffffff", background) >= contrast("#000000", background);
  // Text can always reach the floor on the background, by going to white or to black. A
  // surface may lie only so far from it that it still can there too.
  const extreme = dark ? "#ffffff" : "#000000";
  const surface = behind(mix(background, foreground, 0.05), background, extreme);
  const border = mix(background, foreground, 0.16);
  const plain = [background, surface];
  const firstHighlight = readable(ansiOf(palette, 3), plain, textFloor);
  const highlightSurface = behind(mix(background, firstHighlight, 0.09), background, extreme);
  const grounds = [background, surface, highlightSurface];
  const text = readable(foreground, grounds, textFloor);
  const accent = readable(ansiOf(palette, 6), grounds, textFloor);
  const shadowed = dark ? "#000000" : text;

  const onAccent = readable(
    contrast(background, accent) >= contrast(text, accent) ? background : text,
    [accent],
    textFloor
  );

  const tokens: Tokens = {
    accent,
    background,
    border,
    danger: readable(ansiOf(palette, 1), grounds, textFloor),
    focus: readable(accent, plain, dimFloor),
    highlight: readable(firstHighlight, grounds, textFloor),
    highlightSurface,
    muted: readable(mix(background, foreground, 0.55), grounds, dimFloor),
    ok: readable(ansiOf(palette, 2), grounds, textFloor),
    onAccent,
    scrim: translucent(shadowed, dark ? 55 : 35),
    selection: behind(palette.selection ?? mix(background, accent, 0.3), background, text),
    shadow: translucent(shadowed, dark ? 60 : 25),
    surface,
    text,
  };

  const ircGrounds = mircOf(palette, colours);

  return {
    irc: ircGrounds.map((one) => readable(one, grounds, textFloor)),
    ircGrounds,
    nicks: nickColours(palette, grounds),
    scheme: dark ? "dark" : "light",
    tokens,
  };
};

/** Each token's CSS variable, as the theme's style sheet names it. */
const tokenVariables: readonly (readonly [keyof Tokens, string])[] = [
  ["background", "--color-background"],
  ["surface", "--color-surface"],
  ["text", "--color-text"],
  ["muted", "--color-muted"],
  ["border", "--color-border"],
  ["accent", "--color-accent"],
  ["onAccent", "--color-on-accent"],
  ["danger", "--color-danger"],
  ["ok", "--color-ok"],
  ["focus", "--color-focus"],
  ["highlight", "--color-level-highlight"],
  ["highlightSurface", "--color-highlight-surface"],
  ["selection", "--color-selection"],
  ["scrim", "--color-scrim"],
  ["shadow", "--color-shadow"],
];

/**
 * A drawn theme as CSS custom properties, each a name and its value: the tokens, the nick
 * slots as `--nick-0` to `--nick-15`, and mIRC's colours as `--irc-0` to `--irc-98`.
 * @param theme - The theme, drawn.
 * @returns The properties, in a fixed order.
 */
export const cssVariables = (theme: Drawn): readonly (readonly [string, string])[] => [
  ...tokenVariables.map(([token, name]) => [name, theme.tokens[token]] as const),
  ...theme.nicks.map((colour, slot) => [`--nick-${slot}`, colour] as const),
  ...theme.irc.map((colour, index) => [`--irc-${index}`, colour] as const),
];

/** A run's colours as CSS, for an element's style. */
export interface RunStyle {
  readonly color?: string;
  readonly backgroundColor?: string;
}

/**
 * A colour a Message asked for, as it is: one of mIRC's, as the theme draws it, or hex.
 * @param colour - The colour asked for.
 * @param theme - The theme, drawn.
 * @returns The colour, or none for the default.
 */
const askedFor = (colour: RunColour | undefined, theme: Drawn): Colour | undefined => {
  if (colour === undefined) {
    return undefined;
  }

  return colour._tag === "Hex" ? `#${colour.hex.toLowerCase()}` : theme.ircGrounds[colour.index];
};

/**
 * A run's colours, as a Message asked for them, kept readable. With no background of its
 * own, a mIRC colour is its readable variable, `var(--irc-N)`, and a hex colour is made
 * readable on the theme's grounds. With one, which reverse gives a run too by swapping
 * the colours in force, the defaults included, the background is as asked and the text is
 * made readable on it.
 * @param style - The run's style.
 * @param theme - The theme, drawn.
 * @returns Its colours as CSS, each left out for the default.
 */
export const runColours = (style: Style, theme: Drawn): RunStyle => {
  const { tokens } = theme;
  const foreground = askedFor(style.foreground, theme);
  const background = askedFor(style.background, theme);

  if (style.reverse) {
    const ground = foreground ?? tokens.text;

    return {
      backgroundColor: ground,
      color: readable(background ?? tokens.background, [ground], textFloor),
    };
  }

  if (background !== undefined) {
    return {
      backgroundColor: background,
      color: readable(foreground ?? tokens.text, [background], textFloor),
    };
  }

  if (foreground === undefined || style.foreground === undefined) {
    return {};
  }

  return style.foreground._tag === "Palette"
    ? { color: `var(--irc-${style.foreground.index})` }
    : {
        color: readable(
          foreground,
          [tokens.background, tokens.surface, tokens.highlightSurface],
          textFloor
        ),
      };
};

// Which themes there are, and which one is in effect.

/** The name that follows the device's light or dark setting. */
export const systemTheme = "system";

/** A theme a list shows: its name, and whether it is built in or imported. */
export interface ListedTheme {
  readonly name: ThemeName;
  readonly builtIn: boolean;
}

/**
 * Every theme there is, in the order a list shows them: `system`, the built-in ones, and
 * then those imported.
 * @param imported - The themes imported.
 * @returns The themes.
 */
export const listedThemes = (imported: readonly Theme[]): readonly ListedTheme[] => [
  { builtIn: true, name: systemTheme },
  ...builtInThemes.map((one) => ({ builtIn: true, name: one.name })),
  ...imported.map((one) => ({ builtIn: false, name: one.name })),
];

/** A palette that stands in only if no built-in theme could, which never happens. */
const fallback: Palette = {
  ansi: Array.from({ length: ansiCount }, () => "#d4d7d6"),
  background: "#111314",
  foreground: "#d4d7d6",
};

const builtInNamed = (name: string) => builtInThemes.find((one) => one.name === name);

/**
 * The palette a theme's name draws: `system`'s is the built-in dark or light, as the device
 * prefers, a built-in one its own, an imported one its own, and a name that names none, as
 * one removed since, `system`'s.
 * @param name - The theme's name.
 * @param imported - The themes imported.
 * @param prefersDark - Whether the device prefers dark.
 * @returns The palette.
 */
export const paletteNamed = (
  name: string,
  imported: readonly Theme[],
  prefersDark: boolean
): Palette => {
  const found = builtInNamed(name) ?? imported.find((one) => one.name === name);

  if (found !== undefined && name !== systemTheme) {
    return found.palette;
  }

  return (builtInNamed(prefersDark ? "dark" : "light") ?? builtInThemes[0])?.palette ?? fallback;
};

const parsed = <A>(value: A): Parsed<A> => ({ _tag: "Parsed", value });

const invalid = <A>(message: string): Parsed<A> => ({ _tag: "Invalid", message });

const decodeName = Schema.decodeUnknownOption(ThemeName);

/**
 * A theme's name, from text: one word of lower-case letters and digits joined by `-`,
 * typed in any ASCII case.
 * @param text - The text.
 * @returns The name, or why it is not one.
 */
export const parseThemeName = (text: string): Parsed<ThemeName> => {
  const name = decodeName(text.trim().replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase()));

  return Option.isSome(name)
    ? parsed(name.value)
    : invalid(
        `${text.trim() === "" ? "A theme needs a name" : `${text.trim()} is not a theme's name`}: 1 to 32 letters and digits, in words joined by -, such as tokyo-night.`
      );
};

/**
 * The name to draw in, once it names a theme there is.
 * @param name - The name.
 * @param imported - The themes imported.
 * @returns It, or why it names none.
 */
export const usable = (name: ThemeName, imported: readonly Theme[]): Parsed<ThemeName> =>
  listedThemes(imported).some((one) => one.name === name)
    ? parsed(name)
    : invalid(`There is no theme ${name}. /theme lists them, and /theme import adds one.`);

/**
 * A change to the themes imported, applied to those in force, whatever they are, so it can
 * be applied again after a conflict.
 *
 * - `Add`: a theme, replacing one imported with its name.
 * - `Remove`: the theme imported with this name.
 */
export type ThemesEdit =
  | { readonly _tag: "Add"; readonly theme: Theme }
  | { readonly _tag: "Remove"; readonly name: ThemeName };

/**
 * The themes imported after an edit, or why it cannot be made: a built-in name, or
 * `system`, is never imported or removed, one not imported cannot be removed, and no more
 * than `themesCap` are kept. Nor is a theme named `import` or `remove`, which `/theme`
 * reads as what to do.
 * @param themes - The themes imported.
 * @param edit - The edit.
 * @returns The themes after.
 */
export const editThemes = (
  themes: readonly Theme[],
  edit: ThemesEdit
): Parsed<readonly Theme[]> => {
  const name = edit._tag === "Add" ? edit.theme.name : edit.name;

  if (builtInThemeNames.includes(name)) {
    return invalid(
      `${name} is built in, so it is never ${edit._tag === "Add" ? "imported" : "removed"}.${edit._tag === "Add" ? " Give it another name." : ""}`
    );
  }

  if (edit._tag === "Add" && themeCommandWords.includes(name)) {
    return invalid(
      `${name} is a word /theme takes, so no theme is named it. Give it another name.`
    );
  }

  const others = themes.filter((one) => one.name !== name);

  if (edit._tag === "Remove") {
    return others.length === themes.length
      ? invalid(`No theme ${name} was imported. /theme lists them.`)
      : parsed(others);
  }

  if (others.length === themes.length && themes.length >= themesCap) {
    return invalid(`${themesCap} themes are imported already. /theme remove one first.`);
  }

  const at = themes.findIndex((one) => one.name === name);

  return parsed(
    at === -1
      ? [...themes, edit.theme]
      : themes.map((one, index) => (index === at ? edit.theme : one))
  );
};
