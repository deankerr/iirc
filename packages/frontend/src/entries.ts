/**
 * The entries the Composer's list ranks, as data: a command, a Timeline, a Network to
 * remove, a theme, a font, and an alias, each with the words a query matches it by and the key it is
 * remembered by once run. The entries add no action of their own: picking one only writes the
 * draft, and sending it gives the intents the composer's `/commands` do. Which commands were
 * run recently is remembered, at most `recentCap`.
 *
 * @packageDocumentation
 */
import type { NetworkId, TimelineId } from "@iirc/api";
import type { Alias, FontShown } from "@iirc/api/ui";
import { FontFamily, fontNames, isFontName } from "@iirc/api/ui";
import { Option as Maybe, Schema } from "effect";

import { commandWithId } from "./commands.ts";
import type { Command, NamedTimeline } from "./commands.ts";
import { chordsFor } from "./keymap.ts";
import type { Chord, Keymap } from "./keymap.ts";
import type { Matched } from "./ranking.ts";
import { systemTheme } from "./theme.ts";
import type { ListedTheme, ThemeOption } from "./theme.ts";

/** How many commands run recently the Composer's list remembers. */
export const recentCap = 20;

/** One entry the Composer's list ranks, keyed so it can be remembered. */
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
    }
  | {
      /** An alias after `/alias`, by its name, with the line it stands for. */
      readonly _tag: "Alias";
      readonly key: string;
      readonly name: string;
      readonly line: string;
      /** What choosing it writes: its name to remove it, or `add` and the alias to edit it. */
      readonly text: string;
    };

/**
 * Remembers a key as the newest run, once, keeping at most `recentCap`.
 * @param recent - The keys, newest first.
 * @param key - The key chosen.
 * @returns The keys after.
 */
export const remember = (recent: readonly string[], key: string): readonly string[] =>
  [key, ...recent.filter((one) => one !== key)].slice(0, recentCap);

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
    return "font: a font family on this device";
  }

  switch (font) {
    case "system": {
      return "font: this device's monospace font";
    }

    case "system-sans": {
      return "font: this device's sans-serif font";
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
    ? "network: delete its kept conversations and free its name"
    : "network: remove it, asking first whether to keep its conversations to read";

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

    case "Theme": {
      return { description: themeDescription(entry), names: [entry.name] };
    }

    case "Font": {
      return {
        description: fontDescription(entry.name),
        names: isFontName(entry.name) ? [entry.name] : [`font ${entry.name}`, entry.name],
      };
    }

    case "Alias": {
      return { description: entry.line, names: [entry.name] };
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

/** What the key of a font's entry starts with. */
const fontKeyPrefix = "font:";

/**
 * The key a command's entry is remembered by, once run.
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
 * An alias's entry, after `/alias`.
 * @param alias - The alias.
 * @param edit - Whether choosing it writes `add` and the alias, to edit it, or only its
 *   name, as `remove` takes it.
 * @returns The entry.
 */
export const aliasEntry = (alias: Alias, edit: boolean): Entry => ({
  _tag: "Alias",
  key: `alias:${alias.name}`,
  line: alias.line,
  name: alias.name,
  text: edit ? `add ${alias.name} ${alias.line}` : alias.name,
});
