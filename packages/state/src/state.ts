import type { Line } from "@iirc/protocol/line";

/** Why an Ircd would not let Self into a Channel. */
export interface JoinFailure {
  readonly numeric: string;
  readonly text: string;
}

/** What a Session knows about itself, derived entirely from inbound Lines. */
export interface SessionState {
  readonly self: string | undefined;
  readonly channels: readonly string[];
  /** Each Channel's latest `JOIN` failure, until Self gets in (LIVE-7). */
  readonly joinFailures: ReadonlyMap<string, JoinFailure>;
  /** Channels Self was kicked from and is not back in (LIVE-8). */
  readonly kicked: readonly string[];
  /** `NICKLEN` from `RPL_ISUPPORT`, the limit for the next Connection's nicks (CONN-4). */
  readonly nickLength: number | undefined;
}

/** The state of a Session before any Line has arrived. */
export const initialState: SessionState = {
  channels: [],
  joinFailures: new Map(),
  kicked: [],
  nickLength: undefined,
  self: undefined,
};

// Every way a `JOIN` is refused (LIVE-7), and `@iirc/session` decides which of them retry.
// `437` is here as well as in CONN-4, because it also applies to Channels. One naming a
// nick lands under that nick, where nothing that asks about a Channel will find it.
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

/** Something a participant said. */
export interface Message {
  readonly kind: "PRIVMSG" | "NOTICE";
  readonly sender: string;
  readonly target: string;
  readonly text: string;
}

const nickLengthToken = /^NICKLEN=(?<length>[1-9]\d*)$/u;

const nickOf = (source: string | undefined) => source?.split(/[!@]/u, 1)[0];

const without = (channels: readonly string[], channel: string | undefined) =>
  channels.filter((joined) => joined !== channel);

const withoutFailure = (failures: ReadonlyMap<string, JoinFailure>, channel: string) => {
  const remaining = new Map(failures);

  remaining.delete(channel);

  return remaining;
};

// Tokens run to the last parameter, which is usually prose and never looks like one.
const nickLengthFrom = (tokens: readonly string[], current: number | undefined) => {
  let length = current;

  for (const token of tokens) {
    const value = nickLengthToken.exec(token)?.groups?.length;

    if (value !== undefined) {
      length = Number(value);
    } else if (token === "-NICKLEN") {
      length = undefined;
    }
  }

  return length;
};

const withJoinFailure = (state: SessionState, { command, params }: Line, channel: string) => ({
  ...state,
  joinFailures: new Map(state.joinFailures).set(channel, {
    numeric: command,
    text: params.at(-1) ?? "",
  }),
});

const afterJoin = (state: SessionState, channel: string) => ({
  ...state,
  channels: [...without(state.channels, channel), channel],
  joinFailures: withoutFailure(state.joinFailures, channel),
  kicked: without(state.kicked, channel),
});

const afterKick = (state: SessionState, channel: string) => ({
  ...state,
  channels: without(state.channels, channel),
  kicked: [...without(state.kicked, channel), channel],
});

/**
 * Advances a Session's state by one inbound Line.
 * @param state - The state so far.
 * @param line - The Line that arrived.
 * @returns The state after that Line.
 */
export const reduce = (state: SessionState, line: Line): SessionState => {
  const [first, second] = line.params;
  const fromSelf = state.self !== undefined && nickOf(line.source) === state.self;
  const failed = joinFailureNumerics.has(line.command) ? failedChannel(line) : undefined;

  if (failed !== undefined) {
    return withJoinFailure(state, line, failed);
  }

  switch (line.command) {
    // The first welcome names Self, and an Ircd may only rename us with a `NICK`.
    case "001": {
      return first === undefined || state.self !== undefined ? state : { ...state, self: first };
    }

    case "NICK": {
      return fromSelf && first !== undefined ? { ...state, self: first } : state;
    }

    case "005": {
      return { ...state, nickLength: nickLengthFrom(line.params.slice(1), state.nickLength) };
    }

    case "JOIN": {
      return fromSelf && first !== undefined ? afterJoin(state, first) : state;
    }

    case "PART": {
      return fromSelf ? { ...state, channels: without(state.channels, first) } : state;
    }

    case "KICK": {
      return first !== undefined && second !== undefined && second === state.self
        ? afterKick(state, first)
        : state;
    }

    default: {
      return state;
    }
  }
};

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
