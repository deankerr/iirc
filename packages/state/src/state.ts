import type { Line } from "@iirc/protocol/line";

/** What a Session knows about itself, derived entirely from inbound Lines. */
export interface SessionState {
  readonly self: string | undefined;
  readonly channels: readonly string[];
}

/** The state of a Session before any Line has arrived. */
export const initialState: SessionState = { channels: [], self: undefined };

/** Something a participant said. */
export interface Message {
  readonly kind: "PRIVMSG" | "NOTICE";
  readonly sender: string;
  readonly target: string;
  readonly text: string;
}

const nickOf = (source: string | undefined) => source?.split(/[!@]/u, 1)[0];

const without = (channels: readonly string[], channel: string | undefined) =>
  channels.filter((joined) => joined !== channel);

/**
 * Advances a Session's state by one inbound Line.
 * @param state - The state so far.
 * @param line - The Line that arrived.
 * @returns The state after that Line.
 */
export const reduce = (state: SessionState, line: Line): SessionState => {
  const [first, second] = line.params;
  const fromSelf = state.self !== undefined && nickOf(line.source) === state.self;

  switch (line.command) {
    case "001": {
      return first === undefined ? state : { ...state, self: first };
    }

    case "NICK": {
      return fromSelf && first !== undefined ? { ...state, self: first } : state;
    }

    case "JOIN": {
      return fromSelf && first !== undefined
        ? { ...state, channels: [...without(state.channels, first), first] }
        : state;
    }

    case "PART": {
      return fromSelf ? { ...state, channels: without(state.channels, first) } : state;
    }

    case "KICK": {
      return second !== undefined && second === state.self
        ? { ...state, channels: without(state.channels, first) }
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
