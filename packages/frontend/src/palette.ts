/**
 * The command palette, as data: what it lists for a query, ranked, and what choosing an
 * entry asks for. It lists the commands the registry can run here, every Timeline, every
 * theme, every font, and the options, or the themes alone, as `/theme` opens it, and adds no action of
 * its own: choosing gives the same intents the composer's `/commands` do. Which entries
 * were chosen recently is remembered, at most `recentCap`.
 *
 * @packageDocumentation
 */
import type { NetworkId, TimelineId } from "@iirc/api";
import { fontNames } from "@iirc/api/ui";
import type { FontShown } from "@iirc/api/ui";

import { commands, commandWithId, interpret, runIn, unmet } from "./commands.ts";
import type { CommandContext, Intent } from "./commands.ts";
import { chordsFor } from "./keymap.ts";
import type { Chord, Keymap } from "./keymap.ts";
import type { Option } from "./options.ts";
import type { ListedTheme } from "./theme.ts";
import type { SidebarNetwork } from "./timelines.ts";

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
      /** Whether it is the one in effect on this device. */
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
  readonly title: "Recent" | "Commands" | "Timelines" | "Themes" | "Fonts" | "Options";
  readonly entries: readonly Entry[];
}

/** What the palette lists from. */
export interface Listing {
  readonly context: CommandContext;
  readonly sidebar: readonly SidebarNetwork[];
  readonly options: readonly Option[];
  readonly keymap: Keymap;
  /** Every theme, and the name of the one in effect on this device. */
  readonly themes: readonly ListedTheme[];
  readonly theme: string;
  /** The font in effect on this device. */
  readonly font: FontShown;
}

/** What the palette lists: everything, or the themes alone, as `/theme` opens it. */
export type Scope = "All" | "Themes";

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
 */
export type PaletteEvent =
  | { readonly _tag: "Opened"; readonly scope: Scope }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Queried"; readonly query: string }
  | { readonly _tag: "Chosen"; readonly key: string };

/** The palette closed, with nothing chosen yet. */
export const initialPalette: Palette = { open: false, query: "", recent: [], scope: "All" };

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

    default: {
      return event satisfies never;
    }
  }
};

/**
 * How well a query matches, best first: the text starts with it, it starts a word of the
 * text, it starts a word of the description, or its characters appear in the text in order.
 */
const tiers = { Described: 1, Fuzzy: 0, Prefix: 3, WordStart: 2 } as const;

/** How well an entry matches: its tier, then the lower `cost` the better. */
interface Score {
  readonly tier: number;
  readonly cost: number;
}

/**
 * Orders scores best first.
 * @param left - One score.
 * @param right - The other.
 * @returns Their order.
 */
const byScore = (left: Score, right: Score) => right.tier - left.tier || left.cost - right.cost;

const lower = (text: string) => text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

const wordCharacter = /[\p{L}\p{N}]/u;

/**
 * Where the query starts a word of the text: at its start, or after a character that is
 * not a letter or a digit, such as `.`, `#`, or a space.
 * @param text - The text, folded.
 * @param query - The query, folded.
 * @returns Where, or -1.
 */
const wordStart = (text: string, query: string) => {
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + 1)) {
    if (at === 0 || !wordCharacter.test(text[at - 1] ?? "")) {
      return at;
    }
  }

  return -1;
};

/**
 * The span the query's characters cover in the text, in order, matching each as early as
 * it can after the last.
 * @param text - The text, folded.
 * @param query - The query, folded.
 * @returns The span and where it begins, or `null` when they do not all appear in order.
 */
const subsequence = (text: string, query: string) => {
  let first = -1;
  let at = -1;

  for (const character of query) {
    at = text.indexOf(character, at + 1);

    if (at === -1) {
      return null;
    }

    first = first === -1 ? at : first;
  }

  return { first, span: at - first };
};

/**
 * How well a query matches names and a description.
 * @param query - The query, folded, not empty.
 * @param names - What the entry is called, best first.
 * @param description - What it is, or nothing.
 * @returns The score, or none when it does not match.
 */
const scoreOf = (
  query: string,
  names: readonly string[],
  description: string
): Score | undefined => {
  const folded = names.map(lower);
  const best: Score[] = [];

  for (const [index, name] of folded.entries()) {
    // A name further down the list costs more, so the entry's own name wins over its others.
    const penalty = index * 1000;

    if (name.startsWith(query)) {
      best.push({ cost: penalty + name.length, tier: tiers.Prefix });
    }

    const word = wordStart(name, query);

    if (word !== -1) {
      best.push({ cost: penalty + word * 100 + name.length, tier: tiers.WordStart });
    }

    const fuzzy = subsequence(name, query);

    if (fuzzy !== null) {
      best.push({
        cost: penalty + fuzzy.span * 1000 + fuzzy.first * 100 + name.length,
        tier: tiers.Fuzzy,
      });
    }
  }

  const described = description === "" ? -1 : wordStart(lower(description), query);

  if (described !== -1) {
    best.push({ cost: described, tier: tiers.Described });
  }

  return best.toSorted(byScore)[0];
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
export const fontDescription = (font: FontShown) =>
  font === "system" ? "font: the device's own monospace font" : "font";

/**
 * What an entry is matched by: its names, best first, and its description.
 * @param entry - The entry.
 * @returns Its names and description.
 */
/** What an entry is matched by. */
interface Matched {
  readonly names: readonly string[];
  readonly description: string;
}

const matchedBy = (entry: Entry): Matched => {
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

    case "Option": {
      return { description: entry.description, names: [entry.name] };
    }

    case "Theme": {
      return { description: themeDescription(entry), names: [entry.name] };
    }

    case "Font": {
      return { description: fontDescription(entry.name), names: [entry.name] };
    }

    default: {
      return entry satisfies never;
    }
  }
};

/**
 * Every entry the palette can list here, by section, in their own orders: the commands
 * whose conditions hold, but for opening the palette itself; every Timeline, in the
 * sidebar's order; every theme; every font; and every option read.
 * @param listing - What the palette lists from.
 * @returns The sections, each with every entry.
 */
const everything = (listing: Listing): readonly Section[] => [
  {
    entries: commands
      .filter((one) => one.id !== "palette.open" && unmet(one.when, listing.context) === undefined)
      .map((one) => ({
        _tag: "Command",
        chords: chordsFor(listing.keymap, one.id),
        description: one.description,
        id: one.id,
        key: `command:${one.id}`,
        name: one.name,
        usage: one.usage,
      })),
    title: "Commands",
  },
  {
    entries: listing.sidebar.flatMap((network) =>
      network.timelines.map((timeline): Entry => ({
        _tag: "Timeline",
        key: `timeline:${timeline.id}`,
        kind: timeline.kind,
        name: timeline.name,
        network: network.network,
        timeline: timeline.id,
      }))
    ),
    title: "Timelines",
  },
  {
    entries: listing.themes.map((theme): Entry => ({
      _tag: "Theme",
      builtIn: theme.builtIn,
      current: theme.name === listing.theme,
      key: `theme:${theme.name}`,
      name: theme.name,
    })),
    title: "Themes",
  },
  {
    entries: fontNames.map((font): Entry => ({
      _tag: "Font",
      current: font === listing.font,
      key: `font:${font}`,
      name: font,
    })),
    title: "Fonts",
  },
  {
    entries: listing.options.map((option): Entry => ({
      _tag: "Option",
      credential: option.kind._tag === "Credential",
      description: option.description,
      key: `option:${option.name}`,
      name: option.name,
    })),
    title: "Options",
  },
];

/**
 * What the palette lists for a query. With none, the entries chosen recently come first,
 * newest first, and then each section in its own order. With one, only entries that match,
 * each section ranked best first, and the sections by their best entry. A leading `/` is
 * ignored, so `/set` finds `set`. Scoped to the themes, it lists only them, with nothing
 * recent.
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
  scope: Scope = "All"
): readonly Section[] => {
  const all = everything(listing).filter(
    (section) => scope === "All" || section.title === "Themes"
  );

  const wanted = lower(query.trim().replace(/^\//u, ""));

  if (wanted === "") {
    const byKey = new Map(
      all.flatMap((section) => section.entries.map((one) => [one.key, one] as const))
    );

    const recently = scope === "All" ? recent.flatMap((key) => byKey.get(key) ?? []) : [];
    const shown = new Set(recently.map((one) => one.key));

    return [
      { entries: recently, title: "Recent" } as const,
      ...all.map((section) => ({
        ...section,
        entries: section.entries.filter((one) => !shown.has(one.key)),
      })),
    ].filter((section) => section.entries.length > 0);
  }

  const ranked = all.map((section) => {
    const scored = section.entries.flatMap((entry) => {
      const { description, names } = matchedBy(entry);
      const score = scoreOf(wanted, names, description);

      return score === undefined ? [] : [{ entry, score }];
    });

    // Sorting is stable, so entries that score the same keep the section's own order.
    const sorted = scored.toSorted((left, right) => byScore(left.score, right.score));

    return {
      best: sorted[0]?.score,
      section: { ...section, entries: sorted.map((one) => one.entry) },
    };
  });

  return ranked
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
 * `/set <name>` alone does, since its value is never typed into the composer. A theme or a
 * font is drawn in, on every device.
 * @param entry - The entry chosen.
 * @param context - The context commands are judged in.
 * @returns The intents to carry out.
 */
export const choose = (entry: Entry, context: CommandContext): readonly Intent[] => {
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

    case "Theme": {
      return [{ _tag: "UseTheme", device: false, name: entry.name }];
    }

    case "Font": {
      return [{ _tag: "ChangeUi", device: false, option: "font", value: entry.name }];
    }

    default: {
      return entry satisfies never;
    }
  }
};
