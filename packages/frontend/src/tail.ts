/**
 * The Tail as a Frontend holds it: what was read of it, then each line the stream gave
 * after, of one Daemon, as a reducer. Nothing here is derived from the Journal, and nothing
 * outlives the Daemon it is of.
 *
 * @packageDocumentation
 */
import type { TailDaemon, TailLevel, TailLine, TailRead, TailShown } from "@iirc/api";

/** The most lines held, as many as the Daemon keeps: one more lets go of the oldest. */
export const tailCap = 4096;

/** The Tail held: which Daemon it is of, and its lines, oldest first. */
export interface HeldTail {
  readonly version: string;
  readonly started: number;
  readonly lines: readonly TailLine[];
}

/**
 * What happened to the Tail held.
 *
 * - `Read`: the Tail was read whole, which replaces whatever was held.
 * - `Opened`: the stream opened, saying which Daemon it is of. Another than the one held
 *   is a Daemon that restarted, so what is held is let go, to be read again.
 * - `Logged`: the stream gave a line.
 */
export type TailEvent =
  | { readonly _tag: "Read"; readonly read: TailRead }
  | { readonly _tag: "Opened"; readonly daemon: TailDaemon }
  | { readonly _tag: "Logged"; readonly line: TailLine };

/**
 * Where to follow the stream from: the number of the last line held, or none when none is,
 * so every line held by the Daemon comes.
 * @param held - The Tail held.
 * @returns The number, or none.
 */
export const lastNumber = (held: HeldTail): number | undefined => held.lines.at(-1)?.n;

/**
 * The Tail held after an event, or none once there is nothing to follow from.
 * @param held - The Tail held, if any.
 * @param event - What happened.
 * @returns The Tail held after it, if any.
 */
export const reduceTail = (held: HeldTail | undefined, event: TailEvent): HeldTail | undefined => {
  switch (event._tag) {
    case "Read": {
      const { lines, started, version } = event.read;

      return { lines: lines.slice(-tailCap), started, version };
    }

    case "Opened": {
      return held?.started === event.daemon.started ? held : undefined;
    }

    case "Logged": {
      // A line at or before the last held was given already, as a stream followed again can.
      if (held === undefined || event.line.n <= (lastNumber(held) ?? 0)) {
        return held;
      }

      return { ...held, lines: [...held.lines, event.line].slice(-tailCap) };
    }

    default: {
      return event satisfies never;
    }
  }
};

/** Each level's rank, least first. */
const ranks: Readonly<Record<TailLevel, number>> = {
  Debug: 0,
  Error: 3,
  Fatal: 4,
  Info: 1,
  Warn: 2,
};

/**
 * Whether a level is at least another.
 * @param level - The level.
 * @param least - The least it may be.
 * @returns Whether it is.
 */
export const atLeast = (level: TailLevel, least: TailLevel): boolean =>
  ranks[level] >= ranks[least];

/**
 * The lines a view shows: those at `least` and above, oldest first.
 * @param held - The Tail held.
 * @param least - The least level shown.
 * @returns The lines.
 */
export const linesShown = (held: HeldTail, least: TailLevel): readonly TailLine[] =>
  held.lines.filter((line) => atLeast(line.level, least));

/** The least level each value of `ui.logs` names. */
const leastOf: Readonly<Record<TailShown, TailLevel>> = {
  debug: "Debug",
  error: "Error",
  info: "Info",
  warning: "Warn",
};

/**
 * The least level a view shows under a value of `ui.logs`.
 * @param shown - The value.
 * @returns The level.
 */
export const leastShown = (shown: TailShown): TailLevel => leastOf[shown];
