/**
 * Previews on the wire: what a Frontend shows of a link in a Message beyond its address,
 * as the Daemon fetched it, never the browser. A Preview is kept outside the Journal, so
 * its state is not a Change and its stream resumes nothing: a Frontend asks again for what
 * it shows.
 *
 * @packageDocumentation
 */
import { TimelineId } from "@iirc/timelines";
import { Schema } from "effect";

import { Cursor, Untrusted, windowLimit } from "./schemas.ts";

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
 * What a link is: a `page`; or `image`, `video`, or `audio`, a link to the media itself,
 * or `video`, a page that names a video file; or a `player`, a page whose media plays in a
 * frame; or a `file`, a link whose answer is none of these, read from its headers alone but
 * for a plain-text file's first lines.
 */
export const PreviewKind = Schema.Literals([
  "page",
  "image",
  "video",
  "audio",
  "player",
  "file",
]).annotate({
  identifier: "PreviewKind",
});

/** The decoded form of {@link PreviewKind}. */
export type PreviewKind = typeof PreviewKind.Type;

/**
 * The hash of an image a Preview holds: the SHA-256 of its bytes, as 64 lower-case hex
 * digits, which names it at `GET /api/previews/images/{hash}`.
 */
export const ImageHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { message: "must be 64 lower-case hex digits" })
).annotate({
  description: "The SHA-256 of an image a Preview holds, which names it on the images route.",
  identifier: "ImageHash",
});

/** The decoded form of {@link ImageHash}. */
export type ImageHash = typeof ImageHash.Type;

/** The types an image a Preview holds may be, as read from its leading bytes. */
export const ImageType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]).annotate({ identifier: "ImageType" });

/** The decoded form of {@link ImageType}. */
export type ImageType = typeof ImageType.Type;

/**
 * An image's width and height in pixels, as its bytes state them, each at least `1` and at
 * most `32768`, past any screen.
 */
export const ImageDimensions = Schema.Struct({
  height: Schema.Int.check(Schema.isBetween({ maximum: 32_768, minimum: 1 })),
  width: Schema.Int.check(Schema.isBetween({ maximum: 32_768, minimum: 1 })),
}).annotate({ identifier: "ImageDimensions" });

/** The decoded form of {@link ImageDimensions}. */
export type ImageDimensions = typeof ImageDimensions.Type;

/**
 * An image a Preview holds, kept by the Daemon and served from its own origin at
 * `GET /api/previews/images/{hash}`, never from the host it came from: its hash, its type
 * and whether it moves, both read from its bytes, its size in bytes, and its `dimensions`
 * in pixels, read from its bytes too, or `null` where they do not say.
 */
export const PreviewImage = Schema.Struct({
  animated: Schema.Boolean,
  dimensions: Schema.NullOr(ImageDimensions),
  hash: ImageHash,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  type: ImageType,
}).annotate({ identifier: "PreviewImage" });

/** The decoded form of {@link PreviewImage}. */
export type PreviewImage = typeof PreviewImage.Type;

/** A player's size, as the page gave it, in CSS pixels. */
export const PlayerSize = Schema.Struct({
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({ identifier: "PlayerSize" });

/** The decoded form of {@link PlayerSize}. */
export type PlayerSize = typeof PlayerSize.Type;

/**
 * A page's player: the address the page names in `og:video` or `twitter:player`, an
 * `https` address whose host is one `ui.previews.players` lists, with YouTube's read as
 * `www.youtube-nocookie.com`, and its size, or `null` when the page gave none.
 */
export const PreviewPlayer = Schema.Struct({
  link: Untrusted,
  size: Schema.NullOr(PlayerSize),
}).annotate({ identifier: "PreviewPlayer" });

/** The decoded form of {@link PreviewPlayer}. */
export type PreviewPlayer = typeof PreviewPlayer.Type;

/**
 * A Preview: the link it was read from, after any redirects, as the URL parser wrote it,
 * what it is, and what it says of itself. `site` is the name the page gives its site, or
 * else the link's host, so it is always there. `type` is the media type of a link to media
 * itself, read from its headers alone, or of the video file a page names, as the page gave
 * it, and `null` for any other page. `image` is the image the
 * Daemon kept for it, a page's own or the link itself, or `null` for none: a player's or a
 * video's is its poster. `stream` is where a Preview of kind `video` or `audio` is: the link
 * itself, or the video file its page names, which only the Daemon fetches, through
 * `GET /api/previews/{id}/stream`, and `null` for any other kind. `player` is the player of
 * a Preview of kind `player`, and `null` for any other. A `file` has no `title`, its
 * `type` is its media type, its `description` is a plain-text file's first lines, with their
 * line breaks, or `null`, and its `size` is its length in bytes as its host declared it, or
 * `null` where it did not; `size` is `null` for any other kind. Every field but `kind`,
 * `image`, and `size` is what a stranger wrote.
 */
export const Preview = Schema.Struct({
  description: Schema.NullOr(Untrusted),
  image: Schema.NullOr(PreviewImage),
  kind: PreviewKind,
  link: Untrusted,
  player: Schema.NullOr(PreviewPlayer),
  site: Untrusted,
  size: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  stream: Schema.NullOr(Untrusted),
  title: Schema.NullOr(Untrusted),
  type: Schema.NullOr(Untrusted),
}).annotate({ identifier: "Preview" });

/** The decoded form of {@link Preview}. */
export type Preview = typeof Preview.Type;

/**
 * Why a link has no Preview: `Refused`, its address is one the Daemon never fetches;
 * `Unreachable`, it could not be reached; `TimedOut`, it took too long; `TooLarge`, its
 * answer passed what the Daemon reads; `AnsweredError`, its last answer, after any
 * redirects, had a status outside 200 to 299; or `NothingToShow`, its answer held nothing
 * to show.
 */
export const PreviewFailure = Schema.Literals([
  "Refused",
  "Unreachable",
  "TimedOut",
  "TooLarge",
  "AnsweredError",
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

/**
 * Which Message's link a stream is of: the Message's place in its Timeline, as for an ask.
 * The stream answers only for a link of that Message, while its Timeline's mode is `on`.
 */
export const StreamQuery = Schema.Struct({ position: Cursor, timeline: TimelineId });

/** The decoded form of {@link StreamQuery}. */
export type StreamQuery = typeof StreamQuery.Type;

/**
 * Where a link's Preview stands as the Daemon holds it, read with no fetch: as an ask
 * answers, `Pending`, `Ready`, `WaitingForPress`, or `Failed`, a ready one however long ago
 * it was fetched; or `NotHeld`, nothing held of it, which stays unfetched until it is asked
 * for.
 */
export const HeldState = Schema.TaggedUnion({
  Failed: { reason: PreviewFailure },
  NotHeld: {},
  Pending: {},
  Ready: { preview: Preview },
  WaitingForPress: {},
}).annotate({ identifier: "HeldState" });

/** The decoded form of {@link HeldState}. */
export type HeldState = typeof HeldState.Type;

/** One link of a Message and what the Daemon holds of its Preview, as an item is. */
export const HeldItem = Schema.Struct({
  id: PreviewId,
  link: Untrusted,
  state: HeldState,
}).annotate({ identifier: "HeldItem" });

/** The decoded form of {@link HeldItem}. */
export type HeldItem = typeof HeldItem.Type;

/** The most places one held read names, as many as a window holds. */
export const heldLimit = windowLimit.maximum;

/**
 * Which Messages' held Previews are read: their places in one Timeline, as a window gave
 * them, from `1` to {@link heldLimit}.
 */
export const HeldRequest = Schema.Struct({
  positions: Schema.Array(Cursor).check(Schema.isMinLength(1), Schema.isMaxLength(heldLimit)),
});

/** The decoded form of {@link HeldRequest}. */
export type HeldRequest = typeof HeldRequest.Type;

/**
 * What the Daemon holds of many Messages' Previews: one entry for each place asked, in the
 * order asked, with the Message's held items in its order, and none for a place where no
 * Message stands.
 */
export const HeldPreviews = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ position: Cursor, previews: Schema.Array(HeldItem) })),
}).annotate({ identifier: "HeldPreviews" });

/** The decoded form of {@link HeldPreviews}. */
export type HeldPreviews = typeof HeldPreviews.Type;
