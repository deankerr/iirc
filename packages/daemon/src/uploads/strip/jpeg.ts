/**
 * JPEG: walked segment by segment from its start-of-image marker, and through each scan's
 * entropy-coded data to the marker that ends it, never by searching the file. It is cut at
 * the end-of-image marker that ends the primary image, which drops motion-photo video and
 * the secondary images and gain maps MPF and Ultra HDR put after it.
 *
 * @packageDocumentation
 */
import { ascii, asciiAt, be, concat, readBe } from "./bytes.ts";
import { exifHeader, orientationOf, orientationTiff } from "./exif.ts";
import { stripped, unreadable } from "./result.ts";
import type { Stripped } from "./result.ts";

const startOfImage = Uint8Array.of(0xff, 0xd8);
const endOfImage = Uint8Array.of(0xff, 0xd9);

const segment = (marker: number, payload: Uint8Array) =>
  concat([Uint8Array.of(0xff, marker), be(payload.length + 2, 2), payload]);

// Frames, Huffman and arithmetic tables, quantization tables, restart intervals, line
// counts, hierarchical progression and expansion: everything decoding needs but the scans.
// 0xC8 is reserved for extensions, and is not among them.
const isDecoding = (marker: number) =>
  (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) || (marker >= 0xdb && marker <= 0xdf);

const isRestart = (marker: number) => marker >= 0xd0 && marker <= 0xd7;

/**
 * Where a scan's entropy-coded data ends: at the first marker that is not a stuffed zero, a
 * restart, or a fill byte, or at the end of the bytes.
 * @param bytes - The JPEG.
 * @param from - Where the data begins, after its SOS segment.
 * @returns Where the next marker begins, or the length of the bytes.
 */
const scanEnd = (bytes: Uint8Array, from: number) => {
  let at = from;

  while (at < bytes.length) {
    const next = bytes[at + 1];

    if (bytes[at] !== 0xff || next === undefined) {
      at += 1;
    } else if (next === 0x00 || isRestart(next)) {
      at += 2;
    } else if (next === 0xff) {
      at += 1;
    } else {
      return at;
    }
  }

  return at;
};

/** What a JPEG keeps, as the walk finds it. */
interface Walked {
  /** APP0 JFIF, rebuilt without its thumbnail. */
  jfif: Uint8Array | undefined;
  orientation: number | undefined;
  /** Every other segment kept, and the scans, in order. */
  readonly kept: Uint8Array[];
  /** Whether image data has begun, after which a cut keeps what came before it. */
  scanned: boolean;
}

const assemble = (walked: Walked, ended: boolean): Stripped =>
  stripped(
    concat([
      startOfImage,
      ...(walked.jfif === undefined ? [] : [walked.jfif]),
      ...(walked.orientation === undefined
        ? []
        : [segment(0xe1, concat([ascii(exifHeader), orientationTiff(walked.orientation)]))]),
      ...walked.kept,
      ...(ended ? [endOfImage] : []),
    ])
  );

/**
 * Keeps an application segment, rebuilt, or drops it. JFIF holds only a pixel density, which
 * says nothing of who or where, and is kept without its thumbnail, which could show what a
 * crop removed. EXIF gives its Orientation. ICC profiles are colour, and every chunk of one
 * is kept in order. Adobe's APP14 says how the colours of a CMYK or YCCK image are
 * transformed, so it is colour too. Every other, XMP, MPF, IPTC and the unknown, is dropped.
 * @param walked - The walk so far.
 * @param marker - The APPn marker.
 * @param payload - What follows its length.
 * @param whole - The segment, marker and length included.
 */
const application = (walked: Walked, marker: number, payload: Uint8Array, whole: Uint8Array) => {
  if (marker === 0xe0 && walked.jfif === undefined && asciiAt(payload, 0, "JFIF\0")) {
    // Identifier, version, units and density: 12 bytes, then a thumbnail of 0 by 0.
    walked.jfif =
      payload.length >= 14
        ? segment(0xe0, concat([payload.subarray(0, 12), Uint8Array.of(0, 0)]))
        : undefined;
  } else if (marker === 0xe1 && asciiAt(payload, 0, exifHeader)) {
    walked.orientation ??= orientationOf(payload.subarray(exifHeader.length));
  } else if (marker === 0xe2 && asciiAt(payload, 0, "ICC_PROFILE\0")) {
    walked.kept.push(whole);
  } else if (marker === 0xee && asciiAt(payload, 0, "Adobe") && payload.length >= 12) {
    walked.kept.push(segment(0xee, payload.subarray(0, 12)));
  }
};

/**
 * Keeps a segment other than a scan, rebuilt, or drops it.
 * @param walked - The walk so far.
 * @param marker - Its marker.
 * @param payload - What follows its length.
 * @param whole - The segment, marker and length included.
 */
const keepSegment = (walked: Walked, marker: number, payload: Uint8Array, whole: Uint8Array) => {
  if (marker >= 0xe0 && marker <= 0xef) {
    application(walked, marker, payload, whole);
  } else if (isDecoding(marker)) {
    walked.kept.push(whole);
  }
};

/**
 * Where a marker's code is, past the fill bytes before it, which are dropped.
 * @param bytes - The JPEG.
 * @param at - Where the first `0xFF` is.
 * @returns Where the code is, which may be past the end.
 */
const markerAfterFill = (bytes: Uint8Array, at: number) => {
  let markerAt = at + 1;

  while (bytes[markerAt] === 0xff) {
    markerAt += 1;
  }

  return markerAt;
};

/**
 * Strips a JPEG.
 * @param bytes - The JPEG.
 * @returns What to keep: start of image, JFIF, an EXIF of Orientation only, ICC, Adobe's
 *   colour transform, the tables, frames and scans, and the end of image.
 */
export const stripJpeg = (bytes: Uint8Array): Stripped => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return unreadable("a JPEG begins with its start-of-image marker");
  }

  const walked: Walked = { jfif: undefined, kept: [], orientation: undefined, scanned: false };

  const broken = (reason: string) =>
    walked.scanned ? assemble(walked, false) : unreadable(reason);

  let at = 2;

  for (;;) {
    if (at >= bytes.length) {
      return broken("a JPEG ends before its image data");
    }

    if (bytes[at] !== 0xff) {
      return broken("a JPEG holds bytes where a marker belongs");
    }

    const markerAt = markerAfterFill(bytes, at);
    const marker = bytes[markerAt];

    if (marker === undefined) {
      return broken("a JPEG ends inside a marker");
    }

    if (marker === 0xd9) {
      return walked.scanned
        ? assemble(walked, true)
        : unreadable("a JPEG ends before its image data");
    }

    if (marker === 0x00 || marker === 0xd8) {
      return broken("a JPEG holds a marker out of place");
    }

    // Markers with no length, out of place outside a scan: dropped.
    if (marker === 0x01 || isRestart(marker)) {
      at = markerAt + 1;
      continue;
    }

    const length = readBe(bytes, markerAt + 1, 2);
    const end = markerAt + 1 + length;

    if (markerAt + 3 > bytes.length || length < 2 || end > bytes.length) {
      return broken("a JPEG segment runs past the end");
    }

    const whole = bytes.subarray(markerAt - 1, end);

    if (marker === 0xda) {
      const dataEnd = scanEnd(bytes, end);

      walked.kept.push(whole, bytes.subarray(end, dataEnd));
      walked.scanned = true;
      at = dataEnd;
    } else {
      keepSegment(walked, marker, bytes.subarray(markerAt + 3, end), whole);
      at = end;
    }
  }
};
