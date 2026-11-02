import { Effect, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  OpenApi,
} from "effect/http-api";

const maxPageSize = 1000;
const defaultPageSize = "100";
const start = "0";

const Phase = Schema.Literals([
  "idle",
  "connecting",
  "registering",
  "session",
  "closing",
  "closed",
]);

// Query parameters arrive as text. SQLite reads a negative LIMIT as no limit at all, so
// these bounds are what keep a Frontend from asking for the whole Log.
const IntFromString = Schema.FiniteFromString.check(Schema.isInt());

const Page = {
  after: IntFromString.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(start))
  ),
  limit: IntFromString.check(Schema.isBetween({ maximum: maxPageSize, minimum: 1 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultPageSize))
  ),
};

const Numbered = { at: Schema.Int, sequence: Schema.Int };

const Ircd = Schema.Struct({ host: Schema.String, port: Schema.Int, tls: Schema.Boolean });

const Connected = { ...Numbered, ircd: Ircd, network: Schema.String };

const OfConnection = { ...Connected, connection: Schema.Int };

const Lane = Schema.Literals(["control", "interactive", "background"]);

/**
 * Where a Network stands and why, and the Log's newest sequence (OBS-1, OBS-4), which is
 * `null` when the Log cannot be read. Times are epoch milliseconds. `self` and `joined`
 * describe the current Session, and `refusal` is the Network's own words while its
 * refusal stands. `nextAttemptAt` is `null` while a Connection is under way or the Daemon
 * is stopping. A rejected Channel is one no `JOIN` can carry, so it is never tried, and
 * only its name is here because a key is a Credential (CRED-3). Between Connections, and
 * while the Log is at fault, `self`, `joined`, and `lagMillis` are empty, because no
 * Session is current. `logFault.retryMillis` is the wait that `retryAt` stands for.
 */
const Status = Schema.Struct({
  closeReason: Schema.NullOr(Schema.String),
  consecutiveFailures: Schema.Int,
  head: Schema.NullOr(Schema.Int),
  joinFailures: Schema.Array(
    Schema.Struct({
      at: Schema.Int,
      channel: Schema.String,
      connection: Schema.NullOr(Schema.Int),
      numeric: Schema.String,
      text: Schema.String,
    })
  ),
  joined: Schema.Array(Schema.String),
  kicked: Schema.Array(Schema.Struct({ at: Schema.Int, channel: Schema.String })),
  lagMillis: Schema.NullOr(Schema.Int),
  lanes: Schema.Struct({
    background: Schema.Int,
    control: Schema.Int,
    interactive: Schema.Int,
  }),
  logFault: Schema.NullOr(
    Schema.Struct({ failures: Schema.Int, retryAt: Schema.Int, retryMillis: Schema.Int })
  ),
  network: Schema.String,
  nextAttemptAt: Schema.NullOr(Schema.Int),
  phase: Phase,
  refusal: Schema.NullOr(Schema.String),
  refused: Schema.Boolean,
  rejectedChannels: Schema.Array(
    Schema.Struct({
      channel: Schema.String,
      reason: Schema.Literals(["InvalidChannel", "InvalidKey", "TooLong"]),
    })
  ),
  self: Schema.NullOr(Schema.String),
});

/** The decoded form of {@link Status}. */
export type Status = typeof Status.Type;

/**
 * One Entry in the Log. `at` is epoch milliseconds. A Line carries its bytes as base64,
 * because hostile bytes must survive JSON (API-4), beside `text`, their decoded form,
 * and `reason` says why they could not be parsed, if they could not (HOST-1). A Dropped
 * Entry carries the Line that never left in the same way, and its `reason` says why.
 */
export const LogEntry = Schema.Union([
  Schema.TaggedStruct("Line", {
    ...Numbered,
    bytes: Schema.Uint8ArrayFromBase64,
    cause: Schema.optionalKey(Schema.String),
    connection: Schema.Int,
    cut: Schema.optionalKey(Schema.Boolean),
    direction: Schema.Literals(["inbound", "outbound"]),
    network: Schema.String,
    reason: Schema.optionalKey(Schema.Literals(["Empty", "NoCommand"])),
    text: Schema.String,
  }),
  Schema.TaggedStruct("Connection", {
    ...Connected,
    nicks: Schema.Array(Schema.String),
    phase: Schema.Literal("attempt"),
  }),
  Schema.TaggedStruct("Connection", { ...OfConnection, phase: Schema.Literal("opened") }),
  Schema.TaggedStruct("Connection", {
    ...OfConnection,
    chosen: Schema.Boolean,
    phase: Schema.Literal("closing"),
    reason: Schema.String,
  }),
  Schema.TaggedStruct("Connection", {
    ...OfConnection,
    phase: Schema.Literal("closed"),
    reason: Schema.optionalKey(Schema.String),
    refused: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("Dropped", {
    ...Numbered,
    bytes: Schema.Uint8ArrayFromBase64,
    cause: Schema.String,
    connection: Schema.Int,
    network: Schema.String,
    reason: Schema.String,
    text: Schema.String,
  }),
  Schema.TaggedStruct("Deadline", {
    ...Numbered,
    name: Schema.String,
    network: Schema.String,
  }),
  Schema.TaggedStruct("Daemon", {
    ...Numbered,
    phase: Schema.Literals(["started", "stopped"]),
    version: Schema.String,
  }),
]);

/** The decoded form of {@link LogEntry}. */
export type LogEntry = typeof LogEntry.Type;

/** Something a participant said, with the sequence of the Line that carried it. */
const LoggedMessage = Schema.Struct({
  ...Numbered,
  kind: Schema.Literals(["PRIVMSG", "NOTICE"]),
  network: Schema.String,
  sender: Schema.String,
  target: Schema.String,
  text: Schema.String,
});

/**
 * Time the Daemon was not on a Network, from the `sequence` where it began. An open Gap
 * has no `ended`, which is the `001` that closed it (LIVE-10).
 */
export const Gap = Schema.Struct({
  ...Numbered,
  ended: Schema.optionalKey(Schema.Struct(Numbered)),
  network: Schema.String,
  reason: Schema.String,
});

/** The decoded form of {@link Gap}. */
export type Gap = typeof Gap.Type;

/**
 * What became of a Line the Daemon took (API-9). `written` left, under that sequence.
 * `queued` is still in its lane after the wait, and may yet leave or be Dropped.
 */
const Sent = Schema.Union([
  Schema.Struct({ sequence: Schema.Int, status: Schema.Literal("written") }),
  Schema.Struct({ status: Schema.Literal("queued") }),
]);

/** There is no Session on the Network to send through. */
export class NotInSession extends Schema.TaggedError<
  NotInSession,
  { readonly brand: unique symbol }
>()("NotInSession", { phase: Phase }, { httpApiStatus: 409 }) {}

/** The Message cannot be sent safely as a Line. */
export class InvalidMessage extends Schema.TaggedError<
  InvalidMessage,
  { readonly brand: unique symbol }
>()(
  "InvalidMessage",
  {
    reason: Schema.Literals([
      "EmptyText",
      "InvalidCommand",
      "InvalidParameter",
      "InvalidTarget",
      "TooLong",
    ]),
  },
  { httpApiStatus: 422 }
) {}

/** The lane holds as many Lines as it may, so nothing was queued (SEND-3). */
export class LaneFull extends Schema.TaggedError<LaneFull, { readonly brand: unique symbol }>()(
  "LaneFull",
  { lane: Lane },
  { httpApiStatus: 429 }
) {}

/** The Line was queued, and its Connection ended before it left (SEND-4). */
export class LineDropped extends Schema.TaggedError<
  LineDropped,
  { readonly brand: unique symbol }
>()("LineDropped", { reason: Schema.String }, { httpApiStatus: 409 }) {}

/** The Line was recorded and its write did not finish, so it may not have reached the Ircd. */
export class WriteFailed extends Schema.TaggedError<
  WriteFailed,
  { readonly brand: unique symbol }
>()("WriteFailed", { reason: Schema.String }, { httpApiStatus: 502 }) {}

/** The Log could not be read or appended to, and `/status` has the fault (LOG-9). */
export class LogUnavailable extends Schema.TaggedError<
  LogUnavailable,
  { readonly brand: unique symbol }
>()("LogUnavailable", {}, { httpApiStatus: 503 }) {}

/**
 * A request the API could not read, and what was wrong with it (API-3). Each issue gives
 * where in the request it was, such as `["query", "limit"]` or `["payload", "text"]`.
 */
export class InvalidRequest extends Schema.TaggedError<
  InvalidRequest,
  { readonly brand: unique symbol }
>()(
  "InvalidRequest",
  {
    issues: Schema.Array(
      Schema.Struct({
        message: Schema.String,
        path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
      })
    ),
  },
  { httpApiStatus: 400 }
) {}

/**
 * Turns a request that fails to decode into an {@link InvalidRequest}. It applies to the
 * whole API, so every operation declares it.
 */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  "@iirc/api/RequestValidation",
  { error: InvalidRequest }
) {}

/** The contract every Frontend drives the Daemon through. */
export class DaemonApi extends HttpApi.make("iirc")
  .add(
    HttpApiGroup.make("health").add(
      HttpApiEndpoint.get("health", "/health", {
        success: Schema.Struct({ status: Schema.Literal("ok") }),
      })
    )
  )
  .add(
    HttpApiGroup.make("daemon").add(
      HttpApiEndpoint.get("status", "/status", { success: Status }),
      HttpApiEndpoint.get("entries", "/entries", {
        error: LogUnavailable,
        query: Page,
        success: Schema.Array(LogEntry),
      }),
      HttpApiEndpoint.get("messages", "/messages", {
        error: LogUnavailable,
        query: Page,
        success: Schema.Array(LoggedMessage),
      }),
      HttpApiEndpoint.get("gaps", "/gaps", {
        error: LogUnavailable,
        query: { ...Page, network: Schema.optionalKey(Schema.String) },
        success: Schema.Array(Gap),
      }),
      HttpApiEndpoint.post("send", "/messages", {
        error: [InvalidMessage, LaneFull, LineDropped, LogUnavailable, NotInSession, WriteFailed],
        payload: Schema.Struct({ target: Schema.String, text: Schema.String }),
        success: Sent,
      })
    )
  )
  .middleware(RequestValidation)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "iirc daemon" })) {}
