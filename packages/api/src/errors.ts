/**
 * The API's typed errors, each with the status it is answered with.
 *
 * @packageDocumentation
 */
import { TimelineId } from "@iirc/timelines";
import { Schema } from "effect";

import { ByteCount, OwnerOptionName, OwnerSequence } from "./options.ts";
import { PreviewFailure, PreviewId } from "./previews.ts";
import { CallerIntent, Cursor, NetworkId, Sequence } from "./schemas.ts";
import { UiSequence } from "./ui.ts";
import { UploadId } from "./uploads.ts";

/** No Network by this id has been configured. */
export class UnknownNetwork extends Schema.TaggedError<
  UnknownNetwork,
  { readonly brand: unique symbol }
>()("UnknownNetwork", { network: NetworkId }, { httpApiStatus: 404 }) {}

/**
 * No Timeline has ever had this id, nor been merged from one that had. An id is never
 * given again to another Timeline, and a merged one reads the Timeline it went to.
 */
export class UnknownTimeline extends Schema.TaggedError<
  UnknownTimeline,
  { readonly brand: unique symbol }
>()("UnknownTimeline", { timeline: TimelineId }, { httpApiStatus: 404 }) {}

/**
 * The Timeline is the Network's own or a Direct Message partner's, not a Channel's, so it
 * has no Channel to read. A Timeline's kind never changes: a 404.
 */
export class NotAChannel extends Schema.TaggedError<
  NotAChannel,
  { readonly brand: unique symbol }
>()(
  "NotAChannel",
  { kind: Schema.Literals(["Network", "Direct"]), timeline: TimelineId },
  { httpApiStatus: 404 }
) {}

/**
 * Self is not in the Channel now, so it has no members to list: `standing` says where Self
 * stands with it, or `null` when the Client holds no such Channel. Asking again once Self
 * is in it succeeds: a 409.
 */
export class NotInChannel extends Schema.TaggedError<
  NotInChannel,
  { readonly brand: unique symbol }
>()(
  "NotInChannel",
  {
    standing: Schema.NullOr(Schema.Literals(["Wanted", "Joining", "Refused", "Kicked"])),
    timeline: TimelineId,
  },
  { httpApiStatus: 409 }
) {}

/**
 * The Timelines could not be read. They are derived from the Journal, and a read may
 * succeed when asked again, as one that waited on a lock does, while a store that is
 * damaged is made again when the Daemon restarts: a 503.
 */
export class TimelinesFailed extends Schema.TaggedError<
  TimelinesFailed,
  { readonly brand: unique symbol }
>()("TimelinesFailed", { reason: Schema.String }, { httpApiStatus: 503 }) {}

/**
 * The Network stopped, so it took no more input. This does not mean the input was
 * refused: it may have been journaled before the Network stopped, and a restart steps
 * it. The outcome is `Uncertain`. Configuration and a retry can be given again freely. A
 * `say` or an `act` must not be: ask `GET /api/networks/{network}/said/{intent}` with the
 * `intent` here, on this Daemon or the one started after it, and give it again only if
 * the answer is `NotJournaled`.
 */
export class NetworkStopped extends Schema.TaggedError<
  NetworkStopped,
  { readonly brand: unique symbol }
>()(
  "NetworkStopped",
  {
    /** The intent a `say` or an `act` was given under, to ask `said` about. */
    intent: Schema.optionalKey(CallerIntent),
    network: NetworkId,
    outcome: Schema.Literal("Uncertain"),
    reason: Schema.String,
  },
  { httpApiStatus: 503 }
) {}

/**
 * A `PUT` of Configuration named, with `ifSequence`, the Configuration it was made from,
 * and another is in force: `sequence`, or `null` when the Network was never configured.
 * Nothing was journaled. Read the Configuration again, make the change to it, and send it
 * with the new sequence: a 409.
 */
export class ConfigurationChanged extends Schema.TaggedError<
  ConfigurationChanged,
  { readonly brand: unique symbol }
>()(
  "ConfigurationChanged",
  { network: NetworkId, sequence: Schema.NullOr(Sequence) },
  { httpApiStatus: 409 }
) {}

/**
 * A removal named the life of the Network it was made from, and the Daemon holds another of
 * it, live or kept: `life`, or `null` while one just added has none yet. Another Frontend
 * removed it, or added it again, since. Nothing was journaled. Read the Network list again,
 * and ask again about the life it names: a 409.
 */
export class LifeChanged extends Schema.TaggedError<
  LifeChanged,
  { readonly brand: unique symbol }
>()("LifeChanged", { life: Schema.NullOr(Sequence), network: NetworkId }, { httpApiStatus: 409 }) {}

/**
 * A `PUT` of Configuration named the id of a Network removed with its Timelines kept, so
 * no Network can take it until they are dropped, by removing it again without keeping
 * them. Nothing was journaled: a 409.
 */
export class TimelinesKept extends Schema.TaggedError<
  TimelinesKept,
  { readonly brand: unique symbol }
>()("TimelinesKept", { network: NetworkId }, { httpApiStatus: 409 }) {}

/**
 * A change of a `ui` option was made from other options than those now in force: another
 * Change was journaled since, at `sequence`, the last one. Nothing was journaled: a 409.
 */
export class UiChanged extends Schema.TaggedError<UiChanged, { readonly brand: unique symbol }>()(
  "UiChanged",
  { sequence: UiSequence },
  { httpApiStatus: 409 }
) {}

/**
 * A change of an option beyond `ui` was made from other options than those
 * now in force: another Change of one was journaled since, at `sequence`, the last one.
 * Nothing was journaled: a 409.
 */
export class OptionsChanged extends Schema.TaggedError<
  OptionsChanged,
  { readonly brand: unique symbol }
>()("OptionsChanged", { sequence: OwnerSequence }, { httpApiStatus: 409 }) {}

/**
 * No Message stands at this position in the Timeline: nothing does, or what does is not a
 * Message, such as an Activity: a 404.
 */
export class UnknownMessage extends Schema.TaggedError<
  UnknownMessage,
  { readonly brand: unique symbol }
>()("UnknownMessage", { position: Cursor, timeline: TimelineId }, { httpApiStatus: 404 }) {}

/**
 * Previews are off for the Timeline, as `ui.previews` says, so nothing was fetched. Asking
 * again once they are on succeeds: a 409.
 */
export class PreviewsOff extends Schema.TaggedError<
  PreviewsOff,
  { readonly brand: unique symbol }
>()("PreviewsOff", { timeline: TimelineId }, { httpApiStatus: 409 }) {}

/**
 * The link pressed is not waiting for a press: the Message has no link at that index, or
 * the link is already kept, being fetched, or in a Timeline that does not wait, so nothing
 * was fetched: a 409.
 */
export class NotWaiting extends Schema.TaggedError<NotWaiting, { readonly brand: unique symbol }>()(
  "NotWaiting",
  { link: Schema.Int, position: Cursor, timeline: TimelineId },
  { httpApiStatus: 409 }
) {}

/**
 * Previews are `text` for the Timeline, so no video or sound is streamed. Asking again
 * once they are `on` succeeds: a 409.
 */
export class PreviewsText extends Schema.TaggedError<
  PreviewsText,
  { readonly brand: unique symbol }
>()("PreviewsText", { timeline: TimelineId }, { httpApiStatus: 409 }) {}

/**
 * No link of the Message has a ready Preview of a video or a sound with this id, so nothing
 * is streamed: a 404.
 */
export class UnknownStream extends Schema.TaggedError<
  UnknownStream,
  { readonly brand: unique symbol }
>()("UnknownStream", { id: PreviewId }, { httpApiStatus: 404 }) {}

/**
 * The stream's address gave nothing to stream: it was refused, unreachable, too slow, too large,
 * or answered with something other than video or sound: a 502.
 */
export class StreamFailed extends Schema.TaggedError<
  StreamFailed,
  { readonly brand: unique symbol }
>()("StreamFailed", { id: PreviewId, reason: PreviewFailure }, { httpApiStatus: 502 }) {}

/** No Preview holds an image with this hash, so none is served: a 404. */
export class UnknownImage extends Schema.TaggedError<
  UnknownImage,
  { readonly brand: unique symbol }
>()("UnknownImage", { hash: Schema.String }, { httpApiStatus: 404 }) {}

/** No Upload has this id: a 404. */
export class UnknownUpload extends Schema.TaggedError<
  UnknownUpload,
  { readonly brand: unique symbol }
>()("UnknownUpload", { id: UploadId }, { httpApiStatus: 404 }) {}

/**
 * Uploads are off, since `missing` names options that are not set, so nothing was read or
 * kept. Uploading again once they are set succeeds: a 409.
 */
export class UploadsOff extends Schema.TaggedError<UploadsOff, { readonly brand: unique symbol }>()(
  "UploadsOff",
  { missing: Schema.Array(OwnerOptionName) },
  { httpApiStatus: 409 }
) {}

/**
 * The body passed `maxSize` bytes, `uploads.maxSize` when it began, so it was cut off there
 * and nothing was kept: a 413.
 */
export class UploadTooLarge extends Schema.TaggedError<
  UploadTooLarge,
  { readonly brand: unique symbol }
>()("UploadTooLarge", { maxSize: ByteCount }, { httpApiStatus: 413 }) {}

/**
 * The body is an image or video of `type` whose structure could not be walked, as `reason` says, so
 * it could not be stripped of its metadata and nothing was kept: a 422.
 */
export class UploadUnreadable extends Schema.TaggedError<
  UploadUnreadable,
  { readonly brand: unique symbol }
>()("UploadUnreadable", { reason: Schema.String, type: Schema.String }, { httpApiStatus: 422 }) {}

/**
 * Keeping the body would take the distinct bytes held by live Uploads past `maxTotal`,
 * `uploads.maxTotal` when it was checked, so nothing was kept and nothing was evicted. Bytes
 * a live Upload already holds add nothing. Deleting Uploads, or raising the limit, makes
 * room: a 507.
 */
export class StoreFull extends Schema.TaggedError<StoreFull, { readonly brand: unique symbol }>()(
  "StoreFull",
  { maxTotal: ByteCount },
  { httpApiStatus: 507 }
) {}

/**
 * The store that keeps Uploads' bytes could not be reached, refused what was asked, or
 * holds no key the options name, so nothing was kept. Asking again may succeed: a 503.
 */
export class StoreUnavailable extends Schema.TaggedError<
  StoreUnavailable,
  { readonly brand: unique symbol }
>()("StoreUnavailable", { reason: Schema.String }, { httpApiStatus: 503 }) {}

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
