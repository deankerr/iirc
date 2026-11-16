/**
 * Stripping: an image's bytes in, the same image with nothing but what it needs to be shown
 * out. Each format is walked by a keep-list of our own, so a part we do not know is dropped,
 * and nothing is re-encoded, so the image data is kept byte for byte. It is pure: no I/O, no
 * clock, no randomness, and it never throws, whatever the bytes.
 *
 * Two kinds of format are stripped. A JPEG, PNG, GIF or WebP is read whole and comes out as
 * new bytes. A HEIC, AVIF, MP4 or MOV, which may be a video of any size, is read only where
 * its boxes begin, and comes out as patches over the file, each the same length as what it
 * covers.
 *
 * @packageDocumentation
 */
import type { Effect } from "effect";

import { stripGif } from "./gif.ts";
import { plan } from "./isobmff.ts";
import type { Layout, Planned, Reader } from "./isobmff.ts";
import { stripJpeg } from "./jpeg.ts";
import { stripPng } from "./png.ts";
import type { Stripped } from "./result.ts";
import { stripWebp } from "./webp.ts";

export type { Stripped } from "./result.ts";

export type { Patch } from "./boxes.ts";

export type { Planned, Reader } from "./isobmff.ts";

const strippers = new Map<string, (bytes: Uint8Array) => Stripped>([
  ["image/gif", stripGif],
  ["image/jpeg", stripJpeg],
  ["image/png", stripPng],
  ["image/webp", stripWebp],
]);

/**
 * How bytes of a type are stripped, or none for a type that is kept as it is.
 * @param type - The type read from the bytes, as a Content-Type.
 * @returns The stripper, or none.
 */
export const stripperFor = (type: string): ((bytes: Uint8Array) => Stripped) | undefined =>
  strippers.get(type);

const layouts = new Map<string, Layout>([
  ["image/avif", "image"],
  ["image/heic", "image"],
  ["video/mp4", "movie"],
  ["video/quicktime", "movie"],
]);

/**
 * How a file of a type is walked for patches, or none for a type that is not stripped that way.
 * @param type - The type read from the bytes, as a Content-Type.
 * @returns The walk, which is given how the file is read and how long it is, or none.
 */
export const patcherFor = (
  type: string
): ((read: Reader, size: number) => Effect.Effect<Planned>) | undefined => {
  const layout = layouts.get(type);

  return layout === undefined ? undefined : (read, size) => plan(layout, read, size);
};
