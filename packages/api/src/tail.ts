/**
 * The Tail on the wire: a line the Daemon logged, the Tail whole, and the events of the
 * stream that follows it. The Tail is held in the Daemon's memory and gone when it
 * restarts, so nothing here is journaled and no line names an Entry.
 *
 * @packageDocumentation
 */
import { Instant } from "@iirc/client";
import { Schema } from "effect";

import { After } from "./schemas.ts";

/** How severe a line is, from `Debug`, the least the Tail keeps, to `Fatal`. */
export const TailLevel = Schema.Literals(["Debug", "Info", "Warn", "Error", "Fatal"]);

/** The decoded form of {@link TailLevel}. */
export type TailLevel = typeof TailLevel.Type;

/**
 * Which line of this Daemon's Tail it is: `1` for the first it logged, counting up, so a
 * line dropped from the Tail leaves its number unused.
 */
export const TailNumber = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })
);

/**
 * One line the Daemon logged: its number, the instant it was logged, its level, its words,
 * its annotations, each as text, such as `network`, and, when it was logged with one, its
 * cause as text. Every part is text the Daemon wrote down, which may hold an Ircd's or a
 * stranger's words, so a Frontend shows it as text, never as markup.
 */
export const TailLine = Schema.Struct({
  annotations: Schema.Record(Schema.String, Schema.String),
  at: Instant,
  cause: Schema.optionalKey(Schema.String),
  level: TailLevel,
  message: Schema.String,
  n: TailNumber,
});

/** The decoded form of {@link TailLine}. */
export type TailLine = typeof TailLine.Type;

/**
 * Which Daemon a Tail is of: its version, and the instant it started. A Daemon that
 * restarted has started anew, so a Frontend holding another `started` holds another Tail.
 */
export const TailDaemon = Schema.Struct({ started: Instant, version: Schema.String });

/** The decoded form of {@link TailDaemon}. */
export type TailDaemon = typeof TailDaemon.Type;

/** The Tail whole, oldest first, with the Daemon it is of. */
export const TailRead = Schema.Struct({
  lines: Schema.Array(TailLine),
  started: Instant,
  version: Schema.String,
});

/** The decoded form of {@link TailRead}. */
export type TailRead = typeof TailRead.Type;

/**
 * One event of the stream of the Tail: `daemon` comes first as the stream opens, saying
 * which Daemon it is of, with no id; `line` carries one line, with its number as its id;
 * and `heartbeat` says the stream is alive. A Frontend that followed after a number from
 * another Daemon, as `daemon` shows, reads the Tail again.
 */
export const TailEvent = Schema.Union([
  Schema.Struct({
    data: Schema.fromJsonString(TailDaemon),
    event: Schema.Literal("daemon"),
  }),
  Schema.Struct({
    data: Schema.fromJsonString(TailLine),
    event: Schema.Literal("line"),
    id: After,
  }),
  Schema.Struct({
    data: Schema.fromJsonString(Schema.Struct({})),
    event: Schema.Literal("heartbeat"),
  }),
]);

/** The decoded form of {@link TailEvent}. */
export type TailEvent = typeof TailEvent.Type;
