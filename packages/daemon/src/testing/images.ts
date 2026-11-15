/**
 * Images for testing stripping, built here, since no image tool is at hand: tiny images that
 * decode, made by a browser's encoder or by hand, with the metadata a phone or an editor
 * leaves planted in them, each marked by text a test can search for. And readers that take
 * an image apart, independent of the walker, so a test can say what came out.
 *
 * @packageDocumentation
 */
import { crc32, deflateSync } from "node:zlib";

const encoder = new TextEncoder();

const utf8 = (text: string) => encoder.encode(text);

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "base64"));

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;

  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }

  return whole;
};

const bigEndian = (value: number, width: number) =>
  Uint8Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** (width - 1 - i)) % 256);

const littleEndian = (value: number, width: number) =>
  Uint8Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** i) % 256);

/** Text planted in metadata, which must never come out. */
export const planted = {
  comment: "PLANTED-COMMENT",
  gifXmp: "PLANTED-GIF-XMP",
  itxt: "PLANTED-ITXT",
  make: "PLANTED-MAKE",
  model: "PLANTED-MODEL",
  mpf: "PLANTED-MPF",
  text: "PLANTED-TEXT",
  video: "PLANTED-VIDEO",
  xmp: "PLANTED-XMP",
} as const;

/** The sRGB ICC profile a browser's encoder writes, 456 bytes. */
export const iccProfile = fromBase64(
  "AAAByAAAAAAEMAAAbW50clJHQiBYWVogB+AAAQABAAAAAAAAYWNzcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAPbWAAEAAAAA0y0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAAAkclhZWgAAARQAAAAUZ1hZWgAAASgAAAAUYlhZWgAAATwAAAAUd3RwdAAAAVAAAAAUclRSQwAAAWQAAAAoZ1RSQwAAAWQAAAAoYlRSQwAAAWQAAAAoY3BydAAAAYwAAAA8bWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCWFlaIAAAAAAAAG+iAAA49QAAA5BYWVogAAAAAAAAYpkAALeFAAAY2lhZWiAAAAAAAAAkoAAAD4QAALbPWFlaIAAAAAAAAPbWAAEAAAAA0y1wYXJhAAAAAAAEAAAAAmZmAADypwAADVkAABPQAAAKWwAAAAAAAAAAbWx1YwAAAAAAAAABAAAADGVuVVMAAAAgAAAAHABHAG8AbwBnAGwAZQAgAEkAbgBjAC4AIAAyADAAMQA2"
);

// --- EXIF ---------------------------------------------------------------------------------

const ifdSize = (entries: number) => 2 + entries * 12 + 4;

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** The value, in the TIFF's byte order. */
  readonly value: Uint8Array;
}

/**
 * A TIFF structure as EXIF is: IFD0, and a GPS IFD it points to, if any.
 * @param order - Its byte order.
 * @param ifd0 - IFD0's entries, sorted by tag, the GPS pointer left out.
 * @param gps - The GPS IFD's entries, if any.
 * @returns The TIFF.
 */
const tiff = (order: "II" | "MM", ifd0: readonly Entry[], gps: readonly Entry[] = []) => {
  const number = order === "II" ? littleEndian : bigEndian;

  const zeroth =
    gps.length > 0
      ? [...ifd0, { count: 1, tag: 0x88_25, type: 4, value: new Uint8Array(4) }]
      : ifd0;

  const gpsAt = 8 + ifdSize(zeroth.length);
  let dataAt = gpsAt + (gps.length > 0 ? ifdSize(gps.length) : 0);
  const data: Uint8Array[] = [];

  const ifd = (entries: readonly Entry[]) =>
    concat(
      number(entries.length, 2),
      ...entries.map((entry) => {
        const value = entry.tag === 0x88_25 ? number(gpsAt, 4) : entry.value;
        let field = concat(value, new Uint8Array(Math.max(0, 4 - value.length)));

        if (value.length > 4) {
          field = number(dataAt, 4);
          data.push(value);
          dataAt += value.length;
        }

        return concat(number(entry.tag, 2), number(entry.type, 2), number(entry.count, 4), field);
      }),
      number(0, 4)
    );

  const first = ifd(zeroth);
  const second = gps.length > 0 ? ifd(gps) : new Uint8Array();

  return concat(utf8(order === "II" ? "II*\0" : "MM\0*"), number(8, 4), first, second, ...data);
};

const asciiEntry = (tag: number, text: string): Entry => ({
  count: text.length + 1,
  tag,
  type: 2,
  value: utf8(`${text}\0`),
});

const shortEntry = (order: "II" | "MM", tag: number, value: number): Entry => ({
  count: 1,
  tag,
  type: 3,
  value: (order === "II" ? littleEndian : bigEndian)(value, 2),
});

const rationals = (order: "II" | "MM", values: readonly number[]) =>
  concat(
    ...values.flatMap((value) => [
      (order === "II" ? littleEndian : bigEndian)(value, 4),
      (order === "II" ? littleEndian : bigEndian)(1, 4),
    ])
  );

/**
 * The EXIF a phone writes: Make, Model, an Orientation if given, and where it was, in GPS.
 * @param order - Its byte order.
 * @param orientation - The Orientation, if any.
 * @returns The TIFF structure.
 */
export const phoneExif = (order: "II" | "MM", orientation: number | undefined) =>
  tiff(
    order,
    [
      asciiEntry(0x01_0f, planted.make),
      asciiEntry(0x01_10, planted.model),
      ...(orientation === undefined ? [] : [shortEntry(order, 0x01_12, orientation)]),
    ],
    [
      asciiEntry(0x00_01, "N"),
      { count: 3, tag: 0x00_02, type: 5, value: rationals(order, [51, 30, 26]) },
      asciiEntry(0x00_03, "W"),
      { count: 3, tag: 0x00_04, type: 5, value: rationals(order, [0, 7, 39]) },
    ]
  );

/**
 * The EXIF stripping keeps: a big-endian TIFF of one Orientation.
 * @param orientation - The Orientation.
 * @returns The TIFF structure.
 */
export const orientationExif = (orientation: number) =>
  tiff("MM", [shortEntry("MM", 0x01_12, orientation)]);

const xmpPacket = (extra = "") =>
  utf8(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description exif:GPSLatitude="51,30.4N" ${extra}>${planted.xmp}</rdf:Description></rdf:RDF></x:xmpmeta>`
  );

// --- JPEG ---------------------------------------------------------------------------------

/**
 * A 2×2 baseline JPEG from a browser's encoder: SOI, JFIF, two DQT, SOF0, four DHT, SOS, its
 * scan, and EOI.
 */
export const jpeg = fromBase64(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAcEAACAgMBAQAAAAAAAAAAAAABAgADBAUHBiH/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCP/EABwRAAAGAwAAAAAAAAAAAAAAAAABAwQ0sQJxcv/aAAwDAQACEQMRAD8AtPM9Nr8nm/lLrsHGtts1OI72PSpZmNKEkkj6TERJjfzFusrMA3UhTZ2P/9k="
);

/**
 * A JPEG segment.
 * @param marker - Its marker.
 * @param payload - What follows its length.
 * @returns The marker, length, and payload.
 */
export const jpegSegment = (marker: number, payload: Uint8Array) =>
  concat(Uint8Array.of(0xff, marker), bigEndian(payload.length + 2, 2), payload);

/**
 * An ICC profile cut into APP2 chunks.
 * @param profile - The profile.
 * @param count - How many chunks.
 * @returns The segments, in order.
 */
export const iccSegments = (profile: Uint8Array, count: number) => {
  const size = Math.ceil(profile.length / count);

  return Array.from({ length: count }, (_, i) =>
    jpegSegment(
      0xe2,
      concat(
        utf8("ICC_PROFILE\0"),
        Uint8Array.of(i + 1, count),
        profile.subarray(i * size, (i + 1) * size)
      )
    )
  );
};

/**
 * The JPEG with segments put in after its JFIF APP0, and bytes after its EOI.
 * @param segments - The segments.
 * @param trailer - What follows EOI.
 * @returns The JPEG.
 */
export const jpegWith = (segments: readonly Uint8Array[], trailer: Uint8Array = new Uint8Array()) =>
  concat(jpeg.subarray(0, 20), ...segments, jpeg.subarray(20), trailer);

/** A phone's photo: EXIF with GPS, Make, Model and Orientation 6, XMP, ICC, and a comment. */
export const jpegWithGps = jpegWith([
  jpegSegment(0xe1, concat(utf8("Exif\0\0"), phoneExif("MM", 6))),
  jpegSegment(0xe1, concat(utf8("http://ns.adobe.com/xap/1.0/\0"), xmpPacket())),
  ...iccSegments(iccProfile, 1),
  jpegSegment(0xfe, utf8(planted.comment)),
]);

/**
 * A motion photo: a little-endian EXIF with GPS and Orientation 6, XMP saying where its
 * video is, ICC, MPF, and an MP4 after EOI.
 */
export const motionPhoto = jpegWith(
  [
    jpegSegment(0xe1, concat(utf8("Exif\0\0"), phoneExif("II", 6))),
    jpegSegment(
      0xe1,
      concat(
        utf8("http://ns.adobe.com/xap/1.0/\0"),
        xmpPacket('GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1"')
      )
    ),
    ...iccSegments(iccProfile, 1),
    jpegSegment(0xe2, concat(utf8("MPF\0"), utf8(planted.mpf))),
  ],
  concat(bigEndian(24, 4), utf8("ftypmp42"), bigEndian(0, 4), utf8("isommp42"), utf8(planted.video))
);

// --- PNG ----------------------------------------------------------------------------------

/**
 * A PNG chunk.
 * @param type - Its type.
 * @param data - Its data.
 * @returns Its length, type, data, and CRC.
 */
export const pngChunk = (type: string, data: Uint8Array) => {
  const typed = concat(utf8(type), data);

  return concat(bigEndian(data.length, 4), typed, bigEndian(crc32(typed), 4));
};

/** PNG's signature. */
export const pngSignature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

// Two rows of two RGB pixels, each row with filter 0.
const pixels = (rgb: readonly number[]) =>
  new Uint8Array(deflateSync(Uint8Array.of(0, ...rgb.slice(0, 6), 0, ...rgb.slice(6, 12))));

const header = pngChunk(
  "IHDR",
  concat(bigEndian(2, 4), bigEndian(2, 4), Uint8Array.of(8, 2, 0, 0, 0))
);

const firstFrame = pixels([200, 50, 50, 50, 200, 50, 50, 50, 200, 200, 200, 50]);
const secondFrame = pixels([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);

const frameControl = (sequence: number) =>
  pngChunk(
    "fcTL",
    concat(
      bigEndian(sequence, 4),
      bigEndian(2, 4),
      bigEndian(2, 4),
      bigEndian(0, 4),
      bigEndian(0, 4),
      bigEndian(1, 2),
      bigEndian(2, 2),
      Uint8Array.of(0, 0)
    )
  );

/** A 2×2 PNG: IHDR, IDAT, IEND. */
export const png = concat(
  pngSignature,
  header,
  pngChunk("IDAT", firstFrame),
  pngChunk("IEND", new Uint8Array())
);

/** The text chunks an editor writes. */
const textChunks = [
  pngChunk("tEXt", utf8(`Comment\0${planted.text}`)),
  pngChunk("zTXt", concat(utf8("Author\0\0"), new Uint8Array(deflateSync(utf8("someone"))))),
  pngChunk("iTXt", utf8(`Description\0\0\0\0\0${planted.itxt}`)),
  pngChunk("tIME", Uint8Array.of(0x07, 0xea, 11, 15, 12, 0, 0)),
];

/** The PNG with tEXt, zTXt, iTXt and tIME, around its image data, and gAMA, which stays. */
export const pngWithText = concat(
  pngSignature,
  header,
  ...textChunks.slice(0, 2),
  pngChunk("gAMA", bigEndian(45_455, 4)),
  pngChunk("IDAT", firstFrame),
  ...textChunks.slice(2),
  pngChunk("IEND", new Uint8Array())
);

/**
 * A 2×2 APNG of two frames, looping, with tEXt, an eXIf holding GPS and Orientation 6, ICC,
 * and a chunk no one knows.
 */
export const apng = concat(
  pngSignature,
  header,
  pngChunk("iCCP", concat(utf8("sRGB\0\0"), new Uint8Array(deflateSync(iccProfile)))),
  pngChunk("tEXt", utf8(`Comment\0${planted.text}`)),
  pngChunk("eXIf", phoneExif("MM", 6)),
  pngChunk("acTL", concat(bigEndian(2, 4), bigEndian(0, 4))),
  frameControl(0),
  pngChunk("IDAT", firstFrame),
  frameControl(1),
  pngChunk("fdAT", concat(bigEndian(2, 4), secondFrame)),
  pngChunk("prVt", utf8(planted.comment)),
  pngChunk("IEND", new Uint8Array())
);

/** One chunk of a PNG as a reader sees it. */
export interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
  /** Whether its CRC is right. */
  readonly crcHolds: boolean;
}

/**
 * The chunks of a PNG, read plainly: whatever does not fit ends the list.
 * @param bytes - The PNG.
 * @returns Its chunks.
 */
export const pngChunks = (bytes: Uint8Array): PngChunk[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];

  for (let at = 8; at + 12 <= bytes.length;) {
    const length = view.getUint32(at);

    if (at + 12 + length > bytes.length) {
      break;
    }

    chunks.push({
      crcHolds: view.getUint32(at + 8 + length) === crc32(bytes.subarray(at + 4, at + 8 + length)),
      data: bytes.subarray(at + 8, at + 8 + length),
      type: new TextDecoder().decode(bytes.subarray(at + 4, at + 8)),
    });
    at += 12 + length;
  }

  return chunks;
};

// --- GIF ----------------------------------------------------------------------------------

/**
 * A 2×2 image's LZW data with a code size of 2, a clear code before every pixel so the
 * table never grows, packed least significant bit first, as sub-blocks.
 * @param indices - The four pixels' colour indices.
 * @returns The code size and the sub-blocks.
 */
const gifImageData = (indices: readonly number[]) => {
  const codes = [...indices.flatMap((index) => [4, index]), 5];
  const bytes: number[] = [];
  let bits = 0;
  let held = 0;

  for (const code of codes) {
    held += code * 2 ** bits;
    bits += 3;

    while (bits >= 8) {
      bytes.push(held % 256);
      held = Math.floor(held / 256);
      bits -= 8;
    }
  }

  if (bits > 0) {
    bytes.push(held);
  }

  return Uint8Array.of(2, bytes.length, ...bytes, 0);
};

/**
 * A graphic control extension.
 * @param transparent - Whether colour index 3 is transparent.
 * @returns The block.
 */
export const gifControl = (transparent = false) =>
  Uint8Array.of(0x21, 0xf9, 4, transparent ? 0x05 : 0x04, 50, 0, transparent ? 3 : 0, 0);

/**
 * An image of the 2×2 screen.
 * @param indices - The four pixels' colour indices.
 * @returns The block.
 */
export const gifImage = (indices: readonly number[]) =>
  concat(Uint8Array.of(0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0), gifImageData(indices));

const gifFrame = (indices: readonly number[]) => concat(gifControl(), gifImage(indices));

const gifSubBlocks = (data: Uint8Array) => {
  const blocks: Uint8Array[] = [];

  for (let at = 0; at < data.length; at += 255) {
    const block = data.subarray(at, at + 255);

    blocks.push(Uint8Array.of(block.length), block);
  }

  return concat(...blocks, Uint8Array.of(0));
};

/** A GIF's header, screen of 2×2 and global colour table of four. */
const gifHead = concat(
  utf8("GIF89a"),
  Uint8Array.of(2, 0, 2, 0, 0xf1, 0, 0),
  Uint8Array.of(200, 50, 50, 50, 200, 50, 50, 50, 200, 255, 255, 255)
);

const looping = concat(
  Uint8Array.of(0x21, 0xff, 11),
  utf8("NETSCAPE2.0"),
  Uint8Array.of(3, 1, 0, 0, 0)
);

/** A comment extension. */
export const gifComment = concat(Uint8Array.of(0x21, 0xfe), gifSubBlocks(utf8(planted.comment)));

/** A plain text extension, which no browser draws. */
export const gifPlainText = concat(
  Uint8Array.of(0x21, 0x01, 12, ...new Uint8Array(12)),
  gifSubBlocks(utf8(planted.text))
);

/** The application extension that holds a GIF's ICC colour profile. */
export const gifIccExtension = concat(
  Uint8Array.of(0x21, 0xff, 11),
  utf8("ICCRGBG1012"),
  gifSubBlocks(iccProfile)
);

/**
 * A GIF of blocks, under the 2×2 screen.
 * @param blocks - The blocks.
 * @returns They, ended by the trailer.
 */
export const gifOf = (...blocks: readonly Uint8Array[]) =>
  concat(gifHead, ...blocks, Uint8Array.of(0x3b));

/** A 2×2 GIF of two frames, looping forever. */
export const gif = concat(
  gifHead,
  looping,
  gifFrame([0, 1, 2, 3]),
  gifFrame([3, 3, 3, 3]),
  Uint8Array.of(0x3b)
);

/** The GIF with an ICC colour profile, and its frames. */
export const gifWithIcc = gifOf(
  gifIccExtension,
  looping,
  gifFrame([0, 1, 2, 3]),
  gifFrame([3, 3, 3, 3])
);

/** The GIF with a comment, plain text, and an XMP application extension. */
export const gifWithComment = concat(
  gifHead,
  concat(Uint8Array.of(0x21, 0xfe), gifSubBlocks(utf8(planted.comment))),
  looping,
  concat(Uint8Array.of(0x21, 0xff, 11), utf8("XMP DataXMP"), gifSubBlocks(utf8(planted.gifXmp))),
  gifFrame([0, 1, 2, 3]),
  concat(Uint8Array.of(0x21, 0x01, 12, ...new Uint8Array(12)), gifSubBlocks(utf8(planted.text))),
  gifFrame([3, 3, 3, 3]),
  Uint8Array.of(0x3b)
);

const gifTableSize = (packed: number) => (packed >= 0x80 ? 3 * 2 ** ((packed % 8) + 1) : 0);

/**
 * The images of a GIF, read plainly.
 * @param bytes - The GIF.
 * @returns Each image, from its descriptor through its data's terminator.
 */
export const gifImages = (bytes: Uint8Array): Uint8Array[] => {
  const images: Uint8Array[] = [];
  let at = 13 + gifTableSize(bytes[10] ?? 0);

  const blocksEnd = (from: number) => {
    let end = from;

    while ((bytes[end] ?? 0) !== 0) {
      end += 1 + (bytes[end] ?? 0);
    }

    return end + 1;
  };

  while (at < bytes.length && bytes[at] !== 0x3b) {
    if (bytes[at] === 0x2c) {
      const end = blocksEnd(at + 10 + gifTableSize(bytes[at + 9] ?? 0) + 1);

      images.push(bytes.subarray(at, end));
      at = end;
    } else {
      at = blocksEnd(at + 2);
    }
  }

  return images;
};

// --- WebP ---------------------------------------------------------------------------------

/** A browser's lossy encoding of the 2×2 image, a VP8 bitstream. */
export const vp8First = fromBase64(
  "sAEAnQEqAgACAAFAJiUAToAh38BdgAD+uF1kf9r/0FbbbTXY0d9CvWX30dmAAAAA"
);

/** A browser's lossy encoding of a white 2×2 image. */
const vp8Second = fromBase64("MAEAnQEqAgACAAFAJiWkAANwAP789AAA");

/** A browser's lossless encoding of the 2×2 image, a VP8L bitstream. */
export const vp8l = fromBase64("LwFAAAAfIBBIoIaaKXOBQJLTtNsKBJJslx1q/qNOHsANGCL6HwI=");

/**
 * A RIFF chunk.
 * @param fourCC - Its FourCC.
 * @param data - Its data.
 * @returns The chunk, padded to an even size.
 */
export const riffChunk = (fourCC: string, data: Uint8Array) =>
  concat(utf8(fourCC), littleEndian(data.length, 4), data, new Uint8Array(data.length % 2));

/**
 * A WebP of chunks.
 * @param chunks - The chunks.
 * @returns They, under a RIFF header of their size.
 */
export const webpOf = (...chunks: readonly Uint8Array[]) => {
  const body = concat(utf8("WEBP"), ...chunks);

  return concat(utf8("RIFF"), littleEndian(body.length, 4), body);
};

/**
 * A VP8X chunk of a 2×2 canvas.
 * @param flags - Its flags.
 * @returns The chunk.
 */
export const vp8x = (flags: number) =>
  riffChunk("VP8X", concat(Uint8Array.of(flags, 0, 0, 0), littleEndian(1, 3), littleEndian(1, 3)));

const frame = (vp8: Uint8Array) =>
  riffChunk(
    "ANMF",
    concat(
      new Uint8Array(6),
      littleEndian(1, 3),
      littleEndian(1, 3),
      littleEndian(100, 3),
      Uint8Array.of(0),
      riffChunk("VP8 ", vp8)
    )
  );

/** A simple lossless WebP. */
export const webpLossless = webpOf(riffChunk("VP8L", vp8l));

/**
 * A 2×2 animated WebP of two frames, with ICC, an EXIF holding GPS and Orientation 6, and an
 * XMP of odd size, whose VP8X says it has them all.
 */
export const animatedWebp = webpOf(
  // ICC, EXIF, XMP, and animation.
  vp8x(0x2e),
  riffChunk("ICCP", iccProfile),
  riffChunk("ANIM", Uint8Array.of(255, 255, 255, 255, 0, 0)),
  frame(vp8First),
  frame(vp8Second),
  riffChunk("EXIF", phoneExif("MM", 6)),
  riffChunk("XMP ", concat(xmpPacket(), utf8(xmpPacket().length % 2 === 0 ? " " : "")))
);

/** One chunk of a WebP as a reader sees it. */
export interface WebpChunk {
  readonly fourCC: string;
  readonly data: Uint8Array;
}

/**
 * The chunks of a RIFF body, read plainly.
 * @param bytes - The bytes.
 * @param from - Where the first chunk begins: 12 for a WebP, 16 within an ANMF's data.
 * @returns Its chunks.
 */
export const webpChunks = (bytes: Uint8Array, from = 12): WebpChunk[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: WebpChunk[] = [];

  for (let at = from; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);

    chunks.push({
      data: bytes.subarray(at + 8, at + 8 + size),
      fourCC: new TextDecoder().decode(bytes.subarray(at, at + 4)),
    });
    at += 8 + size + (size % 2);
  }

  return chunks;
};

/**
 * Whether bytes hold text anywhere.
 * @param bytes - The bytes.
 * @param text - The text.
 * @returns Whether it is there.
 */
export const holds = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(text);

/** One segment of a JPEG as a reader sees it. */
export interface JpegSegment {
  readonly marker: number;
  readonly payload: Uint8Array;
}

/**
 * The segments of a JPEG before its first scan, read plainly.
 * @param bytes - The JPEG.
 * @returns Its segments, through the first SOS.
 */
export const jpegSegments = (bytes: Uint8Array): JpegSegment[] => {
  const segments: JpegSegment[] = [];

  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1] ?? 0;
    const length = (bytes[at + 2] ?? 0) * 256 + (bytes[at + 3] ?? 0);

    segments.push({ marker, payload: bytes.subarray(at + 4, at + 2 + length) });

    if (marker === 0xda) {
      break;
    }

    at += 2 + length;
  }

  return segments;
};

/**
 * A JPEG's image data: from its first SOS through the first end of image after it.
 * @param bytes - The JPEG.
 * @returns The bytes.
 */
export const jpegScans = (bytes: Uint8Array): Uint8Array => {
  const start = Buffer.from(bytes).indexOf(Uint8Array.of(0xff, 0xda));
  const end = Buffer.from(bytes).indexOf(Uint8Array.of(0xff, 0xd9), start);

  return bytes.subarray(start, end + 2);
};

/**
 * The data of a PNG's chunks of some types, in order.
 * @param chunks - The chunks.
 * @param types - The types.
 * @returns Their data.
 */
export const pngData = (chunks: readonly PngChunk[], ...types: readonly string[]) =>
  chunks.flatMap(({ type, data }) => (types.includes(type) ? [data] : []));

/**
 * The data of a WebP's chunks of one FourCC, in order.
 * @param chunks - The chunks.
 * @param fourCC - The FourCC.
 * @returns Their data.
 */
export const webpData = (chunks: readonly WebpChunk[], fourCC: string) =>
  chunks.flatMap((chunk) => (chunk.fourCC === fourCC ? [chunk.data] : []));
