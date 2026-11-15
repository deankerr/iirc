/**
 * Stripping: an image's bytes in, the same image with nothing but what it needs to be shown
 * out. Each format is walked by a keep-list of our own, so a part we do not know is dropped,
 * and nothing is re-encoded, so the image data is kept byte for byte. It is pure: no I/O, no
 * clock, no randomness, and it never throws, whatever the bytes.
 *
 * @packageDocumentation
 */
import { stripGif } from "./gif.ts";
import { stripJpeg } from "./jpeg.ts";
import { stripPng } from "./png.ts";
import type { Stripped } from "./result.ts";
import { stripWebp } from "./webp.ts";

export type { Stripped } from "./result.ts";

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
