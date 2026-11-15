/**
 * WebP: the RIFF container walked chunk by chunk, simple lossy and lossless files and the
 * extended format alike, keeping image data, alpha, ICC, animation and its frames, and an
 * `EXIF` rebuilt with Orientation only. `VP8X`'s flags and the RIFF size are rewritten to
 * say what is kept.
 *
 * @packageDocumentation
 */
import {
  asciiAt,
  copy,
  hasFlag,
  makeWriter,
  patch,
  patchLe,
  put,
  putAscii,
  putLe,
  readLe,
  reserve,
  written,
} from "./bytes.ts";
import type { Writer } from "./bytes.ts";
import { orientationOfPayload, orientationTiff } from "./exif.ts";
import { stripped, unreadable } from "./result.ts";
import type { Stripped } from "./result.ts";

const iccFlag = 0x20;
const alphaFlag = 0x10;
const exifFlag = 0x08;
const animationFlag = 0x02;

// What a frame of an animation holds, and what each holds once: a second is no use to a reader.
const frameParts: ReadonlySet<string> = new Set(["ALPH", "VP8 ", "VP8L"]);

// What a file of the extended format holds, besides its frames, and what each holds once.
const fileParts: ReadonlySet<string> = new Set([
  "VP8X",
  "ICCP",
  "ANIM",
  "EXIF",
  "ANMF",
  ...frameParts,
]);

const fileOnce: ReadonlySet<string> = new Set(["VP8X", "ICCP", "ANIM", "EXIF", ...frameParts]);

// The `VP8X` chunk's data: flags, then the canvas size.
const vp8xDataSize = 10;

// The `ANMF` chunk's data before its image data: a frame's position, size, duration and flags.
const frameHeaderSize = 16;

// An `EXIF` chunk, rebuilt from nothing: its header and a TIFF of 26 bytes.
const exifChunkSize = 8 + 26;

/**
 * The most a stripped WebP outgrows the WebP. Every chunk but the `EXIF` is copied from a part
 * of the WebP no other chunk is, or is no longer than that part, but for the padding byte of
 * the last chunk, which a WebP may leave off.
 */
const outgrowth = exifChunkSize + 1;

/**
 * Walks the chunks between `from` and `end`, calling `visit` with each, so that what is held
 * is what `visit` holds and never how many chunks a hostile file strings together. A chunk
 * that runs past `end` stops the walk; its last padding byte alone may be missing.
 * @param bytes - The bytes.
 * @param from - Where the first chunk begins.
 * @param end - Where the chunks end.
 * @param visit - Called with each whole chunk's FourCC, and where its data begins and ends.
 * @returns Whether the walk reached `end`.
 */
const walkChunks = (
  bytes: Uint8Array,
  from: number,
  end: number,
  visit: (fourCC: string, dataAt: number, dataEnd: number) => void
): boolean => {
  let at = from;

  while (at + 8 <= end) {
    const size = readLe(bytes, at + 4, 4);

    if (at + 8 + size > end) {
      return false;
    }

    visit(
      String.fromCodePoint(
        bytes[at] ?? 0,
        bytes[at + 1] ?? 0,
        bytes[at + 2] ?? 0,
        bytes[at + 3] ?? 0
      ),
      at + 8,
      at + 8 + size
    );
    at += 8 + size + (size % 2);
  }

  return at >= end;
};

/**
 * Whether a chunk is on the keep-list and, if it is held once, the first of its FourCC.
 * @param seen - The FourCCs already kept, which this adds to.
 * @param keep - The FourCCs to keep.
 * @param once - The FourCCs, among those, to keep only the first of.
 * @param fourCC - The chunk's FourCC.
 * @returns Whether to keep it.
 */
const admits = (
  seen: Set<string>,
  keep: ReadonlySet<string>,
  once: ReadonlySet<string>,
  fourCC: string
) => {
  if (!keep.has(fourCC) || (once.has(fourCC) && seen.has(fourCC))) {
    return false;
  }

  seen.add(fourCC);

  return true;
};

/**
 * Writes a chunk, with its padding byte when its size is odd.
 * @param out - The writer.
 * @param fourCC - Its FourCC.
 * @param bytes - The bytes its data is in.
 * @param from - Where its data begins.
 * @param to - Where its data ends.
 */
const putChunk = (out: Writer, fourCC: string, bytes: Uint8Array, from: number, to: number) => {
  putAscii(out, fourCC);
  putLe(out, to - from, 4);
  copy(out, bytes, from, to);
  reserve(out, (to - from) % 2);
};

/**
 * Writes a frame of an animation, keeping its header and only its image data. Its size is
 * written once its image data is, and a frame that cannot be walked, or holds no image data,
 * is taken back out.
 * @param out - The writer.
 * @param frame - The `ANMF` chunk's data.
 * @returns Whether the frame was written.
 */
const putFrame = (out: Writer, frame: Uint8Array): boolean => {
  if (frame.length < frameHeaderSize) {
    return false;
  }

  const start = out.length;
  const seen = new Set<string>();
  let imaged = false;

  putAscii(out, "ANMF");

  const sizeAt = reserve(out, 4);

  put(out, frame.subarray(0, frameHeaderSize));

  const whole = walkChunks(frame, frameHeaderSize, frame.length, (fourCC, dataAt, dataEnd) => {
    if (admits(seen, frameParts, frameParts, fourCC)) {
      putChunk(out, fourCC, frame, dataAt, dataEnd);
      imaged ||= fourCC !== "ALPH";
    }
  });

  if (!whole || !imaged) {
    out.length = start;

    return false;
  }

  patchLe(out, sizeAt, out.length - sizeAt - 4, 4);
  reserve(out, (out.length - sizeAt - 4) % 2);

  return true;
};

/**
 * What the walk has found, which the chunks after the first are written by.
 */
interface Walk {
  /** What the first chunk makes the WebP, or none before it is walked. */
  kind: "simple" | "extended" | "refused" | undefined;
  /** The `VP8X` flags as they were, and where its flags are written. */
  vp8xFlags: number;
  vp8xAt: number;
  orientation: number | undefined;
  icc: boolean;
  imaged: boolean;
  /** Whether a frame that cannot be walked has ended what is kept. */
  ended: boolean;
}

/**
 * Writes a chunk after the first of an extended WebP, or drops it.
 * @param walk - The walk so far.
 * @param out - The writer.
 * @param fourCC - The chunk's FourCC.
 * @param bytes - The bytes its data is in.
 * @param from - Where its data begins.
 * @param to - Where its data ends.
 */
const putExtended = (
  walk: Walk,
  out: Writer,
  fourCC: string,
  bytes: Uint8Array,
  from: number,
  to: number
) => {
  if (fourCC === "ANMF") {
    walk.ended = !putFrame(out, bytes.subarray(from, to));
    walk.imaged ||= !walk.ended;
  } else if (fourCC === "EXIF") {
    walk.orientation ??= orientationOfPayload(bytes.subarray(from, to));
  } else if (fourCC === "ICCP" || fourCC === "ANIM" || frameParts.has(fourCC)) {
    putChunk(out, fourCC, bytes, from, to);
    walk.icc ||= fourCC === "ICCP";
    walk.imaged ||= frameParts.has(fourCC) && fourCC !== "ALPH";
  }
};

/**
 * `VP8X`'s flags as kept: alpha and animation as they were, ICC and EXIF as kept, and XMP
 * never.
 * @param walk - The walk.
 * @returns The flags.
 */
const keptFlags = (walk: Walk) =>
  (hasFlag(walk.vp8xFlags, alphaFlag) ? alphaFlag : 0) +
  (hasFlag(walk.vp8xFlags, animationFlag) ? animationFlag : 0) +
  (walk.icc ? iccFlag : 0) +
  (walk.orientation === undefined ? 0 : exifFlag);

/**
 * Strips a WebP. XMP, the original EXIF, and every unknown chunk are dropped.
 * @param bytes - The WebP.
 * @returns What to keep, under a RIFF header of the size kept.
 */
export const stripWebp = (bytes: Uint8Array): Stripped => {
  if (!asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) {
    return unreadable("a WebP begins with its RIFF header");
  }

  // The RIFF header, then each kept chunk as the walk reaches it, with the sizes of the RIFF
  // and of each frame, and `VP8X`'s flags, written once they are known.
  const out = makeWriter(bytes.length + outgrowth);
  const seen = new Set<string>();

  const walk: Walk = {
    ended: false,
    icc: false,
    imaged: false,
    kind: undefined,
    orientation: undefined,
    vp8xAt: 0,
    vp8xFlags: 0,
  };

  putAscii(out, "RIFF");

  const riffSizeAt = reserve(out, 4);

  putAscii(out, "WEBP");

  const whole = walkChunks(
    bytes,
    12,
    Math.min(8 + readLe(bytes, 4, 4), bytes.length),
    (fourCC, dataAt, dataEnd) => {
      if (walk.kind === undefined) {
        if (!admits(seen, fileParts, fileOnce, fourCC)) {
          walk.kind = "refused";
        } else if (fourCC === "VP8 " || fourCC === "VP8L") {
          // A simple file holds its image and nothing else.
          walk.kind = "simple";
          putChunk(out, fourCC, bytes, dataAt, dataEnd);
        } else if (fourCC === "VP8X" && dataEnd - dataAt >= vp8xDataSize) {
          walk.kind = "extended";
          walk.vp8xFlags = bytes[dataAt] ?? 0;
          putAscii(out, "VP8X");
          putLe(out, vp8xDataSize, 4);
          walk.vp8xAt = reserve(out, vp8xDataSize);
          patch(out, walk.vp8xAt + 4, bytes.subarray(dataAt + 4, dataAt + vp8xDataSize));
        } else {
          walk.kind = "refused";
        }
      } else if (
        walk.kind === "extended" &&
        !walk.ended &&
        admits(seen, fileParts, fileOnce, fourCC)
      ) {
        putExtended(walk, out, fourCC, bytes, dataAt, dataEnd);
      }
    }
  );

  if (walk.kind === undefined || walk.kind === "refused") {
    return unreadable("a WebP begins with VP8, VP8L, or a whole VP8X");
  }

  if (walk.kind === "extended") {
    if (!walk.imaged) {
      return unreadable(whole ? "a WebP holds no image data" : "a WebP chunk runs past the end");
    }

    patch(out, walk.vp8xAt, Uint8Array.of(keptFlags(walk)));

    if (walk.orientation !== undefined) {
      const tiff = orientationTiff(walk.orientation);

      putChunk(out, "EXIF", tiff, 0, tiff.length);
    }
  }

  patchLe(out, riffSizeAt, out.length - 8, 4);

  return stripped(written(out));
};
