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
  Schema.TaggedStruct("Connection", {
    ...Numbered,
    connection: nullable(Schema.Int),
    ircd: Schema.fromJsonString(Ircd),
    network: Schema.String,
    phase: Schema.Literals(["attempt", "opened", "closed"]),
    reason: nullable(Schema.String),
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

/** Which rows to read, by cursor. */
export const Page = Schema.Struct({ after: Schema.Int, limit: Schema.Int });

/** The decoded form of {@link Page}. */
export type Page = typeof Page.Type;
