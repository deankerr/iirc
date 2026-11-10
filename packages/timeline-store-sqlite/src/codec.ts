/**
 * Schemas for what the store writes: the fold's plain types, as JSON text, and the rows
 * it reads back. Each Schema's type is checked against the fold's own, so a field the fold
 * adds fails to compile here until the store can keep it.
 *
 * @packageDocumentation
 */
import { CloseReason, Instant, IntentId, MessageId, SayKind } from "@iirc/client";
import { TimelineId, cursorOf, parseCursor } from "@iirc/timelines";
import type { Content, Directory, Position } from "@iirc/timelines";
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";

/**
 * `S` when its type and `T` are each assignable to the other, and a type naming `T`
 * otherwise, so a Schema that drifts from the fold's type fails to compile where it is made.
 * @returns A function that gives back the Schema it is given.
 */
const exactly =
  <T>() =>
  <S extends Schema.Top>(
    schema: S &
      ([S["Type"]] extends [T]
        ? [T] extends [S["Type"]]
          ? unknown
          : { readonly notExactly: T }
        : { readonly notExactly: T })
  ): S =>
    schema;

/** A whole number, as every count and sequence the store keeps is. */
const { Int } = Schema;

const PositionFields = Schema.Struct({ at: Instant, n: Int, sequence: Int });

/**
 * A position, kept as its cursor: text that sorts as positions do, so the database orders
 * by it. Text that is not a cursor `cursorOf` could write does not decode.
 */
const Cursor = exactly<Position>()(
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.toType(PositionFields),
      SchemaTransformation.transformEffect<Position, string>({
        decode: (text, options) => {
          const position = parseCursor(text);

          return position === undefined
            ? Effect.fail(new SchemaIssue.InvalidValue({ expected: "a cursor" }, text, options))
            : Effect.succeed(position);
        },
        encode: (position) => Effect.succeed(cursorOf(position)),
      })
    )
  )
);

const Provenance = Schema.Literals(["ircd", "replied", "receipt", "ours"]);

/**
 * A fact that is not a set: `Known`, `Stale`, or `Unknown`.
 * @param value - The fact's own Schema.
 * @returns The fact's Schema.
 */
const Fact = <S extends Schema.Top>(value: S) =>
  Schema.Union([
    Schema.TaggedStruct("Known", { at: Instant, from: Provenance, value }),
    Schema.TaggedStruct("Stale", { since: Instant, was: value }),
    Schema.TaggedStruct("Unknown", {}),
  ]);

const Topic = Schema.Struct({
  setAt: Schema.UndefinedOr(Instant),
  setBy: Schema.UndefinedOr(Schema.String),
  text: Schema.String,
});

const ModeChange = Schema.Struct({
  mode: Schema.String,
  param: Schema.UndefinedOr(Schema.String),
  set: Schema.Boolean,
});

const Activity = Schema.TaggedUnion({
  AwayChanged: {
    away: Schema.NullOr(Schema.Struct({ message: Schema.String })),
    nick: Schema.String,
  },
  Joined: { channel: Schema.String, nick: Schema.String },
  Kicked: {
    by: Schema.String,
    channel: Schema.String,
    nick: Schema.String,
    reason: Schema.UndefinedOr(Schema.String),
  },
  ModeChanged: { by: Schema.String, changes: Schema.Array(ModeChange), target: Schema.String },
  NickChanged: { from: Schema.String, to: Schema.String },
  Parted: {
    channel: Schema.String,
    nick: Schema.String,
    reason: Schema.UndefinedOr(Schema.String),
  },
  Quit: { nick: Schema.String, reason: Schema.UndefinedOr(Schema.String) },
  TopicChanged: { by: Schema.String, channel: Schema.String, topic: Schema.NullOr(Topic) },
});

const EndReason = Schema.TaggedUnion({
  Closed: { reason: CloseReason },
  Disabled: {},
  Error: {},
  LoginFailed: {},
  Restarted: {},
  Silent: {},
  Upgrading: { port: Int },
});

const Delivery = Schema.TaggedUnion({
  Confirmed: { at: Fact(Instant), id: Fact(MessageId), text: Schema.String },
  Pending: {},
  Unconfirmed: {},
  Unsent: {},
});

/** What an item shows. */
const Content = exactly<Content>()(
  Schema.TaggedUnion({
    Activity: {
      activity: Activity,
      at: Fact(Instant),
      id: Fact(MessageId),
      live: Schema.Boolean,
    },
    ConnectionFailed: { at: Instant, reason: EndReason },
    Message: {
      at: Fact(Instant),
      id: Fact(MessageId),
      kind: SayKind,
      live: Schema.Boolean,
      ours: Schema.UndefinedOr(Schema.Struct({ delivery: Delivery, intent: IntentId })),
      sender: Schema.String,
      tags: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
      target: Schema.String,
      text: Schema.String,
    },
    SessionBegan: { at: Instant, nick: Schema.String },
    SessionEnded: { at: Instant, reason: EndReason },
  })
);

/** An item's content, as the JSON text of its Schema encoding. */
export const ContentText = Schema.fromJsonString(Schema.toCodecJson(Content));

const Kind = Schema.Literals(["Network", "Channel", "Direct"]);

const NetworkDirectory = Schema.Struct({
  channels: Schema.ReadonlyMap(Schema.String, TimelineId),
  directs: Schema.ReadonlyMap(Schema.String, TimelineId),
  gap: Schema.UndefinedOr(Cursor),
  keyed: Schema.ReadonlyMap(
    TimelineId,
    Schema.Struct({
      id: TimelineId,
      key: Schema.String,
      kind: Schema.Literals(["Channel", "Direct"]),
      name: Schema.String,
    })
  ),
  last: Cursor,
  timeline: TimelineId,
});

/** The fold's state, which the store keeps with each step. */
const Directory = exactly<Directory>()(
  Schema.Struct({ networks: Schema.ReadonlyMap(Schema.String, NetworkDirectory) })
);

/** The directory, as the JSON text of its Schema encoding. Maps are kept as their entries. */
export const DirectoryText = Schema.fromJsonString(Schema.toCodecJson(Directory));

// Rows, as SQLite gives them: text, numbers, and `null`, which is how JSON says
// `undefined`, so each row is decoded as JSON.

/** How far the store has folded, and by which projection version. */
export const FoldedRow = Schema.toCodecJson(
  Schema.Struct({ through: Schema.UndefinedOr(Int), version: Schema.UndefinedOr(Int) })
);

/** The directory as of the last step folded. */
export const DirectoryRow = Schema.Struct({ directory: DirectoryText });

/** A Timeline, with its latest item's position. */
export const SummaryRow = Schema.toCodecJson(
  Schema.Struct({
    changed: Int,
    id: TimelineId,
    key: Schema.NullOr(Schema.String),
    kind: Kind,
    latest: Schema.UndefinedOr(Cursor),
    name: Schema.String,
    network: Schema.String,
  })
);

/** A tombstone. */
export const TombstoneRow = Schema.toCodecJson(
  Schema.Struct({ changed: Int, id: TimelineId, into: TimelineId, network: Schema.String })
);

/** A Gap. */
export const GapRow = Schema.toCodecJson(
  Schema.Struct({
    changed: Int,
    from: Cursor,
    network: Schema.String,
    to: Schema.UndefinedOr(Cursor),
  })
);

/** An item. */
export const ItemRow = Schema.toCodecJson(
  Schema.Struct({
    changed: Int,
    content: ContentText,
    network: Schema.String,
    position: Cursor,
    timeline: TimelineId,
  })
);

/** One of ours, as a delivery update reads it. */
export const OursRow = Schema.toCodecJson(
  Schema.Struct({
    content: ContentText,
    cursor: Schema.String,
    messageId: Schema.UndefinedOr(MessageId),
    timeline: TimelineId,
  })
);
