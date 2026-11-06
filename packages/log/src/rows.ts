import type {
  Entry,
  IfFieldsOfEntry,
  Ircd as IrcdOf,
  TlsDetails as TlsDetailsOf,
} from "@iirc/session/entry";
import type { Casemapping } from "@iirc/state";
import { Option, Predicate, Schema, SchemaGetter } from "effect";

// One Schema for every field of `T`, and none for any other, which an object literal of
// them can be checked against.
type FieldsOf<T> = { readonly [Key in keyof T]-?: Schema.Top };

type TuningOf = Extract<Entry, { readonly phase: "attempt" }>["tuning"];

// NULL in a column is a field the record does not have, and so is absence in a row.
const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.toType(schema)), {
      decode: SchemaGetter.transformOptional(Option.filter(Predicate.isNotNull)),
      encode: SchemaGetter.passthrough({ strict: false }),
    })
  );

const Numbered = { at: Schema.Int, sequence: Schema.Int };

// The names of the Credentials whose values a Line's bytes hold as `<redacted>`, as JSON
// text (LOG-6).
const Redacted = Schema.fromJsonString(Schema.Array(Schema.String));

const Ircd = Schema.Struct({
  host: Schema.String,
  pin: Schema.optionalKey(Schema.String),
  port: Schema.Int,
  tls: Schema.Boolean,
} satisfies FieldsOf<IrcdOf>);

// What a field an `attempt` from before it existed left out is read as: the default it
// had when it arrived, written out here so that a new default cannot rewrite history
// (CONF-1). It needs no Effect, because every `attempt` is read at every start.
const orDefault =
  <S extends Schema.Top>(value: S["Type"]) =>
  (self: S) =>
    Schema.optionalKey(Schema.toEncoded(self)).pipe(
      Schema.decodeTo(self, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => value)),
        encode: SchemaGetter.passthrough(),
      })
    );

// The whole Tuning an `attempt` ran with, kept as it was. Whether it was a good one was
// decided before it ran, so nothing here judges it, and reading it back must not fail.
// Every field is listed, and checked against lifecycle's. An `attempt` recorded before the
// encoding, the casemapping, and CTCP replies were Tuning has none of them, and reads as
// no fallback, the Ircd's mapping, and the CTCP defaults (MSG-4, KNOW-3, PROT-3, PROT-4).
// The label is kept as recorded, and whoever decodes with it parses it.
// Each mapping `@iirc/state` folds under, which a new one fails to compile without.
const everyMapping = {
  ascii: "ascii",
  rfc1459: "rfc1459",
  "rfc1459-strict": "rfc1459-strict",
  rfc8265: "rfc8265",
} as const satisfies { readonly [Key in Casemapping]: Key };

/** Every mapping `@iirc/state` folds under (KNOW-3). */
export const casemappings: readonly Casemapping[] = Object.values(everyMapping);

const CasemappingColumn = Schema.Literals(Object.values(everyMapping));

const Tuning = Schema.Struct({
  burstMillis: Schema.Int,
  casemapping: Schema.optionalKey(CasemappingColumn),
  connectTimeoutMillis: Schema.Int,
  controlLaneLimit: Schema.Int,
  ctcpNetworkLimit: Schema.Int.pipe(orDefault(5)),
  ctcpNetworkWindowMillis: Schema.Int.pipe(orDefault(60_000)),
  ctcpPing: Schema.Boolean.pipe(orDefault(true)),
  ctcpTime: Schema.Boolean.pipe(orDefault(false)),
  ctcpUserIntervalMillis: Schema.Int.pipe(orDefault(10_000)),
  ctcpVersion: Schema.Boolean.pipe(orDefault(true)),
  drainMillis: Schema.Int,
  encoding: Schema.optionalKey(Schema.String),
  floodBurst: Schema.Int,
  floodIntervalMillis: Schema.Int,
  joinRetryMillis: Schema.Int,
  kickRejoinMillis: Schema.Int,
  lagCheckMillis: Schema.Int,
  laneLimit: Schema.Int,
  loginWaitMillis: Schema.Int,
  quitWaitMillis: Schema.Int,
  reconnectInitialMillis: Schema.Int,
  reconnectMaxMillis: Schema.Int,
  registrationTimeoutMillis: Schema.Int,
  rejoinSettleMillis: Schema.Int,
  sendWaitMillis: Schema.Int,
  silenceMillis: Schema.Int,
  stableAfterMillis: Schema.Int,
  writeTimeoutMillis: Schema.Int,
} satisfies FieldsOf<TuningOf>);

const TlsDetails = Schema.Struct({
  cipher: Schema.String,
  pin: Schema.String,
  protocol: Schema.String,
  verifiedBy: Schema.Literals(["authority", "pin"]),
} satisfies FieldsOf<TlsDetailsOf>);

const Connected = {
  ...Numbered,
  ircd: Schema.fromJsonString(Ircd),
  network: Schema.String,
};

// `refused` is `true` or absent, so the column is 1 or NULL. Only earlier Daemons wrote it,
// for a close they took as a refusal (LIVE-5).
const RefusedFromBit = Schema.Literal(1).pipe(
  Schema.decodeTo(Schema.Literal(true), {
    decode: SchemaGetter.transform(() => true as const),
    encode: SchemaGetter.transform(() => 1 as const),
  })
);

const ConnectionRow = Schema.Union([
  Schema.TaggedStruct("Connection", {
    ...Connected,
    loginLines: Schema.Int,
    nicks: Schema.fromJsonString(Schema.Array(Schema.String)),
    phase: Schema.Literal("attempt"),
    realname: Schema.String,
    services: Schema.fromJsonString(Schema.Array(Schema.String)),
    tuning: Schema.fromJsonString(Tuning),
    username: Schema.String,
  }).pipe(Schema.encodeKeys({ _tag: "kind", loginLines: "login_lines" })),
  Schema.TaggedStruct("Connection", {
    ...Connected,
    connection: Schema.Int,
    phase: Schema.Literal("opened"),
    tls: nullable(Schema.fromJsonString(TlsDetails)),
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
    endedAt: nullable(Schema.Int),
    phase: Schema.Literal("closed"),
    reason: nullable(Schema.String),
    refused: nullable(RefusedFromBit),
  }).pipe(Schema.encodeKeys({ _tag: "kind", endedAt: "ended_at" })),
]);

const entryRow = Schema.Union([
  Schema.TaggedStruct("Line", {
    ...Numbered,
    bytes: Schema.Uint8Array,
    cause: nullable(Schema.String),
    connection: Schema.Int,
    cut: nullable(Schema.BooleanFromBit),
    direction: Schema.Literals(["inbound", "outbound"]),
    network: Schema.String,
    redacted: nullable(Redacted),
    redactedBy: nullable(Schema.Int),
  }).pipe(Schema.encodeKeys({ _tag: "kind", redactedBy: "redacted_by" })),
  ConnectionRow,
  // `change` is JSON text that only its reader decodes further, so `null` is the text
  // `null` and never a missing column.
  Schema.TaggedStruct("Change", {
    ...Numbered,
    by: Schema.String,
    change: Schema.fromJsonString(Schema.Json),
    network: nullable(Schema.String),
  }).pipe(Schema.encodeKeys({ _tag: "kind" })),
  Schema.TaggedStruct("Dropped", {
    ...Numbered,
    bytes: Schema.Uint8Array,
    cause: Schema.String,
    connection: Schema.Int,
    network: Schema.String,
    reason: Schema.String,
    redacted: nullable(Redacted),
    redactedBy: nullable(Schema.Int),
  }).pipe(Schema.encodeKeys({ _tag: "kind", redactedBy: "redacted_by" })),
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

/**
 * An Entry, encoded as a row of `entries` and decoded back unchanged. Its kinds and their
 * fields are checked against Entry's, so a new one fails to compile until it has a column.
 */
export const EntryRow: IfFieldsOfEntry<typeof entryRow.Type, typeof entryRow> = entryRow;

/** Where a Message or an Activity belongs (MSG-2), as `@iirc/state/place` gives it. */
export const Place = Schema.Union([
  Schema.TaggedStruct("Network", {}),
  Schema.TaggedStruct("Channel", { key: Schema.String, name: Schema.String }),
  Schema.TaggedStruct("User", { key: Schema.String, name: Schema.String }),
]);

/** The decoded form of {@link Place}, which is `@iirc/state/place`'s. */
export type Place = typeof Place.Type;

// A place is three columns, so that a Timeline is a range over an index. The Network's has
// no key or name, which are `''` rather than NULL, so the index compares them like others.
const PlaceColumns = {
  place_key: Schema.String,
  place_kind: Schema.Literals(["Network", "Channel", "User"]),
  place_name: Schema.String,
};

interface PlaceColumns {
  readonly place_key: string;
  readonly place_kind: "Network" | "Channel" | "User";
  readonly place_name: string;
}

const placeOfColumns = ({ place_key, place_kind, place_name }: PlaceColumns): Place =>
  place_kind === "Network"
    ? { _tag: "Network" }
    : { _tag: place_kind, key: place_key, name: place_name };

const columnsOfPlace = (place: Place): PlaceColumns =>
  place._tag === "Network"
    ? { place_key: "", place_kind: "Network", place_name: "" }
    : { place_key: place.key, place_kind: place._tag, place_name: place.name };

// A column that is NULL for a field the row does not have. Unlike `nullable`, it encodes
// to NULL rather than leaving the key out, because a batch insert takes its columns from
// its first row, and a later row must not lose one.
const orNull = <A>(value: A | undefined): A | null => value ?? null;

/** What a Message's text was, as MSG-1 and PROT-2 tell them apart. */
const MessageKind = Schema.Literals(["PRIVMSG", "NOTICE", "ACTION"]);

const messageFields = {
  ...Numbered,
  kind: MessageKind,
  network: Schema.String,
  sender: Schema.String,
  target: Schema.String,
  text: Schema.String,
};

/** A Message, as a row of `messages`. Its place is three columns of its own. */
export const MessageRow = Schema.Struct({
  ...messageFields,
  ...PlaceColumns,
  statusmsg: Schema.NullOr(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({
      ...messageFields,
      place: Place,
      statusmsg: Schema.optionalKey(Schema.String),
    }),
    {
      decode: SchemaGetter.transform(
        ({ place_key, place_kind, place_name, statusmsg, ...message }) => ({
          ...message,
          place: placeOfColumns({ place_key, place_kind, place_name }),
          ...(statusmsg !== null && { statusmsg }),
        })
      ),
      encode: SchemaGetter.transform(({ place, statusmsg, ...message }) => ({
        ...message,
        ...columnsOfPlace(place),
        statusmsg: orNull(statusmsg),
      })),
    }
  )
);

const Params = Schema.Array(Schema.String);

const optionalString = Schema.optionalKey(Schema.String);

/**
 * What an Activity says, by its kind (MSG-5, PROT-1, PROT-2, PROT-5, PROT-6). Each holds
 * what the Line said, as data: nothing in it is ever acted on.
 */
export const ActivityDetails = Schema.Union([
  Schema.Struct({ host: optionalString, kind: Schema.Literal("join"), user: optionalString }),
  Schema.Struct({ kind: Schema.Literal("part"), reason: optionalString }),
  Schema.Struct({ kind: Schema.Literal("quit"), reason: optionalString }),
  /** `nick` was kicked, by the Activity's actor. */
  Schema.Struct({ kind: Schema.Literal("kick"), nick: Schema.String, reason: optionalString }),
  Schema.Struct({ from: Schema.String, kind: Schema.Literal("nick"), to: Schema.String }),
  /** `""` cleared it. */
  Schema.Struct({ kind: Schema.Literal("topic"), topic: Schema.String }),
  /**
   * The letters and parameters after the Target, and, for a Channel's `MODE` that added up
   * under `PREFIX` and `CHANMODES`, each change they made (KNOW-6).
   */
  Schema.Struct({
    changes: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          adding: Schema.Boolean,
          letter: Schema.String,
          param: optionalString,
        })
      )
    ),
    kind: Schema.Literal("mode"),
    params: Params,
  }),
  /** `nick` was invited to `channel`, which is recorded and never followed (LIVE-8). */
  Schema.Struct({ channel: Schema.String, kind: Schema.Literal("invite"), nick: Schema.String }),
  /**
   * A CTCP other than `ACTION` and `DCC`. A `NOTICE` carries a reply, and a `PRIVMSG` a
   * request, which is never answered here (PROT-2, PROT-3).
   */
  Schema.Struct({
    args: Schema.String,
    command: Schema.String,
    kind: Schema.Literal("ctcp"),
    reply: Schema.Boolean,
  }),
  /** A DCC offer, recorded and never acted on (PROT-5). */
  Schema.Struct({ args: Schema.String, kind: Schema.Literal("dcc"), subcommand: Schema.String }),
  /** A `FAIL`, `WARN`, or `NOTE` (PROT-6). */
  Schema.Struct({
    code: Schema.String,
    command: Schema.String,
    context: Params,
    description: Schema.String,
    kind: Schema.Literal("reply"),
    reply: Schema.Literals(["FAIL", "WARN", "NOTE"]),
  }),
  /** A Line the Daemon handles that has no Activity of its own, such as a numeric (MSG-6). */
  Schema.Struct({ command: Schema.String, kind: Schema.Literal("line"), params: Params }),
  /** A Line of a command the Daemon does not handle (PROT-1). */
  Schema.Struct({ command: Schema.String, kind: Schema.Literal("unknown"), params: Params }),
]);

/** The decoded form of {@link ActivityDetails}. */
export type ActivityDetails = typeof ActivityDetails.Type;

/** Every kind of Activity. */
export type ActivityKind = ActivityDetails["kind"];

const activityKinds = {
  ctcp: "ctcp",
  dcc: "dcc",
  invite: "invite",
  join: "join",
  kick: "kick",
  line: "line",
  mode: "mode",
  nick: "nick",
  part: "part",
  quit: "quit",
  reply: "reply",
  topic: "topic",
  unknown: "unknown",
} as const satisfies { readonly [Kind in ActivityKind]: Kind };

const activityFields = {
  ...Numbered,
  casemapping: CasemappingColumn,
  network: Schema.String,
  ordinal: Schema.Int,
};

/**
 * An Activity, as a row of `activity`. Its place is three columns, and its kind is a column
 * of its own beside the JSON of its details, so that it can be filtered on, though only the
 * details are read back.
 */
export const ActivityRow = Schema.Struct({
  ...activityFields,
  ...PlaceColumns,
  actor: Schema.NullOr(Schema.String),
  details: Schema.fromJsonString(ActivityDetails),
  kind: Schema.Literals(Object.values(activityKinds)),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({
      ...activityFields,
      actor: optionalString,
      details: ActivityDetails,
      place: Place,
    }),
    {
      decode: SchemaGetter.transform(
        ({ actor, details, kind: _kind, place_key, place_kind, place_name, ...activity }) => ({
          ...activity,
          ...(actor !== null && { actor }),
          details,
          place: placeOfColumns({ place_key, place_kind, place_name }),
        })
      ),
      encode: SchemaGetter.transform(({ actor, details, place, ...activity }) => ({
        ...activity,
        ...columnsOfPlace(place),
        actor: orNull(actor),
        details,
        kind: details.kind,
      })),
    }
  )
);

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

/**
 * Where a read of Activity resumes. With only `sequence`, after the whole of that Entry, as
 * every other read's `after` and `/stream`'s sequence mean. With `ordinal` too, after that
 * one row of it, which is where a page cut inside an Entry ends. A row's own `sequence` and
 * `ordinal` are the cursor that resumes after it, so a reader passes back the last row's.
 */
export const ActivityCursor = Schema.Struct({
  ordinal: Schema.optionalKey(Schema.Int),
  sequence: Schema.Int,
});

/** The decoded form of {@link ActivityCursor}. */
export type ActivityCursor = typeof ActivityCursor.Type;

/** Which Activity to read, by cursor, as the writer reads it. */
export const ActivityPage = Schema.Struct({ after: ActivityCursor, limit: Schema.Int });

/** The decoded form of {@link ActivityPage}. */
export type ActivityPage = typeof ActivityPage.Type;

/**
 * The bound parameters of an {@link ActivityCursor}, for `(sequence, ordinal) > (?, ?)`. A
 * whole Entry is behind the cursor when no ordinal could follow it, and SQLite's integers
 * are 64 bits, so no row has an ordinal past the largest safe one.
 * @param cursor - The cursor.
 * @returns The sequence and the ordinal to read after.
 */
export const afterCursor = ({ ordinal, sequence }: ActivityCursor) =>
  [sequence, ordinal ?? Number.MAX_SAFE_INTEGER] as const;
