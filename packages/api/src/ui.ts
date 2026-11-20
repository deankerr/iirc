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
import { TimelineId } from "@iirc/timelines";
import { Schema, SchemaAST, Struct } from "effect";

import { NetworkId } from "./network-id.ts";

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
    "The theme to draw in: system, which draws ui.light or ui.dark as the device is light or dark, a built-in such as dark, light, or nord, or one imported. /theme lists them.",
});

/**
 * The theme `system` draws while the device is light or dark, by name: a built-in one or one
 * imported, but never `system` itself, which follows the device and so draws nothing of its
 * own. A name is plain text on the wire, as `theme`'s is, and one that names no theme, as
 * one imported and removed since, draws as the built-in `light` or `dark`.
 * @param scheme - Whether it is drawn while the device is light or dark.
 * @param example - Another built-in theme for that scheme, to name.
 * @returns The option's Schema.
 */
const themeForScheme = (scheme: "light" | "dark", example: ThemeName) =>
  ThemeName.check(
    Schema.makeFilter(
      (name: string) =>
        name !== "system" ||
        "must not be system, which follows the device and draws no theme of its own"
    )
  ).annotate({
    default: scheme,
    description: `The theme drawn while ui.theme is system and the device is ${scheme}: a built-in such as ${scheme} or ${example}, or one imported. /theme -${scheme} sets it.`,
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

/**
 * What a journaled value is kept as when its option's Schema refuses it whole, as one from
 * before a rule was added: each entry that `entry` decodes, the first of each name, up to
 * `cap`, so one bad entry drops only itself. A value that is no list is none.
 * @param entry - The Schema of one entry.
 * @param cap - The most entries the option holds.
 * @returns What it keeps of a value, as JSON.
 */
const keptByName = <A extends { readonly name: string }>(entry: Schema.Decoder<A>, cap: number) => {
  const decode = Schema.decodeUnknownOption(entry);

  return (value: Schema.Json): readonly A[] | undefined => {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const kept: A[] = [];
    const names = new Set<string>();

    for (const each of value) {
      const one = decode(each);

      if (one._tag === "Some" && !names.has(one.value.name) && kept.length < cap) {
        names.add(one.value.name);
        kept.push(one.value);
      }
    }

    return kept;
  };
};

const themesKept = keptByName(Theme, themesCap);

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

/**
 * How a line's time shows: hours and minutes, with seconds too or not, on a 24-hour clock
 * or a 12-hour one, or not at all. The values are CLDR's patterns: `HH` is the hour from
 * 00 to 23, `h` the hour from 1 to 12, and `a` says AM or PM, in the device's language.
 */
export const TimeShown = Schema.Literals([
  "HH:mm",
  "HH:mm:ss",
  "h:mm a",
  "h:mm:ss a",
  "none",
]).annotate({
  default: "HH:mm",
  description:
    "How a line's time shows: HH:mm or HH:mm:ss on a 24-hour clock, h:mm a or h:mm:ss a on a 12-hour one, or none.",
});

/** The decoded form of {@link TimeShown}. */
export type TimeShown = typeof TimeShown.Type;

/**
 * How a day is written where a Timeline's day changes: `full`, `long`, `medium`, or
 * `short`, as the device's language writes a date at that length, or `iso`, as
 * `2026-11-15`. The first four are the `dateStyle`s of `Intl.DateTimeFormat`.
 */
export const DayShown = Schema.Literals(["full", "long", "medium", "short", "iso"]).annotate({
  default: "full",
  description:
    "How a day is written where the day changes: full, long, medium, or short, as the device's language writes a date, or iso, as 2026-11-15.",
});

/** The decoded form of {@link DayShown}. */
export type DayShown = typeof DayShown.Type;

/**
 * Which Activity a Channel's Timeline shows, each value hiding more than the one before:
 * all of it, all but the joins, parts, and quits of Users who did not speak there in the
 * five minutes before (`spoke`), all but joins, parts, and quits (`quiet`), or none. Self's
 * own are always shown under `spoke`. It changes what is drawn, never what is counted.
 */
export const ActivityShown = Schema.Literals(["all", "spoke", "quiet", "none"]).annotate({
  default: "all",
  description:
    "Which Activity a Channel shows: all, spoke to hide the joins, parts, and quits of Users who did not speak there in the five minutes before, quiet to hide all joins, parts, and quits, or none. Unread counts are unchanged.",
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

/** The least and the most a line of text may be tall, as a multiple of the text's size. */
export const leadingBounds = { maximum: 2, minimum: 1 } as const;

/** The step the line height moves in, a hundredth of the text's size. */
const leadingStep = 0.01;

/**
 * The line height: how tall a line of text is, as a multiple of the text's size, within
 * {@link leadingBounds} and a multiple of {@link leadingStep}, so a line too short to read
 * or too tall to fit cannot be given, and every value is exact however it is written.
 */
export const Leading = Schema.Finite.check(
  Schema.isBetween(leadingBounds),
  Schema.isMultipleOf(leadingStep)
).annotate({
  default: 1.45,
  description: `The line height: how tall a line of text is, as a multiple of the text's size, from ${leadingBounds.minimum} to ${leadingBounds.maximum}.`,
});

/** The decoded form of {@link Leading}. */
export type Leading = typeof Leading.Type;

/**
 * The least and the most characters the widest line may hold. Under forty, a line of a
 * Timeline holds too few words to read as one; four hundred is wider than any screen at the
 * smallest text, so no wider bound is a bound at all, and `none` says that instead.
 */
export const widestLineBounds = { maximum: 400, minimum: 40 } as const;

/**
 * The widest line: how many characters what was said in a Timeline runs before it wraps,
 * a whole number within {@link widestLineBounds}, or `none`, so it runs the width of its
 * Pane. A character is the font's own `0` at the text's size, so a bound holds as many
 * words at any size and in any font.
 */
export const WidestLine = Schema.Union([
  Schema.Literal("none"),
  Schema.Int.check(Schema.isBetween(widestLineBounds)),
]).annotate({
  default: "none",
  description: `The widest a line of a Timeline's text runs, in characters, from ${widestLineBounds.minimum} to ${widestLineBounds.maximum}, or none to run the width of its Pane. A character is as wide as the font's 0, so the bound grows with the text's size.`,
});

/** The decoded form of {@link WidestLine}. */
export type WidestLine = typeof WidestLine.Type;

/**
 * The fonts text can be drawn in. Two are the device's own, which need nothing fetched:
 * `system`, its monospace font, and `system-sans`, its sans font. The rest are freely
 * licensed fonts the Frontend serves itself: five monospace, then four sans.
 */
export const fontNames = [
  "system",
  "jetbrains-mono",
  "ibm-plex-mono",
  "source-code-pro",
  "commit-mono",
  "atkinson-hyperlegible-mono",
  "system-sans",
  "ibm-plex-sans",
  "atkinson-hyperlegible-next",
  "source-sans-3",
  "inter",
] as const;

/** A font named in {@link fontNames}: one of those the Frontend draws without being told. */
export type FontName = (typeof fontNames)[number];

const fontNamesFolded: ReadonlySet<string> = new Set(fontNames);

/**
 * Text with its ASCII capitals made small, as a font's name is matched.
 * @param text - The text.
 * @returns The text, folded.
 */
const folded = (text: string) => text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** The most UTF-16 code units a family's name may take. */
export const fontFamilyMaxLength = 64;

/**
 * The name of a font family the device has, such as `Fira Code`, as the Owner wrote it:
 * trimmed, 1 to {@link fontFamilyMaxLength} long, with no control character, lone surrogate,
 * `"`, or `\`, so set between double quotes it is always exactly one CSS family and nothing
 * else. It is never a name of {@link fontNames} in any case, so each font has one value.
 */
export const FontFamily = Schema.String.check(
  Schema.isTrimmed({ message: "must not start or end with a space" }),
  Schema.isMinLength(1),
  Schema.isMaxLength(fontFamilyMaxLength),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}"\\]*$/u, {
    message: 'must hold no control character, ", or \\',
  }),
  Schema.makeFilter(
    (name: string) =>
      !fontNamesFolded.has(folded(name)) || "is a font's name, which names that font instead"
  )
)
  .pipe(Schema.brand("FontFamily"))
  .annotate({ identifier: "FontFamily" });

/** The decoded form of {@link FontFamily}. */
export type FontFamily = typeof FontFamily.Type;

/**
 * The font text is drawn in: one of {@link fontNames}, by name, or a family the device has,
 * by its own name. A glyph it lacks is drawn in the device's own font of the same kind,
 * monospace or sans, and a family the device lacks in the device's own monospace font, as
 * `system`. A name stored as `system` before sans fonts were offered still means the
 * device's own monospace font. Either is plain text on the wire, told apart by
 * {@link fontNames}.
 */
export const FontShown = Schema.Union([Schema.Literals(fontNames), FontFamily]).annotate({
  default: "system",
  description:
    "The font text is drawn in. Monospace: system, the device's own, or jetbrains-mono, ibm-plex-mono, source-code-pro, commit-mono, or atkinson-hyperlegible-mono. Sans: system-sans, the device's own, or ibm-plex-sans, atkinson-hyperlegible-next, source-sans-3, or inter. Or any family the device has, by its name, such as Fira Code, up to 64 characters with no \", \\, or control character. A glyph a font lacks is drawn in the device's own font of the same kind, and a family the device lacks in its own monospace font.",
});

/** The decoded form of {@link FontShown}. */
export type FontShown = typeof FontShown.Type;

/**
 * Whether a font is one of {@link fontNames}, rather than a family the device has.
 * @param font - The font.
 * @returns Whether it is named.
 */
export const isFontName = (font: FontShown): font is FontName => fontNamesFolded.has(font);

/**
 * What Enter does in the Composer: `send` sends what is written, and Shift+Enter begins a
 * new line; `newline` begins a new line, and Mod+Enter, Ctrl+Enter or ⌘Enter on a Mac,
 * sends, as a phone's keyboard or a habit of writing several lines may want.
 */
export const EnterKey = Schema.Literals(["send", "newline"]).annotate({
  default: "send",
  description:
    "What Enter does in the Composer: send, with Shift+Enter for a new line, or newline, with Ctrl+Enter, or ⌘Enter on a Mac, to send.",
});

/** The decoded form of {@link EnterKey}. */
export type EnterKey = typeof EnterKey.Type;

/** Whether the Composer checks spelling, as the device's own checker does. */
export const SpellcheckShown = Schema.Boolean.annotate({
  default: true,
  description: "Whether the Composer checks spelling, with the device's own checker.",
});

/** The most UTF-16 code units the text after a completed nick may take. */
export const nickSuffixMaxLength = 8;

/**
 * The text after a nick completed at the start of a line, as IRC clients address someone:
 * at most {@link nickSuffixMaxLength} long, empty for none, with no control character or
 * lone surrogate, so it never puts a line break or IRC formatting into the Composer. It is
 * kept exactly as given, a trailing space included.
 */
export const NickSuffix = Schema.String.check(
  Schema.isMaxLength(nickSuffixMaxLength, {
    message: `must be at most ${nickSuffixMaxLength} characters`,
  }),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}]*$/u, { message: "must hold no control character" })
).annotate({
  default: ": ",
  description: `The text after a nick Tab completes at the start of a line, up to ${nickSuffixMaxLength} characters, kept exactly, a trailing space included, or nothing. A nick completed anywhere else is followed by a space.`,
});

/** The decoded form of {@link NickSuffix}. */
export type NickSuffix = typeof NickSuffix.Type;

/**
 * When a Timeline is marked read: `shown`, up to the last item that has been on screen in a
 * visible, focused page, even with its Pane scrolled up from the latest; `latest`, once a
 * Pane shows it at its latest and follows it; or `asked`, only when the Owner asks, as
 * `/read` does.
 */
export const ReadRule = Schema.Literals(["shown", "latest", "asked"]).annotate({
  default: "latest",
  description:
    "When a Timeline is marked read: shown, up to the last line on screen, even scrolled up; latest, once a Pane is at its latest; or asked, only by /read.",
});

/** The decoded form of {@link ReadRule}. */
export type ReadRule = typeof ReadRule.Type;

/**
 * The annotation of an option under `ui` that no device may override for itself, as one
 * the Daemon acts on is, or one that is the Owner's single arrangement, as the Sidebar's
 * order is: every device shares it, and a device's override of it is ignored.
 */
export const sharedOnly = { sharedOnly: true } as const;

/**
 * Whether the Daemon previews the links in Messages: `off`; `links only`, a page's title,
 * description, and site, with no image or media fetched; or `on`, which adds a page's
 * image, or a link's own image, kept in the store when a bucket is set. The Daemon
 * fetches each link itself, never the browser, so it is shared only: no device turns
 * fetching on for itself.
 */
export const PreviewsShown = Schema.Literals(["off", "links only", "on"]).annotate({
  ...sharedOnly,
  default: "off",
  description:
    "Whether the Daemon previews links in Messages, fetching them itself, never the browser: off, links only for a page's title, description, and site, or on, which adds images, kept in the store when a bucket is set. Every device shares it.",
});

/** The decoded form of {@link PreviewsShown}. */
export type PreviewsShown = typeof PreviewsShown.Type;

/**
 * Whether an animated image in a Preview plays on its own, which it otherwise does only
 * once pressed. It is a device's own to choose, since a device draws it, and one set to
 * reduce motion keeps animated images still whatever this says.
 */
export const PreviewsAnimate = Schema.Boolean.annotate({
  default: false,
  description:
    "Whether an animated image in a Preview plays on its own: off, it shows its first frame until pressed. A device set to reduce motion keeps them still either way.",
});

/** The decoded form of {@link PreviewsAnimate}. */
export type PreviewsAnimate = typeof PreviewsAnimate.Type;

/**
 * How rich a page's Preview looks: `line`, its site and title alone; `thumbnail`, its text
 * with its image small on the right; or `card`, its text with its image below. A link that
 * is itself an image or a video, a poster, and a player are drawn whole in every style. It
 * is a device's own to choose, since a device draws it.
 */
export const PreviewsStyle = Schema.Literals(["line", "thumbnail", "card"]).annotate({
  default: "thumbnail",
  description:
    "How a page's Preview looks: line, its site and title alone; thumbnail, with its image small on the right; or card, with its description and its image below. Images, videos and players show in every style.",
});

/** The decoded form of {@link PreviewsStyle}. */
export type PreviewsStyle = typeof PreviewsStyle.Type;

/**
 * Whether a Message's Previews start folded: `open`, each drawn whole; `summary`, each with
 * more to show folded to its one line until pressed; or `chip`, all of them one `[+n]`,
 * which a press opens. A device chooses its own.
 */
export const PreviewsFolded = Schema.Literals(["open", "summary", "chip"]).annotate({
  default: "summary",
  description:
    "Whether Previews start folded: open, drawn whole; summary, each folded to its site and title until pressed; or chip, a Message's Previews as one [+n] until pressed.",
});

/** The decoded form of {@link PreviewsFolded}. */
export type PreviewsFolded = typeof PreviewsFolded.Type;

/**
 * How tall a Preview's image, video, poster, or player is drawn at most: `small`, 160
 * pixels; `medium`, 260; or `large`, 400. A device chooses its own.
 */
export const PreviewsMediaHeight = Schema.Literals(["small", "medium", "large"]).annotate({
  default: "medium",
  description:
    "How tall a Preview's image, video or player is at most: small, 160 pixels; medium, 260; or large, 400.",
});

/** The decoded form of {@link PreviewsMediaHeight}. */
export type PreviewsMediaHeight = typeof PreviewsMediaHeight.Type;

/**
 * Each Timeline's own choice of whether the Daemon previews its links, by its id, over
 * `ui.previews`: `off`, `links only`, or `on`. A Timeline it does not name follows
 * `ui.previews`, and an entry for a Timeline that no longer exists does nothing. A Direct
 * Message's Timeline named here as `links only` or `on` is fetched without waiting for a
 * press. It is set whole, like any option, and shared only, as `ui.previews` is.
 */
export const PreviewsByTimeline = Schema.Record(
  TimelineId,
  Schema.Literals(["off", "links only", "on"])
).annotate({
  ...sharedOnly,
  default: {},
  description:
    "Each Timeline's own choice over ui.previews, by its id: off, links only, or on. A Timeline it does not name follows ui.previews, and a Direct Message named links only or on is previewed without a press. /previews off|links|on|default sets the focused Timeline's. Every device shares it.",
});

/** The decoded form of {@link PreviewsByTimeline}. */
export type PreviewsByTimeline = typeof PreviewsByTimeline.Type;

/**
 * A host a player may play from: a DNS name of two labels or more, in lower case, with no
 * port, as the URL parser writes a link's host. A player's address matches it only when its
 * host is exactly this, so no other host under it, and no name that contains it, plays.
 */
export const PlayerHost = Schema.String.check(
  Schema.isPattern(
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u,
    { message: "must be a host name in lower case, such as player.vimeo.com, with no port" }
  )
).annotate({ identifier: "PlayerHost" });

/** The decoded form of {@link PlayerHost}. */
export type PlayerHost = typeof PlayerHost.Type;

/**
 * The hosts a link's player may play from, each matched exactly. A page whose `og:video` or
 * `twitter:player` names a host not listed is a page Preview, with its image. A YouTube
 * player is always read as `www.youtube-nocookie.com`, whatever YouTube host it names. The
 * defaults are the hosts YouTube, Vimeo, SoundCloud, Bandcamp, Spotify and Twitch name in
 * their tags. It decides which third parties a page may load, so it is shared only: no
 * device adds a host for itself.
 */
export const PreviewsPlayers = Schema.Array(PlayerHost).annotate({
  ...sharedOnly,
  default: [
    "www.youtube-nocookie.com",
    "player.vimeo.com",
    "w.soundcloud.com",
    "bandcamp.com",
    "open.spotify.com",
    "player.twitch.tv",
  ],
  description:
    "The hosts a link's player may play from, each matched exactly, so a player from any other host shows as a page. YouTube's players always play from www.youtube-nocookie.com. Every device shares it. A change applies to the web frontend on its next load.",
});

/** The decoded form of {@link PreviewsPlayers}. */
export type PreviewsPlayers = typeof PreviewsPlayers.Type;

/**
 * How a line of a Timeline is laid out: `columns`, the time and the nick each in a column
 * of their own; `inline`, the time, the nick, then what was said as one run of text that
 * wraps under itself, as a Pane too narrow for the columns draws it; or `stacked`, a run of
 * Messages from one User under one line with the nick and the time, each Message's text on
 * a line of its own below, and everything else as `inline` draws it.
 */
export const LineLayout = Schema.Literals(["columns", "inline", "stacked"]).annotate({
  default: "columns",
  description:
    "How a line is laid out: columns, with the time and the nick each in a column; inline, the time, the nick, then what was said as one run of text that wraps under itself; or stacked, the nick and the time on a line above a run of Messages from one User, each on its own line. A Pane too narrow for columns draws columns as inline, and inline and stacked as they are.",
});

/** The decoded form of {@link LineLayout}. */
export type LineLayout = typeof LineLayout.Type;

/**
 * Refuses a list that names an id twice, so a place in the Sidebar is given once.
 * @param ids - The ids.
 * @returns Whether each is named once, or the reason it is refused.
 */
const namesEachOnce = (ids: readonly string[]) =>
  new Set(ids).size === ids.length || "names an id twice";

/**
 * The Networks in the Owner's order in the Sidebar, by id. A Network it does not name keeps
 * the place the fixed order gives it, and an id of a Network that has gone does nothing.
 * Each is named once.
 */
export const SidebarNetworks = Schema.Array(NetworkId)
  .check(Schema.makeFilter(namesEachOnce))
  .annotate({
    ...sharedOnly,
    default: [],
    description:
      "The Networks in the Owner's order in the Sidebar, by id. A Network not named keeps the place the fixed order gives it, and an id of one that has gone does nothing. Moving a Network in the Sidebar sets it. Every device shares it.",
  });

/** The decoded form of {@link SidebarNetworks}. */
export type SidebarNetworks = typeof SidebarNetworks.Type;

/**
 * The Timelines in the Owner's order in the Sidebar, by id, of which only the order among
 * one Network's Timelines matters. A Timeline it does not name takes the place the fixed
 * order gives it, and an id of one that has gone does nothing. Each is named once.
 */
export const SidebarOrder = Schema.Array(TimelineId)
  .check(Schema.makeFilter(namesEachOnce))
  .annotate({
    ...sharedOnly,
    default: [],
    description:
      "The Timelines in the Owner's order in the Sidebar, by id; only the order among one Network's Timelines matters. A Timeline not named takes the place the fixed order gives it, and an id of one that has gone does nothing. Moving a Timeline in the Sidebar sets it. Every device shares it.",
  });

/** The decoded form of {@link SidebarOrder}. */
export type SidebarOrder = typeof SidebarOrder.Type;

/**
 * The Timelines pinned above the Networks in the Sidebar, by id, in order. An id of a
 * Timeline that has gone, or that the Sidebar does not list, shows nothing. Each is named
 * once.
 */
export const SidebarPinned = Schema.Array(TimelineId)
  .check(Schema.makeFilter(namesEachOnce))
  .annotate({
    ...sharedOnly,
    default: [],
    description:
      "The Timelines pinned above the Networks in the Sidebar, by id, in order. An id of a Timeline that has gone does nothing. /pin pins or unpins the focused Timeline. Every device shares it.",
  });

/** The decoded form of {@link SidebarPinned}. */
export type SidebarPinned = typeof SidebarPinned.Type;

/**
 * Whether what bots say is left out of unread counts and notifications, as the Daemon's
 * `botDirect` and `botMessages` count it. A Highlight from a bot still counts and notifies.
 */
export const QuietBots = Schema.Boolean.annotate({
  default: false,
  description:
    "Whether what bots say is left out of unread counts and notifications. A Highlight from a bot still counts and notifies.",
});

/** How many Timelines the Owner may mute, so the options stay small enough to send whole. */
export const mutedCap = 256;

/**
 * The Timelines the Owner muted, by id, each named once, at most {@link mutedCap}. A
 * muted Timeline counts nothing and notifies of nothing but a Highlight. Every device
 * shares it, since a Timeline the Owner silenced on one is silent on all.
 */
export const TimelinesMuted = Schema.Array(TimelineId)
  .check(Schema.isMaxLength(mutedCap), Schema.makeFilter(namesEachOnce))
  .annotate({
    ...sharedOnly,
    default: [],
    description:
      "The Timelines muted, by id, which show no unread count and notify of nothing but a Highlight. An id of a Timeline that has gone does nothing. /mute and /unmute set the focused Timeline's. Every device shares it.",
  });

/** The decoded form of {@link TimelinesMuted}. */
export type TimelinesMuted = typeof TimelinesMuted.Type;

/**
 * An alias's name: 1 to 32 lower-case letters and digits, in words joined by `-`, such as
 * `j` or `join-quiet`, so it is one word to type after `/`. It knows nothing of commands,
 * which a Frontend's own names are for it to keep.
 */
export const AliasName = Schema.String.check(
  Schema.isPattern(/^(?=.{1,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "must be 1 to 32 lower-case letters and digits, in words joined by -",
  })
).annotate({ identifier: "AliasName" });

/** The decoded form of {@link AliasName}. */
export type AliasName = typeof AliasName.Type;

/** The most UTF-16 code units the line an alias stands for may take. */
export const aliasLineMaxLength = 512;

/**
 * The command line an alias stands for: one line, trimmed, at most {@link aliasLineMaxLength}
 * long, that starts with `/` and a command's name, so it is never `//`, which says text, and
 * holds no control character or lone surrogate. It may name `$1` to `$9` for the words typed
 * after the alias, and `$*` for all of them.
 */
export const AliasLine = Schema.String.check(
  Schema.isTrimmed({ message: "must not start or end with a space" }),
  Schema.isMaxLength(aliasLineMaxLength, {
    message: `must be at most ${aliasLineMaxLength} characters`,
  }),
  // The command's name is written out, never a placeholder, and ends at an ASCII space, as
  // a command line is split, so the command an alias runs is fixed when it is made.
  Schema.isPattern(/^\/[A-Za-z0-9-]+(?: |$)/u, {
    message:
      "must be a command line: / and a command's name, of letters, digits, and -, then a space and its arguments",
  }),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}]*$/u, {
    message: "must be one line with no control character",
  })
).annotate({ identifier: "AliasLine" });

/** The decoded form of {@link AliasLine}. */
export type AliasLine = typeof AliasLine.Type;

/** An alias the Owner made: its name, and the command line it stands for. */
export const Alias = Schema.Struct({ line: AliasLine, name: AliasName }).annotate({
  identifier: "Alias",
});

/** The decoded form of {@link Alias}. */
export type Alias = typeof Alias.Type;

/** How many aliases the Owner may make, so the options stay small enough to send whole. */
export const aliasesCap = 64;

/**
 * The aliases the Owner made, each named once, at most {@link aliasesCap}. Every device
 * shares them, since a command the Owner made on one is the Owner's on all.
 */
export const Aliases = Schema.Array(Alias)
  .check(
    Schema.isMaxLength(aliasesCap),
    Schema.makeFilter(
      (aliases: readonly Alias[]) =>
        new Set(aliases.map((one) => one.name)).size === aliases.length || "names an alias twice"
    )
  )
  .annotate({
    ...sharedOnly,
    default: [],
    description:
      "The aliases made, by name, for every device: each a command line run as /name, which may name $1 to $9 for the words typed after it, and $* for all of them. /alias lists them, /alias add adds or replaces one, and /alias remove takes one away.",
  });

/** The decoded form of {@link Aliases}. */
export type Aliases = typeof Aliases.Type;

const aliasesKept = keptByName(Alias, aliasesCap);

/** The options under `ui`, each with its description and what it starts as. */
export const UiOptions = Schema.Struct({
  activity: ActivityShown,
  aliases: Aliases,
  colours: ColoursShown,
  dark: themeForScheme("dark", "solarized-dark"),
  day: DayShown,
  enter: EnterKey,
  font: FontShown,
  leading: Leading,
  light: themeForScheme("light", "solarized-light"),
  line: LineLayout,
  muted: TimelinesMuted,
  previews: PreviewsShown,
  "previews.animate": PreviewsAnimate,
  "previews.folded": PreviewsFolded,
  "previews.mediaHeight": PreviewsMediaHeight,
  "previews.players": PreviewsPlayers,
  "previews.style": PreviewsStyle,
  "previews.timelines": PreviewsByTimeline,
  quietBots: QuietBots,
  read: ReadRule,
  "sidebar.networks": SidebarNetworks,
  "sidebar.order": SidebarOrder,
  "sidebar.pinned": SidebarPinned,
  size: TextSize,
  spellcheck: SpellcheckShown,
  suffix: NickSuffix,
  theme: ThemeShown,
  themes: Themes,
  time: TimeShown,
  width: WidestLine,
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
 * The options under `ui` no device overrides for itself, from each field's
 * {@link sharedOnly} annotation.
 */
export const uiSharedOnly: ReadonlySet<UiOptionName> = new Set(
  uiOptionNames.filter((name) => SchemaAST.resolve(UiOptions.fields[name].ast)?.sharedOnly === true)
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

  if (option === "themes") {
    return themesKept(value);
  }

  return option === "aliases" ? aliasesKept(value) : undefined;
};
