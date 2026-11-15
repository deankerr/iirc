/**
 * PNG and APNG: walked chunk by chunk from the signature to `IEND`, keeping image data,
 * colour, animation, and an `eXIf` rebuilt with Orientation only. CRCs are copied, never
 * checked, so a chunk is kept exactly as it came.
 *
 * @packageDocumentation
 */
import { ascii, asciiAt, be, concat, readBe } from "./bytes.ts";
import { orientationOfPayload, orientationTiff } from "./exif.ts";
import { stripped, unreadable } from "./result.ts";
import type { Stripped } from "./result.ts";

const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

// Image data and its palette and transparency; colour, `bKGD` for what shows where nothing
// is drawn; `pHYs`, a pixel density that says nothing of who or where; and APNG's frames.
const keep: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "iCCP",
  "cICP",
  "gAMA",
  "cHRM",
  "sRGB",
  "sBIT",
  "mDCV",
  "cLLI",
  "bKGD",
  "pHYs",
  "acTL",
  "fcTL",
  "fdAT",
]);

/* oxlint-disable no-bitwise -- CRC-32 is defined on bits */
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;

  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  }

  return c >>> 0;
});

/**
 * The CRC-32 a PNG chunk ends with.
 * @param bytes - Its type and data.
 * @returns The CRC.
 */
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xff_ff_ff_ff;

  for (const byte of bytes) {
    c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }

  return (c ^ 0xff_ff_ff_ff) >>> 0;
};
/* oxlint-enable no-bitwise */

/**
 * A chunk: its length, type, data, and CRC.
 * @param type - Its type.
 * @param data - Its data.
 * @returns The chunk.
 */
const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typed = concat([ascii(type), data]);

  return concat([be(data.length, 4), typed, be(crc32(typed), 4)]);
};

/**
 * Strips a PNG or APNG.
 * @param bytes - The PNG.
 * @returns What to keep, `IHDR` first, an `eXIf` of Orientation only after it, then every
 *   other kept chunk in order, through `IEND`.
 */
export const stripPng = (bytes: Uint8Array): Stripped => {
  if (bytes.length < signature.length || signature.some((byte, i) => bytes[i] !== byte)) {
    return unreadable("a PNG begins with its signature");
  }

  const kept: Uint8Array[] = [];
  let orientation: number | undefined = undefined;
  let imaged = false;
  let at = signature.length;

  const assemble = () => {
    const [header, ...rest] = kept;
    const exif = orientation === undefined ? [] : [pngChunk("eXIf", orientationTiff(orientation))];

    return stripped(
      concat([signature, ...(header === undefined ? [] : [header]), ...exif, ...rest])
    );
  };

  for (;;) {
    const length = readBe(bytes, at, 4);
    const end = at + 12 + length;

    if (at + 12 > bytes.length || length > 0x7f_ff_ff_ff || end > bytes.length) {
      return imaged ? assemble() : unreadable("a PNG chunk runs past the end");
    }

    if (kept.length === 0 && !asciiAt(bytes, at + 4, "IHDR")) {
      return unreadable("a PNG begins with IHDR");
    }

    const type = String.fromCodePoint(...bytes.subarray(at + 4, at + 8));

    if (type === "eXIf") {
      orientation ??= orientationOfPayload(bytes.subarray(at + 8, end - 4));
    } else if (keep.has(type)) {
      kept.push(bytes.subarray(at, end));
    }

    if (type === "IDAT") {
      imaged = true;
    }

    if (type === "IEND") {
      return imaged ? assemble() : unreadable("a PNG ends before its image data");
    }

    at = end;
  }
};
