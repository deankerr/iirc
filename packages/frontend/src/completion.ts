/**
 * Completion in the composer, as a reducer: the word at the caret, completed from what it
 * can be, a command after `/` at the start of a line, an option after `/set `, a Channel's
 * name, or a nick, or the whole argument of `/go`, `/theme`, `/set ui.font`, and
 * `/network remove`, a Timeline, a theme, a font, or a Network, listed above the composer
 * and ranked as the palette ranks them. A draft that starts with a command opens the
 * list as it is typed, and anything else opens it on Tab. Tab, Shift+Tab, and the arrows
 * move through it, writing the one highlighted into the draft, and Escape gives back what
 * was typed. A nick in a Channel comes from the Daemon's members route, which the runtime
 * asks while this waits; everything else is at hand.
 *
 * @packageDocumentation
 */
import type { NetworkId, TimelineId } from "@iirc/api";
import type { FontShown } from "@iirc/api/ui";
import { themeCommandWords } from "@iirc/api/ui";
import { casefold } from "@iirc/protocol/casemapping";

import { commandNamed, commands, namedIn, themeFlags } from "./commands.ts";
import type { Command, NamedTimeline } from "./commands.ts";
import { isTimelinePlace } from "./composer.ts";
import type { Place } from "./composer.ts";
import type { Chord, Keymap } from "./keymap.ts";
import { fields, optionName } from "./options.ts";
import type { Option } from "./options.ts";
import {
  commandEntry,
  familyNamed,
  fontEntries,
  matchedBy,
  networkEntry,
  themeEntries,
  timelineEntry,
} from "./palette.ts";
import type { Entry } from "./palette.ts";
import { queryOf, ranked, tiers, wordStart } from "./ranking.ts";
import type { ListedTheme, ThemeOption } from "./theme.ts";
import { resolve, sidebar } from "./timelines.ts";
import type { NetworkView, Timelines } from "./timelines.ts";

/** How many nicks the members route is asked for. */
export const nicksLimit = 100;

/** Where a nick can come from: the open Channel's members, which the Daemon is asked for, or a list at hand. */
export type Nicks =
  | { readonly _tag: "Members"; readonly timeline: TimelineId }
  | { readonly _tag: "Listed"; readonly nicks: readonly string[] };

/** An option as completion lists it: its name, and what it is, which a query matches too. */
export interface OptionListed {
  readonly name: string;
  readonly description: string;
}

/** A Network as `/network remove` lists it, and whether it was removed with its Timelines kept. */
export interface NetworkListed {
  readonly network: NetworkId;
  readonly removed: boolean;
}

/** An emoji, as completion lists it: the character itself and the names it goes by, best first. */
export interface Emoji {
  readonly emoji: string;
  readonly names: readonly string[];
}

/** What a word can be completed from, for the composer at one place. */
export interface Sources {
  /** Every command, each listed once, by its name. */
  readonly commands: readonly Command[];
  /** The keymap, for the chords bound to a command. */
  readonly keymap: Keymap;
  /** The keys of what the palette remembers as chosen or run recently, newest first. */
  readonly ran: readonly string[];
  /** Every option. */
  readonly options: readonly OptionListed[];
  /** Every emoji, by the names its `:name:` is written as, or none while they are not loaded. */
  readonly emoji: readonly Emoji[] | undefined;
  /** The Network the composer is on, if any, which `/go` names a Timeline from. */
  readonly network: NetworkId | undefined;
  /** Every Timeline by name, as `namedIn` lists them. */
  readonly timelines: readonly NamedTimeline[];
  /** Every Network, in the sidebar's order. */
  readonly networks: readonly NetworkListed[];
  /** Every theme. */
  readonly themes: readonly ListedTheme[];
  /** The theme each option that names one names on this device. */
  readonly chosen: Readonly<Record<ThemeOption, string>>;
  /** The font in effect on this device. */
  readonly font: FontShown;
  /** The names of the Network's Channel Timelines, in code-unit order. */
  readonly channels: readonly string[];
  /**
   * The Network's `CHANTYPES`, as its Session said, or none while unknown, when RFC 2811's
   * `#&+!` stand in.
   */
  readonly chantypes: string | undefined;
  readonly nicks: Nicks;
  /** Who said something in the open Timeline, the latest first. */
  readonly recent: readonly string[];
  /** Self's nick, if known, which comes last. */
  readonly self: string | undefined;
  /** What follows a nick completed at the start of a line, as `ui.suffix` says. */
  readonly suffix: string;
}

/** The text and caret the composer shows. */
export interface Shown {
  readonly text: string;
  readonly caret: number;
}

/** The word at the caret, what comes before it, and what comes after the caret. */
export interface Spot {
  readonly before: string;
  readonly word: string;
  readonly after: string;
}

/**
 * Where completion stands.
 *
 * - `Idle`: nothing is being completed.
 * - `Asking`: a nick in a Channel, while the runtime asks the members route for those that
 *   start with `prefix`, under `request`.
 * - `Following`: a draft that starts with a command, as typed, its list derived from the
 *   draft and the sources, with none highlighted.
 * - `Listed`: the candidates for the word, held in their order while the one at `index`
 *   is highlighted and shown in place of the word.
 * - `Unmatched`: nothing completes the word.
 */
export type Phase =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Asking";
      readonly place: Place;
      readonly timeline: TimelineId;
      readonly request: number;
      readonly prefix: string;
      readonly spot: Spot;
      readonly shown: Shown;
      readonly backwards: boolean;
    }
  | { readonly _tag: "Following"; readonly place: Place; readonly shown: Shown }
  | {
      readonly _tag: "Listed";
      readonly place: Place;
      readonly spot: Spot;
      readonly candidates: readonly Candidate[];
      readonly index: number;
      readonly suffix: string;
      readonly shown: Shown;
    }
  | {
      readonly _tag: "Unmatched";
      readonly place: Place;
      readonly word: string;
      readonly shown: Shown;
    };

/** Completion's state: where it stands, and counters a request and the caret are told apart by. */
export interface Completion {
  readonly phase: Phase;
  /** The last request made of the members route. */
  readonly requests: number;
  /** How many times completion changed the text, so a view puts the caret where it says. */
  readonly applied: number;
  /** Where the caret goes after the last change completion made. */
  readonly caret: number;
}

/**
 * What happened.
 *
 * - `Typed`: the Owner changed the draft, which is now `text` with the caret at `caret`.
 *   One that starts with a command opens the list, and anything else lets go.
 * - `Tabbed`: Tab, or Shift+Tab `backwards`, with the composer's text and caret, which the
 *   arrows also say while the list is open.
 * - `Picked`: a candidate was picked from the list by its index, as by a tap, while the
 *   composer showed `text`.
 * - `Moved`: the selection moved from `start` to `end` without the text changing, as an
 *   arrow, Home, or a click moves it. Away from where completion left the caret, it lets go.
 * - `NicksRead`: the members route answered a request, with their nicks in its order, and
 *   the composer under the main view as it is now: its place and its draft's text.
 * - `NicksFailed`: it did not.
 * - `Escaped`: Escape, which gives back what was typed.
 * - `LetGo`: the draft was replaced other than by completion or typing, as by recalling,
 *   sending, or the palette, so what was being completed is let go of.
 */
export type CompletionEvent =
  | {
      readonly _tag: "Typed";
      readonly place: Place;
      readonly text: string;
      readonly caret: number;
    }
  | {
      readonly _tag: "Picked";
      readonly place: Place;
      readonly text: string;
      readonly index: number;
    }
  | {
      readonly _tag: "Moved";
      readonly place: Place;
      readonly text: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly _tag: "Tabbed";
      readonly place: Place;
      readonly text: string;
      readonly caret: number;
      readonly backwards: boolean;
    }
  | {
      readonly _tag: "NicksRead";
      readonly request: number;
      readonly nicks: readonly string[];
      readonly place: Place;
      readonly text: string;
    }
  | { readonly _tag: "NicksFailed"; readonly request: number }
  | { readonly _tag: "Escaped"; readonly place: Place }
  | { readonly _tag: "LetGo" };

/** Completion's next state, and the text and caret to put in the composer, if any. */
export interface Completed {
  readonly state: Completion;
  readonly edit: (Shown & { readonly place: Place }) | undefined;
}

/** Nothing is being completed. */
export const initialCompletion: Completion = {
  applied: 0,
  caret: 0,
  phase: { _tag: "Idle" },
  requests: 0,
};

const idle: Phase = { _tag: "Idle" };

/**
 * Whether a character separates words.
 * @param character - The character.
 * @returns Whether it is whitespace.
 */
const isSpace = (character: string) => /\s/u.test(character);

/**
 * The word that ends at the caret: everything back to the whitespace before it.
 * @param text - The text.
 * @param caret - Where the caret is.
 * @returns The word, what comes before it, and what comes after the caret.
 */
export const spotAt = (text: string, caret: number): Spot => {
  let start = caret;

  while (start > 0 && !isSpace(text[start - 1] ?? "")) {
    start -= 1;
  }

  return { after: text.slice(caret), before: text.slice(0, start), word: text.slice(start, caret) };
};

/**
 * Whether Tab at the caret has a word to complete, so the composer takes it, rather than
 * letting it move focus, as Tab otherwise does.
 * @param text - The text.
 * @param caret - Where the caret is.
 * @returns Whether it does.
 */
export const completes = (text: string, caret: number): boolean => spotAt(text, caret).word !== "";

/**
 * Where completion stands in a composer, while what it left there is still shown.
 * @param state - The state.
 * @param place - The composer's place.
 * @param text - What the composer shows.
 * @returns The phase, or none.
 */
const at = (state: Completion, place: Place, text: string) => {
  const { phase } = state;

  return phase._tag !== "Idle" && phase.place === place && phase.shown.text === text
    ? phase
    : undefined;
};

/**
 * A nick or Channel's name folded as RFC 1459 does, which is how a Frontend compares names
 * it only orders or offers, never routes.
 * @param name - The name.
 * @returns It, folded.
 */
const fold = (name: string) => casefold("rfc1459", name);

const startsFolded = (name: string, prefix: string) => fold(name).startsWith(fold(prefix));

const byCodeUnits = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
};

/**
 * Whether the text before the word starts a line.
 * @param before - The text before the word.
 * @returns Whether it does.
 */
const atLineStart = (before: string) => before === "" || before.endsWith("\n");

/**
 * Nicks as offered: those who spoke latest first, then in the order given, and Self last.
 * @param nicks - The nicks, in the members route's order.
 * @param sources - The sources.
 * @returns The nicks, ordered.
 */
export const orderNicks = (nicks: readonly string[], sources: Sources): readonly string[] => {
  const recency = new Map<string, number>();

  for (const [index, nick] of sources.recent.entries()) {
    if (!recency.has(fold(nick))) {
      recency.set(fold(nick), index);
    }
  }

  const self = sources.self === undefined ? undefined : fold(sources.self);

  const order = (nick: string) => {
    if (fold(nick) === self) {
      return Number.MAX_SAFE_INTEGER;
    }

    return recency.get(fold(nick)) ?? sources.recent.length;
  };

  return nicks
    .map((nick, index) => ({ index, nick, order: order(nick) }))
    .toSorted((left, right) => left.order - right.order || left.index - right.index)
    .map((one) => one.nick);
};

/**
 * What follows a candidate: a space, or `: ` after a nick at the start of a line, less a
 * space where whitespace already follows the caret.
 * @param suffix - The suffix.
 * @param after - What follows the caret.
 * @returns The suffix to put in.
 */
const fitted = (suffix: string, after: string) =>
  after !== "" && isSpace(after[0] ?? "") ? suffix.trimEnd() : suffix;

/**
 * The text and caret with a candidate in place of the word.
 * @param spot - The word, and what surrounds it.
 * @param candidate - The candidate.
 * @param suffix - What follows it.
 * @returns The text and caret.
 */
const placed = (spot: Spot, candidate: string, suffix: string): Shown => {
  const put = `${candidate}${fitted(suffix, spot.after)}`;

  return { caret: spot.before.length + put.length, text: `${spot.before}${put}${spot.after}` };
};

/**
 * The text and caret as they were typed, the word back in place.
 * @param spot - The word, and what surrounds it.
 * @returns The text and caret.
 */
const typedOf = (spot: Spot): Shown => ({
  caret: spot.before.length + spot.word.length,
  text: `${spot.before}${spot.word}${spot.after}`,
});

/** Candidates for a word, and what follows each. */
interface Found {
  readonly candidates: readonly Candidate[];
  readonly suffix: string;
}

/**
 * The list for a word, held, with the one at `index` highlighted and shown in place of it.
 * With no candidates, nothing completes it.
 * @param state - The state.
 * @param place - The composer's place.
 * @param spot - The word.
 * @param found - The candidates.
 * @param index - Which to highlight, if any.
 * @returns The state, and the edit.
 */
const listing = (
  state: Completion,
  place: Place,
  spot: Spot,
  found: Found,
  index: number
): Completed => {
  const { candidates, suffix } = found;
  const original = typedOf(spot);

  if (candidates.length === 0) {
    return {
      edit: undefined,
      state: { ...state, phase: { _tag: "Unmatched", place, shown: original, word: spot.word } },
    };
  }

  const shown = placed(spot, candidates[index]?.text ?? spot.word, suffix);
  const phase: Phase = { _tag: "Listed", candidates, index, place, shown, spot, suffix };

  return {
    edit: { ...shown, place },
    state: { ...state, applied: state.applied + 1, caret: shown.caret, phase },
  };
};

/** The commands whose first argument completion lists as it is typed, and what it lists. */
const arguments_: ReadonlyMap<string, "Options" | "Channels"> = new Map([
  ["options.set", "Options"],
  ["channels.join", "Channels"],
  ["channels.part", "Channels"],
]);

/**
 * What a command's whole argument is completed from: a Timeline after `/go`, a theme after
 * `/theme` and any flags, to set the option they say, a font after `/set ui.font`, or a
 * Network after `/network remove`.
 */
type Whole =
  | { readonly _tag: "Timelines" }
  | { readonly _tag: "Themes"; readonly option: ThemeOption }
  | { readonly _tag: "Fonts" }
  | { readonly _tag: "Networks" };

/**
 * Where a command whose whole argument is listed begins that argument, in a line typed up
 * to the caret, and what it lists.
 * @param line - The line, up to the caret.
 * @returns Where its argument begins, and what it is completed from, or none.
 */
const wholeIn = (line: string): { readonly start: number; readonly whole: Whole } | undefined => {
  const head = /^\/(?<name>\S+)\s+/u.exec(line);
  const name = head?.groups?.name;
  const command = name === undefined ? undefined : commandNamed(name);

  if (head === null || command === undefined) {
    return undefined;
  }

  const after = line.slice(head[0].length);

  /**
   * The argument after what the head is followed by, if that matched.
   * @param more - What follows the command's name, matched, or `null`.
   * @param whole - What the argument is completed from.
   * @returns Where it begins, and what it is completed from, or none.
   */
  const past = (more: RegExpExecArray | null, whole: Whole) =>
    more === null ? undefined : { start: head[0].length + more[0].length, whole };

  switch (command.id) {
    case "timeline.go": {
      return { start: head[0].length, whole: { _tag: "Timelines" } };
    }

    case "network.manage": {
      return past(/^remove\s+/u.exec(after), { _tag: "Networks" });
    }

    case "options.set": {
      return past(/^(?:-device\s+)?ui\.font\s+/u.exec(after), { _tag: "Fonts" });
    }

    case "theme.set": {
      const given = /^(?:(?:-device|-light|-dark)\s+)*/iu.exec(after)?.[0] ?? "";

      const flags = themeFlags(
        given
          .toLowerCase()
          .split(/\s+/u)
          .filter((one) => one !== "")
      );

      // `import` and `remove` are verbs, not a theme to draw: neither is listed nor previewed.
      const verb = /^\S*/u.exec(after.slice(given.length))?.[0].toLowerCase() ?? "";

      return flags === undefined || themeCommandWords.some((word) => word === verb)
        ? undefined
        : { start: head[0].length + given.length, whole: { _tag: "Themes", option: flags.option } };
    }

    default: {
      return undefined;
    }
  }
};

/**
 * Entries in their own order with no query, or those a query matches, ranked as the
 * palette ranks them.
 * @param query - The query, as `queryOf` reads it.
 * @param entries - The entries, in their own order.
 * @returns The entries listed.
 */
const rankedEntries = (query: string, entries: readonly Entry[]): readonly Entry[] =>
  query === "" ? entries : ranked(query, entries, matchedBy).map((one) => one.item);

/** What `/go` writes for a Timeline, or none for one it cannot reach. */
type GoText = (timeline: NamedTimeline) => string | undefined;

/**
 * What `/go` writes for each Timeline, as `timelineNamed` reads it back: its name where
 * that finds it from the Network the composer is on, else its Network's id and its name,
 * or none where neither does, as for the second of two that share a name on one Network.
 * Every name is folded once, so the list takes time in proportion to the Timelines.
 * @param sources - The sources.
 * @returns What it writes for each.
 */
const goTexts = (sources: Sources): GoText => {
  const byName = new Map<string, NamedTimeline[]>();

  for (const one of sources.timelines) {
    const key = fold(one.name);
    const same = byName.get(key);

    if (same === undefined) {
      byName.set(key, [one]);
    } else {
      same.push(one);
    }
  }

  return (timeline) => {
    const all = byName.get(fold(timeline.name)) ?? [];
    const networks = new Set(all.map((one) => one.network));

    const alone =
      all.find((one) => one.network === sources.network) ??
      (networks.size === 1 ? all[0] : undefined);

    if (alone?.timeline === timeline.timeline) {
      return timeline.name;
    }

    const onNetwork = all.find((one) => one.network === timeline.network);

    return onNetwork?.timeline === timeline.timeline
      ? `${timeline.network} ${timeline.name}`
      : undefined;
  };
};

/**
 * An entry as a candidate in the list.
 * @param entry - The entry.
 * @param go - What `/go` writes for a Timeline, given wherever one can be listed.
 * @returns The candidate, or none for one the list never shows, or a Timeline `/go` cannot reach.
 */
const candidateOfEntry = (entry: Entry, go?: GoText): Candidate | undefined => {
  switch (entry._tag) {
    case "Command": {
      const name = `/${entry.name}`;
      const space = entry.usage.indexOf(" ");

      return {
        _tag: "Command",
        chords: entry.chords,
        description: entry.description,
        name,
        takes: space === -1 ? "" : entry.usage.slice(space + 1),
        text: name,
      };
    }

    case "Timeline": {
      const { kind, name, network, timeline } = entry;
      const text = go?.({ kind, name, network, timeline });

      return text === undefined ? undefined : { _tag: "Timeline", kind, name, network, text };
    }

    case "Network": {
      return { _tag: "Network", name: entry.network, removed: entry.removed, text: entry.network };
    }

    case "Theme": {
      const { builtIn, current, name } = entry;

      return { _tag: "Theme", builtIn, current, name, text: name };
    }

    case "Font": {
      return { _tag: "Font", current: entry.current, name: entry.name, text: entry.name };
    }

    case "Option": {
      return undefined;
    }

    default: {
      return entry satisfies never;
    }
  }
};

/**
 * The candidates for a command's whole argument, as typed so far.
 * @param whole - What it is completed from.
 * @param typed - The argument, as typed.
 * @param sources - The sources.
 * @returns The candidates.
 */
const wholeCandidates = (whole: Whole, typed: string, sources: Sources): readonly Candidate[] => {
  const query = queryOf(typed);

  const entries = (): readonly Entry[] => {
    switch (whole._tag) {
      case "Timelines": {
        return sources.timelines.map(timelineEntry);
      }

      case "Networks": {
        return sources.networks.map(networkEntry);
      }

      case "Themes": {
        return themeEntries(sources.themes, sources.chosen, whole.option);
      }

      case "Fonts": {
        return fontEntries(familyNamed(typed.trim().replaceAll(/\s+/gu, " ")), sources.font);
      }

      default: {
        return whole satisfies never;
      }
    }
  };

  // Only Timelines are written by name, so only their list folds every name.
  const go = whole._tag === "Timelines" ? goTexts(sources) : undefined;

  return rankedEntries(query, entries()).flatMap((entry) => candidateOfEntry(entry, go) ?? []);
};

/**
 * The commands, once each by name: with nothing typed, those run recently first, newest
 * first, then the rest by name, and with a query, those it matches, ranked, those that
 * match as well in the registry's order, as in the palette.
 * @param typed - What was typed after `/`.
 * @param sources - The sources.
 * @returns The candidates.
 */
const commandCandidates = (typed: string, sources: Sources): readonly Candidate[] => {
  const query = queryOf(typed);
  const all = sources.commands.map((one) => commandEntry(one, sources.keymap));

  const unranked = () => {
    const byName = all.toSorted((left, right) => byCodeUnits(left.name, right.name));
    const keyed = new Map(byName.map((one) => [one.key, one] as const));
    const recently = sources.ran.flatMap((key) => keyed.get(key) ?? []);
    const shown = new Set(recently.map((one) => one.key));

    return [...recently, ...byName.filter((one) => !shown.has(one.key))];
  };

  const entries = query === "" ? unranked() : rankedEntries(query, all);

  return entries.flatMap((entry) => candidateOfEntry(entry) ?? []);
};

/**
 * A word as a candidate: a Channel's name, a nick, or an option's name.
 * @param name - The word.
 * @returns The candidate.
 */
const asWord = (name: string): Candidate => ({ _tag: "Word", name, text: name });

/**
 * The options a query matches, ranked as the palette ranks them, or all, by name.
 * @param typed - What was typed.
 * @param sources - The sources.
 * @returns The candidates.
 */
const optionCandidates = (typed: string, sources: Sources): readonly Candidate[] => {
  const query = queryOf(typed);

  const listed =
    query === ""
      ? sources.options
      : ranked(query, sources.options, (one) => ({
          description: one.description,
          names: [one.name],
        })).map((one) => one.item);

  return listed.map((one) => asWord(one.name));
};

/**
 * A word, its candidates, and what follows each. It is `pending` while they wait on names
 * that are not loaded yet.
 */
interface Listed {
  readonly spot: Spot;
  readonly found: Found;
  readonly pending?: true;
}

/** The characters an emoji's name is made of, as the names in use are, in either case. */
const emojiWord = /^:(?<name>[A-Za-z0-9_+-]{2,})$/u;

/**
 * The emoji whose names a query matches: those a name starts with, then those a word of a
 * name starts with, each once, under the name that matched first.
 * @param query - What follows the colon, folded.
 * @param emoji - Every emoji.
 * @returns The candidates.
 */
const emojiCandidates = (query: string, emoji: readonly Emoji[]): readonly Candidate[] =>
  ranked(query, emoji, (one) => ({ description: "", names: one.names })).flatMap(
    ({ item, score }) => {
      const name = item.names.find((one) => one.startsWith(query) || wordStart(one, query) !== -1);

      return score.tier >= tiers.WordStart && name !== undefined
        ? [{ _tag: "Emoji", emoji: item.emoji, name: `:${name}:`, text: item.emoji }]
        : [];
    }
  );

/**
 * What the word at the caret is completed from when it is `:` and two or more characters
 * of a name: the emoji whose names it matches, or, while those are not loaded, nothing yet.
 * @param text - The text.
 * @param caret - Where the caret is.
 * @param sources - The sources.
 * @returns The word and its candidates, or none where the word is no such thing.
 */
const emojiIn = (text: string, caret: number, sources: Sources): Listed | undefined => {
  const spot = spotAt(text, caret);
  const name = emojiWord.exec(spot.word)?.groups?.name;

  if (name === undefined) {
    return undefined;
  }

  if (sources.emoji === undefined) {
    return { found: { candidates: [], suffix: " " }, pending: true, spot };
  }

  return {
    found: { candidates: emojiCandidates(queryOf(name), sources.emoji), suffix: " " },
    spot,
  };
};

/**
 * What a word in a command's line is completed from, at hand: a command's name, as the
 * first word of a line; the whole argument of `/go`, `/theme`, `/set ui.font`, or
 * `/network remove`; or the first argument of a command whose argument is listed, an
 * option after `/set`, or a Channel's name after `/join` or `/part`.
 * @param text - The text.
 * @param caret - Where the caret is.
 * @param sources - The sources.
 * @returns The word and its candidates, or none where the word is no such thing.
 */
const inCommand = (text: string, caret: number, sources: Sources): Listed | undefined => {
  const spot = spotAt(text, caret);
  const { before, word: typed } = spot;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const whole = wholeIn(text.slice(lineStart, caret));

  if (whole !== undefined) {
    const start = lineStart + whole.start;
    const argument = text.slice(start, caret);

    return {
      found: { candidates: wholeCandidates(whole.whole, argument, sources), suffix: "" },
      spot: { after: text.slice(caret), before: text.slice(0, start), word: argument },
    };
  }

  if (atLineStart(before) && typed.startsWith("/") && !typed.startsWith("//")) {
    return { found: { candidates: commandCandidates(typed.slice(1), sources), suffix: " " }, spot };
  }

  const line = before.slice(before.lastIndexOf("\n") + 1);
  const head = /^\/(?<name>\S+) +$/u.exec(line)?.groups?.name;
  const command = head === undefined ? undefined : commandNamed(head);
  const listing = command === undefined ? undefined : arguments_.get(command.id);

  switch (listing) {
    case "Options": {
      return { found: { candidates: optionCandidates(typed, sources), suffix: " " }, spot };
    }

    case "Channels": {
      return {
        found: {
          candidates: sources.channels.filter((name) => startsFolded(name, typed)).map(asWord),
          suffix: " ",
        },
        spot,
      };
    }

    case undefined: {
      return undefined;
    }

    default: {
      return listing satisfies never;
    }
  }
};

/**
 * What a word at the caret is completed from, at hand: what a command's line lists, else an
 * emoji.
 * @param text - The text.
 * @param caret - Where the caret is.
 * @param sources - The sources.
 * @returns The word and its candidates, or none where nothing completes it.
 */
const inWord = (text: string, caret: number, sources: Sources): Listed | undefined =>
  inCommand(text, caret, sources) ?? emojiIn(text, caret, sources);

/**
 * What a draft lists as it is typed, from the sources as they are now: one whose first
 * line starts with a command, with the caret in that line, in the command's name or a
 * listed argument, and an emoji's `:name`, on any line.
 * @param shown - The draft, and the caret.
 * @param sources - The sources.
 * @returns The word and its candidates, or none for a draft that lists nothing.
 */
const followed = (shown: Shown, sources: Sources): Listed | undefined =>
  shown.text.slice(0, shown.caret).includes("\n")
    ? emojiIn(shown.text, shown.caret, sources)
    : inWord(shown.text, shown.caret, sources);

/**
 * A draft typed: one that lists something as it is typed is followed, and anything else
 * lets go.
 * @param state - The state.
 * @param event - What was typed.
 * @param sources - The sources.
 * @returns The state, and no edit.
 */
const typedIn = (
  state: Completion,
  event: Extract<CompletionEvent, { readonly _tag: "Typed" }>,
  sources: Sources
): Completed => {
  const shown = { caret: event.caret, text: event.text };

  return {
    edit: undefined,
    state: {
      ...state,
      phase:
        followed(shown, sources) === undefined
          ? idle
          : { _tag: "Following", place: event.place, shown },
    },
  };
};

/** What a Channel's name starts with while a Network's `CHANTYPES` is unknown: RFC 2811's. */
export const rfc2811Chantypes = "#&+!";

/**
 * Begins completing the word at the caret.
 * @param state - The state.
 * @param event - The Tab.
 * @param sources - What it can be completed from.
 * @returns The state, and the edit.
 */
const begin = (
  state: Completion,
  event: Extract<CompletionEvent, { readonly _tag: "Tabbed" }>,
  sources: Sources
): Completed => {
  const { backwards, caret, place, text } = event;
  const spot = spotAt(text, caret);
  const { before, word } = spot;

  if (word === "") {
    return { edit: undefined, state: { ...state, phase: idle } };
  }

  const first = (count: number) => (backwards ? count - 1 : 0);
  const listed = inWord(text, caret, sources);

  if (listed?.pending === true) {
    // The names are on their way: the list follows what is typed once they are here.
    return {
      edit: undefined,
      state: { ...state, phase: { _tag: "Following", place, shown: { caret, text } } },
    };
  }

  if (listed !== undefined) {
    return listing(state, place, listed.spot, listed.found, first(listed.found.candidates.length));
  }

  if ((sources.chantypes ?? rfc2811Chantypes).includes(word[0] ?? " ")) {
    const candidates = sources.channels.filter((name) => startsFolded(name, word)).map(asWord);

    return listing(state, place, spot, { candidates, suffix: " " }, first(candidates.length));
  }

  const lineStart = atLineStart(before);

  const suffix = lineStart ? sources.suffix : " ";

  if (sources.nicks._tag === "Members") {
    const request = state.requests + 1;

    return {
      edit: undefined,
      state: {
        ...state,
        phase: {
          _tag: "Asking",
          backwards,
          place,
          prefix: word,
          request,
          shown: { caret, text },
          spot,
          timeline: sources.nicks.timeline,
        },
        requests: request,
      },
    };
  }

  const nicks = orderNicks(
    sources.nicks.nicks.filter((nick) => startsFolded(nick, word)),
    sources
  );

  return listing(
    state,
    place,
    spot,
    { candidates: nicks.map(asWord), suffix },
    first(nicks.length)
  );
};

/**
 * The list with another candidate highlighted, and shown in place of the word.
 * @param state - The state.
 * @param phase - The list.
 * @param index - The candidate's index.
 * @returns The state, and the edit.
 */
const highlight = (
  state: Completion,
  phase: Extract<Phase, { readonly _tag: "Listed" }>,
  index: number
): Completed => {
  const next = placed(phase.spot, phase.candidates[index]?.text ?? phase.spot.word, phase.suffix);

  return {
    edit: { ...next, place: phase.place },
    state: {
      ...state,
      applied: state.applied + 1,
      caret: next.caret,
      phase: { ...phase, index, shown: next },
    },
  };
};

/**
 * Tab, or an arrow while the list is open: begins completing the word at the caret, or
 * moves through the list under way, or waits for the answer asked for.
 * @param state - The state.
 * @param event - The Tab.
 * @param sources - The sources.
 * @returns The state, and the edit.
 */
const tabbed = (
  state: Completion,
  event: Extract<CompletionEvent, { readonly _tag: "Tabbed" }>,
  sources: Sources
): Completed => {
  const phase = at(state, event.place, event.text);

  if (phase === undefined || phase.shown.caret !== event.caret || phase._tag === "Unmatched") {
    return begin(state, event, sources);
  }

  // Asked already: another Tab waits for the same answer.
  if (phase._tag === "Asking") {
    return { edit: undefined, state };
  }

  if (phase._tag === "Following") {
    const list = followed(phase.shown, sources);

    if (list?.pending === true) {
      return { edit: undefined, state };
    }

    return list === undefined
      ? begin(state, event, sources)
      : listing(
          state,
          phase.place,
          list.spot,
          list.found,
          event.backwards ? list.found.candidates.length - 1 : 0
        );
  }

  const count = phase.candidates.length;
  const step = event.backwards ? count - 1 : 1;
  // From none highlighted, forwards is the first and backwards the last.
  const first = event.backwards ? count - 1 : 0;
  const index = phase.index === undefined ? first : (phase.index + step) % count;

  return highlight(state, phase, index);
};

/**
 * A candidate picked from the list, written in only if it is listed for the draft shown.
 * @param state - The state.
 * @param event - The pick.
 * @param sources - The sources, which a list that follows typing is derived from.
 * @returns The state, and the edit.
 */
const picked = (
  state: Completion,
  event: Extract<CompletionEvent, { readonly _tag: "Picked" }>,
  sources: Sources
): Completed => {
  const phase = at(state, event.place, event.text);
  const { index } = event;
  const none: Completed = { edit: undefined, state: { ...state, phase: idle } };

  if (phase?._tag === "Listed") {
    return index >= 0 && index < phase.candidates.length ? highlight(state, phase, index) : none;
  }

  const list = phase?._tag === "Following" ? followed(phase.shown, sources) : undefined;

  return list !== undefined && index >= 0 && index < list.found.candidates.length
    ? listing(state, event.place, list.spot, list.found, index)
    : none;
};

/**
 * The selection moved without the text changing: away from where completion left the
 * caret, it lets go. A move with the text changed too is what was typed, which says so.
 * @param state - The state.
 * @param event - The move.
 * @returns The state, and no edit.
 */
const movedTo = (
  state: Completion,
  event: Extract<CompletionEvent, { readonly _tag: "Moved" }>
): Completed => {
  const phase = at(state, event.place, event.text);
  const stayed = event.start === event.end && event.start === phase?.shown.caret;

  return phase === undefined || stayed
    ? { edit: undefined, state }
    : { edit: undefined, state: { ...state, phase: idle } };
};

/**
 * Escape: gives back what was typed in place of the candidate highlighted, if any, and
 * closes the list.
 * @param state - The state.
 * @param event - The Escape.
 * @returns The state, and the edit.
 */
const escaped = (
  state: Completion,
  event: Extract<CompletionEvent, { readonly _tag: "Escaped" }>
): Completed => {
  const { phase } = state;

  if (phase._tag === "Listed" && phase.place === event.place) {
    const restored = typedOf(phase.spot);

    return {
      edit: { ...restored, place: phase.place },
      state: { ...state, applied: state.applied + 1, caret: restored.caret, phase: idle },
    };
  }

  return { edit: undefined, state: { ...state, phase: idle } };
};

/**
 * The state after an event, and what to put in the composer.
 * @param state - The state before.
 * @param event - What happened.
 * @param sources - What a word can be completed from, at the composer's place.
 * @returns The state after, and the edit.
 */
export const reduceCompletion = (
  state: Completion,
  event: CompletionEvent,
  sources: Sources
): Completed => {
  const { phase } = state;
  const unchanged: Completed = { edit: undefined, state };

  switch (event._tag) {
    case "Typed": {
      return typedIn(state, event, sources);
    }

    case "Tabbed": {
      return tabbed(state, event, sources);
    }

    case "Picked": {
      return picked(state, event, sources);
    }

    case "Moved": {
      return movedTo(state, event);
    }

    case "NicksRead": {
      if (phase._tag !== "Asking" || phase.request !== event.request) {
        return unchanged;
      }

      // The answer is only for the draft it was asked for: one replaced since, or another
      // composer shown, lets it go, so it never writes over what is there now.
      if (event.place !== phase.place || event.text !== phase.shown.text) {
        return { edit: undefined, state: { ...state, phase: idle } };
      }

      const suffix = atLineStart(phase.spot.before) ? sources.suffix : " ";
      const nicks = orderNicks(event.nicks, sources);

      return listing(
        state,
        phase.place,
        phase.spot,
        { candidates: nicks.map(asWord), suffix },
        phase.backwards ? nicks.length - 1 : 0
      );
    }

    case "NicksFailed": {
      return phase._tag === "Asking" && phase.request === event.request
        ? {
            edit: undefined,
            state: {
              ...state,
              phase: {
                _tag: "Unmatched",
                place: phase.place,
                shown: phase.shown,
                word: phase.spot.word,
              },
            },
          }
        : unchanged;
    }

    case "Escaped": {
      return escaped(state, event);
    }

    case "LetGo": {
      return phase._tag === "Idle"
        ? unchanged
        : { edit: undefined, state: { ...state, phase: idle } };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Lets go of what was being completed, as when the draft was replaced other than by
 * completion.
 * @param state - The state.
 * @returns The state, completing nothing.
 */
export const cancelled = (state: Completion): Completion =>
  state.phase._tag === "Idle" ? state : { ...state, phase: idle };

/**
 * The members route's request to make now: the prefix of the nick being completed, in the
 * Channel being completed in, under its request.
 * @param state - The state.
 * @returns The request, or none.
 */
export const nicksWanted = (
  state: Completion
):
  | { readonly request: number; readonly timeline: TimelineId; readonly prefix: string }
  | undefined =>
  state.phase._tag === "Asking"
    ? { prefix: state.phase.prefix, request: state.phase.request, timeline: state.phase.timeline }
    : undefined;

/**
 * Whether completion is on an emoji word whose names are not loaded yet, so a Frontend
 * loads them now: a word of `:` and two or more characters of a name, which nothing else
 * completes, and none held.
 * @param state - The state.
 * @param sources - What a word can be completed from there.
 * @returns Whether it is.
 */
export const emojiWanted = (state: Completion, sources: Sources): boolean =>
  state.phase._tag === "Following" && followed(state.phase.shown, sources)?.pending === true;

/**
 * One candidate as the list shows it, with the `text` it writes into the draft, in place of
 * the word or the whole argument, and `name`, what it shows.
 *
 * - `Command`: a command, by its name with its `/`, with what its usage says it takes after
 *   its name, what it does, and the chords bound to it.
 * - `Timeline`: a Timeline after `/go`, by its name, with its Network and its kind.
 * - `Theme`: a theme after `/theme`, whether it is built in or imported, and whether it is
 *   the one the option it sets names on this device.
 * - `Font`: a font after `/set ui.font`, or a family typed by name, and whether it is the one
 *   in effect on this device.
 * - `Network`: a Network after `/network remove`, by its id, and whether it was removed with
 *   its Timelines kept.
 * - `Word`: an option's name, a Channel's name, or a nick.
 * - `Emoji`: an emoji after `:`, by the `:name:` its query matched, with the emoji itself,
 *   which is what it writes.
 */
export type Candidate =
  | {
      readonly _tag: "Command";
      readonly name: string;
      readonly text: string;
      readonly takes: string;
      readonly description: string;
      readonly chords: readonly Chord[];
    }
  | {
      readonly _tag: "Timeline";
      readonly name: string;
      readonly text: string;
      readonly network: NetworkId;
      readonly kind: "Network" | "Channel" | "Direct";
    }
  | {
      readonly _tag: "Theme";
      readonly name: string;
      readonly text: string;
      readonly builtIn: boolean;
      readonly current: boolean;
    }
  | {
      readonly _tag: "Font";
      readonly name: FontShown;
      readonly text: string;
      readonly current: boolean;
    }
  | {
      readonly _tag: "Network";
      readonly name: NetworkId;
      readonly text: string;
      readonly removed: boolean;
    }
  | { readonly _tag: "Word"; readonly name: string; readonly text: string }
  | {
      readonly _tag: "Emoji";
      readonly name: string;
      readonly emoji: string;
      readonly text: string;
    };

/** The list shown above a composer, and which candidate, if any, is highlighted. */
export interface List {
  readonly candidates: readonly Candidate[];
  readonly highlighted: number | undefined;
}

/**
 * The list shown above a composer, while one is open there for what it shows: as the draft
 * is typed, derived from it and the sources as they are now, or held while one is
 * highlighted. One with nothing in it is none.
 * @param state - The state.
 * @param place - The composer's place.
 * @param text - What the composer shows.
 * @param sources - What a word can be completed from there.
 * @returns The list, or none.
 */
export const listOf = (
  state: Completion,
  place: Place,
  text: string,
  sources: Sources
): List | undefined => {
  const phase = at(state, place, text);

  if (phase?._tag === "Listed") {
    return { candidates: phase.candidates, highlighted: phase.index };
  }

  const found = phase?._tag === "Following" ? followed(phase.shown, sources)?.found : undefined;

  return found === undefined || found.candidates.length === 0
    ? undefined
    : { candidates: found.candidates, highlighted: undefined };
};

/** A theme or a font drawn while the list highlights it, in place of the one in effect. */
export type Preview =
  | { readonly _tag: "Theme"; readonly name: string }
  | { readonly _tag: "Font"; readonly font: FontShown };

/**
 * The theme or font a composer's list draws while it highlights one: only while the list
 * is held with it highlighted, and the composer still shows what completion left, so the
 * one in effect comes back once the highlight moves on, the list closes, or the draft
 * changes or is sent.
 * @param state - The state.
 * @param place - The composer's place.
 * @param text - What the composer shows.
 * @returns What is drawn in place of the one in effect, or none.
 */
export const previewOf = (state: Completion, place: Place, text: string): Preview | undefined => {
  const phase = at(state, place, text);
  const candidate = phase?._tag === "Listed" ? phase.candidates[phase.index] : undefined;

  switch (candidate?._tag) {
    case "Theme": {
      return { _tag: "Theme", name: candidate.name };
    }

    case "Font": {
      return { _tag: "Font", font: candidate.name };
    }

    case "Command":
    case "Timeline":
    case "Network":
    case "Word":
    case "Emoji":
    case undefined: {
      return undefined;
    }

    default: {
      return candidate satisfies never;
    }
  }
};

/**
 * Whether completion owns a composer's Tab, arrows, Escape, and a press on its list: while
 * a list is shown there, and, for Tab and Escape, while a nick is asked for.
 * @param state - The state.
 * @param place - The composer's place.
 * @param text - What the composer shows.
 * @param sources - What a word can be completed from there.
 * @returns Whether it does.
 */
export const owns = (state: Completion, place: Place, text: string, sources: Sources): boolean =>
  at(state, place, text)?._tag === "Asking" || listOf(state, place, text, sources) !== undefined;

/**
 * What a screen reader is told, politely, about a composer: how many the list holds as it
 * opens, or that nothing completes the word, while the composer still shows what
 * completion left it with. The list itself names the candidate highlighted.
 * @param state - The state.
 * @param place - The composer's place.
 * @param text - What the composer shows.
 * @param sources - What a word can be completed from there.
 * @returns The words, or nothing.
 */
export const announced = (
  state: Completion,
  place: Place,
  text: string,
  sources: Sources
): string => {
  const phase = at(state, place, text);

  switch (phase?._tag) {
    case "Following": {
      const count = listOf(state, place, text, sources)?.candidates.length ?? 0;

      return count === 0 ? "" : `${count} ${count === 1 ? "completion" : "completions"}`;
    }

    case "Unmatched": {
      return `Nothing completes ${phase.word}`;
    }

    case "Listed":
    case "Asking":
    case undefined: {
      return "";
    }

    default: {
      return phase satisfies never;
    }
  }
};

/**
 * Every option: those of every Configuration read, and each field of every Network, as the
 * Schema has them, so options complete before any Configuration is read.
 * @param networks - The Networks.
 * @param options - The options read.
 * @returns The options, by name, each once.
 */
export const optionsListed = (
  networks: readonly NetworkId[],
  options: readonly Option[]
): readonly OptionListed[] => {
  const listed = new Map<string, string>(
    options.map((option) => [option.name, option.description])
  );

  const add = (name: string, description: string) => {
    if (!listed.has(name)) {
      listed.set(name, description);
    }
  };

  for (const network of networks) {
    for (const field of fields) {
      add(optionName(network, [field.key]), field.description);

      if (field.kind._tag === "Tagged") {
        for (const member of field.kind.members) {
          for (const inner of member.fields) {
            add(optionName(network, [field.key, inner.key]), inner.description);
          }
        }
      }
    }
  }

  return [...listed]
    .map(([name, description]) => ({ description, name }))
    .toSorted((left, right) => byCodeUnits(left.name, right.name));
};

/**
 * A Network's `CHANTYPES` as read from `known` during a Session, which began at `since`.
 * Only one the Session said is kept: an answer of none may come before the Ircd's `005`
 * does, so it is provisional, and read again.
 */
export interface Chantypes {
  readonly since: number;
  readonly chantypes: string;
}

/**
 * The Network whose `CHANTYPES` completing at a place needs read, for the Session it is
 * in now: one connected, with none kept for that Session yet.
 * @param state - The Timelines.
 * @param place - The composer's place.
 * @param chantypes - Each Network's `CHANTYPES`, as kept.
 * @returns The Network, and when its Session began, or none.
 */
export const chantypesWanted = (
  state: Timelines,
  place: Place,
  chantypes: ReadonlyMap<NetworkId, Chantypes>
): { readonly network: NetworkId; readonly since: number } | undefined => {
  if (!isTimelinePlace(place)) {
    return undefined;
  }

  const timeline = resolve(state, place);
  const network = [...state.networks.values()].find((one) => one.timelines.has(timeline));
  const connection = network?.connection;

  return network !== undefined &&
    connection?._tag === "Connected" &&
    chantypes.get(network.network)?.since !== connection.since
    ? { network: network.network, since: connection.since }
    : undefined;
};

/**
 * A Network's `CHANTYPES`, only as read during the Session it is in now.
 * @param network - The Network, if any.
 * @param chantypes - Each Network's `CHANTYPES`, as read.
 * @returns Its `CHANTYPES`, or none while unknown.
 */
const chantypesNow = (
  network: NetworkView | undefined,
  chantypes: ReadonlyMap<NetworkId, Chantypes>
): string | undefined => {
  const read = network === undefined ? undefined : chantypes.get(network.network);
  const connection = network?.connection;

  return connection?._tag === "Connected" && read?.since === connection.since
    ? read.chantypes
    : undefined;
};

/**
 * What completion lists from beyond the Timelines, as a Frontend holds it: the options
 * read, each Network's `CHANTYPES`, `ui.suffix` in effect, the keymap, the keys the palette
 * remembers as chosen or run recently, every theme, the one each theme option names on this
 * device, and the font in effect on it, as the palette's `Listing` has them, and every emoji
 * once loaded.
 */
export interface Held {
  readonly options: readonly Option[];
  readonly chantypes: ReadonlyMap<NetworkId, Chantypes>;
  readonly suffix: string;
  readonly keymap: Keymap;
  readonly ran: readonly string[];
  readonly themes: readonly ListedTheme[];
  readonly chosen: Readonly<Record<ThemeOption, string>>;
  readonly font: FontShown;
  readonly emoji: readonly Emoji[] | undefined;
}

/**
 * What a word typed at a place can be completed from: every command, the options, every
 * Timeline and Network, the themes and fonts, the Network's Channels, and the nicks there,
 * the open Channel's members, a Direct Message's partner, or none in the Network's own
 * Timeline, with those who spoke there, latest first. A Network's `CHANTYPES` is taken only
 * as read during the Session it is in now, so one read before a reconnect is never taken
 * for the Ircd's now.
 * @param state - The Timelines.
 * @param place - The composer's place.
 * @param held - What completion lists from beyond the Timelines.
 * @returns The sources.
 */
export const sourcesOf = (state: Timelines, place: Place, held: Held): Sources => {
  const ids = [...state.networks.keys()];
  const networks = sidebar(state);

  const at = {
    chosen: held.chosen,
    commands,
    emoji: held.emoji,
    font: held.font,
    keymap: held.keymap,
    networks: networks.map((one) => ({ network: one.network, removed: one.removed })),
    options: optionsListed(ids, held.options),
    ran: held.ran,
    suffix: held.suffix,
    themes: held.themes,
    timelines: namedIn(networks),
  };

  if (!isTimelinePlace(place)) {
    return {
      ...at,
      channels: [],
      chantypes: undefined,
      network: ids.find((id) => place.startsWith(`draft ${id} `)),
      nicks: { _tag: "Listed", nicks: [] },
      recent: [],
      self: undefined,
    };
  }

  const timeline = resolve(state, place);
  const network = [...state.networks.values()].find((one) => one.timelines.has(timeline));
  const listed = network?.timelines.get(timeline);

  const channels = [...(network?.timelines.values() ?? [])]
    .flatMap((one) => (one.kind === "Channel" ? [one.name] : []))
    .toSorted(byCodeUnits);

  const window = state.windows.get(timeline);

  const recent =
    window === undefined
      ? []
      : window.items
          .toReversed()
          .flatMap((item) =>
            item.content._tag === "Message" && item.content.ours === null
              ? [item.content.sender]
              : []
          );

  const connection = network?.connection;
  const self = connection?._tag === "Connected" ? connection.nick : undefined;

  let nicks: Nicks = { _tag: "Listed", nicks: [] };

  if (listed?.kind === "Channel") {
    nicks = { _tag: "Members", timeline };
  } else if (listed?.kind === "Direct" && !listed.detached) {
    nicks = { _tag: "Listed", nicks: [listed.name] };
  }

  return {
    ...at,
    channels,
    chantypes: chantypesNow(network, held.chantypes),
    network: network?.network,
    nicks,
    recent,
    self,
  };
};
