import { Palette, Themes, builtInThemeNames } from "@iirc/api/ui";
import type { Colour, Theme } from "@iirc/api/ui";
import { plainStyle } from "@iirc/protocol/format";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { builtInThemes } from "./builtin-themes.ts";
import { contrast, lchOf, readable } from "./colour.ts";
import {
  cssVariables,
  dimFloor,
  drawn,
  editThemes,
  listedThemes,
  mircColours,
  mircOnAnsi,
  paletteNamed,
  parseThemeName,
  runColours,
  textFloor,
  usable,
} from "./theme.ts";
import type { Drawn } from "./theme.ts";

const hex = fc
  .integer({ max: 0xff_ff_ff, min: 0 })
  .map((value): Colour => `#${value.toString(16).padStart(6, "0")}`);

// Weighted towards palettes that fight back: greys near the middle, where the least
// contrast either way is lowest, and text the colour of its background.
const hostile = fc.oneof(
  hex,
  fc.integer({ max: 0x90, min: 0x60 }).map((grey): Colour => {
    const byte = grey.toString(16).padStart(2, "0");

    return `#${byte}${byte}${byte}`;
  })
);

const palettes = fc
  .record({
    ansi: fc.array(hostile, { maxLength: 16, minLength: 16 }),
    background: hostile,
    foreground: hostile,
    selection: fc.option(hostile, { nil: undefined }),
  })
  .map(({ selection, ...palette }): Palette =>
    selection === undefined ? palette : { ...palette, selection }
  );

/**
 * The least contrast a colour has with each of some backgrounds.
 * @param colour - The colour.
 * @param grounds - The backgrounds.
 * @returns The least ratio.
 */
const least = (colour: Colour, grounds: readonly Colour[]) =>
  Math.min(...grounds.map((ground) => contrast(colour, ground)));

/**
 * The least contrast of a theme's text colours, of its dim ones, and of what is drawn on
 * the accent and the selection.
 * @param theme - The theme, drawn.
 * @returns The least ratios.
 */
const floorsOf = (theme: Drawn) => {
  const { tokens } = theme;
  const grounds = [tokens.background, tokens.surface, tokens.highlightSurface];
  const text = [tokens.text, tokens.accent, tokens.danger, tokens.ok, tokens.highlight];

  return {
    dim: Math.min(least(tokens.muted, grounds), least(tokens.focus, [tokens.background])),
    onAccent: contrast(tokens.onAccent, tokens.accent),
    selection: contrast(tokens.text, tokens.selection),
    text: Math.min(...[...text, ...theme.nicks, ...theme.irc].map((one) => least(one, grounds))),
  };
};

const decodePalette = Schema.decodeUnknownOption(Palette);

const hueDistance = (one: number, other: number) => {
  const turn = Math.abs(one - other) % 360;

  return Math.min(turn, 360 - turn);
};

describe("a theme drawn from a palette", () => {
  it("keeps every text colour readable on what it is drawn on, for any palette", () => {
    fc.assert(
      fc.property(palettes, fc.constantFrom("theme", "raw"), (palette, colours) => {
        const floors = floorsOf(drawn(palette, colours));

        expect({
          dim: floors.dim >= dimFloor,
          onAccent: floors.onAccent >= textFloor,
          selection: floors.selection >= textFloor,
          text: floors.text >= textFloor,
        }).toStrictEqual({ dim: true, onAccent: true, selection: true, text: true });
      }),
      { numRuns: 150 }
    );
  });

  it("is the same every time it is drawn, and every colour is a palette's colour", () => {
    fc.assert(
      fc.property(palettes, (palette) => {
        const once = drawn(palette, "theme");

        const colours = [...cssVariables(once).map(([, value]) => value), ...once.ircGrounds];

        expect({
          again: drawn(palette, "theme"),
          css: colours.every((one) => /^#[0-9a-f]{6}$|^rgb\(/u.test(one)),
        }).toStrictEqual({ again: once, css: true });
      }),
      { numRuns: 40 }
    );
  });

  it("keeps a colour's hue while it moves its lightness to be read", () => {
    fc.assert(
      fc.property(hex, hex, (colour, background) => {
        const moved = readable(colour, [background], textFloor);
        const before = lchOf(colour);
        const after = lchOf(moved);

        // Hue means little for a grey, and sRGB's corners take chroma away near white and black.
        fc.pre(before.c > 0.06 && after.c > 0.06);

        expect(hueDistance(before.h, after.h)).toBeLessThan(6);
      }),
      { numRuns: 300 }
    );
  });

  it("leaves a colour alone that is readable already", () => {
    expect({
      kept: readable("#5fb3b3", ["#111314"], textFloor),
      lighter: contrast(readable("#3b4252", ["#2e3440"], textFloor), "#2e3440") >= textFloor,
      mid: contrast(readable("#777777", ["#777777"], textFloor), "#777777") >= textFloor,
    }).toStrictEqual({ kept: "#5fb3b3", lighter: true, mid: true });
  });

  it("maps mIRC's first sixteen onto the ANSI colours as terminal IRC clients do", () => {
    const ansi = Array.from(
      { length: 16 },
      (_, index) => `#0000${(index * 16).toString(16).padStart(2, "0")}`
    );

    const palette: Palette = { ansi, background: "#ffffff", foreground: "#000000" };

    expect({
      raw: drawn(palette, "raw").ircGrounds,
      table: mircOnAnsi,
      theme: drawn(palette, "theme").ircGrounds.slice(0, 16),
      themeExtended: drawn(palette, "theme").ircGrounds.slice(16),
    }).toStrictEqual({
      raw: mircColours,
      table: [15, 0, 4, 2, 9, 1, 5, 3, 11, 10, 6, 14, 12, 13, 8, 7],
      theme: mircOnAnsi.map((index) => ansi[index]),
      themeExtended: mircColours.slice(16),
    });
  });

  it("is dark or light by which reads better on its background, and its tokens are CSS variables", () => {
    const dark = drawn(paletteNamed("dark", [], false), "theme");
    const light = drawn(paletteNamed("light", [], true), "theme");
    const names = cssVariables(dark).map(([name]) => name);

    expect({
      backgrounds: [dark.tokens.background, light.tokens.background],
      count: names.length,
      first: names.slice(0, 3),
      last: names.at(-1),
      nick: names.includes("--nick-15"),
      schemes: [dark.scheme, light.scheme],
      scrims: [dark.tokens.scrim, light.tokens.scrim],
    }).toStrictEqual({
      backgrounds: ["#111314", "#f6f5f1"],
      count: 15 + 16 + 99,
      first: ["--color-background", "--color-surface", "--color-text"],
      last: "--irc-98",
      nick: true,
      schemes: ["dark", "light"],
      scrims: ["rgb(0 0 0 / 55%)", "rgb(36 41 46 / 35%)"],
    });
  });

  it("spreads nicks over sixteen slots drawn from the palette's hues", () => {
    const nord = paletteNamed("nord", [], true);
    const grey: Palette = { ...nord, ansi: Array.from({ length: 16 }, () => "#888888") };

    expect({
      grey: new Set(drawn(grey, "theme").nicks).size,
      nord: new Set(drawn(nord, "theme").nicks).size,
    }).toStrictEqual({ grey: 16, nord: 16 });
  });
});

describe("a run's colours", () => {
  const theme = drawn(paletteNamed("dark", [], true), "theme");
  const black = { _tag: "Palette", index: 1 } as const;
  const yellow = { _tag: "Palette", index: 8 } as const;

  it("are the readable variable alone, and made readable on a background of their own", () => {
    const onYellow = runColours({ ...plainStyle, background: yellow, foreground: black }, theme);
    const reversed = runColours({ ...plainStyle, foreground: yellow, reverse: true }, theme);
    const hexed = runColours({ ...plainStyle, foreground: { _tag: "Hex", hex: "111111" } }, theme);

    expect({
      hex: contrast(hexed.color ?? "", theme.tokens.background) >= textFloor,
      none: runColours(plainStyle, theme),
      onYellow: [
        onYellow.backgroundColor,
        contrast(onYellow.color ?? "", onYellow.backgroundColor ?? "") >= textFloor,
      ],
      plain: runColours({ ...plainStyle, foreground: black }, theme),
      reversed: [
        reversed.backgroundColor,
        contrast(reversed.color ?? "", reversed.backgroundColor ?? "") >= textFloor,
      ],
    }).toStrictEqual({
      hex: true,
      none: {},
      onYellow: [theme.ircGrounds[8], true],
      plain: { color: "var(--irc-1)" },
      reversed: [theme.ircGrounds[8], true],
    });
  });
});

describe("the themes there are", () => {
  const tokyo = builtInThemes.find((one) => one.name === "tokyo-night");
  const mine: Theme = { name: "mine", palette: paletteNamed("nord", [], true) };

  it("are built in, valid, and listed after system, then those imported", () => {
    expect({
      decoded: builtInThemes.every((one) => decodePalette(one.palette)._tag === "Some"),
      listed: listedThemes([mine]).map((one) => [one.name, one.builtIn]),
    }).toStrictEqual({
      decoded: true,
      listed: [
        ["system", true],
        ["dark", true],
        ["light", true],
        ["solarized-dark", true],
        ["solarized-light", true],
        ["gruvbox-dark", true],
        ["nord", true],
        ["dracula", true],
        ["tokyo-night", true],
        ["mine", false],
      ],
    });
  });

  it("draw a name as its own palette, system as the device prefers, and a name gone as system", () => {
    expect({
      builtIn: paletteNamed("tokyo-night", [], true),
      gone: paletteNamed("removed", [mine], false).background,
      imported: paletteNamed("mine", [mine], false),
      systemDark: paletteNamed("system", [], true).background,
      systemLight: paletteNamed("system", [], false).background,
    }).toStrictEqual({
      builtIn: tokyo?.palette,
      gone: "#f6f5f1",
      imported: mine.palette,
      systemDark: "#111314",
      systemLight: "#f6f5f1",
    });
  });

  it("parse a name in any case, and use only one there is", () => {
    expect({
      bad: parseThemeName("tokyo night"),
      empty: parseThemeName(""),
      known: usable("mine", [mine]),
      unknown: usable("nope", [mine]),
      upper: parseThemeName("Tokyo-Night"),
    }).toStrictEqual({
      bad: {
        _tag: "Invalid",
        message:
          "tokyo night is not a theme's name: 1 to 32 letters and digits, in words joined by -, such as tokyo-night.",
      },
      empty: {
        _tag: "Invalid",
        message:
          "A theme needs a name: 1 to 32 letters and digits, in words joined by -, such as tokyo-night.",
      },
      known: { _tag: "Parsed", value: "mine" },
      unknown: {
        _tag: "Invalid",
        message: "There is no theme nope. /theme lists them, and /theme import adds one.",
      },
      upper: { _tag: "Parsed", value: "tokyo-night" },
    });
  });

  it("are imported and removed by edits, never built-in ones, nor more than 32", () => {
    const other: Theme = { ...mine, palette: paletteNamed("dracula", [], true) };
    const full = Array.from({ length: 32 }, (_, index) => ({ ...mine, name: `t${index}` }));

    expect({
      added: editThemes([], { _tag: "Add", theme: mine }),
      builtIn: editThemes([], { _tag: "Add", theme: { ...mine, name: "nord" } }),
      full: editThemes(full, { _tag: "Add", theme: mine }),
      fullReplace: editThemes(full, { _tag: "Add", theme: { ...mine, name: "t3" } })._tag,
      missing: editThemes([mine], { _tag: "Remove", name: "other" }),
      removeBuiltIn: editThemes([], { _tag: "Remove", name: "system" }),
      removed: editThemes([mine], { _tag: "Remove", name: "mine" }),
      replaced: editThemes([mine], { _tag: "Add", theme: other }),
      word: editThemes([], { _tag: "Add", theme: { ...mine, name: "import" } }),
    }).toStrictEqual({
      added: { _tag: "Parsed", value: [mine] },
      builtIn: {
        _tag: "Invalid",
        message: "nord is built in, so it is never imported. Give it another name.",
      },
      full: {
        _tag: "Invalid",
        message: "32 themes are imported already. /theme remove one first.",
      },
      fullReplace: "Parsed",
      missing: { _tag: "Invalid", message: "No theme other was imported. /theme lists them." },
      removeBuiltIn: { _tag: "Invalid", message: "system is built in, so it is never removed." },
      removed: { _tag: "Parsed", value: [] },
      replaced: { _tag: "Parsed", value: [other] },
      word: {
        _tag: "Invalid",
        message: "import is a word /theme takes, so no theme is named it. Give it another name.",
      },
    });
  });

  it("are the contract's built-in names, which the contract refuses an import to take", () => {
    const decode = Schema.decodeUnknownOption(Themes);

    expect({
      names: listedThemes([]).map((one) => one.name),
      refused: ["system", "nord", "import", "remove"].map(
        (name) => decode([{ ...mine, name }])._tag
      ),
    }).toStrictEqual({
      names: builtInThemeNames,
      refused: ["None", "None", "None", "None"],
    });
  });

  it("are refused by the contract when named twice or past the cap", () => {
    const decode = Schema.decodeUnknownOption(Themes);
    const many = Array.from({ length: 33 }, (_, index) => ({ ...mine, name: `t${index}` }));

    expect({
      cap: decode(many)._tag,
      twice: decode([mine, mine])._tag,
      upper: decode([{ ...mine, name: "Mine" }])._tag,
    }).toStrictEqual({ cap: "None", twice: "None", upper: "None" });
  });
});
