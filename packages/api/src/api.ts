import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

const Phase = Schema.Literals(["connecting", "registering", "registered", "closed"]);

/** Where the Daemon's Session is, and what it has derived from the Log. */
export const Status = Schema.Struct({
  channels: Schema.Array(Schema.String),
  closeReason: Schema.NullOr(Schema.String),
  phase: Phase,
  self: Schema.NullOr(Schema.String),
});

/** One Line in the Log, kept exactly as it crossed the Connection. */
export const LogEntry = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  direction: Schema.Literals(["inbound", "outbound"]),
  sequence: Schema.Int,
  text: Schema.String,
  unparseable: Schema.NullOr(Schema.String),
});

/** Something a participant said, with the sequence of the Line that carried it. */
export const Message = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  kind: Schema.Literals(["PRIVMSG", "NOTICE"]),
  sender: Schema.String,
  sequence: Schema.Int,
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
>()("InvalidMessage", { reason: Schema.String }, { httpApiStatus: 422 }) {}

const afterCursor = { after: Schema.optional(Schema.FiniteFromString) };

/** The contract every Frontend drives the Daemon through. */
export class DaemonApi extends HttpApi.make("iirc")
  .add(
    HttpApiGroup.make("daemon").add(
      HttpApiEndpoint.get("status", "/status", { success: Status }),
      HttpApiEndpoint.get("lines", "/lines", {
        query: afterCursor,
        success: Schema.Array(LogEntry),
      }),
      HttpApiEndpoint.get("messages", "/messages", {
        query: afterCursor,
        success: Schema.Array(Message),
      }),
      HttpApiEndpoint.post("send", "/messages", {
        error: [InvalidMessage, NotInSession],
        payload: Schema.Struct({ target: Schema.String, text: Schema.String }),
        success: Schema.Void,
      })
    )
  )
  .annotateMerge(OpenApi.annotations({ title: "iirc daemon" })) {}
