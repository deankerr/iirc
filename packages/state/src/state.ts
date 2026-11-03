import type { Line } from "@iirc/protocol/line";

import { refolded, withChannel, withKey, withoutChannel } from "./channels.ts";
import type { Channel, Channels } from "./channels.ts";
import { casefold, defaultIsupport, withIsupport } from "./isupport.ts";
import type { Isupport } from "./isupport.ts";
import { parseModes } from "./modes.ts";

export type { Channel, Channels } from "./channels.ts";

export { casefold } from "./isupport.ts";

export type { Casemapping, Isupport } from "./isupport.ts";

/**
 * What one Session's Ircd has said of Self and the Channels Self is in, folded from its
 * inbound Lines by {@link stepState}. A Session is one Connection from its welcome, so a
 * new Connection starts again from {@link initialState} (LIVE-6).
 */
export interface IrcState {
  /** Self's nick, as the welcome or a later `NICK` gave it. */
  readonly self: string | undefined;
  readonly isupport: Isupport;
  /** Keyed by name casefolded under `isupport.casemapping`. Bounded, dropping the oldest. */
  readonly channels: Channels;
}

/** The state of a Session before any Line has arrived. */
export const initialState: IrcState = {
  channels: new Map(),
  isupport: defaultIsupport,
  self: undefined,
};

/** Why an Ircd would not let Self into a Channel. */
export interface JoinFailure {
  readonly numeric: string;
  readonly text: string;
}

/**
 * What one Line did, each named. Channels are spelled as the Line spelled them, except
 * that leaving one names it as Self held it.
 */
export type StateChange =
  /** The welcome began the Session and named Self. Nothing from before it carries in. */
  | { readonly _tag: "Welcomed"; readonly self: string }
  | { readonly _tag: "NickChanged"; readonly from: string; readonly to: string }
  /** Self is in a Channel, perhaps again. */
  | { readonly _tag: "Joined"; readonly channel: string }
  | { readonly _tag: "Parted"; readonly channel: string }
  | {
      readonly _tag: "Kicked";
      readonly by: string | undefined;
      readonly channel: string;
      readonly reason: string | undefined;
    }
  /**
   * The Ircd refused a `JOIN` (LIVE-7). `437` names nicks as well as Channels, so this can
   * name a nick, and only someone who asked for a Channel knows which it was.
   */
  | ({ readonly _tag: "JoinRefused"; readonly channel: string } & JoinFailure)
  /** `param` is where in the `MODE`'s parameters the key stood. */
  | {
      readonly _tag: "KeySet";
      readonly channel: string;
      readonly key: string;
      readonly param: number;
    }
  | { readonly _tag: "KeyCleared"; readonly channel: string }
  | { readonly _tag: "IsupportChanged"; readonly isupport: Isupport };

/** A state and what changed to reach it. */
export interface SteppedState {
  readonly changes: readonly StateChange[];
  readonly next: IrcState;
}

// Every way a `JOIN` is refused (LIVE-7). `437` is here as well as in CONN-4, because it
// also applies to Channels.
const joinFailureNumerics: ReadonlySet<string> = new Set([
  "403",
  "405",
  "407",
  "437",
  "471",
  "473",
  "474",
  "475",
  "476",
  "477",
  "479",
  "489",
  "520",
]);

// RFC 2812 gives `476` no `<client>`, and Ircds still follow it, so its Channel can come
// first. Left at the second parameter, the failure would land under its own prose.
const failedChannel = ({ command, params }: Line) =>
  command === "476" && params.length === 2 ? params[0] : params[1];

const nickOf = (source: string | undefined) => source?.split(/[!@]/u, 1)[0];

const unchanged = (state: IrcState): SteppedState => ({ changes: [], next: state });

// A comma never belongs to a name, so `JOIN` and `PART` can each name several Channels.
const targetsOf = (list: string | undefined) =>
  list === undefined ? [] : list.split(",").filter((name) => name !== "");

const fold = (state: IrcState, name: string) => casefold(state.isupport.casemapping, name);

const isSelf = (state: IrcState, nick: string | undefined) =>
  state.self !== undefined && nick !== undefined && fold(state, nick) === fold(state, state.self);

/**
 * The Channel Self is in by that name, however it is spelled.
 * @param state - The Session's state.
 * @param name - The Channel, spelled any way the mapping in force allows.
 * @returns The Channel, or `undefined` if Self is not in it.
 */
export const channelOf = (state: IrcState, name: string): Channel | undefined =>
  state.channels.get(fold(state, name));

const afterWelcome = (state: IrcState, [self]: readonly string[]): SteppedState =>
  state.self !== undefined || self === undefined
    ? unchanged(state)
    : { changes: [{ _tag: "Welcomed", self }], next: { ...initialState, self } };

const afterNick = (state: IrcState, line: Line): SteppedState => {
  const [to] = line.params;
  const from = state.self;

  return from === undefined ||
    to === undefined ||
    to === from ||
    !isSelf(state, nickOf(line.source))
    ? unchanged(state)
    : { changes: [{ _tag: "NickChanged", from, to }], next: { ...state, self: to } };
};

const afterIsupport = (state: IrcState, tokens: readonly string[]): SteppedState => {
  const isupport = withIsupport(state.isupport, tokens);

  if (isupport === state.isupport) {
    return unchanged(state);
  }

  const channels =
    isupport.casemapping === state.isupport.casemapping
      ? state.channels
      : refolded(state.channels, isupport.casemapping);

  return {
    changes: [{ _tag: "IsupportChanged", isupport }],
    next: { ...state, channels, isupport },
  };
};

const afterJoin = (state: IrcState, line: Line): SteppedState => {
  if (!isSelf(state, nickOf(line.source))) {
    return unchanged(state);
  }

  const names = targetsOf(line.params[0]);
  let { channels } = state;

  for (const name of names) {
    channels = withChannel(channels, state.isupport.casemapping, name);
  }

  return {
    changes: names.map((channel) => ({ _tag: "Joined", channel })),
    next: { ...state, channels },
  };
};

const afterPart = (state: IrcState, line: Line): SteppedState => {
  if (!isSelf(state, nickOf(line.source))) {
    return unchanged(state);
  }

  const changes: StateChange[] = [];
  let { channels } = state;

  for (const name of targetsOf(line.params[0])) {
    const folded = fold(state, name);
    const held = channels.get(folded);

    if (held !== undefined) {
      channels = withoutChannel(channels, folded);
      changes.push({ _tag: "Parted", channel: held.name });
    }
  }

  return changes.length === 0 ? unchanged(state) : { changes, next: { ...state, channels } };
};

// A `KICK` may name several Channels and Users, which pair up in order, or one Channel and
// several Users. Each pair is a kick of its own, and only one of Self from a Channel Self
// is in changes anything.
const afterKick = (state: IrcState, line: Line): SteppedState => {
  const [list = "", users = "", reason] = line.params;
  const named = list.split(",");
  const changes: StateChange[] = [];
  let { channels } = state;

  for (const [index, user] of users.split(",").entries()) {
    const name = named.length === 1 ? list : (named[index] ?? "");
    const folded = fold(state, name);
    const held = channels.get(folded);

    if (name !== "" && held !== undefined && isSelf(state, user)) {
      channels = withoutChannel(channels, folded);
      changes.push({ _tag: "Kicked", by: nickOf(line.source), channel: held.name, reason });
    }
  }

  return changes.length === 0 ? unchanged(state) : { changes, next: { ...state, channels } };
};

// The last `k` a `MODE` touches is the key it leaves. One that does not add up says
// nothing, and nor does a key shown as `*`, which is hidden (KNOW-6).
const afterMode = (state: IrcState, line: Line): SteppedState => {
  const [channel = "", ...rest] = line.params;
  const folded = fold(state, channel);

  if (!state.channels.has(folded)) {
    return unchanged(state);
  }

  const parsed = parseModes(rest, state.isupport.modes);
  const at = parsed.changes.findLastIndex(({ letter }) => letter === "k");
  const last = parsed.changes[at];

  if (parsed._tag === "Uneven" || last === undefined) {
    return unchanged(state);
  }

  if (!last.adding) {
    return {
      changes: [{ _tag: "KeyCleared", channel }],
      next: { ...state, channels: withKey(state.channels, folded, undefined) },
    };
  }

  if (last.param === undefined || last.param === "*") {
    return unchanged(state);
  }

  // Each change that took a parameter took the next one after the letters, so the key's
  // is as far along as the changes before it that took one.
  const param =
    2 + parsed.changes.slice(0, at).filter((change) => change.param !== undefined).length;

  return {
    changes: [{ _tag: "KeySet", channel, key: last.param, param }],
    next: { ...state, channels: withKey(state.channels, folded, last.param) },
  };
};

const afterJoinFailure = (state: IrcState, line: Line, channel: string): SteppedState => ({
  changes: [
    { _tag: "JoinRefused", channel, numeric: line.command, text: line.params.at(-1) ?? "" },
  ],
  next: state,
});

// Every command {@link stepState} reads, beside the `JOIN` failures.
const readCommands: ReadonlySet<string> = new Set([
  "001",
  "005",
  "JOIN",
  "KICK",
  "MODE",
  "NICK",
  "PART",
]);

/**
 * Whether {@link stepState} reads Lines of a command at all, so that a host can skip what
 * would only look again at a state no such Line can change.
 * @param command - A Line's command.
 * @returns Whether a Line of it can change a Session's state.
 */
export const readsCommand = (command: string): boolean =>
  readCommands.has(command) || joinFailureNumerics.has(command);

/**
 * Advances a Session's state by one inbound Line, and says what that changed. Never
 * throws, and leaves `state` as it is.
 * @param state - The state so far.
 * @param line - The Line that arrived.
 * @returns The state after it, the very same one when it changed nothing, and each change.
 */
export const stepState = (state: IrcState, line: Line): SteppedState => {
  if (!readsCommand(line.command)) {
    return unchanged(state);
  }

  const failed = joinFailureNumerics.has(line.command) ? failedChannel(line) : undefined;

  if (failed !== undefined) {
    return afterJoinFailure(state, line, failed);
  }

  switch (line.command) {
    // The first welcome names Self, and an Ircd may only rename us with a `NICK`.
    case "001": {
      return afterWelcome(state, line.params);
    }

    case "005": {
      return afterIsupport(state, line.params.slice(1));
    }

    case "NICK": {
      return afterNick(state, line);
    }

    case "JOIN": {
      return afterJoin(state, line);
    }

    case "PART": {
      return afterPart(state, line);
    }

    case "KICK": {
      return afterKick(state, line);
    }

    case "MODE": {
      return afterMode(state, line);
    }

    default: {
      return unchanged(state);
    }
  }
};

/** Something a participant said. */
export interface Message {
  readonly kind: "PRIVMSG" | "NOTICE";
  readonly sender: string;
  readonly target: string;
  readonly text: string;
}

/**
 * Derives the Message a Line carries, if it carries one.
 * @param line - The Line to read.
 * @param sender - Who sent it when the Line has no source, as our own Lines don't.
 * @returns The Message, or `undefined` for any other Line.
 */
export const messageOf = (line: Line, sender?: string): Message | undefined => {
  const [target, text] = line.params;
  const from = nickOf(line.source) ?? sender;

  if (
    (line.command !== "PRIVMSG" && line.command !== "NOTICE") ||
    target === undefined ||
    text === undefined ||
    from === undefined
  ) {
    return undefined;
  }

  return { kind: line.command, sender: from, target, text };
};
