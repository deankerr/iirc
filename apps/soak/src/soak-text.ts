import { parseLine } from "@iirc/protocol/line";
import { nickOf } from "@iirc/state";

// What the soak test says, and how it reads that back. The sender says
// `soak <minute> <epochMillis>`, where the minute is `floor(epochMillis / 60000)` of its
// run, and a Log holds it as a Line or a Dropped Entry, so every reader parses the same
// text the same way (PROOF-5). The minute is what silence is judged by. The pair is the
// Message's identity: two Messages of one minute, which a clock stepped back can make, are
// told apart by their milliseconds.

const minuteMillis = 60_000;

const soakPattern = /^soak (?<n>[1-9]\d{0,14}) (?<millis>[1-9]\d{0,16})$/u;

/** A counted Message: the minute of its run, and the millisecond that names it. */
export interface Identity {
  readonly millis: number;
  readonly n: number;
}

/**
 * The text of the counted Message of a run.
 * @param millis - When the run began, in epoch milliseconds.
 * @returns The text, `soak <minute> <millis>`.
 */
export const soakText = (millis: number) => `soak ${Math.floor(millis / minuteMillis)} ${millis}`;

/**
 * Reads a counted Message back. Only the exact form counts, with no leading zero and the
 * minute the milliseconds fall in, so that something a person typed is not mistaken for
 * ours.
 * @param text - A Message's text.
 * @returns Its identity, or `undefined` if it is not a counted Message.
 */
export const soakIdentity = (text: string): Identity | undefined => {
  const { n, millis } = soakPattern.exec(text)?.groups ?? {};

  if (n === undefined || millis === undefined) {
    return undefined;
  }

  const identity = { millis: Number(millis), n: Number(n) };

  return Math.floor(identity.millis / minuteMillis) === identity.n ? identity : undefined;
};

/** A counted Message as a `PRIVMSG` Line carries it. */
export interface SoakLine extends Identity {
  /** The nick it came from, if the Line has a source. */
  readonly source: string | undefined;
  readonly target: string;
}

/**
 * Reads a counted Message from the text of a Line.
 * @param text - A Line's text.
 * @returns Its identity, Target, and source nick, or `undefined` if the Line is anything else.
 */
export const soakLine = (text: string): SoakLine | undefined => {
  const parsed = parseLine(text);

  if (parsed._tag !== "Line" || parsed.line.command !== "PRIVMSG") {
    return undefined;
  }

  const [target, body, ...more] = parsed.line.params;
  const identity = soakIdentity(body ?? "");

  return target === undefined || identity === undefined || more.length > 0
    ? undefined
    : { ...identity, source: nickOf(parsed.line.source), target };
};
