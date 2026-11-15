/**
 * WebP: the RIFF container walked chunk by chunk, simple lossy and lossless files and the
 * extended format alike, keeping image data, alpha, ICC, animation and its frames, and an
 * `EXIF` rebuilt with Orientation only. `VP8X`'s flags and the RIFF size are rewritten to
 * say what is kept.
 *
 * @packageDocumentation
 */
import { ascii, asciiAt, concat, hasFlag, le, readLe } from "./bytes.ts";
import { orientationOfPayload, orientationTiff } from "./exif.ts";
import { stripped, unreadable } from "./result.ts";
import type { Stripped } from "./result.ts";

const iccFlag = 0x20;
const alphaFlag = 0x10;
const exifFlag = 0x08;
const animationFlag = 0x02;

// What a frame of an animation holds.
const frameParts: ReadonlySet<string> = new Set(["ALPH", "VP8 ", "VP8L"]);

/** One chunk as walked: its FourCC and its data. */
interface Chunk {
  readonly fourCC: string;
  readonly data: Uint8Array;
}

/**
 * A chunk with its padding byte when its size is odd.
 * @param fourCC - Its FourCC.
 * @param data - Its data.
 * @returns The chunk.
 */
const riffChunk = (fourCC: string, data: Uint8Array) =>
  concat([ascii(fourCC), le(data.length, 4), data, new Uint8Array(data.length % 2)]);

/**
 * Walks the chunks between `from` and `end`. A chunk that runs past `end` stops the walk;
 * its last padding byte alone may be missing.
 * @param bytes - The bytes.
 * @param from - Where the first chunk begins.
 * @param end - Where the chunks end.
 * @returns The chunks walked whole, and whether the walk reached `end`.
 */
const chunksOf = (bytes: Uint8Array, from: number, end: number) => {
  const chunks: Chunk[] = [];
  let at = from;

  while (at + 8 <= end) {
    const size = readLe(bytes, at + 4, 4);

    if (at + 8 + size > end) {
      return { chunks, whole: false };
    }

    chunks.push({
      data: bytes.subarray(at + 8, at + 8 + size),
      fourCC: String.fromCodePoint(...bytes.subarray(at, at + 4)),
    });
    at += 8 + size + (size % 2);
  }

  return { chunks, whole: at >= end };
};

/**
 * A frame of an animation, keeping its header and only its image data.
 * @param frame - The `ANMF` chunk's data.
 * @returns The frame, or none if its parts cannot be walked or hold no image data.
 */
const frameOf = (frame: Uint8Array): Uint8Array | undefined => {
  if (frame.length < 16) {
    return undefined;
  }

  const { chunks, whole } = chunksOf(frame, 16, frame.length);
  const kept = chunks.filter((chunk) => frameParts.has(chunk.fourCC));

  if (!whole || !kept.some((chunk) => chunk.fourCC !== "ALPH")) {
    return undefined;
  }

  return riffChunk(
    "ANMF",
    concat([frame.subarray(0, 16), ...kept.map((chunk) => riffChunk(chunk.fourCC, chunk.data))])
  );
};

/** What the chunks after `VP8X` keep. */
interface Extended {
  readonly kept: readonly Uint8Array[];
  readonly orientation: number | undefined;
  readonly icc: boolean;
  readonly imaged: boolean;
}

/**
 * Walks the chunks after `VP8X`. A frame that cannot be walked ends them.
 * @param chunks - The chunks.
 * @returns What they keep.
 */
const extendedOf = (chunks: readonly Chunk[]): Extended => {
  const kept: Uint8Array[] = [];
  let orientation: number | undefined = undefined;

  for (const chunk of chunks) {
    if (chunk.fourCC === "ANMF") {
      const frame = frameOf(chunk.data);

      if (frame === undefined) {
        break;
      }

      kept.push(frame);
    } else if (chunk.fourCC === "EXIF") {
      orientation ??= orientationOfPayload(chunk.data);
    } else if (chunk.fourCC === "ICCP" || chunk.fourCC === "ANIM" || frameParts.has(chunk.fourCC)) {
      kept.push(riffChunk(chunk.fourCC, chunk.data));
    }
  }

  const fourCCs = new Set(kept.map((chunk) => String.fromCodePoint(...chunk.subarray(0, 4))));

  return {
    icc: fourCCs.has("ICCP"),
    imaged: fourCCs.has("ANMF") || fourCCs.has("VP8 ") || fourCCs.has("VP8L"),
    kept,
    orientation,
  };
};

/**
 * `VP8X` rewritten to say what is kept: alpha and animation as they were, ICC and EXIF as
 * kept, and XMP never.
 * @param header - The original `VP8X` data.
 * @param icc - Whether ICC is kept.
 * @param exif - Whether an EXIF is kept.
 * @returns The chunk.
 */
const vp8xOf = (header: Uint8Array, icc: boolean, exif: boolean) => {
  const flags = header[0] ?? 0;

  const kept =
    (hasFlag(flags, alphaFlag) ? alphaFlag : 0) +
    (hasFlag(flags, animationFlag) ? animationFlag : 0) +
    (icc ? iccFlag : 0) +
    (exif ? exifFlag : 0);

  return riffChunk("VP8X", concat([Uint8Array.of(kept, 0, 0, 0), header.subarray(4, 10)]));
};

/**
 * Strips a WebP. XMP, the original EXIF, and every unknown chunk are dropped.
 * @param bytes - The WebP.
 * @returns What to keep, under a RIFF header of the size kept.
 */
export const stripWebp = (bytes: Uint8Array): Stripped => {
  if (!asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) {
    return unreadable("a WebP begins with its RIFF header");
  }

  const { chunks, whole } = chunksOf(bytes, 12, Math.min(8 + readLe(bytes, 4, 4), bytes.length));
  const [first, ...rest] = chunks;
  let parts: readonly Uint8Array[] = [];

  if (first?.fourCC === "VP8 " || first?.fourCC === "VP8L") {
    // A simple file holds its image and nothing else.
    parts = [riffChunk(first.fourCC, first.data)];
  } else if (first?.fourCC === "VP8X" && first.data.length >= 10) {
    const extended = extendedOf(rest);
    const { orientation } = extended;

    const exif = orientation === undefined ? [] : [riffChunk("EXIF", orientationTiff(orientation))];

    parts = extended.imaged
      ? [vp8xOf(first.data, extended.icc, exif.length > 0), ...extended.kept, ...exif]
      : [];
  } else {
    return unreadable("a WebP begins with VP8, VP8L, or a whole VP8X");
  }

  if (parts.length === 0) {
    return unreadable(whole ? "a WebP holds no image data" : "a WebP chunk runs past the end");
  }

  const body = concat([ascii("WEBP"), ...parts]);

  return stripped(concat([ascii("RIFF"), le(body.length, 4), body]));
};
