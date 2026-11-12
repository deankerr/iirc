/**
 * The options under `ui`: Configuration that belongs to the Owner rather than to any
 * Network, such as how Frontends look, shared by every device (ADR 0013, ADR 0015). Each
 * field says what it is and what it starts as in its annotations, which a Frontend reads
 * to offer every field as an option, so a new field is a new option with no work in any
 * Frontend. This module is the Schema alone, so a Frontend's pure core can derive its
 * options from it without the HTTP contract.
 *
 * @packageDocumentation
 */
import { Schema, SchemaAST, Struct } from "effect";

/**
 * A colour in sRGB, as `#` and six lower-case hex digits, such as `#1a1b26`: the one form a
 * palette holds, so two that look alike are alike.
 */
export const Colour = Schema.String.check(
  Schema.isPattern(/^#[0-9a-f]{6}$/u, {
    message: "must be # and six lower-case hex digits, such as #1a1b26",
  })
).annotate({ identifier: "Colour" });

/** The decoded form of {@link Colour}. */
export type Colour = typeof Colour.Type;

/** How many colours a terminal's palette holds: eight, then their eight bright forms. */
export const ansiCount = 16;

/**
 * A terminal's palette, from which a Frontend derives every colour it draws: the text and
 * the background, the cursor and the selection when the palette says, and the sixteen ANSI
 * colours, black, red, green, yellow, blue, magenta, cyan, and white, then their bright
 * forms in the same order.
 */
export const Palette = Schema.Struct({
  ansi: Schema.Array(Colour).check(Schema.isMinLength(ansiCount), Schema.isMaxLength(ansiCount)),
  background: Colour,
  cursor: Schema.optionalKey(Colour),
  foreground: Colour,
  selection: Schema.optionalKey(Colour),
}).annotate({ identifier: "Palette" });

/** The decoded form of {@link Palette}. */
export type Palette = typeof Palette.Type;

/**
 * A theme's name: 1 to 32 lower-case letters and digits, in words joined by `-`, such as
 * `tokyo-night`, so it is one word to type after `/theme`.
 */
export const ThemeName = Schema.String.check(
  Schema.isPattern(/^(?=.{1,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "must be 1 to 32 lower-case letters and digits, in words joined by -",
  })
).annotate({ identifier: "ThemeName" });

/** The decoded form of {@link ThemeName}. */
export type ThemeName = typeof ThemeName.Type;

/**
 * The names of the themes every Frontend draws without importing them: `system`, which
 * follows the device, and the built-in ones. The web frontend's core holds their palettes,
 * and its tests check it holds exactly these.
 */
export const builtInThemeNames: readonly ThemeName[] = [
  "system",
  "dark",
  "light",
  "solarized-dark",
  "solarized-light",
  "gruvbox-dark",
  "nord",
  "dracula",
  "tokyo-night",
];

/** The words `/theme` reads as what to do rather than a theme's name. */
export const themeCommandWords: readonly ThemeName[] = ["import", "remove"];

/** The names no imported theme may take: the built-in ones, and `/theme`'s own words. */
export const reservedThemeNames: ReadonlySet<string> = new Set([
  ...builtInThemeNames,
  ...themeCommandWords,
]);

/**
 * The name of a theme the Owner imported: a theme's name that is not reserved, so it never
 * hides a built-in one or reads as what `/theme` should do.
 */
export const ImportedThemeName = ThemeName.check(
  Schema.makeFilter(
    (name: string) =>
      !reservedThemeNames.has(name) ||
      "is built in, or a word /theme takes, so no import is named it"
  )
);

/** A theme the Owner imported: its name, and its palette. */
export const Theme = Schema.Struct({ name: ImportedThemeName, palette: Palette });

/** The decoded form of {@link Theme}. */
export type Theme = typeof Theme.Type;

/** How many themes the Owner may import, so the options stay small enough to send whole. */
export const themesCap = 32;

/**
 * The theme a Frontend draws in, by name: `system`, which follows the device's light or
 * dark setting, a built-in one, or one imported. A name is plain text on the wire, so every
 * name journaled before still decodes, and one that names no theme draws as `system`.
 */
const ThemeShown = ThemeName.annotate({
  default: "system",
  description:
    "The theme to draw in: system, which follows the device's setting, a built-in such as dark, light, or nord, or one imported. /theme lists them.",
});

/** The themes the Owner imported, each named once, at most {@link themesCap}. */
export const Themes = Schema.Array(Theme)
  .check(
    Schema.isMaxLength(themesCap),
    Schema.makeFilter(
      (themes: readonly Theme[]) =>
        new Set(themes.map((one) => one.name)).size === themes.length || "names a theme twice"
    )
  )
  .annotate({
    default: [],
    description:
      "The themes imported, by name, for every device: /theme import adds one, and /theme remove takes one away.",
  });

const decodeTheme = Schema.decodeUnknownOption(Theme);

/**
 * The themes kept from a value journaled for `themes` that `Themes` refuses whole, as one
 * from before a name was reserved: each entry that is a theme, the first of each name, up
 * to {@link themesCap}, so one bad entry drops only itself. A value that is no list is none.
 * @param value - The value, as JSON.
 * @returns The themes kept, or none.
 */
const themesKept = (value: Schema.Json): readonly Theme[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const kept: Theme[] = [];
  const names = new Set<string>();

  for (const entry of value) {
    const theme = decodeTheme(entry);

    if (theme._tag === "Some" && !names.has(theme.value.name) && kept.length < themesCap) {
      names.add(theme.value.name);
      kept.push(theme.value);
    }
  }

  return kept;
};

/**
 * How the colours a Message asks for are drawn: `theme` maps mIRC's sixteen onto the
 * theme's palette, and `raw` draws mIRC's own. Either way, text never falls below the
 * contrast a theme keeps against its background.
 */
export const ColoursShown = Schema.Literals(["theme", "raw"]).annotate({
  default: "theme",
  description:
    "How colours a Message asks for are drawn: theme, mapped onto the theme's palette, or raw, as mIRC gives them. Either is kept readable.",
});

/** The decoded form of {@link ColoursShown}. */
export type ColoursShown = typeof ColoursShown.Type;

/** How a line's time shows: hours and minutes, with seconds too, or not at all. */
export const TimeShown = Schema.Literals(["HH:mm", "HH:mm:ss", "none"]).annotate({
  default: "HH:mm",
  description: "How a line's time shows: HH:mm, HH:mm:ss, or none.",
});

/** The decoded form of {@link TimeShown}. */
export type TimeShown = typeof TimeShown.Type;

/**
 * Which Activity a Channel's Timeline shows: all of it, all but joins, parts, and quits
 * (`quiet`), or none. It changes what is drawn, never what is counted.
 */
export const ActivityShown = Schema.Literals(["all", "quiet", "none"]).annotate({
  default: "all",
  description:
    "Which Activity a Channel shows: all, quiet to hide joins, parts, and quits, or none. Unread counts are unchanged.",
});

/** The decoded form of {@link ActivityShown}. */
export type ActivityShown = typeof ActivityShown.Type;

/** The least and the most the text's size may be, in pixels. */
export const textSizeBounds = { maximum: 24, minimum: 10 } as const;

/**
 * The text's size, in pixels: a whole number within {@link textSizeBounds}, so a size too
 * small to read or too big to fit cannot be given.
 */
export const TextSize = Schema.Int.check(Schema.isBetween(textSizeBounds)).annotate({
  default: 14,
  description: `The text's size, in pixels, from ${textSizeBounds.minimum} to ${textSizeBounds.maximum}. A field's text on a touch screen is never under 16.`,
});

/** The decoded form of {@link TextSize}. */
export type TextSize = typeof TextSize.Type;

/**
 * The fonts text can be drawn in: `system`, the device's own monospace font, which needs
 * nothing fetched, or a freely licensed monospace font the Frontend serves itself.
 */
export const fontNames = [
  "system",
  "jetbrains-mono",
  "ibm-plex-mono",
  "source-code-pro",
  "commit-mono",
  "atkinson-hyperlegible-mono",
] as const;

/**
 * The font text is drawn in, by name, one of {@link fontNames}. A glyph it lacks is drawn
 * in the device's own monospace font.
 */
export const FontShown = Schema.Literals(fontNames).annotate({
  default: "system",
  description:
    "The font text is drawn in: system, the device's own monospace font, or jetbrains-mono, ibm-plex-mono, source-code-pro, commit-mono, or atkinson-hyperlegible-mono.",
});

/** The decoded form of {@link FontShown}. */
export type FontShown = typeof FontShown.Type;

/** The options under `ui`, each with its description and what it starts as. */
export const UiOptions = Schema.Struct({
  activity: ActivityShown,
  colours: ColoursShown,
  font: FontShown,
  size: TextSize,
  theme: ThemeShown,
  themes: Themes,
  time: TimeShown,
});

/** The decoded form of {@link UiOptions}. */
export type UiOptions = typeof UiOptions.Type;

/** An option's name under `ui`, such as `time`: one of {@link UiOptions}' fields. */
export const UiOptionName = Schema.Literals(Struct.keys(UiOptions.fields)).annotate({
  description: "An option under ui, such as time.",
  identifier: "UiOptionName",
});

/** The decoded form of {@link UiOptionName}. */
export type UiOptionName = typeof UiOptionName.Type;

/** Every option's name under `ui`, in the Schema's order. */
export const uiOptionNames: readonly UiOptionName[] = UiOptionName.literals;

/** What every option under `ui` starts as, from each field's `default` annotation. */
export const uiDefaults: UiOptions = Schema.decodeUnknownSync(UiOptions)(
  Object.fromEntries(
    uiOptionNames.map((name) => [name, SchemaAST.resolve(UiOptions.fields[name].ast)?.default])
  )
);

/**
 * How far the `ui` options have been changed: the sequence of the last Change, or `0`
 * before any, to send back as `ifSequence` with a change made from it.
 */
export const UiSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The `ui` options in force, every one with a value, and the sequence of the last Change. */
export const UiInForce = Schema.Struct({ options: UiOptions, sequence: UiSequence });

/** The decoded form of {@link UiInForce}. */
export type UiInForce = typeof UiInForce.Type;

/** A `ui` option's value, decoded by its Schema. */
export type UiOptionValue = UiOptions[UiOptionName];

/**
 * A `ui` option's value read from JSON kept before, as a journaled Change or a device's
 * override: by its Schema, or, for `themes`, entry by entry when its Schema refuses the
 * whole, so one bad theme drops only itself. Anything else that its Schema refuses is none.
 * @param option - The option.
 * @param value - Its value, as JSON.
 * @returns The value, or none.
 */
export const uiValueKept = (
  option: UiOptionName,
  value: Schema.Json
): UiOptionValue | undefined => {
  const decoded = Schema.decodeOption(Schema.toCodecJson(UiOptions.fields[option]))(value);

  if (decoded._tag === "Some") {
    return decoded.value;
  }

  return option === "themes" ? themesKept(value) : undefined;
};
