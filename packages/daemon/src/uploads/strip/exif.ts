/**
 * The one EXIF tag an image keeps: Orientation, read from the TIFF structure EXIF is, and
 * written back as a TIFF holding nothing else. JPEG, PNG and WebP all carry it this way.
 *
 * @packageDocumentation
 */
import { ascii, asciiAt, be, concat, readBe, readLe } from "./bytes.ts";

const orientationTag = 0x01_12;
const shortType = 3;
const entrySize = 12;

/** The header some writers put before the TIFF in PNG's `eXIf` and WebP's `EXIF`, as JPEG's APP1 has. */
export const exifHeader = "Exif\0\0";

/**
 * The Orientation in a TIFF structure, from its first IFD, in either byte order. Any offset
 * that does not fit, or a value outside 2 to 8, gives none: 1 is upright, which is what an
 * image with no Orientation shows anyway.
 * @param tiff - The TIFF structure.
 * @returns The Orientation, 2 to 8, or none.
 */
export const orientationOf = (tiff: Uint8Array): number | undefined => {
  const little = asciiAt(tiff, 0, "II*\0");

  if (!little && !asciiAt(tiff, 0, "MM\0*")) {
    return undefined;
  }

  const u16 = (at: number) => (little ? readLe(tiff, at, 2) : readBe(tiff, at, 2));
  const u32 = (at: number) => (little ? readLe(tiff, at, 4) : readBe(tiff, at, 4));

  if (tiff.length < 8) {
    return undefined;
  }

  const ifd = u32(4);

  if (ifd + 2 > tiff.length) {
    return undefined;
  }

  const count = u16(ifd);

  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * entrySize;

    if (entry + entrySize > tiff.length) {
      return undefined;
    }

    if (u16(entry) === orientationTag) {
      const value = u16(entry + 8);

      return u16(entry + 2) === shortType && value >= 2 && value <= 8 ? value : undefined;
    }
  }

  return undefined;
};

/**
 * A big-endian TIFF structure holding only an Orientation: its header, one IFD of one entry,
 * and no next IFD.
 * @param orientation - The Orientation, 2 to 8.
 * @returns The 26 bytes.
 */
export const orientationTiff = (orientation: number): Uint8Array =>
  concat([
    ascii("MM\0*"),
    be(8, 4),
    be(1, 2),
    be(orientationTag, 2),
    be(shortType, 2),
    be(1, 4),
    be(orientation, 2),
    be(0, 2),
    be(0, 4),
  ]);

/**
 * The Orientation in an EXIF payload that may or may not begin with {@link exifHeader}.
 * @param payload - The payload.
 * @returns The Orientation, 2 to 8, or none.
 */
export const orientationOfPayload = (payload: Uint8Array): number | undefined =>
  orientationOf(asciiAt(payload, 0, exifHeader) ? payload.subarray(6) : payload);
