/**
 * An image's size in pixels, read from the header bytes its format keeps it in, with no
 * decoder: a PNG's IHDR, a GIF's screen, a JPEG's first frame turned by its EXIF
 * Orientation, a WebP's frame or canvas, an AVIF's primary item turned by its `irot`, and an
 * SVG root's `width` and `height` when they are plain pixels. Bytes that do not say, or that
 * say what no image is, such as a zero or a size past any screen, have none. It never
 * throws, whatever the bytes.
 *
 * @packageDocumentation
 */
import { ImageDimensions } from "@iirc/api";
import type { ImageType } from "@iirc/api";
import { Option, Schema } from "effect";

import { Unreadable, readBox } from "../uploads/strip/boxes.ts";
import type { Box } from "../uploads/strip/boxes.ts";
import { asciiAt, readBe, readLe } from "../uploads/strip/bytes.ts";

/** A size as a header states it, before it is known to be one an image has. */
interface Stated {
  readonly width: number;
  readonly height: number;
}

/** What a reader says: a size, or that the bytes state none. */
type Read = Stated | undefined;

const decodeDimensions = Schema.decodeUnknownOption(ImageDimensions);

// --- PNG ----------------------------------------------------------------------------------

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The signature, then IHDR, which must be the first chunk: its length of 13, its type, and
// its width and height.
const pngSize = (bytes: Uint8Array): Read =>
  pngSignature.every((byte, index) => bytes[index] === byte) &&
  bytes.length >= 24 &&
  readBe(bytes, 8, 4) === 13 &&
  asciiAt(bytes, 12, "IHDR")
    ? { height: readBe(bytes, 20, 4), width: readBe(bytes, 16, 4) }
    : undefined;

// --- GIF ----------------------------------------------------------------------------------

// The logical screen, which is the size a browser draws a GIF at.
const gifSize = (bytes: Uint8Array): Read =>
  (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) && bytes.length >= 10
    ? { height: readLe(bytes, 8, 2), width: readLe(bytes, 6, 2) }
    : undefined;

// --- JPEG ---------------------------------------------------------------------------------

// Orientations 5 to 8 turn the image a quarter, which a browser does when it draws it.
const turnsAQuarter = (orientation: number | undefined) =>
  orientation !== undefined && orientation >= 5 && orientation <= 8;

const orientationTag = 0x01_12;

/**
 * The Orientation of an EXIF segment's TIFF structure, in IFD0, in either byte order.
 * @param bytes - The file.
 * @param from - Where the TIFF header begins.
 * @param to - Where the segment ends.
 * @returns The Orientation, or nothing when the structure does not say.
 */
const orientationOf = (bytes: Uint8Array, from: number, to: number): number | undefined => {
  const little = asciiAt(bytes, from, "II");

  if ((!little && !asciiAt(bytes, from, "MM")) || from + 8 > to) {
    return undefined;
  }

  const read = (at: number, width: number) => (little ? readLe : readBe)(bytes, at, width);
  const ifd = from + read(from + 4, 4);

  if (read(from + 2, 2) !== 42 || ifd + 2 > to) {
    return undefined;
  }

  // As many entries as it says, and no more than fit in the segment.
  const entries = Math.min(read(ifd, 2), Math.floor((to - ifd - 2) / 12));

  for (let entry = 0; entry < entries; entry += 1) {
    const at = ifd + 2 + entry * 12;

    // A SHORT of one value, which sits in the entry itself.
    if (read(at, 2) === orientationTag && read(at + 2, 2) === 3 && read(at + 4, 4) === 1) {
      return read(at + 8, 2);
    }
  }

  return undefined;
};

// Markers that stand alone, with no length after them.
const standalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

// The start-of-frame markers: C0 to CF, but for the tables C4, C8 and CC.
const isFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

// SOI, then segments by their lengths to the first frame, whose height and width it reads.
// An EXIF APP1 on the way gives the Orientation, which may turn them. A scan before any frame,
// the end, a length that is too small or runs past the end, or a stray byte, is no size.
const jpegSize = (bytes: Uint8Array): Read => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  let at = 2;
  let orientation: number | undefined;

  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return undefined;
    }

    const marker = bytes[at + 1] ?? 0;

    if (marker === 0xff) {
      // Fill before a marker.
      at += 1;
    } else if (standalone(marker)) {
      at += 2;
    } else {
      const length = readBe(bytes, at + 2, 2);
      const end = at + 2 + length;

      if (length < 2 || end > bytes.length) {
        return undefined;
      }

      if (isFrame(marker)) {
        // Precision, height, width.
        if (length < 8) {
          return undefined;
        }

        const height = readBe(bytes, at + 5, 2);
        const width = readBe(bytes, at + 7, 2);

        return turnsAQuarter(orientation) ? { height: width, width: height } : { height, width };
      }

      if (marker === 0xda || marker === 0xd9) {
        // A scan or the end, with no frame before it.
        return undefined;
      }

      if (marker === 0xe1 && orientation === undefined && asciiAt(bytes, at + 4, "Exif\0\0")) {
        orientation = orientationOf(bytes, at + 10, end);
      }

      at = end;
    }
  }

  return undefined;
};

// --- WebP ---------------------------------------------------------------------------------

// The first chunk says how the image is coded, and where its size is.
const webpSize = (bytes: Uint8Array): Read => {
  if (!asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) {
    return undefined;
  }

  if (asciiAt(bytes, 12, "VP8 ")) {
    // A key frame's header: its start code, then 14-bit width and height under 2-bit scales.
    return bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
      ? { height: readLe(bytes, 28, 2) % 2 ** 14, width: readLe(bytes, 26, 2) % 2 ** 14 }
      : undefined;
  }

  if (asciiAt(bytes, 12, "VP8L")) {
    // Its signature byte, then 14 bits of width less one, and 14 of height less one.
    if (bytes.length < 25 || bytes[20] !== 0x2f) {
      return undefined;
    }

    const bits = readLe(bytes, 21, 4);

    return { height: (Math.floor(bits / 2 ** 14) % 2 ** 14) + 1, width: (bits % 2 ** 14) + 1 };
  }

  if (asciiAt(bytes, 12, "VP8X")) {
    // The canvas, each side less one in 24 bits.
    return bytes.length >= 30
      ? { height: readLe(bytes, 27, 3) + 1, width: readLe(bytes, 24, 3) + 1 }
      : undefined;
  }

  return undefined;
};

// --- AVIF ---------------------------------------------------------------------------------

// The most boxes a list is read to, so that a file of nothing but tiny boxes cannot make a
// walk long.
const maxBoxes = 4096;

/**
 * The boxes laid end to end in a range, each checked against it.
 * @param bytes - The file.
 * @param from - Where the first begins.
 * @param to - Where the range ends.
 * @returns The boxes, or nothing when one lies or there are too many.
 */
const boxesIn = (bytes: Uint8Array, from: number, to: number): readonly Box[] | undefined => {
  const found: Box[] = [];
  let at = from;

  while (at + 8 <= to) {
    const next = readBox(bytes, at, to);

    if (next instanceof Unreadable || found.length >= maxBoxes) {
      return undefined;
    }

    found.push(next);
    at = next.end;
  }

  return found;
};

const typeNamed = (bytes: Uint8Array, box: Box, name: string) =>
  asciiAt(bytes, box.start + 4, name);

// What a full box's payload begins at: after its header, and its version and flags.
const fullFrom = (box: Box) => box.start + box.header + 4;

// A property's 1-based index among an item's associations: an essential flag in the top bit
// and the index in the rest.
const associated = (bytes: Uint8Array, at: number, wide: boolean): number =>
  wide ? readBe(bytes, at, 2) % 2 ** 15 : (bytes[at] ?? 0) % 2 ** 7;

// Which properties an item has, 1-based, in an `ipma`.
const propertiesOf = (
  bytes: Uint8Array,
  ipma: Box,
  item: number
): readonly number[] | undefined => {
  const version = bytes[ipma.start + ipma.header] ?? 0;
  const wide = (bytes[ipma.start + ipma.header + 3] ?? 0) % 2 === 1;
  const count = readBe(bytes, fullFrom(ipma), 4);
  const idWidth = version === 0 ? 2 : 4;
  const width = wide ? 2 : 1;
  let at = fullFrom(ipma) + 4;

  for (let entry = 0; entry < count && at + idWidth + 1 <= ipma.end; entry += 1) {
    const id = readBe(bytes, at, idWidth);
    const associations = bytes[at + idWidth] ?? 0;
    const first = at + idWidth + 1;

    if (first + associations * width > ipma.end) {
      return undefined;
    }

    if (id === item) {
      return Array.from({ length: associations }, (_, index) =>
        associated(bytes, first + index * width, wide)
      );
    }

    at = first + associations * width;
  }

  return undefined;
};

/** The boxes that say what an AVIF's primary item is. */
interface Primary {
  readonly item: number;
  readonly ipco: Box;
  readonly ipma: Box;
}

// `meta` of the file, which must begin with `ftyp`, and in it `pitm`, and `ipco` and `ipma`
// of `iprp`.
const primaryOf = (bytes: Uint8Array): Primary | undefined => {
  const top = boxesIn(bytes, 0, bytes.length);
  const first = top?.[0];
  const meta = top?.find((box) => typeNamed(bytes, box, "meta"));

  if (first === undefined || !typeNamed(bytes, first, "ftyp") || meta === undefined) {
    return undefined;
  }

  const children = boxesIn(bytes, fullFrom(meta), meta.end);
  const pitm = children?.find((box) => typeNamed(bytes, box, "pitm"));
  const iprp = children?.find((box) => typeNamed(bytes, box, "iprp"));

  const inside =
    iprp === undefined ? undefined : boxesIn(bytes, iprp.start + iprp.header, iprp.end);

  const ipco = inside?.find((box) => typeNamed(bytes, box, "ipco"));
  const ipma = inside?.find((box) => typeNamed(bytes, box, "ipma"));

  if (pitm === undefined || ipco === undefined || ipma === undefined) {
    return undefined;
  }

  const wide = (bytes[pitm.start + pitm.header] ?? 0) !== 0;

  return { ipco, ipma, item: readBe(bytes, fullFrom(pitm), wide ? 4 : 2) };
};

// The primary item's `ispe`, turned a quarter by an `irot` of 1 or 3 among its properties.
const avifSize = (bytes: Uint8Array): Read => {
  const primary = primaryOf(bytes);

  if (primary === undefined) {
    return undefined;
  }

  const listed = propertiesOf(bytes, primary.ipma, primary.item);
  const properties = boxesIn(bytes, primary.ipco.start + primary.ipco.header, primary.ipco.end);

  if (listed === undefined || properties === undefined) {
    return undefined;
  }

  const has = listed.flatMap((index) => properties[index - 1] ?? []);
  const ispe = has.find((box) => typeNamed(bytes, box, "ispe"));
  const irot = has.find((box) => typeNamed(bytes, box, "irot"));

  if (ispe === undefined || ispe.end < fullFrom(ispe) + 8) {
    return undefined;
  }

  const height = readBe(bytes, fullFrom(ispe) + 4, 4);
  const width = readBe(bytes, fullFrom(ispe), 4);
  const angle = irot === undefined ? 0 : (bytes[irot.start + irot.header] ?? 0) % 4;

  return angle % 2 === 1 ? { height: width, width: height } : { height, width };
};

// --- SVG ----------------------------------------------------------------------------------

// How far into an SVG its root element is looked for, so hostile text is read in a bounded
// time, whatever is put before the root.
const svgWindow = 4096;

const decoder = new TextDecoder();

const isSpace = (character: string | undefined) =>
  character === " " || character === "\t" || character === "\n" || character === "\r";

/**
 * Where a doctype ends: its first `>` that is outside quotes and outside an internal subset.
 * @param text - The text.
 * @param from - Where the doctype begins.
 * @returns Where it ends, or nothing when it does not end in the text.
 */
const doctypeEnd = (text: string, from: number): number | undefined => {
  let depth = 0;
  let quote: string | undefined;

  for (let at = from; at < text.length; at += 1) {
    const character = text[at];

    if (quote !== undefined) {
      quote = character === quote ? undefined : quote;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
    } else if (character === ">" && depth <= 0) {
      return at + 1;
    }
  }

  return undefined;
};

// Where a closing marker ends, or nothing when the text holds none after `from`.
const endOf = (text: string, marker: string, from: number): number | undefined => {
  const found = text.indexOf(marker, from);

  return found === -1 ? undefined : found + marker.length;
};

/**
 * Where the root element's tag begins, after whitespace, a declaration, comments, and a
 * doctype, each scanned for its own end.
 * @param text - The start of the document.
 * @returns Where the `<` of the root is, or nothing when there is no root in the text.
 */
const rootAt = (text: string): number | undefined => {
  let at = text.startsWith("\u{FEFF}") ? 1 : 0;

  for (;;) {
    while (isSpace(text[at])) {
      at += 1;
    }

    let end: number | undefined;

    if (text.startsWith("<?", at)) {
      end = endOf(text, "?>", at + 2);
    } else if (text.startsWith("<!--", at)) {
      end = endOf(text, "-->", at + 4);
    } else if (text.startsWith("<!", at)) {
      end = doctypeEnd(text, at + 2);
    } else {
      return text[at] === "<" ? at : undefined;
    }

    if (end === undefined) {
      return undefined;
    }

    at = end;
  }
};

/**
 * The attributes of a start tag, read by hand so the time is that of the text's length:
 * names, `=`, and values in quotes. The first of a name is kept.
 * @param text - The text after `<svg`.
 * @returns The attributes up to the tag's end.
 */
const attributesOf = (text: string): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  let at = 0;

  while (at < text.length && text[at] !== ">") {
    if (isSpace(text[at]) || text[at] === "/") {
      at += 1;
      continue;
    }

    const begin = at;

    while (at < text.length && !isSpace(text[at]) && !"=/>".includes(text[at] ?? "")) {
      at += 1;
    }

    const name = text.slice(begin, at);

    while (isSpace(text[at])) {
      at += 1;
    }

    if (text[at] !== "=") {
      // A name with no value, or a stray `=` or quote, which is passed over.
      at += at === begin ? 1 : 0;
      continue;
    }

    at += 1;

    while (isSpace(text[at])) {
      at += 1;
    }

    const quote = text[at];

    if (quote !== '"' && quote !== "'") {
      continue;
    }

    const close = text.indexOf(quote, at + 1);

    if (close === -1) {
      break;
    }

    if (!found.has(name)) {
      found.set(name, text.slice(at + 1, close));
    }

    at = close + 1;
  }

  return found;
};

// A plain number of pixels: digits with an optional fraction, then nothing or `px`. Its parts
// do not overlap, so a failing value is not tried every way.
const pixels = /^(?<number>\d+(?:\.\d*)?|\.\d+)(?:px)?$/u;

const lengthOf = (value: string | undefined): number | undefined => {
  const number = value === undefined ? undefined : pixels.exec(value.trim())?.groups?.number;

  return number === undefined ? undefined : Math.round(Number(number));
};

// The root `<svg>`'s `width` and `height`, when both are plain pixels. A `viewBox` is not a
// size, nor is a percentage or any other unit.
const svgSize = (bytes: Uint8Array): Read => {
  const text = decoder.decode(bytes.subarray(0, svgWindow));
  const root = rootAt(text);

  if (root === undefined || !text.startsWith("<svg", root)) {
    return undefined;
  }

  const after = text[root + 4];

  if (!isSpace(after) && after !== ">" && after !== "/") {
    return undefined;
  }

  const attributes = attributesOf(text.slice(root + 4));
  const width = lengthOf(attributes.get("width"));
  const height = lengthOf(attributes.get("height"));

  return width === undefined || height === undefined ? undefined : { height, width };
};

// ------------------------------------------------------------------------------------------

const readers: Readonly<Record<ImageType, (bytes: Uint8Array) => Read>> = {
  "image/avif": avifSize,
  "image/gif": gifSize,
  "image/jpeg": jpegSize,
  "image/png": pngSize,
  "image/svg+xml": svgSize,
  "image/webp": webpSize,
};

/**
 * An image's size in pixels, from its bytes.
 * @param bytes - The image, whole or as much as there is.
 * @param type - Its type, which decides where its size is read from.
 * @returns Its width and height, or `null` when the bytes do not state them, or state a zero
 * or a size past any screen.
 */
export const dimensionsOf = (bytes: Uint8Array, type: ImageType): ImageDimensions | null =>
  Option.getOrNull(decodeDimensions(readers[type](bytes)));
