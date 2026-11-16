/**
 * How an Upload's bytes are answered, wherever they are served: at its link, by the link
 * listener, and on the API's own origin, for a signed-in Frontend. Both answer through
 * here, so the headers that stop what is served from acting in a reader's browser are the
 * same.
 *
 * @packageDocumentation
 */
import type { ByteStoreUnavailable } from "@iirc/byte-store";
import { Effect, Sink, Stream } from "effect";
import { HttpServerResponse } from "effect/http";

import { knownKinds } from "./kind.ts";
import type { Recorded } from "./uploads.ts";

/**
 * What every answer of an Upload carries: no sniffing, a sandbox with nothing allowed but
 * downloads, no referrer, and readable from any origin, since Chromium plays top-level
 * media under a sandbox only so, and the link listener reads no cookie to give away.
 */
export const safety = {
  "access-control-allow-origin": "*",
  "content-security-policy": "sandbox allow-downloads; default-src 'none'",
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

/**
 * A `Content-Disposition` naming a file, as RFC 6266 says: an ASCII `filename` for old
 * readers, every other character `_`, and the name itself in `filename*`, as RFC 5987
 * encodes it.
 * @param inline - Whether it is shown in place, rather than downloaded.
 * @param name - The name.
 * @returns The header's value.
 */
const contentDisposition = (inline: boolean, name: string) => {
  const ascii = name.replaceAll(/[^\u0020-\u007E]|["\\]/gu, "_");

  const encoded = encodeURIComponent(name).replaceAll(
    /['()*]/gu,
    (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
  );

  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

/**
 * Whether a type is shown in place: raster images, common audio and video, and plain
 * text. Anything else, and any type no kind has, downloads.
 * @param type - The type the record holds.
 * @returns Whether it is.
 */
const shownInPlace = (type: string) =>
  knownKinds.find((kind) => kind.type === type)?.inline ?? false;

/**
 * An Upload's bytes as an answer: its record's type and size, its safe name, and the safety
 * headers. The first chunk is read before answering, so a store found to be unreachable
 * before any byte arrives fails here, where it can still be answered, rather than resetting
 * the Connection. A failure after the first byte can only end the body early, as the status
 * and headers are already sent.
 * @param opened - The record, and its bytes.
 * @returns The response.
 */
export const servedUpload = ({
  bytes,
  record,
}: {
  readonly record: Recorded;
  readonly bytes: Stream.Stream<Uint8Array, ByteStoreUnavailable>;
}) =>
  Effect.map(Stream.peel(bytes, Sink.take<Uint8Array>(1)), ([first, rest]) =>
    HttpServerResponse.stream(Stream.concat(Stream.fromIterable(first), rest), {
      contentLength: record.size,
      contentType: record.type,
      headers: {
        ...safety,
        "cache-control": "no-cache",
        "content-disposition": contentDisposition(shownInPlace(record.type), record.safeName),
      },
    })
  );
