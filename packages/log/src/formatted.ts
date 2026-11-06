import { parseFormatting } from "@iirc/protocol/format";
import type { Span as ParsedSpan } from "@iirc/protocol/format";
import { Schema } from "effect";

import type { LoggedActivity, LoggedMessage } from "./fold.ts";
import { ActivityDetails, Place } from "./rows.ts";

const Colour = Schema.Union([
  Schema.TaggedStruct("Palette", { index: Schema.Int }),
  Schema.TaggedStruct("Hex", { hex: Schema.String }),
]);

const styled = Schema.optionalKey(Schema.Literal(true));

/**
 * Some text with no formatting code in it, and the formatting in force over it, holding
 * only the styles that are on (MSG-3). A colour that is absent is the Frontend's default.
 */
const Span = Schema.Struct({
  background: Schema.optionalKey(Colour),
  bold: styled,
  foreground: Schema.optionalKey(Colour),
  italic: styled,
  monospace: styled,
  reverse: styled,
  strikethrough: styled,
  text: Schema.String,
  underline: styled,
});

/** The decoded form of {@link Span}. */
type Span = typeof Span.Type;

/** Text a participant wrote, raw, beside the same text as spans (MSG-3). */
const Formatted = Schema.Struct({ spans: Schema.Array(Span), text: Schema.String });

/** The decoded form of {@link Formatted}. */
type Formatted = typeof Formatted.Type;

// Only what is on is said, so a plain Message costs one small object.
const spanOf = ({ style, text }: ParsedSpan): Span => ({
  text,
  ...(style.bold && { bold: true }),
  ...(style.italic && { italic: true }),
  ...(style.underline && { underline: true }),
  ...(style.strikethrough && { strikethrough: true }),
  ...(style.monospace && { monospace: true }),
  ...(style.reverse && { reverse: true }),
  ...(style.foreground !== undefined && { foreground: style.foreground }),
  ...(style.background !== undefined && { background: style.background }),
});

const formatted = (text: string): Formatted => ({
  spans: parseFormatting(text).map(spanOf),
  text,
});

const [join, part, quit, kick, nick, topic, mode, invite, ctcp, dcc, reply, line, unknown] =
  ActivityDetails.members;

const optionalFormatted = Schema.optionalKey(Formatted);

/**
 * What an Activity says, as a read gives it: what a participant or an Ircd wrote, a
 * reason, a topic, a CTCP's or a DCC offer's arguments, and a standard reply's
 * description, is {@link Formatted} (MSG-3). The rest is as the Log holds it.
 */
const FormattedDetails = Schema.Union([
  join,
  Schema.Struct({ ...part.fields, reason: optionalFormatted }),
  Schema.Struct({ ...quit.fields, reason: optionalFormatted }),
  Schema.Struct({ ...kick.fields, reason: optionalFormatted }),
  nick,
  Schema.Struct({ ...topic.fields, topic: Formatted }),
  mode,
  invite,
  Schema.Struct({ ...ctcp.fields, args: Formatted }),
  Schema.Struct({ ...dcc.fields, args: Formatted }),
  Schema.Struct({ ...reply.fields, description: Formatted }),
  line,
  unknown,
]);

/** The decoded form of {@link FormattedDetails}. */
export type FormattedDetails = typeof FormattedDetails.Type;

/** A Message as a read gives it: as the Log holds it, with its text as spans (MSG-3). */
export const ReadMessage = Schema.Struct({
  at: Schema.Int,
  kind: Schema.Literals(["PRIVMSG", "NOTICE", "ACTION"]),
  network: Schema.String,
  place: Place,
  sender: Schema.String,
  sequence: Schema.Int,
  spans: Schema.Array(Span),
  statusmsg: Schema.optionalKey(Schema.String),
  target: Schema.String,
  text: Schema.String,
});

/** The decoded form of {@link ReadMessage}. */
export type ReadMessage = typeof ReadMessage.Type;

/**
 * An Activity as a read gives it: with its details' participant text as spans (MSG-3),
 * and the mapping its place's key was casefolded under (KNOW-3).
 */
export const ReadActivity = Schema.Struct({
  actor: Schema.optionalKey(Schema.String),
  at: Schema.Int,
  casemapping: Schema.Literals(["ascii", "rfc1459", "rfc1459-strict", "rfc8265"]),
  details: FormattedDetails,
  network: Schema.String,
  ordinal: Schema.Int,
  place: Place,
  sequence: Schema.Int,
});

/** The decoded form of {@link ReadActivity}. */
export type ReadActivity = typeof ReadActivity.Type;

/** A row as a read gives it, and how many spans formatting it made. */
export interface FormattedRow<Row> {
  readonly row: Row;
  readonly spans: number;
}

/**
 * A Message with its spans (MSG-3).
 * @param message - As the Log holds it.
 * @returns It, and how many spans it made.
 */
export const formatMessage = (message: LoggedMessage): FormattedRow<ReadMessage> => {
  const { spans } = formatted(message.text);

  return { row: { ...message, spans }, spans: spans.length };
};

// Each kind is listed, so a new one fails to compile here until a read says how to give it.
const formatDetails = (details: LoggedActivity["details"]): FormattedRow<FormattedDetails> => {
  const counted = (row: FormattedDetails, given?: Formatted) => ({
    row,
    spans: given?.spans.length ?? 0,
  });

  switch (details.kind) {
    case "part":
    case "quit":
    case "kick": {
      const { reason, ...rest } = details;
      const given = reason === undefined ? undefined : formatted(reason);

      return counted({ ...rest, ...(given !== undefined && { reason: given }) }, given);
    }

    case "topic": {
      const given = formatted(details.topic);

      return counted({ kind: "topic", topic: given }, given);
    }

    case "ctcp":
    case "dcc": {
      const args = formatted(details.args);

      return counted({ ...details, args }, args);
    }

    case "reply": {
      const description = formatted(details.description);

      return counted({ ...details, description }, description);
    }

    case "invite":
    case "join":
    case "line":
    case "mode":
    case "nick":
    case "unknown": {
      return counted(details);
    }

    default: {
      return details satisfies never;
    }
  }
};

/**
 * An Activity with its participant text as spans (MSG-3).
 * @param activity - As the Log holds it.
 * @returns It, and how many spans it made.
 */
export const formatActivity = (activity: LoggedActivity): FormattedRow<ReadActivity> => {
  const { row, spans } = formatDetails(activity.details);

  return { row: { ...activity, details: row }, spans };
};
