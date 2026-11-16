/**
 * How an image a Preview holds is answered, on the API's own origin, for a signed-in
 * Frontend: as the type its bytes show, never sniffed again by the browser, kept only by the
 * browser itself, named by its hash, and under a sandbox in which nothing may run or load.
 *
 * @packageDocumentation
 */
import type { MediaHash, MediaType } from "@iirc/api";
import type { ByteStoreUnavailable } from "@iirc/byte-store";
import { Effect } from "effect";
import type { Scope } from "effect";
import { HttpServerResponse } from "effect/http";

import type { NoSuchMedia, Previews } from "./previews.ts";

/**
 * The policy an image is served under. An SVG may style itself from within, as it draws
 * with style, but nothing else, and neither may run anything.
 * @param type - Its type.
 * @returns The `Content-Security-Policy`.
 */
const policyOf = (type: MediaType) =>
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
 * no Preview holds is `NoSuchMedia`, whether the Frontend says it holds it or not.
 * @param previews - The Previews.
 * @param hash - The image's hash.
 * @param ifNoneMatch - The request's `If-None-Match`, if any.
 * @returns The response.
 */
export const servedMedia = (
  previews: (typeof Previews)["Service"],
  hash: MediaHash,
  ifNoneMatch: string | undefined
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  NoSuchMedia | ByteStoreUnavailable,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const etag = `"${hash}"`;
    const cached = { "cache-control": "private", etag };

    if (matches(ifNoneMatch, etag) && (yield* previews.refers(hash))) {
      return HttpServerResponse.empty({ headers: cached, status: 304 });
    }

    const { bytes, type } = yield* previews.media(hash);

    return HttpServerResponse.stream(bytes, {
      contentType: type,
      headers: {
        ...cached,
        "content-security-policy": policyOf(type),
        "x-content-type-options": "nosniff",
      },
    });
  });
