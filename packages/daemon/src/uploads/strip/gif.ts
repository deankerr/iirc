/**
 * GIF: walked block by block from its header to its trailer, keeping the screen, colour
 * tables, images, their graphic controls, the looping extension that animates them, and
 * the colour profile.
 *
 * @packageDocumentation
 */
import { asciiAt, copy, hasFlag, makeWriter, written } from "./bytes.ts";
import { stripped, unreadable } from "./result.ts";
import type { Stripped } from "./result.ts";

/**
 * The size of the colour table a packed field announces.
 * @param packed - The packed field.
 * @returns Its size in bytes, or 0 when it has none.
 */
const tableSize = (packed: number) => (hasFlag(packed, 0x80) ? 3 * 2 ** ((packed % 8) + 1) : 0);

/**
 * Where a run of data sub-blocks ends, after its zero-length terminator.
 * @param bytes - The GIF.
 * @param from - Where the first sub-block's length is.
 * @returns Where the run ends, or none if it runs past the end.
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

// The application extensions kept: those that loop an animation, Netscape's and AnimExts',
// and the one that holds its ICC colour profile.
const isKeptApplication = (bytes: Uint8Array, at: number) =>
  bytes[at + 1] === 0xff &&
  bytes[at + 2] === 11 &&
  (asciiAt(bytes, at + 3, "NETSCAPE2.0") ||
    asciiAt(bytes, at + 3, "ANIMEXTS1.0") ||
    asciiAt(bytes, at + 3, "ICCRGBG1012"));

/**
 * Strips a GIF. Comments, plain text, which no browser draws, and every application
 * extension but looping and the colour profile are dropped. A graphic control applies to
 * the next block that draws, an image or plain text, so it is kept only before an image,
 * and goes with the plain text it would have applied to.
 * @param bytes - The GIF.
 * @returns What to keep, through the trailer.
 */
export const stripGif = (bytes: Uint8Array): Stripped => {
  if (!(asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) || bytes.length < 13) {
    return unreadable("invalid GIF: missing header or screen descriptor");
  }

  const screenEnd = 13 + tableSize(bytes[10] ?? 0);

  if (screenEnd > bytes.length) {
    return unreadable("GIF color table runs past the end of file");
  }

  // Everything kept is copied, in order, from disjoint parts of the GIF, so no more than the
  // GIF is ever written.
  const out = makeWriter(bytes.length);
  // Where the graphic control awaiting the block it applies to is: none when they meet.
  let pendingFrom = 0;
  let pendingTo = 0;
  let imaged = false;
  let at = screenEnd;

  copy(out, bytes, 0, screenEnd);

  const broken = (reason: string) => (imaged ? stripped(written(out)) : unreadable(reason));

  for (;;) {
    const introducer = bytes[at];

    if (introducer === 0x3b) {
      copy(out, bytes, at, at + 1);

      return imaged ? stripped(written(out)) : unreadable("truncated GIF: ends before image data");
    }

    if (introducer === 0x2c) {
      // The descriptor, its local colour table, the LZW code size, then the data.
      const dataAt = at + 10 + tableSize(bytes[at + 9] ?? 0) + 1;
      const end = dataAt > bytes.length ? undefined : subBlocksEnd(bytes, dataAt);

      if (end === undefined) {
        return broken("GIF image runs past the end of file");
      }

      copy(out, bytes, pendingFrom, pendingTo);
      copy(out, bytes, at, end);
      pendingFrom = 0;
      pendingTo = 0;
      imaged = true;
      at = end;
    } else if (introducer === 0x21) {
      const label = bytes[at + 1];
      const end = label === undefined ? undefined : subBlocksEnd(bytes, at + 2);

      if (end === undefined) {
        return broken("GIF extension runs past the end of file");
      }

      if (label === 0xf9) {
        pendingFrom = at;
        pendingTo = end;
      } else if (label === 0x01) {
        pendingFrom = 0;
        pendingTo = 0;
      } else if (isKeptApplication(bytes, at)) {
        copy(out, bytes, at, end);
      }

      at = end;
    } else {
      return broken(
        introducer === undefined ? "truncated GIF: ends before trailer" : "GIF has an unknown block"
      );
    }
  }
};
