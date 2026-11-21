/**
 * How an image a Preview holds is answered, on the API's own origin, for a signed-in
 * Frontend: as the type its bytes show, never sniffed again by the browser, kept only by the
 * browser itself, named by its hash, and under a sandbox in which nothing may run or load.
 * A video or sound a link is, is answered likewise, as the host's type, kept by no cache.
 *
 * @packageDocumentation
 */
import type {
  PreviewsText,
  ImageHash,
  ImageType,
  PreviewId,
  PreviewsOff,
  StreamFailed,
  UnknownMessage,
  UnknownStream,
  UnknownTimeline,
} from "@iirc/api";
import type { ByteStoreUnavailable } from "@iirc/byte-store";
import type { TimelineStoreFailed } from "@iirc/timeline-store";
import type { Position, TimelineId } from "@iirc/timelines";
import { Effect } from "effect";
import type { Scope } from "effect";
import { HttpServerResponse } from "effect/http";

import { startingRangeOf } from "../uploads/wanted.ts";
import type { NoSuchImage, Previews } from "./previews.ts";

/**
 * The policy an image is served under. An SVG may style itself from within, as it draws
 * with style, but nothing else, and neither may run anything.
 * @param type - Its type.
 * @returns The `Content-Security-Policy`.
 */
const policyOf = (type: ImageType) =>
  type === "image/svg+xml"
    ? "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    : "default-src 'none'; sandbox";

/**
 * Whether an `If-None-Match` names the image: its tag, weak or strong, among any others, or
 * `*`.
 * @param header - The header, if any.
 * @param etag - The image's tag, quoted.
 * @returns Whether it does.
 */
const matches = (header: string | undefined, etag: string) =>
  header !== undefined &&
  header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//u, ""))
    .some((tag) => tag === "*" || tag === etag);

/**
 * An image a Preview holds, as an answer: `304` when the Frontend already holds it, and
 * otherwise its bytes. Its hash names its bytes, so they never change under its tag. A hash
 * no Preview holds is `NoSuchImage`, whether the Frontend says it holds it or not.
 * @param previews - The Previews.
 * @param hash - The image's hash.
 * @param ifNoneMatch - The request's `If-None-Match`, if any.
 * @returns The response.
 */
export const servedImage = (
  previews: (typeof Previews)["Service"],
  hash: ImageHash,
  ifNoneMatch: string | undefined
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  NoSuchImage | ByteStoreUnavailable,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const etag = `"${hash}"`;
    const cached = { "cache-control": "private", etag };

    if (matches(ifNoneMatch, etag) && (yield* previews.refers(hash))) {
      return HttpServerResponse.empty({ headers: cached, status: 304 });
    }

    const { bytes, type } = yield* previews.image(hash);

    return HttpServerResponse.stream(bytes, {
      contentType: type,
      headers: {
        ...cached,
        "content-security-policy": policyOf(type),
        "x-content-type-options": "nosniff",
      },
    });
  });

/**
 * A video or sound a link of a Message is, streamed through the guard from the address the
 * Daemon read for it: the host's `200` or `206` with its `Content-Range`, or its `416`. Only
 * a single range starting at a position is passed on, and any other `Range` is answered as
 * if there were none. The body is served as the host's media type, never sniffed, kept by no
 * cache, and under a sandbox. A body that fails in the guard, passing its limit among other
 * ways, cuts the response off.
 * @param previews - The Previews.
 * @param timeline - The Message's Timeline.
 * @param position - The Message's place in it.
 * @param id - The Preview's id.
 * @param range - The request's `Range`, if any.
 * @returns The response, whose body needs the Scope until it is written.
 */
export const servedStream = (
  previews: (typeof Previews)["Service"],
  timeline: TimelineId,
  position: Position,
  id: PreviewId,
  range: string | undefined
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  | UnknownTimeline
  | UnknownMessage
  | PreviewsOff
  | PreviewsText
  | UnknownStream
  | StreamFailed
  | TimelineStoreFailed,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const streamed = yield* previews.stream(timeline, position, id, startingRangeOf(range));

    if (streamed._tag === "Unsatisfiable") {
      return HttpServerResponse.empty({
        headers: {
          "cache-control": "private, no-store",
          ...(streamed.contentRange !== undefined && { "content-range": streamed.contentRange }),
        },
        status: 416,
      });
    }

    return HttpServerResponse.stream(streamed.body, {
      contentType: streamed.type,
      headers: {
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
        ...(streamed.acceptRanges !== undefined && { "accept-ranges": streamed.acceptRanges }),
        ...(streamed.contentRange !== undefined && { "content-range": streamed.contentRange }),
      },
      status: streamed.status,
    });
  });
