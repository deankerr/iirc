/**
 * Previews on the wire: what a Frontend shows of a link in a Message beyond its address,
 * as the Daemon fetched it, never the browser. A Preview is kept outside the Journal, so
 * its state is not a Change and its stream resumes nothing: a Frontend asks again for what
 * it shows.
 *
 * @packageDocumentation
 */
import { Schema } from "effect";

import { Cursor, Untrusted } from "./schemas.ts";

/**
 * A Preview's id: 32 lower-case hex digits, the same for one link wherever it is posted
 * and whoever asks, so a Frontend matches a stream's event to what it shows. It is opaque:
 * a Frontend reads nothing into it.
 */
export const PreviewId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{32}$/u, { message: "must be 32 lower-case hex digits" })
)
  .pipe(Schema.brand("PreviewId"))
  .annotate({
    description: "A Preview's id, the same for one link wherever it is posted. It is opaque.",
    identifier: "PreviewId",
  });

/** The decoded form of {@link PreviewId}. */
export type PreviewId = typeof PreviewId.Type;

/**
 * What a link is: a `page`; or `image`, `video`, or `audio`, a link to the media itself;
 * or a `player`, a page whose media plays in a frame.
 */
export const PreviewKind = Schema.Literals(["page", "image", "video", "audio", "player"]).annotate({
  identifier: "PreviewKind",
});

/** The decoded form of {@link PreviewKind}. */
export type PreviewKind = typeof PreviewKind.Type;

/**
 * The hash of an image a Preview holds: the SHA-256 of its bytes, as 64 lower-case hex
 * digits, which names it at `GET /api/previews/media/{hash}`.
 */
export const MediaHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { message: "must be 64 lower-case hex digits" })
).annotate({
  description: "The SHA-256 of an image a Preview holds, which names it on the media route.",
  identifier: "MediaHash",
});

/** The decoded form of {@link MediaHash}. */
export type MediaHash = typeof MediaHash.Type;

/** The types an image a Preview holds may be, as read from its leading bytes. */
export const MediaType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]).annotate({ identifier: "MediaType" });

/** The decoded form of {@link MediaType}. */
export type MediaType = typeof MediaType.Type;

/**
 * An image a Preview holds, kept by the Daemon and served from its own origin at
 * `GET /api/previews/media/{hash}`, never from the host it came from: its hash, its type
 * and whether it moves, both read from its bytes, and its size in bytes.
 */
export const PreviewImage = Schema.Struct({
  animated: Schema.Boolean,
  hash: MediaHash,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  type: MediaType,
}).annotate({ identifier: "PreviewImage" });

/** The decoded form of {@link PreviewImage}. */
export type PreviewImage = typeof PreviewImage.Type;

/**
 * A Preview: the link it was read from, after any redirects, as the URL parser wrote it,
 * what it is, and what it says of itself. `site` is the name the page gives its site, or
 * else the link's host, so it is always there. `type` is the media type of a link to media
 * itself, read from its headers alone, and `null` for a page. `image` is the image the
 * Daemon kept for it, a page's own or the link itself, or `null` for none. Every field but
 * `kind` and `image` is what a stranger wrote.
 */
export const Preview = Schema.Struct({
  description: Schema.NullOr(Untrusted),
  image: Schema.NullOr(PreviewImage),
  kind: PreviewKind,
  link: Untrusted,
  site: Untrusted,
  title: Schema.NullOr(Untrusted),
  type: Schema.NullOr(Untrusted),
}).annotate({ identifier: "Preview" });

/** The decoded form of {@link Preview}. */
export type Preview = typeof Preview.Type;

/**
 * Why a link has no Preview: `Refused`, its address is one the Daemon never fetches;
 * `Unreachable`, it could not be reached; `TimedOut`, it took too long; `TooLarge`, its
 * answer passed what the Daemon reads; or `NothingToShow`, its answer held nothing to show.
 */
export const PreviewFailure = Schema.Literals([
  "Refused",
  "Unreachable",
  "TimedOut",
  "TooLarge",
  "NothingToShow",
]).annotate({ identifier: "PreviewFailure" });

/** The decoded form of {@link PreviewFailure}. */
export type PreviewFailure = typeof PreviewFailure.Type;

/**
 * Where a link's Preview stands: `Pending`, being fetched; `Ready`, with the Preview;
 * `WaitingForPress`, fetched only once the Owner presses it; or `Failed`, with why.
 */
export const PreviewState = Schema.TaggedUnion({
  Failed: { reason: PreviewFailure },
  Pending: {},
  Ready: { preview: Preview },
  WaitingForPress: {},
}).annotate({ identifier: "PreviewState" });

/** The decoded form of {@link PreviewState}. */
export type PreviewState = typeof PreviewState.Type;

/**
 * One link of a Message and its Preview: the Preview's id, the link as the URL parser
 * wrote it, and where its Preview stands.
 */
export const PreviewItem = Schema.Struct({
  id: PreviewId,
  link: Untrusted,
  state: PreviewState,
}).annotate({ identifier: "PreviewItem" });

/** The decoded form of {@link PreviewItem}. */
export type PreviewItem = typeof PreviewItem.Type;

/**
 * Which Message's Previews are asked for: its place in the Timeline, as the item's
 * `position` a Timeline window gave, which says its Entry's sequence and its index in that
 * Entry's News.
 */
export const PreviewsRequest = Schema.Struct({ position: Cursor });

/** The decoded form of {@link PreviewsRequest}. */
export type PreviewsRequest = typeof PreviewsRequest.Type;

/** A Message's Previews: one item for each link that may be previewed, in the Message's order. */
export const MessagePreviews = Schema.Struct({ previews: Schema.Array(PreviewItem) });

/** The decoded form of {@link MessagePreviews}. */
export type MessagePreviews = typeof MessagePreviews.Type;

/**
 * One event of the stream of Previews: `changed` carries a link's item each time its
 * Preview's state changes, so a Frontend replaces what it holds under its id; and
 * `heartbeat` says the stream is alive. No event has an id, since a Preview is not in the
 * Journal: a Frontend that follows again asks again for the Previews it shows.
 */
export const PreviewsEvent = Schema.Union([
  Schema.Struct({
    data: Schema.fromJsonString(PreviewItem),
    event: Schema.Literal("changed"),
  }),
  Schema.Struct({
    data: Schema.fromJsonString(Schema.Struct({})),
    event: Schema.Literal("heartbeat"),
  }),
]);

/** The decoded form of {@link PreviewsEvent}. */
export type PreviewsEvent = typeof PreviewsEvent.Type;

/**
 * A press of a link waiting for one: the Message's place in its Timeline, as for an ask,
 * and the link's index among the Message's links that may be previewed, from `0`.
 */
export const PressRequest = Schema.Struct({
  link: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  position: Cursor,
});

/** The decoded form of {@link PressRequest}. */
export type PressRequest = typeof PressRequest.Type;
