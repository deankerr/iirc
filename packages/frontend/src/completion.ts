/**
 * Tab completion in the composer, as a reducer: the word at the caret, completed from
 * what it can be, a command after `/` at the start of a line, an option after `/set `, a
 * Channel's name, or a nick, and cycled through with Tab and Shift+Tab. Escape gives back
 * what was typed. A nick in a Channel comes from the Daemon's members route, which the
 * runtime asks while this waits; everything else is at hand.
 *
 * @packageDocumentation
 */
import type { NetworkId, TimelineId } from "@iirc/api";
import { casefold } from "@iirc/protocol/casemapping";

import { commands } from "./commands.ts";
import type { Place } from "./composer.ts";
import { fields, optionName } from "./options.ts";
import type { Option } from "./options.ts";
import { opened, resolve } from "./timelines.ts";
import type { NetworkView, Timelines } from "./timelines.ts";

/** What follows a nick completed at the start of a line, as IRC clients address someone. */
export const nickSuffix = ": ";

/** How many nicks the members route is asked for. */
export const nicksLimit = 100;

/** Where a nick can come from: the open Channel's members, which the Daemon is asked for, or a list at hand. */
export type Nicks =
  | { readonly _tag: "Members"; readonly timeline: TimelineId }
  | { readonly _tag: "Listed"; readonly nicks: readonly string[] };

/** What a word can be completed from, for the composer at one place. */
export interface Sources {
  /** Every command's name and alias, without its `/`. */
  readonly commands: readonly string[];
  /** Every option's name. */
  readonly options: readonly string[];
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
 * - `Cycling`: a candidate is shown in place of the word, and Tab moves on.
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
  | {
      readonly _tag: "Cycling";
      readonly place: Place;
      readonly spot: Spot;
      readonly candidates: readonly string[];
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
 * - `Tabbed`: Tab, or Shift+Tab `backwards`, with the composer's text and caret.
 * - `NicksRead`: the members route answered a request, with their nicks in its order, and
 *   the composer under the main view as it is now: its place and its draft's text.
 * - `NicksFailed`: it did not.
 * - `Escaped`: Escape, which gives back what was typed.
 * - `LetGo`: the draft was changed or replaced other than by completion, as by typing,
 *   recalling, sending, or the palette, so what was being completed is let go of.
 */
export type CompletionEvent =
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
 * Whether completion is under way in a composer, so Escape and Tab are its.
 * @param state - The state.
 * @param place - The composer's place.
 * @param shown - What the composer shows.
 * @returns Whether it is.
 */
export const active = (state: Completion, place: Place, shown: Shown): boolean => {
  const { phase } = state;

  return (
    (phase._tag === "Cycling" || phase._tag === "Asking") &&
    phase.place === place &&
    phase.shown.text === shown.text &&
    phase.shown.caret === shown.caret
  );
};

const asciiLower = (text: string) => text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

const startsAscii = (name: string, prefix: string) =>
  asciiLower(name).startsWith(asciiLower(prefix));

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
 * Cycling through candidates, with the first, or the last going backwards, shown.
 * @param state - The state.
 * @param place - The composer's place.
 * @param spot - The word.
 * @param candidates - The candidates.
 * @param suffix - What follows each.
 * @param backwards - Whether Shift+Tab began it.
 * @returns The state, and the edit.
 */
const cycling = (
  state: Completion,
  place: Place,
  spot: Spot,
  candidates: readonly string[],
  suffix: string,
  backwards: boolean
): Completed => {
  const original = {
    caret: spot.before.length + spot.word.length,
    text: `${spot.before}${spot.word}${spot.after}`,
  };

  if (candidates.length === 0) {
    return {
      edit: undefined,
      state: { ...state, phase: { _tag: "Unmatched", place, shown: original, word: spot.word } },
    };
  }

  const index = backwards ? candidates.length - 1 : 0;
  const shown = placed(spot, candidates[index] ?? spot.word, suffix);

  return {
    edit: { ...shown, place },
    state: {
      ...state,
      applied: state.applied + 1,
      caret: shown.caret,
      phase: { _tag: "Cycling", candidates, index, place, shown, spot, suffix },
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

  const lineStart = atLineStart(before);
  const line = before.slice(before.lastIndexOf("\n") + 1);

  if (lineStart && word.startsWith("/") && !word.startsWith("//")) {
    const typed = word.slice(1);

    const names = sources.commands
      .filter((name) => startsAscii(name, typed))
      .toSorted(byCodeUnits)
      .map((name) => `/${name}`);

    return cycling(state, place, spot, names, " ", backwards);
  }

  if (/^\/set +$/iu.test(line)) {
    const names = sources.options.filter((name) => startsAscii(name, word));

    return cycling(state, place, spot, names, " ", backwards);
  }

  if ((sources.chantypes ?? rfc2811Chantypes).includes(word[0] ?? " ")) {
    const names = sources.channels.filter((name) => startsFolded(name, word));

    return cycling(state, place, spot, names, " ", backwards);
  }

  const suffix = lineStart ? nickSuffix : " ";

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

  return cycling(state, place, spot, nicks, suffix, backwards);
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
    case "Tabbed": {
      const shown = { caret: event.caret, text: event.text };

      if (!active(state, event.place, shown)) {
        return begin(state, event, sources);
      }

      // Asked already: another Tab waits for the same answer.
      if (phase._tag !== "Cycling") {
        return unchanged;
      }

      const count = phase.candidates.length;
      const index = (phase.index + (event.backwards ? count - 1 : 1)) % count;
      const next = placed(phase.spot, phase.candidates[index] ?? phase.spot.word, phase.suffix);

      return {
        edit: { ...next, place: phase.place },
        state: {
          ...state,
          applied: state.applied + 1,
          caret: next.caret,
          phase: { ...phase, index, shown: next },
        },
      };
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

      const suffix = atLineStart(phase.spot.before) ? nickSuffix : " ";

      return cycling(
        state,
        phase.place,
        phase.spot,
        orderNicks(event.nicks, sources),
        suffix,
        phase.backwards
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
      if (phase._tag === "Cycling" && phase.place === event.place) {
        const { spot } = phase;

        const restored = {
          caret: spot.before.length + spot.word.length,
          text: `${spot.before}${spot.word}${spot.after}`,
        };

        return {
          edit: { ...restored, place: phase.place },
          state: { ...state, applied: state.applied + 1, caret: restored.caret, phase: idle },
        };
      }

      return { edit: undefined, state: { ...state, phase: idle } };
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
 * The candidates shown in a composer, while completion is under way there, and which is
 * in place of the word.
 * @param state - The state.
 * @param place - The composer's place.
 * @param text - What the composer shows.
 * @returns The candidates and the one shown, or none.
 */
export const cycled = (
  state: Completion,
  place: Place,
  text: string
): { readonly candidates: readonly string[]; readonly index: number } | undefined => {
  const { phase } = state;

  return phase._tag === "Cycling" && phase.place === place && phase.shown.text === text
    ? { candidates: phase.candidates, index: phase.index }
    : undefined;
};

/**
 * What a screen reader is told, politely, about a composer: the candidate shown and where
 * it stands among them, or that nothing completes the word, while the composer still
 * shows what completion left it with.
 * @param state - The state.
 * @param place - The composer's place.
 * @param text - What the composer shows.
 * @returns The words, or nothing.
 */
export const announced = (state: Completion, place: Place, text: string): string => {
  const { phase } = state;

  if (phase._tag === "Idle" || phase.place !== place || phase.shown.text !== text) {
    return "";
  }

  switch (phase._tag) {
    case "Cycling": {
      return `${phase.candidates[phase.index] ?? ""}, ${phase.index + 1} of ${phase.candidates.length}`;
    }

    case "Unmatched": {
      return `Nothing completes ${phase.word}`;
    }

    case "Asking": {
      return "";
    }

    default: {
      return phase satisfies never;
    }
  }
};

/**
 * Every option's name: those of every Configuration read, and each field of every Network,
 * as the Schema has them, so options complete before any Configuration is read.
 * @param networks - The Networks.
 * @param options - The options read.
 * @returns The names, in order, each once.
 */
export const optionNames = (
  networks: readonly NetworkId[],
  options: readonly Option[]
): readonly string[] => {
  const names = new Set(options.map((option) => option.name));

  for (const network of networks) {
    for (const field of fields) {
      names.add(optionName(network, [field.key]));

      if (field.kind._tag === "Tagged") {
        for (const member of field.kind.members) {
          for (const inner of member.fields) {
            names.add(optionName(network, [field.key, inner.key]));
          }
        }
      }
    }
  }

  return [...names].toSorted(byCodeUnits);
};

/** Every command's name and alias, once each. */
const commandNames: readonly string[] = [
  ...new Set(commands.flatMap((command) => [command.name, ...command.aliases])),
];

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
  if (place === "Nowhere") {
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
 * What a word typed at a place can be completed from: the commands, the options, the
 * Network's Channels, and the nicks there, the open Channel's members, a Direct Message's
 * partner, or none in the Network's own Timeline, with those who spoke there, latest first.
 * A Network's `CHANTYPES` is taken only as read during the Session it is in now, so one
 * read before a reconnect is never taken for the Ircd's now.
 * @param state - The Timelines.
 * @param place - The composer's place.
 * @param options - The options read.
 * @param chantypes - Each Network's `CHANTYPES`, as read.
 * @returns The sources.
 */
export const sourcesOf = (
  state: Timelines,
  place: Place,
  options: readonly Option[],
  chantypes: ReadonlyMap<NetworkId, Chantypes> = new Map()
): Sources => {
  const networks = [...state.networks.keys()];

  const at = {
    commands: commandNames,
    options: optionNames(networks, options),
  };

  if (place === "Nowhere") {
    return {
      ...at,
      channels: [],
      chantypes: undefined,
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

  const shown = opened(state);

  const recent =
    shown._tag === "Shown" && shown.timeline === timeline
      ? shown.window.items
          .toReversed()
          .flatMap((item) =>
            item.content._tag === "Message" && item.content.ours === null
              ? [item.content.sender]
              : []
          )
      : [];

  const connection = network?.connection;
  const self = connection?._tag === "Connected" ? connection.nick : undefined;

  let nicks: Nicks = { _tag: "Listed", nicks: [] };

  if (listed?.kind === "Channel") {
    nicks = { _tag: "Members", timeline };
  } else if (listed?.kind === "Direct" && !listed.detached) {
    nicks = { _tag: "Listed", nicks: [listed.name] };
  }

  return { ...at, channels, chantypes: chantypesNow(network, chantypes), nicks, recent, self };
};
