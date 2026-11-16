import { describe, expect, it } from "vitest";

import {
  animatedWebp,
  apng,
  gif,
  gifComment,
  gifControl,
  gifIccExtension,
  gifImage,
  gifOf,
  gifPlainText,
  jpeg,
  png,
  pngChunk,
  pngSignature,
  riffChunk,
  vp8First,
  vp8l,
  vp8x,
  webpLossless,
  webpOf,
} from "../testing/images.ts";
import { animated } from "./animated.ts";

const encoder = new TextEncoder();

/**
 * Every way bytes may be cut short, from nothing to all but the last byte.
 * @param bytes - The bytes.
 * @returns Each prefix.
 */
const prefixes = (bytes: Uint8Array) =>
  Array.from({ length: bytes.length }, (_, length) => bytes.subarray(0, length));

describe("whether an image moves", () => {
  it("a GIF of two images moves", () => {
    expect(animated(gif)).toBeTruthy();
  });

  it("a GIF of one image is still", () => {
    expect(animated(gifOf(gifControl(), gifImage([0, 1, 2, 3])))).toBeFalsy();
  });

  it("a GIF of one image among comments, plain text, and an application extension is still", () => {
    expect(
      animated(gifOf(gifIccExtension, gifComment, gifImage([0, 1, 2, 3]), gifPlainText))
    ).toBeFalsy();
  });

  it("a GIF of two images with extensions between them moves", () => {
    expect(
      animated(
        gifOf(
          gifImage([0, 1, 2, 3]),
          gifComment,
          gifPlainText,
          gifControl(),
          gifImage([3, 3, 3, 3])
        )
      )
    ).toBeTruthy();
  });

  it("a GIF87a of two images moves", () => {
    const old = Uint8Array.from(gif);

    old.set(encoder.encode("GIF87a"));

    expect(animated(old)).toBeTruthy();
  });

  it("a GIF cut short in its second image is still, since the second is not whole", () => {
    expect(animated(gif.subarray(0, -4))).toBeFalsy();
  });

  it("a GIF whose second block is one no GIF has is still", () => {
    expect(
      animated(gifOf(gifImage([0, 1, 2, 3]), Uint8Array.of(0x99), gifImage([0, 0, 0, 0])))
    ).toBeFalsy();
  });

  it("a WebP whose VP8X sets the animation flag moves", () => {
    expect(animated(animatedWebp)).toBeTruthy();
  });

  it("a WebP whose VP8X sets other flags but not animation is still", () => {
    expect(animated(webpOf(vp8x(0x3c), riffChunk("VP8 ", vp8First)))).toBeFalsy();
  });

  it("a simple lossless WebP, with no VP8X, is still", () => {
    expect(animated(webpLossless)).toBeFalsy();
  });

  it("a WebP whose VP8L bitstream happens to hold the flag's bit is still", () => {
    expect(animated(webpOf(riffChunk("VP8L", vp8l)))).toBeFalsy();
  });

  it("an APNG, whose acTL comes before its IDAT, moves", () => {
    expect(animated(apng)).toBeTruthy();
  });

  it("a PNG with no acTL is still", () => {
    expect(animated(png)).toBeFalsy();
  });

  it("a PNG whose acTL comes only after its IDAT is still, as a reader ignores it", () => {
    const late = new Uint8Array([
      ...png.subarray(0, -12),
      ...pngChunk("acTL", new Uint8Array(8)),
      ...png.subarray(-12),
    ]);

    expect(animated(late)).toBeFalsy();
  });

  it("a JPEG, an SVG, and bytes of no image are still", () => {
    expect(animated(jpeg)).toBeFalsy();
    expect(animated(encoder.encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeFalsy();
    expect(animated(encoder.encode("GIF"))).toBeFalsy();
    expect(animated(new Uint8Array())).toBeFalsy();
  });

  it("never throws on any image cut short anywhere", () => {
    for (const image of [gif, animatedWebp, apng, png, webpLossless]) {
      for (const prefix of prefixes(image)) {
        expect(() => animated(prefix)).not.toThrow();
      }
    }
  });

  it("an APNG cut short before its acTL is still, and once it is there moves", () => {
    const at = Buffer.from(apng).indexOf("acTL") - 4;

    expect(animated(apng.subarray(0, at))).toBeFalsy();
    expect(animated(apng.subarray(0, at + 8))).toBeTruthy();
  });

  it("a PNG chunk whose length runs past the end is still, and never loops", () => {
    const huge = new Uint8Array([
      ...pngSignature,
      0xff,
      0xff,
      0xff,
      0xff,
      ...encoder.encode("tEXt"),
    ]);

    expect(animated(huge)).toBeFalsy();
  });
});
