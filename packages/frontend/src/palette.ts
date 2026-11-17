/**
 * The command palette, as data: what it lists for a query, ranked, and what choosing an
 * entry asks for. It lists the commands the registry can run here, every Timeline, every
 * Network to remove, every theme, every font, and the options, or the themes alone, as
 * `/theme` opens it, and adds no action of its own: choosing gives the same intents the
 * composer's `/commands` do. A query of `font` and a family's name offers that family too.
 * Which entries were chosen recently is remembered, at most `recentCap`.
 *
 * @packageDocumentation
 */
import type { NetworkId, TimelineId } from "@iirc/api";
import { FontFamily, FontShown, fontNames, isFontName } from "@iirc/api/ui";
import { Option as Maybe, Schema } from "effect";

import { commands, commandWithId, interpret, namedIn, runIn, unmet } from "./commands.ts";
import type { Command, CommandContext, Intent, NamedTimeline } from "./commands.ts";
import { chordsFor } from "./keymap.ts";
import type { Chord, Keymap } from "./keymap.ts";
import type { Option } from "./options.ts";
import { byScore, lower, ranked } from "./ranking.ts";
import type { Matched } from "./ranking.ts";
import { systemTheme } from "./theme.ts";
import type { ListedTheme, ThemeOption } from "./theme.ts";
import type { SidebarNetwork } from "./timelines.ts";
import { writtenOnDevice } from "./ui.ts";

/** How many entries chosen recently the palette remembers. */
export const recentCap = 20;

/** One entry the palette lists, keyed so it can be remembered. */
export type Entry =
  | {
      readonly _tag: "Command";
      readonly key: string;
      readonly id: string;
      readonly name: string;
      readonly usage: string;
      readonly description: string;
      /** The chords bound to it, to show beside it. */
      readonly chords: readonly Chord[];
    }
  | {
      readonly _tag: "Timeline";
      readonly key: string;
      readonly timeline: TimelineId;
      readonly network: NetworkId;
      readonly kind: "Network" | "Channel" | "Direct";
      readonly name: string;
    }
  | {
      /**
       * Removing a Network, as `/network remove <id>` asks, or, removed with its Timelines
       * kept, dropping them.
       */
      readonly _tag: "Network";
      readonly key: string;
      readonly network: NetworkId;
      /** Its Timelines are kept from its removal, so choosing it drops them. */
      readonly removed: boolean;
      readonly name: string;
    }
  | {
      readonly _tag: "Option";
      readonly key: string;
      readonly name: string;
      readonly description: string;
      readonly credential: boolean;
    }
  | {
      readonly _tag: "Theme";
      readonly key: string;
      readonly name: string;
      readonly builtIn: boolean;
      /** The option choosing it sets. */
      readonly option: ThemeOption;
      /** Whether it is the one that option names on this device. */
      readonly current: boolean;
    }
  | {
      readonly _tag: "Font";
      readonly key: string;
      readonly name: FontShown;
      /** Whether it is the one in effect on this device. */
      readonly current: boolean;
    };

/** A section of the palette, with its entries in order. */
export interface Section {
  readonly title: "Recent" | "Commands" | "Timelines" | "Networks" | "Themes" | "Fonts" | "Options";
  readonly entries: readonly Entry[];
}

/** What the palette lists from. */
export interface Listing {
  readonly context: CommandContext;
  readonly sidebar: readonly SidebarNetwork[];
  readonly options: readonly Option[];
  readonly keymap: Keymap;
  /** Every theme, and the one each option that names a theme names on this device. */
  readonly themes: readonly ListedTheme[];
  readonly chosen: Readonly<Record<ThemeOption, string>>;
  /** The font in effect on this device. */
  readonly font: FontShown;
}

/**
 * What the palette lists: everything, or the themes alone, as `/theme` opens it, to set the
 * option it says. Everything sets `theme`.
 */
export type Scope =
  | { readonly _tag: "All" }
  | { readonly _tag: "Themes"; readonly option: ThemeOption };

/** The palette listing everything. */
export const allScope: Scope = { _tag: "All" };

/**
 * Whether the palette is open, what it lists, its query, and the keys of entries chosen,
 * newest first.
 */
export interface Palette {
  readonly open: boolean;
  readonly scope: Scope;
  readonly query: string;
  readonly recent: readonly string[];
}

/**
 * What happened to the palette.
 *
 * - `Opened`: it opens with an empty query, listing what `scope` says.
 * - `Closed`: it closes, as Escape does, choosing nothing.
 * - `Queried`: the Owner typed.
 * - `Chosen`: the Owner chose the entry with this key, which is remembered, and it closes.
 * - `Ran`: the composer sent a draft that ran the commands with these keys, in order, which
 *   are remembered as chosen, the last the newest.
 */
export type PaletteEvent =
  | { readonly _tag: "Opened"; readonly scope: Scope }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Queried"; readonly query: string }
  | { readonly _tag: "Chosen"; readonly key: string }
  | { readonly _tag: "Ran"; readonly keys: readonly string[] };

/** The palette closed, with nothing chosen yet. */
export const initialPalette: Palette = { open: false, query: "", recent: [], scope: allScope };

/**
 * Remembers a key as the newest chosen, once, keeping at most `recentCap`.
 * @param recent - The keys, newest first.
 * @param key - The key chosen.
 * @returns The keys after.
 */
export const remember = (recent: readonly string[], key: string): readonly string[] =>
  [key, ...recent.filter((one) => one !== key)].slice(0, recentCap);

/**
 * The palette after an event.
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after.
 */
export const reducePalette = (state: Palette, event: PaletteEvent): Palette => {
  switch (event._tag) {
    case "Opened": {
      return { ...state, open: true, query: "", scope: event.scope };
    }

    case "Closed": {
      return { ...state, open: false };
    }

    case "Queried": {
      return { ...state, query: event.query };
    }

    case "Chosen": {
      return { ...state, open: false, recent: remember(state.recent, event.key) };
    }

    case "Ran": {
      let { recent } = state;

      for (const key of event.keys) {
        recent = remember(recent, key);
      }

      return { ...state, recent };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * What a theme is, in a few words, which a query matches too, so `theme` finds them all.
 * @param theme - The theme, and whether it is built in.
 * @returns The words.
 */
export const themeDescription = (theme: { readonly builtIn: boolean }) =>
  theme.builtIn ? "built-in theme" : "imported theme";

/**
 * What a font is, in a few words, which a query matches too, so `font` finds them all.
 * @param font - The font.
 * @returns The words.
 */
export const fontDescription = (font: FontShown) => {
  if (!isFontName(font)) {
    return "font: a family on this device";
  }

  switch (font) {
    case "system": {
      return "font: the device's own monospace font";
    }

    case "system-sans": {
      return "font: the device's own sans font";
    }

    case "ibm-plex-sans":
    case "atkinson-hyperlegible-next":
    case "source-sans-3":
    case "inter": {
      return "font: sans";
    }

    case "jetbrains-mono":
    case "ibm-plex-mono":
    case "source-code-pro":
    case "commit-mono":
    case "atkinson-hyperlegible-mono": {
      return "font: monospace";
    }

    default: {
      return font satisfies never;
    }
  }
};

/**
 * What choosing a Network's entry does, in a few words, which a query matches too.
 * @param entry - The Network's entry.
 * @returns The words.
 */
export const networkDescription = (entry: { readonly removed: boolean }) =>
  entry.removed
    ? "network: drop the Timelines kept since it was removed, which frees its name"
    : "network: remove it, asking first whether its Timelines stay readable";

/**
 * What an entry is matched by: its names, best first, and its description.
 * @param entry - The entry.
 * @returns Its names and description.
 */
export const matchedBy = (entry: Entry): Matched => {
  switch (entry._tag) {
    case "Command": {
      const command = commandWithId(entry.id);

      return {
        description: entry.description,
        names: [entry.name, ...(command?.aliases ?? [])],
      };
    }

    case "Timeline": {
      return { description: "", names: [entry.name, `${entry.network} ${entry.name}`] };
    }

    case "Network": {
      return { description: networkDescription(entry), names: [entry.name] };
    }

    case "Option": {
      return { description: entry.description, names: [entry.name] };
    }

    case "Theme": {
      return { description: themeDescription(entry), names: [entry.name] };
    }

    case "Font": {
      return {
        description: fontDescription(entry.name),
        names: isFontName(entry.name) ? [entry.name] : [`font ${entry.name}`, entry.name],
      };
    }

    default: {
      return entry satisfies never;
    }
  }
};

const decodeFamily = Schema.decodeUnknownOption(FontFamily);

/**
 * The family text names, or none when it names none, or names a font listed already.
 * @param text - The text, trimmed, each run of spaces one.
 * @returns The family.
 */
export const familyNamed = (text: string): FontFamily | undefined =>
  Maybe.getOrUndefined(decodeFamily(text));

/**
 * The family a query names after the word `font`, as in `font Fira Code`, or none when it
 * names none, or names a font the palette lists already.
 * @param query - The query, trimmed, without a leading `/`, each run of spaces one.
 * @returns The family.
 */
const familyQueried = (query: string): FontFamily | undefined => {
  const named = /^font (?<family>.+)$/iu.exec(query)?.groups?.family;

  return named === undefined ? undefined : familyNamed(named);
};

/** What the key of a font's entry in the palette starts with. */
const fontKeyPrefix = "font:";

const decodeFont = Schema.decodeUnknownOption(FontShown);

/**
 * The font an entry's key names, as the page previews it while the entry is highlighted.
 * @param key - The entry's key.
 * @returns The font, or none when the key names none.
 */
export const fontOfKey = (key: string): FontShown | undefined =>
  key.startsWith(fontKeyPrefix)
    ? Maybe.getOrUndefined(decodeFont(key.slice(fontKeyPrefix.length)))
    : undefined;

/**
 * The key a command's entry is remembered by, once chosen or run.
 * @param id - The command's id.
 * @returns The key.
 */
export const commandKey = (id: string) => `command:${id}`;

/**
 * A command's entry.
 * @param command - The command.
 * @param keymap - The keymap, for the chords bound to it.
 * @returns The entry.
 */
export const commandEntry = (command: Command, keymap: Keymap): Entry => ({
  _tag: "Command",
  chords: chordsFor(keymap, command.id),
  description: command.description,
  id: command.id,
  key: commandKey(command.id),
  name: command.name,
  usage: command.usage,
});

/**
 * A Timeline's entry.
 * @param timeline - The Timeline, by name.
 * @returns The entry.
 */
export const timelineEntry = (timeline: NamedTimeline): Entry => ({
  _tag: "Timeline",
  key: `timeline:${timeline.timeline}`,
  kind: timeline.kind,
  name: timeline.name,
  network: timeline.network,
  timeline: timeline.timeline,
});

/**
 * A Network's entry, to remove it, or, removed with its Timelines kept, to drop them.
 * @param network - The Network, and whether it was removed with its Timelines kept.
 * @returns The entry.
 */
export const networkEntry = (network: {
  readonly network: NetworkId;
  readonly removed: boolean;
}): Entry => ({
  _tag: "Network",
  key: `network:${network.network}`,
  name: `${network.removed ? "drop" : "remove"} ${network.network}`,
  network: network.network,
  removed: network.removed,
});

/**
 * The entries of the themes to set an option to: every theme, but `system` only as
 * `theme`, since it follows the device.
 * @param themes - Every theme.
 * @param chosen - The one each option names on this device.
 * @param option - The option choosing one sets.
 * @returns The entries, in the themes' order.
 */
export const themeEntries = (
  themes: readonly ListedTheme[],
  chosen: Readonly<Record<ThemeOption, string>>,
  option: ThemeOption
): readonly Entry[] =>
  themes.flatMap((theme): readonly Entry[] =>
    option === "theme" || theme.name !== systemTheme
      ? [
          {
            _tag: "Theme",
            builtIn: theme.builtIn,
            current: theme.name === chosen[option],
            key: `theme:${theme.name}`,
            name: theme.name,
            option,
          },
        ]
      : []
  );

/**
 * A font's entry.
 * @param font - The font.
 * @param current - The font in effect on this device.
 * @returns The entry.
 */
const fontEntry = (font: FontShown, current: FontShown): Entry => ({
  _tag: "Font",
  current: font === current,
  key: `${fontKeyPrefix}${font}`,
  name: font,
});

/**
 * The entries of every font, and a family named, if any.
 * @param family - The family named, if any.
 * @param current - The font in effect on this device.
 * @returns The entries, the bundled fonts first.
 */
export const fontEntries = (family: FontFamily | undefined, current: FontShown): readonly Entry[] =>
  [...fontNames, ...(family === undefined ? [] : [family])].map((font) => fontEntry(font, current));

/**
 * Every entry the palette can list here, by section, in their own orders: the commands
 * whose conditions hold, but for opening the palette itself; every Timeline, in the
 * sidebar's order, then those closed, which the sidebar leaves out; every Network, to
 * remove it; every theme, to set the option given, but `system` only as `theme`, since it
 * follows the device; every font, and the family the query names, if any; and every option
 * read.
 * @param listing - What the palette lists from.
 * @param family - The family the query names, if any.
 * @param option - The option choosing a theme sets.
 * @returns The sections, each with every entry.
 */
const everything = (
  listing: Listing,
  family: FontFamily | undefined,
  option: ThemeOption
): readonly Section[] => [
  {
    entries: commands
      .filter((one) => one.id !== "palette.open" && unmet(one.when, listing.context) === undefined)
      .map((one) => commandEntry(one, listing.keymap)),
    title: "Commands",
  },
  { entries: namedIn(listing.sidebar).map(timelineEntry), title: "Timelines" },
  { entries: listing.sidebar.map(networkEntry), title: "Networks" },
  { entries: themeEntries(listing.themes, listing.chosen, option), title: "Themes" },
  { entries: fontEntries(family, listing.font), title: "Fonts" },
  {
    entries: listing.options.map((one): Entry => ({
      _tag: "Option",
      credential: one.kind._tag === "Credential",
      description: one.description,
      key: `option:${one.name}`,
      name: one.name,
    })),
    title: "Options",
  },
];

/**
 * What the palette lists for a query. With none, the entries chosen recently come first,
 * newest first, and then each section in its own order. With one, only entries that match,
 * each section ranked best first, and the sections by their best entry. A leading `/` is
 * ignored, so `/set` finds `set`, and a run of spaces is one. Scoped to the themes, it lists
 * only them, to set the option it says, with nothing recent. A query of `font` and a
 * family's name, such as `font Fira Code`, offers that family among the fonts.
 * @param listing - What the palette lists from.
 * @param query - What the Owner typed.
 * @param recent - The keys of entries chosen recently, newest first.
 * @param scope - What it lists.
 * @returns The sections, none empty.
 */
export const sections = (
  listing: Listing,
  query: string,
  recent: readonly string[],
  scope: Scope = allScope
): readonly Section[] => {
  // Spaces between words count as one, so `font  Fira Code` names the family `Fira Code`.
  const asked = query.trim().replace(/^\//u, "").replaceAll(/\s+/gu, " ");

  const all = everything(
    listing,
    familyQueried(asked),
    scope._tag === "All" ? "theme" : scope.option
  ).filter((section) => scope._tag === "All" || section.title === "Themes");

  const wanted = lower(asked);

  if (wanted === "") {
    const byKey = new Map(
      all.flatMap((section) => section.entries.map((one) => [one.key, one] as const))
    );

    // A family is listed only while a query names it, so one chosen recently is made again
    // from its key.
    const recentEntry = (key: string): Entry | undefined => {
      const font = fontOfKey(key);

      return byKey.get(key) ?? (font === undefined ? undefined : fontEntry(font, listing.font));
    };

    const recently = scope._tag === "All" ? recent.flatMap((key) => recentEntry(key) ?? []) : [];
    const shown = new Set(recently.map((one) => one.key));

    return [
      { entries: recently, title: "Recent" } as const,
      ...all.map((section) => ({
        ...section,
        entries: section.entries.filter((one) => !shown.has(one.key)),
      })),
    ].filter((section) => section.entries.length > 0);
  }

  return all
    .map((section) => {
      const sorted = ranked(wanted, section.entries, matchedBy);

      return {
        best: sorted[0]?.score,
        section: { ...section, entries: sorted.map((one) => one.item) },
      };
    })
    .filter((one) => one.best !== undefined)
    .toSorted((left, right) =>
      left.best === undefined || right.best === undefined ? 0 : byScore(left.best, right.best)
    )
    .map((one) => one.section);
};

/**
 * What choosing an entry asks for. A command that needs no arguments runs, as typing its
 * name would; one that needs them, or that cannot run with none, starts in the composer
 * as `/<name> `, which is focused. A Timeline opens. An option starts `/set <name> ` in the
 * composer, but a Credential option asks for its value in the password prompt, as
 * `/set <name>` alone does, since its value is never typed into the composer. A Network
 * asks to remove it, as `/network remove <id>` does. A theme sets the option its entry says
 * on every device: `theme`, to draw in it, or, listed by `/theme -light` or `-dark`, the
 * one `system` draws while the device is light or dark. A
 * font is drawn in, on every device, unless this device overrides the font, but a family
 * the device has is always on this device alone, since another device's fonts are its own.
 * @param entry - The entry chosen.
 * @param context - The context commands are judged in.
 * @param overridesFont - Whether this device overrides `ui.font`.
 * @returns The intents to carry out.
 */
export const choose = (
  entry: Entry,
  context: CommandContext,
  overridesFont: boolean
): readonly Intent[] => {
  switch (entry._tag) {
    case "Command": {
      const command = commandWithId(entry.id);
      const typed: Intent = { _tag: "FocusComposer", text: `/${entry.name} ` };

      if (command === undefined || command.arguments === "Required") {
        return [typed];
      }

      const run = runIn(command, "", context);

      return run._tag === "Parsed" ? run.value : [typed];
    }

    case "Timeline": {
      return [{ _tag: "Open", timeline: entry.timeline }];
    }

    case "Option": {
      if (entry.credential) {
        const asked = interpret(`/set ${entry.name}`, context);

        if (asked._tag === "Parsed") {
          return asked.value;
        }
      }

      return [{ _tag: "FocusComposer", text: `/set ${entry.name} ` }];
    }

    case "Network": {
      return [{ _tag: "AskRemoval", keep: undefined, network: entry.network }];
    }

    case "Theme": {
      return [{ _tag: "UseTheme", device: false, name: entry.name, option: entry.option }];
    }

    case "Font": {
      return [
        {
          _tag: "ChangeUi",
          device: writtenOnDevice("font", entry.name, overridesFont),
          option: "font",
          value: entry.name,
        },
      ];
    }

    default: {
      return entry satisfies never;
    }
  }
};
