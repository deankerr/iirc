/**
 * GIF: walked block by block from its header to its trailer, keeping the screen, colour
 * tables, images, their graphic controls, and the looping extension that animates them.
 *
 * @packageDocumentation
 */
import { asciiAt, concat, hasFlag } from "./bytes.ts";
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

// The application extensions that loop an animation: Netscape's and AnimExts'.
const isLooping = (bytes: Uint8Array, at: number) =>
  bytes[at + 2] === 11 &&
  (asciiAt(bytes, at + 3, "NETSCAPE2.0") || asciiAt(bytes, at + 3, "ANIMEXTS1.0"));

/**
 * Strips a GIF. Comments, plain text, which no browser draws, and every application
 * extension but looping are dropped.
 * @param bytes - The GIF.
 * @returns What to keep, through the trailer.
 */
export const stripGif = (bytes: Uint8Array): Stripped => {
  if (!(asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) || bytes.length < 13) {
    return unreadable("a GIF begins with its header and screen");
  }

  const screenEnd = 13 + tableSize(bytes[10] ?? 0);

  if (screenEnd > bytes.length) {
    return unreadable("a GIF's colour table runs past the end");
  }

  const kept: Uint8Array[] = [bytes.subarray(0, screenEnd)];
  let imaged = false;
  let at = screenEnd;

  const broken = (reason: string) => (imaged ? stripped(concat(kept)) : unreadable(reason));

  for (;;) {
    const introducer = bytes[at];

    if (introducer === 0x3b) {
      kept.push(bytes.subarray(at, at + 1));

      return imaged ? stripped(concat(kept)) : unreadable("a GIF ends before its image data");
    }

    if (introducer === 0x2c) {
      // The descriptor, its local colour table, the LZW code size, then the data.
      const dataAt = at + 10 + tableSize(bytes[at + 9] ?? 0) + 1;
      const end = dataAt > bytes.length ? undefined : subBlocksEnd(bytes, dataAt);

      if (end === undefined) {
        return broken("a GIF image runs past the end");
      }

      kept.push(bytes.subarray(at, end));
      imaged = true;
      at = end;
    } else if (introducer === 0x21) {
      const label = bytes[at + 1];
      const end = label === undefined ? undefined : subBlocksEnd(bytes, at + 2);

      if (end === undefined) {
        return broken("a GIF extension runs past the end");
      }

      if (label === 0xf9 || (label === 0xff && isLooping(bytes, at))) {
        kept.push(bytes.subarray(at, end));
      }

      at = end;
    } else {
      return broken(
        introducer === undefined ? "a GIF ends before its trailer" : "a GIF holds an unknown block"
      );
    }
  }
};
