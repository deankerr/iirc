/**
 * Stripped images shown by a real browser: each fixture decoded in Chromium before and after
 * stripping, frame by frame and with its Orientation applied, to prove that what stripping
 * writes still displays as the original did. Run with `bun run e2e`.
 */
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  animatedWebp,
  apng,
  gif,
  gifWithComment,
  gifWithIcc,
  jpeg,
  jpegWithGps,
  motionPhoto,
  png,
  pngWithText,
  webpLossless,
} from "../testing/images.ts";
import { stripperFor } from "../uploads/strip/strip.ts";

// What the page has that this project's types do not, as much as the page's code here uses.
// The DOM library is not loaded, since it would change the types of every other file.
interface Pixels {
  readonly data: Uint8ClampedArray;
}

interface Drawable {
  readonly close: () => void;
}

interface Canvas {
  readonly drawImage: (source: Drawable, x: number, y: number) => void;
  readonly getImageData: (x: number, y: number, width: number, height: number) => Pixels;
}

declare class OffscreenCanvas {
  public constructor(width: number, height: number);
  public getContext(kind: "2d"): Canvas | null;
}

interface DecodedFrame extends Drawable {
  readonly displayHeight: number;
  readonly displayWidth: number;
  readonly duration: number | null;
}

declare class ImageDecoder {
  public constructor(init: { readonly data: Uint8Array; readonly type: string });
  public readonly completed: Promise<void>;
  public readonly tracks: {
    readonly ready: Promise<void>;
    readonly selectedTrack: {
      readonly frameCount: number;
      readonly repetitionCount: number;
    } | null;
  };
  public decode(options: {
    readonly completeFramesOnly: boolean;
    readonly frameIndex: number;
  }): Promise<{ readonly image: DecodedFrame }>;
}

declare const createImageBitmap: (
  blob: Blob,
  options: { readonly imageOrientation: "from-image" }
) => Promise<Drawable & { readonly height: number; readonly width: number }>;

/** What a browser made of an image: its frames as a decoder gives them, and as it displays it. */
interface Shown {
  readonly frames: readonly {
    readonly duration: number | null;
    readonly height: number;
    readonly rgba: string;
    readonly width: number;
  }[];
  readonly repetitionCount: number;
  readonly fromImage: { readonly height: number; readonly rgba: string; readonly width: number };
}

interface Fixture {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly type: string;
  /** How many frames it has. */
  readonly frames: number;
}

/** A fixture that carries an Orientation of 6, a quarter turn clockwise. */
interface Turned extends Fixture {
  /** The same image without the Orientation. */
  readonly unturned: Uint8Array;
}

const fixtures: readonly Fixture[] = [
  { bytes: jpeg, frames: 1, name: "JPEG", type: "image/jpeg" },
  { bytes: png, frames: 1, name: "PNG", type: "image/png" },
  { bytes: pngWithText, frames: 1, name: "PNG with text", type: "image/png" },
  { bytes: gif, frames: 2, name: "animated GIF", type: "image/gif" },
  { bytes: gifWithIcc, frames: 2, name: "GIF with ICC", type: "image/gif" },
  { bytes: gifWithComment, frames: 2, name: "GIF with comment", type: "image/gif" },
  { bytes: webpLossless, frames: 1, name: "lossless WebP", type: "image/webp" },
  { bytes: jpegWithGps, frames: 1, name: "JPEG with GPS", type: "image/jpeg" },
  { bytes: motionPhoto, frames: 1, name: "motion photo", type: "image/jpeg" },
  { bytes: apng, frames: 2, name: "APNG", type: "image/png" },
  { bytes: animatedWebp, frames: 2, name: "animated WebP", type: "image/webp" },
];

// Chromium shows no WebP turned, whatever its EXIF says, so a WebP has no turn to see.
const turned: readonly Turned[] = [
  { bytes: jpegWithGps, frames: 1, name: "JPEG with GPS", type: "image/jpeg", unturned: jpeg },
  { bytes: motionPhoto, frames: 1, name: "motion photo", type: "image/jpeg", unturned: jpeg },
  // Its first frame is the PNG's image.
  { bytes: apng, frames: 2, name: "APNG", type: "image/png", unturned: png },
];

/**
 * The pixels of a 2×2 image.
 * @param rgba - Its RGBA bytes, as base64.
 * @returns Each pixel's bytes, row by row.
 */
const pixels = (rgba: string) => {
  const bytes = [...Buffer.from(rgba, "base64")];

  return Array.from({ length: bytes.length / 4 }, (_, i) => bytes.slice(i * 4, i * 4 + 4));
};

/**
 * The pixels of a 2×2 image turned a quarter clockwise, as Orientation 6 says to show it.
 * @param stored - Its pixels, row by row.
 * @returns The pixels shown.
 */
const quarterTurn = (stored: readonly number[][]): number[][] => [
  stored[2] ?? [],
  stored[0] ?? [],
  stored[3] ?? [],
  stored[1] ?? [],
];

/**
 * How far apart two images' pixels are, at the worst channel.
 * @param one - One's pixels.
 * @param other - The other's.
 * @returns The greatest difference of any channel.
 */
const farthest = (one: readonly (readonly number[] | undefined)[], other: readonly number[][]) =>
  Math.max(
    ...one.flatMap((pixel, i) =>
      (pixel ?? []).map((value, c) => Math.abs(value - (other[i]?.[c] ?? 0)))
    )
  );

const strippedOf = (fixture: Fixture) => {
  const result = stripperFor(fixture.type)?.(fixture.bytes);

  if (result?._tag !== "Stripped") {
    throw new Error(`${fixture.name} was not stripped`);
  }

  return result.bytes;
};

/**
 * Has the page decode an image every way a Frontend might show it.
 * @param page - The page.
 * @param bytes - The image.
 * @param type - Its Content-Type.
 * @returns What the browser made of it.
 */
const show = async (page: Page, bytes: Uint8Array, type: string): Promise<Shown> =>
  await page.evaluate(
    async ({ base64, mime }) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- the page has only what is in here
      const pixelsOf = (source: Drawable, width: number, height: number) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");

        if (context === null) {
          throw new Error("no 2d context");
        }

        context.drawImage(source, 0, 0);

        return btoa(String.fromCodePoint(...context.getImageData(0, 0, width, height).data));
      };

      const data = Uint8Array.from(atob(base64), (character) => character.codePointAt(0) ?? 0);
      const decoder = new ImageDecoder({ data, type: mime });

      await decoder.completed;
      await decoder.tracks.ready;

      const track = decoder.tracks.selectedTrack;

      if (track === null) {
        throw new Error("no track");
      }

      const frames = await Promise.all(
        Array.from({ length: track.frameCount }, async (_, frameIndex) => {
          const { image } = await decoder.decode({ completeFramesOnly: true, frameIndex });

          const frame = {
            duration: image.duration,
            height: image.displayHeight,
            rgba: pixelsOf(image, image.displayWidth, image.displayHeight),
            width: image.displayWidth,
          };

          image.close();

          return frame;
        })
      );

      // How a page shows it, with the Orientation applied. A decoder gives the frames as
      // stored, and Chromium's `none` applies the Orientation as well, so it is not asked.
      const bitmap = await createImageBitmap(new Blob([data], { type: mime }), {
        imageOrientation: "from-image",
      });

      const fromImage = {
        height: bitmap.height,
        rgba: pixelsOf(bitmap, bitmap.width, bitmap.height),
        width: bitmap.width,
      };

      bitmap.close();

      return { frames, fromImage, repetitionCount: track.repetitionCount };
    },
    { base64: Buffer.from(bytes).toString("base64"), mime: type }
  );

describe("stripped images, decoded in Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    // WebCodecs is only there in a secure context, which a page on loopback is.
    await page.route("http://localhost/", async (route) => {
      await route.fulfill({ body: "<!doctype html>", contentType: "text/html" });
    });
    await page.goto("http://localhost/");
  });

  afterAll(async () => {
    await browser.close();
  });

  it.each(fixtures)(
    "a stripped $name decodes in Chromium to the same pixels, frames and orientation as the original",
    async (fixture) => {
      const before = await show(page, fixture.bytes, fixture.type);
      const after = await show(page, strippedOf(fixture), fixture.type);

      expect(after.frames).toHaveLength(fixture.frames);
      expect(before.frames).toHaveLength(fixture.frames);
      expect(after).toStrictEqual(before);
    }
  );

  it.each(turned)(
    "a stripped $name is still shown turned a quarter, as its Orientation says",
    async (fixture) => {
      const after = await show(page, strippedOf(fixture), fixture.type);
      const alone = await show(page, fixture.unturned, fixture.type);
      const shown = pixels(after.fromImage.rgba);
      const stored = pixels(alone.fromImage.rgba);

      // It matches the image turned, and not the image as it is.
      expect(farthest(shown, quarterTurn(stored))).toBeLessThanOrEqual(2);
      expect(farthest(shown, stored)).toBeGreaterThan(20);
    }
  );
});
