/**
 * JPEG: walked segment by segment from its start-of-image marker, and through each scan's
 * entropy-coded data to the marker that ends it, never by searching the file. It is cut at
 * the end-of-image marker that ends the primary image, which drops motion-photo video and
 * the secondary images and gain maps MPF and Ultra HDR put after it.
 *
 * @packageDocumentation
 */
import {
  ascii,
  asciiAt,
  be,
  closeGap,
  concat,
  copy,
  makeWriter,
  patch,
  put,
  readBe,
  reserve,
  written,
} from "./bytes.ts";
import type { Writer } from "./bytes.ts";
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

// The segments rebuilt from nothing, in bytes: JFIF's marker, length and 14 of payload; and
// EXIF's marker, length, header and a TIFF of 26.
const jfifSize = 18;
const exifSize = 36;

/**
 * The most a stripped JPEG outgrows the JPEG: what else is kept is copied from disjoint parts
 * of it, or is no longer than the part it is rebuilt from.
 */
const rebuiltSize = jfifSize + exifSize;

/**
 * What a JPEG keeps, written as the walk finds it. JFIF and EXIF come first in the output
 * but may be found after segments that follow them, so room for each is left after the
 * start-of-image marker, and what is not found is closed over at the end.
 */
interface Walked {
  readonly out: Writer;
  /** Whether APP0 JFIF is written, rebuilt without its thumbnail. */
  jfif: boolean;
  /** Whether an EXIF of Orientation only is written. */
  exif: boolean;
  /** Whether image data has begun, after which a cut keeps what came before it. */
  scanned: boolean;
}

const jfifAt = startOfImage.length;
const exifAt = jfifAt + jfifSize;

const assemble = (walked: Walked, ended: boolean): Stripped => {
  const { out } = walked;

  if (!walked.exif) {
    closeGap(out, exifAt, exifSize);
  }

  if (!walked.jfif) {
    closeGap(out, jfifAt, jfifSize);
  }

  if (ended) {
    put(out, endOfImage);
  }

  return stripped(written(out));
};

/**
 * Writes a segment of an application, rebuilt, or drops it. JFIF holds only a pixel density,
 * which says nothing of who or where, and is kept without its thumbnail, which could show
 * what a crop removed. EXIF gives its Orientation. ICC profiles are colour, and every chunk
 * of one is kept in order. Adobe's APP14 says how the colours of a CMYK or YCCK image are
 * transformed, so it is colour too. Every other, XMP, MPF, IPTC and the unknown, is dropped.
 * @param walked - The walk so far.
 * @param bytes - The JPEG.
 * @param marker - The APPn marker.
 * @param from - Where the segment begins, at its marker.
 * @param end - Where it ends.
 */
const application = (
  walked: Walked,
  bytes: Uint8Array,
  marker: number,
  from: number,
  end: number
) => {
  // What follows the marker and its length.
  const payload = bytes.subarray(from + 4, end);

  if (marker === 0xe0 && !walked.jfif && asciiAt(payload, 0, "JFIF\0")) {
    // Identifier, version, units and density: 12 bytes, then a thumbnail of 0 by 0.
    if (payload.length >= 14) {
      patch(
        walked.out,
        jfifAt,
        segment(0xe0, concat([payload.subarray(0, 12), Uint8Array.of(0, 0)]))
      );
      walked.jfif = true;
    }
  } else if (marker === 0xe1 && asciiAt(payload, 0, exifHeader) && !walked.exif) {
    const orientation = orientationOf(payload.subarray(exifHeader.length));

    if (orientation !== undefined) {
      patch(
        walked.out,
        exifAt,
        segment(0xe1, concat([ascii(exifHeader), orientationTiff(orientation)]))
      );
      walked.exif = true;
    }
  } else if (marker === 0xe2 && asciiAt(payload, 0, "ICC_PROFILE\0")) {
    copy(walked.out, bytes, from, end);
  } else if (marker === 0xee && asciiAt(payload, 0, "Adobe") && payload.length >= 12) {
    put(walked.out, segment(0xee, payload.subarray(0, 12)));
  }
};

/**
 * Writes a segment other than a scan, rebuilt, or drops it.
 * @param walked - The walk so far.
 * @param bytes - The JPEG.
 * @param marker - Its marker.
 * @param from - Where the segment begins, at its marker.
 * @param end - Where it ends.
 */
const keepSegment = (
  walked: Walked,
  bytes: Uint8Array,
  marker: number,
  from: number,
  end: number
) => {
  if (marker >= 0xe0 && marker <= 0xef) {
    application(walked, bytes, marker, from, end);
  } else if (isDecoding(marker)) {
    copy(walked.out, bytes, from, end);
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
    return unreadable("invalid JPEG: missing start-of-image marker");
  }

  // Everything written is copied from the JPEG, from the part it is rebuilt from, or from the
  // two slots reserved below, so no more than the JPEG and `rebuiltSize` is ever written.
  const out = makeWriter(bytes.length + rebuiltSize);
  const walked: Walked = { exif: false, jfif: false, out, scanned: false };

  put(out, startOfImage);
  reserve(out, jfifSize + exifSize);

  const broken = (reason: string) =>
    walked.scanned ? assemble(walked, false) : unreadable(reason);

  let at = 2;

  for (;;) {
    if (at >= bytes.length) {
      return broken("truncated JPEG: ends before image data");
    }

    if (bytes[at] !== 0xff) {
      return broken("invalid JPEG: unexpected bytes where a marker belongs");
    }

    const markerAt = markerAfterFill(bytes, at);
    const marker = bytes[markerAt];

    if (marker === undefined) {
      return broken("truncated JPEG marker");
    }

    if (marker === 0xd9) {
      return walked.scanned
        ? assemble(walked, true)
        : unreadable("truncated JPEG: ends before image data");
    }

    if (marker === 0x00 || marker === 0xd8) {
      return broken("invalid JPEG: marker out of place");
    }

    // Markers with no length, out of place outside a scan: dropped.
    if (marker === 0x01 || isRestart(marker)) {
      at = markerAt + 1;
      continue;
    }

    const length = readBe(bytes, markerAt + 1, 2);
    const end = markerAt + 1 + length;

    if (markerAt + 3 > bytes.length || length < 2 || end > bytes.length) {
      return broken("JPEG segment runs past the end of file");
    }

    if (marker === 0xda) {
      const dataEnd = scanEnd(bytes, end);

      copy(out, bytes, markerAt - 1, dataEnd);
      walked.scanned = true;
      at = dataEnd;
    } else {
      keepSegment(walked, bytes, marker, markerAt - 1, end);
      at = end;
    }
  }
};
