import { Option, Predicate, Schema, SchemaGetter } from "effect";

// NULL in a column is a field the record does not have, and so is absence in a row.
const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.toType(schema)), {
      decode: SchemaGetter.transformOptional(Option.filter(Predicate.isNotNull)),
      encode: SchemaGetter.passthrough({ strict: false }),
    })
  );

const Numbered = { at: Schema.Int, sequence: Schema.Int };

const Ircd = Schema.Struct({ host: Schema.String, port: Schema.Int, tls: Schema.Boolean });

const Connected = {
  ...Numbered,
  ircd: Schema.fromJsonString(Ircd),
  network: Schema.String,
};

// `refused` is `true` or absent, so the column is 1 or NULL.
const RefusedFromBit = Schema.Literal(1).pipe(
  Schema.decodeTo(Schema.Literal(true), {
    decode: SchemaGetter.transform(() => true as const),
    encode: SchemaGetter.transform(() => 1 as const),
  })
);

const ConnectionRow = Schema.Union([
  Schema.TaggedStruct("Connection", {
    ...Connected,
    nicks: Schema.fromJsonString(Schema.Array(Schema.String)),
    phase: Schema.Literal("attempt"),
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
  Schema.TaggedStruct("Connection", {
    ...Connected,
    connection: Schema.Int,
    phase: Schema.Literal("opened"),
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
  Schema.TaggedStruct("Connection", {
    ...Connected,
    chosen: Schema.BooleanFromBit,
    connection: Schema.Int,
    phase: Schema.Literal("closing"),
    reason: Schema.String,
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
  Schema.TaggedStruct("Connection", {
    ...Connected,
    connection: Schema.Int,
    phase: Schema.Literal("closed"),
    reason: nullable(Schema.String),
    refused: nullable(RefusedFromBit),
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
]);

/** An Entry, encoded as a row of `entries` and decoded back unchanged. */
export const EntryRow = Schema.Union([
  Schema.TaggedStruct("Line", {
    ...Numbered,
    bytes: Schema.Uint8Array,
    cause: nullable(Schema.String),
    connection: Schema.Int,
    cut: nullable(Schema.BooleanFromBit),
    direction: Schema.Literals(["inbound", "outbound"]),
    network: Schema.String,
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
  ConnectionRow,
  Schema.TaggedStruct("Dropped", {
    ...Numbered,
    bytes: Schema.Uint8Array,
    cause: Schema.String,
    connection: Schema.Int,
    network: Schema.String,
    reason: Schema.String,
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
  Schema.TaggedStruct("Deadline", {
    ...Numbered,
    name: Schema.String,
    network: Schema.String,
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
  Schema.TaggedStruct("Daemon", {
    ...Numbered,
    phase: Schema.Literals(["started", "stopped"]),
    version: Schema.String,
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
]);

/** A Message, as a row of `messages`. */
export const MessageRow = Schema.Struct({
  ...Numbered,
  kind: Schema.Literals(["PRIVMSG", "NOTICE"]),
  network: Schema.String,
  sender: Schema.String,
  target: Schema.String,
  text: Schema.String,
});

/** A Gap, as a row of `gaps`. Both ends of its `ended` go in one column, so neither can be lost. */
export const GapRow = Schema.Struct({
  ...Numbered,
  ended: nullable(Schema.fromJsonString(Schema.Struct(Numbered))),
  network: Schema.String,
  reason: Schema.String,
});

/** Which rows to read, by cursor. */
export const Page = Schema.Struct({ after: Schema.Int, limit: Schema.Int });

/** The decoded form of {@link Page}. */
export type Page = typeof Page.Type;

/** Which Gaps to read, by cursor, from every Network or from one. */
export const GapPage = Schema.Struct({
  ...Page.fields,
  network: Schema.optionalKey(Schema.String),
});

/** The decoded form of {@link GapPage}. */
export type GapPage = typeof GapPage.Type;
