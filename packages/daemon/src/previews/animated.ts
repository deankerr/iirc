/**
 * Whether an image moves, read from its bytes alone: a GIF of more than one image, a WebP
 * whose VP8X sets its animation flag, or a PNG with an `acTL` before its first `IDAT`, which
 * is an APNG. Anything else, and anything cut short before it says, is still. It never
 * throws, whatever the bytes.
 *
 * @packageDocumentation
 */

/**
 * Whether bytes hold ASCII text at a place.
 * @param bytes - The bytes.
 * @param at - Where.
 * @param text - The text, ASCII only.
 * @returns Whether they do.
 */
const ascii = (bytes: Uint8Array, at: number, text: string) =>
  Array.from({ length: text.length }, (_, offset) => text.codePointAt(offset)).every(
    (code, offset) => bytes[at + offset] === code
  );

const bigEndian32 = (bytes: Uint8Array, at: number): number | undefined => {
  const four = bytes.subarray(at, at + 4);

  return four.length === 4
    ? (four[0] ?? 0) * 2 ** 24 + (four[1] ?? 0) * 2 ** 16 + (four[2] ?? 0) * 2 ** 8 + (four[3] ?? 0)
    : undefined;
};

/**
 * Where a run of GIF data sub-blocks ends, after its zero-length terminator.
 * @param bytes - The GIF.
 * @param from - Where the first sub-block's length is.
 * @returns Where the run ends, or nothing when it runs past the end.
 */
const subBlocksEnd = (bytes: Uint8Array, from: number): number | undefined => {
  let at = from;

  for (;;) {
    const size = bytes[at];

    if (size === undefined) {
      return undefined;
    }

    at += 1 + size;

    if (size === 0) {
      return at;
    }
  }
};

const gifTableSize = (packed: number) => (packed >= 0x80 ? 3 * 2 ** ((packed % 8) + 1) : 0);

/**
 * Whether a GIF holds more than one image, walking its blocks from its header. A block it
 * does not know, or one cut short, ends the walk with what it counted so far.
 * @param bytes - The GIF.
 * @returns Whether it does.
 */
const gifMoves = (bytes: Uint8Array): boolean => {
  // The header, then the screen descriptor, whose packed field may announce a colour table.
  let at = 13 + gifTableSize(bytes[10] ?? 0);
  let images = 0;

  while (images < 2) {
    const block = bytes[at];

    if (block === 0x2c) {
      // An image: its descriptor, its own colour table, its LZW code size, and its data.
      const packed = bytes[at + 9];

      const end =
        packed === undefined ? undefined : subBlocksEnd(bytes, at + 11 + gifTableSize(packed));

      if (end === undefined) {
        return false;
      }

      images += 1;
      at = end;
    } else if (block === 0x21) {
      // An extension: its label, and its sub-blocks.
      const end = subBlocksEnd(bytes, at + 2);

      if (end === undefined) {
        return false;
      }

      at = end;
    } else {
      // The trailer, the end of the bytes, or a block no GIF has.
      return false;
    }
  }

  return true;
};

const animationFlag = 0x02;

/**
 * Whether a WebP sets the animation flag of the VP8X chunk that, in the extended format,
 * comes first.
 * @param bytes - The WebP.
 * @returns Whether it does.
 */
const webpMoves = (bytes: Uint8Array): boolean =>
  ascii(bytes, 12, "VP8X") && Math.floor((bytes[20] ?? 0) / animationFlag) % 2 === 1;

/**
 * Whether a PNG holds an `acTL` before its first `IDAT`, walking its chunks.
 * @param bytes - The PNG.
 * @returns Whether it does.
 */
const pngMoves = (bytes: Uint8Array): boolean => {
  let at = 8;

  for (;;) {
    const length = bigEndian32(bytes, at);

    if (length === undefined || at + 8 > bytes.length) {
      return false;
    }

    if (ascii(bytes, at + 4, "acTL")) {
      return true;
    }

    if (ascii(bytes, at + 4, "IDAT") || ascii(bytes, at + 4, "IEND")) {
      return false;
    }

    // Its length, type, data, and CRC.
    at += 12 + length;
  }
};

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Whether an image moves, from its bytes.
 * @param bytes - The image, whole or as much as there is.
 * @returns Whether it is an animated GIF, WebP, or PNG.
 */
export const animated = (bytes: Uint8Array): boolean => {
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) {
    return gifMoves(bytes);
  }

  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    return webpMoves(bytes);
  }

  if (pngSignature.every((byte, index) => bytes[index] === byte)) {
    return pngMoves(bytes);
  }

  return false;
};
