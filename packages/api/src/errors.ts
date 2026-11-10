/**
 * The API's typed errors, each with the status it is answered with.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

import { CallerIntent, NetworkId } from "./schemas.ts";

/** No Network by this id has been configured. */
export class UnknownNetwork extends Schema.TaggedError<
  UnknownNetwork,
  { readonly brand: unique symbol }
>()("UnknownNetwork", { network: NetworkId }, { httpApiStatus: 404 }) {}

/**
 * The Network stopped, so it took no more input. This does not mean the input was
 * refused: it may have been journaled before the Network stopped, and a restart steps
 * it. The outcome is `Uncertain`. Configuration and a retry can be given again freely. A
 * `say` must not be: ask `GET /api/networks/{network}/said/{intent}` with the `intent`
 * here, on this Daemon or the one started after it, and say it again only if the answer
 * is `NotJournaled`.
 */
export class NetworkStopped extends Schema.TaggedError<
  NetworkStopped,
  { readonly brand: unique symbol }
>()(
  "NetworkStopped",
  {
    /** The intent a `say` was given under, to ask `said` about. */
    intent: Schema.optionalKey(CallerIntent),
    network: NetworkId,
    outcome: Schema.Literal("Uncertain"),
    reason: Schema.String,
  },
  { httpApiStatus: 503 }
) {}

/**
 * The Journal could not be written or read. Its Network stays stopped until the Daemon
 * starts again, so asking again will not help: it is a 500, not a 503.
 */
export class JournalFailed extends Schema.TaggedError<
  JournalFailed,
  { readonly brand: unique symbol }
>()("JournalFailed", { reason: Schema.String }, { httpApiStatus: 500 }) {}

/**
 * The Credentials could not be read or written. The Vault tries again on the next call,
 * so once the Owner fixes its file or directory the same request succeeds: a 503.
 */
export class VaultFailed extends Schema.TaggedError<
  VaultFailed,
  { readonly brand: unique symbol }
>()("VaultFailed", { reason: Schema.String }, { httpApiStatus: 503 }) {}

/**
 * No key came with the request in `Authorization: Bearer`, and no sign-in in its
 * cookie, or none that matches. Signing in, it is a key that does not match.
 */
export class Unauthorized extends Schema.TaggedError<
  Unauthorized,
  { readonly brand: unique symbol }
>()("Unauthorized", {}, { httpApiStatus: 401 }) {}

/**
 * A request that changes something, carried by a sign-in's cookie rather than a
 * bearer key, did not come from the Daemon's own origin, so another site may have sent it.
 * Signing in and signing out are checked the same way.
 */
export class CrossOrigin extends Schema.TaggedError<
  CrossOrigin,
  { readonly brand: unique symbol }
>()("CrossOrigin", {}, { httpApiStatus: 403 }) {}

/**
 * The Daemon could not write its sign-ins, so nothing changed: a sign-in made none,
 * and a sign-out forgot none. It tries again on the next call: a 503.
 */
export class SignInsFailed extends Schema.TaggedError<
  SignInsFailed,
  { readonly brand: unique symbol }
>()("SignInsFailed", { reason: Schema.String }, { httpApiStatus: 503 }) {}

/**
 * A request the API could not read, and what was wrong with it. Each issue says where in
 * the request it was, such as `["payload", "text"]` or `["params", "network"]`.
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
