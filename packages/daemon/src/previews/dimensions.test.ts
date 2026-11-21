import { describe, expect, it } from "vitest";

import {
  jpegSegment,
  orientationExif,
  phoneExif,
  pngChunk,
  pngSignature,
  riffChunk,
  webpOf,
} from "../testing/images.ts";
import { box, boxAt, cat, fullBox, heif, text, u } from "../testing/isobmff.ts";
import { dimensionsOf } from "./dimensions.ts";

const littleEndian = (value: number, width: number) =>
  Uint8Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** i) % 256);

const pngOf = (width: number, height: number) =>
  cat(
    pngSignature,
    pngChunk("IHDR", cat(u(width, 4), u(height, 4), Uint8Array.of(8, 2, 0, 0, 0))),
    pngChunk("IEND", new Uint8Array())
  );

const gifOf = (width: number, height: number) =>
  cat(
    text("GIF89a"),
    littleEndian(width, 2),
    littleEndian(height, 2),
    Uint8Array.of(0, 0, 0, 0x3b)
  );

// SOI, the given segments, a baseline SOF0 of the size, a scan, and EOI.
const jpegOf = (width: number, height: number, ...before: readonly Uint8Array[]) =>
  cat(
    Uint8Array.of(0xff, 0xd8),
    ...before,
    jpegSegment(
      0xc0,
      cat(Uint8Array.of(8), u(height, 2), u(width, 2), Uint8Array.of(1, 1, 0x11, 0))
    ),
    jpegSegment(0xda, Uint8Array.of(1, 1, 0, 0, 0x3f, 0)),
    Uint8Array.of(0x12, 0x34, 0xff, 0xd9)
  );

const exifSegment = (tiff: Uint8Array) => jpegSegment(0xe1, cat(text("Exif\0\0"), tiff));

const vp8Of = (width: number, height: number) =>
  webpOf(
    riffChunk(
      "VP8 ",
      cat(
        Uint8Array.of(0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a),
        littleEndian(width, 2),
        littleEndian(height, 2),
        new Uint8Array(8)
      )
    )
  );

const vp8lOf = (width: number, height: number) =>
  webpOf(
    riffChunk(
      "VP8L",
      cat(
        Uint8Array.of(0x2f),
        littleEndian(width - 1 + (height - 1) * 2 ** 14, 4),
        new Uint8Array(8)
      )
    )
  );

const vp8xOf = (width: number, height: number) =>
  webpOf(
    riffChunk(
      "VP8X",
      cat(new Uint8Array(4), littleEndian(width - 1, 3), littleEndian(height - 1, 3))
    )
  );

const ispe = (width: number, height: number) => fullBox("ispe", 0, 0, u(width, 4), u(height, 4));

const irot = (angle: number) => box("irot", u(angle, 1));

// An AVIF whose primary item, 2, has the given properties, and whose item 1, a thumbnail,
// says another size.
const avifOf = (width: number, height: number, ...more: readonly Uint8Array[]) =>
  heif({
    associations: [
      { id: 1, indices: [1] },
      { id: 2, indices: [2, ...more.map((_, index) => index + 3)] },
    ],
    brand: "avif",
    items: [
      { data: Uint8Array.of(1), id: 1, type: "av01" },
      { data: Uint8Array.of(2), id: 2, type: "av01" },
    ],
    primary: 2,
    properties: [ispe(7, 9), ispe(width, height), ...more],
  }).bytes;

// A file with the size of the box at `at` put as `size`, with 4 bytes.
const sized = (bytes: Uint8Array, at: number | undefined, size: number) => {
  const copy = Uint8Array.from(bytes);

  copy.set(u(size, 4), at);

  return copy;
};

// A WebP with its first chunk's size, little-endian as RIFF keeps it, put as `size`.
const chunkSized = (bytes: Uint8Array, size: number) => {
  const copy = Uint8Array.from(bytes);

  copy.set(littleEndian(size, 4), 16);

  return copy;
};

const svgOf = (attributes: string, before = "") =>
  text(`${before}<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect/></svg>`);

describe("an image's size from its bytes", () => {
  it.each([
    ["a PNG", pngOf(640, 480), "image/png", { height: 480, width: 640 }],
    ["a JPEG", jpegOf(640, 480), "image/jpeg", { height: 480, width: 640 }],
    [
      "a JPEG after other segments",
      jpegOf(640, 480, jpegSegment(0xe0, text("JFIF\0")), jpegSegment(0xfe, text("hello"))),
      "image/jpeg",
      { height: 480, width: 640 },
    ],
    [
      "a JPEG whose EXIF says it is upright, big-endian",
      jpegOf(640, 480, exifSegment(orientationExif(1))),
      "image/jpeg",
      { height: 480, width: 640 },
    ],
    [
      "a JPEG turned a quarter by its EXIF, big-endian",
      jpegOf(640, 480, exifSegment(orientationExif(6))),
      "image/jpeg",
      { height: 640, width: 480 },
    ],
    [
      "a JPEG mirrored and turned by its EXIF, little-endian, among other tags",
      jpegOf(640, 480, exifSegment(phoneExif("II", 5))),
      "image/jpeg",
      { height: 640, width: 480 },
    ],
    [
      "a JPEG mirrored only, which keeps its size",
      jpegOf(640, 480, exifSegment(orientationExif(4))),
      "image/jpeg",
      { height: 480, width: 640 },
    ],
    ["a GIF", gifOf(640, 480), "image/gif", { height: 480, width: 640 }],
    ["a lossy WebP", vp8Of(640, 480), "image/webp", { height: 480, width: 640 }],
    ["a lossless WebP", vp8lOf(640, 480), "image/webp", { height: 480, width: 640 }],
    ["an extended WebP", vp8xOf(640, 480), "image/webp", { height: 480, width: 640 }],
    ["an AVIF, by its primary item", avifOf(640, 480), "image/avif", { height: 480, width: 640 }],
    [
      "an AVIF turned a quarter",
      avifOf(640, 480, irot(1)),
      "image/avif",
      { height: 640, width: 480 },
    ],
    [
      "an AVIF turned half, which keeps its size",
      avifOf(640, 480, irot(2)),
      "image/avif",
      { height: 480, width: 640 },
    ],
    [
      "an AVIF turned three quarters",
      avifOf(640, 480, irot(3)),
      "image/avif",
      { height: 640, width: 480 },
    ],
    [
      "an SVG of unitless numbers",
      svgOf('width="640" height="480"'),
      "image/svg+xml",
      { height: 480, width: 640 },
    ],
    [
      "an SVG of pixels, after a declaration, a comment, and a doctype",
      svgOf(
        "height=\"480px\" width = '640px'",
        '<?xml version="1.0"?>\n<!-- <svg width="1" height="1"> -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x" [ <!ENTITY a "b>"> ]>\n'
      ),
      "image/svg+xml",
      { height: 480, width: 640 },
    ],
    [
      "an SVG of fractions, rounded",
      svgOf('width="640.4" height=".6"'),
      "image/svg+xml",
      { height: 1, width: 640 },
    ],
  ] as const)("reads %s", (_name, bytes, type, expected) => {
    expect(dimensionsOf(bytes, type)).toStrictEqual(expected);
  });
});

describe("bytes that lie have no size", () => {
  it.each([
    ["a PNG of no width", pngOf(0, 480), "image/png"],
    ["a PNG of no height", pngOf(640, 0), "image/png"],
    ["a PNG past 32768", pngOf(32_769, 480), "image/png"],
    ["a JPEG of no width", jpegOf(0, 480), "image/jpeg"],
    ["a JPEG of no height", jpegOf(640, 0), "image/jpeg"],
    ["a JPEG past 32768", jpegOf(640, 40_000), "image/jpeg"],
    ["a GIF of no width", gifOf(0, 480), "image/gif"],
    ["a GIF of no height", gifOf(640, 0), "image/gif"],
    ["a GIF past 32768", gifOf(40_000, 480), "image/gif"],
    ["a lossy WebP of no width", vp8Of(0, 480), "image/webp"],
    ["an extended WebP past 32768", vp8xOf(40_000, 480), "image/webp"],
    ["an AVIF of no width", avifOf(0, 480), "image/avif"],
    ["an AVIF of no height", avifOf(640, 0), "image/avif"],
    ["an AVIF past 32768", avifOf(640, 40_000), "image/avif"],
    ["an AVIF of a size that is a 32-bit maximum", avifOf(2 ** 32 - 1, 480), "image/avif"],
    ["an SVG of no width", svgOf('width="0" height="480"'), "image/svg+xml"],
    ["an SVG of no height", svgOf('width="640" height="0px"'), "image/svg+xml"],
    ["an SVG past 32768", svgOf('width="640" height="40000"'), "image/svg+xml"],
    ["an SVG of a size that rounds to nothing", svgOf('width="0.2" height="480"'), "image/svg+xml"],
  ] as const)("%s", (_name, bytes, type) => {
    expect(dimensionsOf(bytes, type)).toBeNull();
  });

  it.each([
    ["a PNG", pngOf(640, 480), "image/png", 33],
    ["a GIF", gifOf(640, 480), "image/gif", 13],
    ["a JPEG", jpegOf(640, 480), "image/jpeg", jpegOf(640, 480).length - 14],
    [
      "a JPEG with EXIF",
      jpegOf(640, 480, exifSegment(orientationExif(6))),
      "image/jpeg",
      jpegOf(640, 480, exifSegment(orientationExif(6))).length - 14,
    ],
    ["a lossy WebP", vp8Of(640, 480), "image/webp", 30],
    ["a lossless WebP", vp8lOf(640, 480), "image/webp", 25],
    ["an extended WebP", vp8xOf(640, 480), "image/webp", 30],
    ["an AVIF", avifOf(640, 480), "image/avif", boxAt(avifOf(640, 480), "meta")?.end ?? 0],
  ] as const)("a header of %s cut short has no size", (_name, bytes, type, needed) => {
    // Every cut shorter than what the size is read from, and the first that is not.
    for (let length = 0; length < needed; length += 1) {
      expect(dimensionsOf(bytes.subarray(0, length), type)).toBeNull();
    }

    expect(dimensionsOf(bytes.subarray(0, needed), type)).not.toBeNull();
  });

  it("reads no size of an SVG whose root tag is cut before its end", () => {
    expect(dimensionsOf(text('<svg width="10" height="20"'), "image/svg+xml")).toBeNull();
    expect(dimensionsOf(text('<svg width="10" height="20">'), "image/svg+xml")).toStrictEqual({
      height: 20,
      width: 10,
    });
  });

  it.each([
    [
      "an extended WebP whose VP8X says it holds nothing",
      chunkSized(vp8xOf(640, 480), 0),
      "image/webp",
    ],
    [
      "a lossy WebP whose VP8 says it holds less than its header",
      chunkSized(vp8Of(640, 480), 4),
      "image/webp",
    ],
    [
      "a lossless WebP whose VP8L says it holds less than its header",
      chunkSized(vp8lOf(640, 480), 2),
      "image/webp",
    ],
    ["an AVIF whose irot is empty", avifOf(640, 480, box("irot", new Uint8Array())), "image/avif"],
  ] as const)("%s has no size", (_name, bytes, type) => {
    expect(dimensionsOf(bytes, type)).toBeNull();
  });

  it.each([
    [
      "a PNG signature, then garbage",
      cat(pngSignature, text("garbage garbage garbage garbage")),
      "image/png",
    ],
    [
      "a PNG whose first chunk is not IHDR",
      cat(pngSignature, pngChunk("IDAT", new Uint8Array(13))),
      "image/png",
    ],
    ["a GIF signature, then nothing", text("GIF89a"), "image/gif"],
    [
      "a JPEG signature, then garbage",
      cat(Uint8Array.of(0xff, 0xd8), text("garbage garbage")),
      "image/jpeg",
    ],
    [
      "a JPEG that reaches its scan before a frame",
      cat(
        Uint8Array.of(0xff, 0xd8),
        jpegSegment(0xda, new Uint8Array(6)),
        Uint8Array.of(0xff, 0xd9)
      ),
      "image/jpeg",
    ],
    ["a JPEG with no frame", cat(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)), "image/jpeg"],
    [
      "a WebP signature, then garbage",
      cat(text("RIFF"), new Uint8Array(4), text("WEBPgarbage garbage garbage garbage")),
      "image/webp",
    ],
    [
      "a lossy WebP with no start code",
      webpOf(riffChunk("VP8 ", new Uint8Array(20))),
      "image/webp",
    ],
    [
      "a lossless WebP with no signature byte",
      webpOf(riffChunk("VP8L", new Uint8Array(20))),
      "image/webp",
    ],
    ["a file of another type", pngOf(640, 480), "image/gif"],
    ["an AVIF of garbage", text("garbage garbage garbage garbage garbage"), "image/avif"],
    ["an empty file", new Uint8Array(), "image/png"],
  ] as const)("%s", (_name, bytes, type) => {
    expect(dimensionsOf(bytes, type)).toBeNull();
  });

  it("a JPEG whose segment length runs past the end, before its frame", () => {
    const lying = jpegOf(640, 480, cat(Uint8Array.of(0xff, 0xe0, 0xff, 0xff), text("short")));

    expect(dimensionsOf(lying, "image/jpeg")).toBeNull();
  });

  it("a JPEG whose segment length is smaller than its own", () => {
    expect(
      dimensionsOf(jpegOf(640, 480, Uint8Array.of(0xff, 0xe0, 0, 1)), "image/jpeg")
    ).toBeNull();
  });

  it("a JPEG whose EXIF is garbage keeps the size of its frame", () => {
    const garbage = jpegSegment(0xe1, cat(text("Exif\0\0"), text("II*\0"), u(0xff_ff_ff_ff, 4)));

    expect(dimensionsOf(jpegOf(640, 480, garbage), "image/jpeg")).toStrictEqual({
      height: 480,
      width: 640,
    });
  });

  it.each([
    ["a size of 0 on the first box", (bytes: Uint8Array) => sized(bytes, 0, 0)],
    [
      "a size smaller than a header on meta",
      (bytes: Uint8Array) => sized(bytes, boxAt(bytes, "meta")?.start, 4),
    ],
    [
      "a size past the end on meta",
      (bytes: Uint8Array) => sized(bytes, boxAt(bytes, "meta")?.start, 0xff_ff_ff_ff),
    ],
    [
      "a size of 1, which says a 64-bit size that is huge, on meta",
      (bytes: Uint8Array) => sized(bytes, boxAt(bytes, "meta")?.start, 1),
    ],
    [
      "a size of 0 on ipco, which swallows the associations",
      (bytes: Uint8Array) => sized(bytes, boxAt(bytes, "meta", "iprp", "ipco")?.start, 0),
    ],
    [
      "a size past the end on ipma",
      (bytes: Uint8Array) =>
        sized(bytes, boxAt(bytes, "meta", "iprp", "ipma")?.start, 0xff_ff_ff_ff),
    ],
    [
      "a size that overruns its parent on ispe's box",
      (bytes: Uint8Array) =>
        sized(bytes, (boxAt(bytes, "meta", "iprp", "ipco")?.start ?? 0) + 8, 0xff_ff),
    ],
  ])("an AVIF with %s", (_name, lie) => {
    expect(dimensionsOf(lie(avifOf(640, 480)), "image/avif")).toBeNull();
  });

  it("an AVIF with no primary item named", () => {
    const withoutPrimary = heif({
      associations: [{ id: 1, indices: [1] }],
      brand: "avif",
      items: [{ data: Uint8Array.of(1), id: 1, type: "av01" }],
      properties: [ispe(640, 480)],
    }).bytes;

    expect(dimensionsOf(withoutPrimary, "image/avif")).toBeNull();
  });

  it("an AVIF whose primary item has no ispe", () => {
    const without = heif({
      associations: [{ id: 1, indices: [1] }],
      brand: "avif",
      items: [{ data: Uint8Array.of(1), id: 1, type: "av01" }],
      primary: 1,
      properties: [irot(1)],
    }).bytes;

    expect(dimensionsOf(without, "image/avif")).toBeNull();
  });

  it.each([
    ["a percentage", 'width="100%" height="100%"'],
    ["ems", 'width="10em" height="20em"'],
    ["a width and no height", 'width="640"'],
    ["a viewBox and no size", 'viewBox="0 0 640 480"'],
    ["no size", ""],
    ["an exponent", 'width="1e3" height="480"'],
    ["a negative size", 'width="-640" height="480"'],
    ["a size that is not a number", 'width="wide" height="480"'],
  ])("an SVG of %s", (_name, attributes) => {
    expect(dimensionsOf(svgOf(attributes), "image/svg+xml")).toBeNull();
  });

  it("an SVG whose size is past the first 4 KiB", () => {
    const far = text(`<svg ${'a="b" '.repeat(1000)} width="640" height="480"></svg>`);

    expect(dimensionsOf(far, "image/svg+xml")).toBeNull();
  });

  it("an SVG that is not an svg element at its root", () => {
    expect(
      dimensionsOf(text('<html><svg width="640" height="480"></svg></html>'), "image/svg+xml")
    ).toBeNull();
  });

  it("an SVG of hostile text is read in the time of its length", () => {
    const hostile = text(`<svg width="${"1".repeat(4000)}x" height="${" ".repeat(4000)}1`);

    expect(dimensionsOf(hostile, "image/svg+xml")).toBeNull();
    expect(dimensionsOf(text("<!--".repeat(2000)), "image/svg+xml")).toBeNull();
    expect(dimensionsOf(text("<!DOCTYPE [".repeat(400)), "image/svg+xml")).toBeNull();
  });
});
