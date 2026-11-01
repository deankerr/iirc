import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

const maxPageSize = 1000;
const defaultPageSize = "100";
const start = "0";

const Phase = Schema.Literals(["idle", "connecting", "registering", "session", "closed"]);

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

/** Where a Network stands, and the Log's newest sequence. */
const Status = Schema.Struct({
  closeReason: Schema.NullOr(Schema.String),
  head: Schema.Int,
  network: Schema.String,
  phase: Phase,
});

/**
 * One Entry in the Log. `at` is epoch milliseconds. A Line carries its bytes as base64,
 * because hostile bytes must survive JSON (API-4), beside `text`, their decoded form,
 * and `reason` says why they could not be parsed, if they could not (HOST-1).
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
    ...Numbered,
    connection: Schema.optionalKey(Schema.Int),
    ircd: Ircd,
    network: Schema.String,
    phase: Schema.Literals(["attempt", "opened", "closed"]),
    reason: Schema.optionalKey(Schema.String),
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
        query: Page,
        success: Schema.Array(LogEntry),
      }),
      HttpApiEndpoint.get("messages", "/messages", {
        query: Page,
        success: Schema.Array(LoggedMessage),
      }),
      HttpApiEndpoint.post("send", "/messages", {
        error: [InvalidMessage, NotInSession],
        payload: Schema.Struct({ target: Schema.String, text: Schema.String }),
        success: Schema.Void,
      })
    )
  )
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "iirc daemon" })) {}
