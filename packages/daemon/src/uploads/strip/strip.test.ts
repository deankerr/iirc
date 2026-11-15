import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  animatedWebp,
  apng,
  gif,
  gifComment,
  gifControl,
  gifIccExtension,
  gifImage,
  gifImages,
  gifOf,
  gifPlainText,
  gifWithComment,
  gifWithIcc,
  holds,
  iccProfile,
  iccSegments,
  jpeg,
  jpegScans,
  jpegSegment,
  jpegSegments,
  jpegWith,
  jpegWithGps,
  motionPhoto,
  orientationExif,
  phoneExif,
  planted,
  png,
  pngChunk,
  pngChunks,
  pngData,
  pngSignature,
  pngWithText,
  riffChunk,
  vp8First,
  vp8l,
  vp8x,
  webpChunks,
  webpData,
  webpLossless,
  webpOf,
} from "../../testing/images.ts";
import { stripperFor } from "./strip.ts";

const encoder = new TextEncoder();

const concat = (...parts: readonly Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

const strip = (type: string, bytes: Uint8Array) => {
  const stripper = stripperFor(type);

  if (stripper === undefined) {
    throw new Error(`no stripper for ${type}`);
  }

  return stripper(bytes);
};

// The bytes kept, failing the test if the image was refused.
const kept = (type: string, bytes: Uint8Array) => {
  const result = strip(type, bytes);

  if (result._tag === "Unreadable") {
    throw new Error(`refused: ${result.reason}`);
  }

  return result.bytes;
};

const tagOf = (type: string, bytes: Uint8Array) => strip(type, bytes)._tag;

const exifPayload = (tiff: Uint8Array) => concat(encoder.encode("Exif\0\0"), tiff);

const fixtures = [
  ["image/jpeg", jpeg],
  ["image/jpeg", jpegWithGps],
  ["image/jpeg", motionPhoto],
  ["image/png", png],
  ["image/png", pngWithText],
  ["image/png", apng],
  ["image/gif", gif],
  ["image/gif", gifWithComment],
  ["image/gif", gifWithIcc],
  ["image/webp", webpLossless],
  ["image/webp", animatedWebp],
] as const;

describe("stripping a JPEG", () => {
  it("keeps a JPEG with nothing to strip byte for byte", () => {
    expect(kept("image/jpeg", jpeg)).toStrictEqual(jpeg);
  });

  it("drops GPS, Make, Model, XMP and a comment, keeping an Orientation-only EXIF and ICC", () => {
    const out = kept("image/jpeg", jpegWithGps);
    const segments = jpegSegments(out);

    expect(segments.map(({ marker }) => marker)).toStrictEqual([
      0xe0, 0xe1, 0xe2, 0xdb, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4, 0xda,
    ]);
    expect(segments[1]?.payload).toStrictEqual(exifPayload(orientationExif(6)));
    expect(segments[2]?.payload).toStrictEqual(iccSegments(iccProfile, 1)[0]?.subarray(4));
    expect(Object.values(planted).filter((text) => holds(out, text))).toStrictEqual([]);
  });

  it("keeps the scan byte for byte", () => {
    expect(jpegScans(kept("image/jpeg", jpegWithGps))).toStrictEqual(jpegScans(jpegWithGps));
  });

  it("cuts a motion photo at the end of its image, dropping its video and MPF", () => {
    const out = kept("image/jpeg", motionPhoto);

    expect(out.subarray(-2)).toStrictEqual(Uint8Array.of(0xff, 0xd9));
    expect([
      holds(out, "ftyp"),
      holds(out, planted.video),
      holds(out, "MPF"),
      holds(out, "MotionPhoto"),
    ]).toStrictEqual([false, false, false, false]);
  });

  it("reads Orientation from a little-endian EXIF and writes it big-endian", () => {
    const exif = jpegSegments(kept("image/jpeg", motionPhoto)).find(
      ({ marker }) => marker === 0xe1
    );

    expect(exif?.payload).toStrictEqual(exifPayload(orientationExif(6)));
  });

  it("keeps no EXIF when the original holds no Orientation", () => {
    const original = jpegWith([jpegSegment(0xe1, exifPayload(phoneExif("II", undefined)))]);

    expect(kept("image/jpeg", original)).toStrictEqual(jpeg);
  });

  it("keeps no EXIF for Orientation 1, which is upright anyway", () => {
    const original = jpegWith([jpegSegment(0xe1, exifPayload(phoneExif("MM", 1)))]);

    expect(kept("image/jpeg", original)).toStrictEqual(jpeg);
  });

  it("keeps every chunk of an ICC profile split across APP2 segments, in order", () => {
    const chunks = iccSegments(iccProfile, 3);

    expect(kept("image/jpeg", jpegWith(chunks))).toStrictEqual(jpegWith(chunks));
  });

  it("keeps Adobe's colour transform and drops what follows it in APP14", () => {
    const adobe = concat(encoder.encode("Adobe"), Uint8Array.of(0, 100, 0, 0, 0, 0, 2));
    const original = jpegWith([jpegSegment(0xee, concat(adobe, encoder.encode(planted.comment)))]);

    expect(kept("image/jpeg", original)).toStrictEqual(jpegWith([jpegSegment(0xee, adobe)]));
  });

  it("drops a JFIF thumbnail, keeping the density", () => {
    const withThumbnail = concat(
      jpeg.subarray(0, 2),
      jpegSegment(0xe0, concat(jpeg.subarray(6, 18), Uint8Array.of(1, 1), Uint8Array.of(9, 9, 9))),
      jpeg.subarray(20)
    );

    expect(kept("image/jpeg", withThumbnail)).toStrictEqual(jpeg);
  });

  it("walks a progressive JPEG's scans through restarts, stuffed bytes and fill, dropping metadata between them", () => {
    const tables = concat(
      jpegSegment(0xdb, new Uint8Array(65)),
      jpegSegment(0xc2, Uint8Array.of(8, 0, 2, 0, 2, 1, 1, 0x11, 0)),
      jpegSegment(0xdd, Uint8Array.of(0, 1))
    );

    const firstScan = concat(
      jpegSegment(0xc4, new Uint8Array(17)),
      jpegSegment(0xda, Uint8Array.of(1, 1, 0, 0, 0, 0)),
      Uint8Array.of(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd1, 0x78)
    );

    const secondScan = concat(
      jpegSegment(0xc4, new Uint8Array(17)),
      jpegSegment(0xda, Uint8Array.of(1, 1, 0, 1, 63, 0)),
      Uint8Array.of(0x9a, 0xff, 0x00, 0xbc)
    );

    const between = jpegSegment(
      0xe1,
      encoder.encode(`http://ns.adobe.com/xap/1.0/\0${planted.xmp}`)
    );

    const comment = jpegSegment(0xfe, encoder.encode(planted.comment));
    const start = Uint8Array.of(0xff, 0xd8);
    const end = Uint8Array.of(0xff, 0xd9);

    expect(
      kept(
        "image/jpeg",
        concat(
          start,
          tables,
          firstScan,
          between,
          secondScan,
          comment,
          end,
          encoder.encode(planted.video)
        )
      )
    ).toStrictEqual(concat(start, tables, firstScan, secondScan, end));
  });

  it("keeps a JPEG cut short inside its final scan, as far as it goes", () => {
    const cut = jpeg.subarray(0, -10);

    expect(kept("image/jpeg", cut)).toStrictEqual(cut);
  });

  it("refuses a JPEG whose segment runs past the end before its image data", () => {
    expect(tagOf("image/jpeg", jpegWithGps.subarray(0, 60))).toBe("Unreadable");
  });

  it("refuses a JPEG with no image data", () => {
    expect(tagOf("image/jpeg", Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBe("Unreadable");
  });

  it("refuses a JPEG with bytes where a marker belongs before its image data", () => {
    expect(
      tagOf("image/jpeg", concat(jpeg.subarray(0, 20), Uint8Array.of(0, 1, 2), jpeg.subarray(20)))
    ).toBe("Unreadable");
  });
});

describe("stripping a PNG", () => {
  it("keeps a PNG with nothing to strip byte for byte", () => {
    expect(kept("image/png", png)).toStrictEqual(png);
  });

  it("drops tEXt, zTXt, iTXt and tIME, keeping gAMA", () => {
    expect(pngChunks(kept("image/png", pngWithText)).map(({ type }) => type)).toStrictEqual([
      "IHDR",
      "gAMA",
      "IDAT",
      "IEND",
    ]);
  });

  it("keeps an APNG's frames and ICC, and an eXIf of Orientation only after IHDR, with every CRC right", () => {
    const chunks = pngChunks(kept("image/png", apng));
    const original = pngChunks(apng);

    expect({
      crcsHold: chunks.every(({ crcHolds }) => crcHolds),
      exif: pngData(chunks, "eXIf"),
      frames: pngData(chunks, "acTL", "fcTL", "IDAT", "fdAT", "iCCP"),
      types: chunks.map(({ type }) => type),
    }).toStrictEqual({
      crcsHold: true,
      exif: [orientationExif(6)],
      frames: pngData(original, "acTL", "fcTL", "IDAT", "fdAT", "iCCP"),
      types: ["IHDR", "eXIf", "iCCP", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "IEND"],
    });
  });

  it("stops after IEND", () => {
    expect(kept("image/png", concat(png, encoder.encode(planted.video)))).toStrictEqual(png);
  });

  it("keeps a PNG missing IEND after its image data, as far as it goes", () => {
    const cut = png.subarray(0, -12);

    expect(kept("image/png", cut)).toStrictEqual(cut);
  });

  it("drops a chunk cut short after the image data", () => {
    const cut = concat(
      png.subarray(0, -12),
      pngChunk("tEXt", encoder.encode(planted.text)).subarray(0, 10)
    );

    expect(kept("image/png", cut)).toStrictEqual(png.subarray(0, -12));
  });

  it("refuses a PNG whose chunk runs past the end before its image data", () => {
    expect(tagOf("image/png", apng.subarray(0, 60))).toBe("Unreadable");
  });

  it("refuses a PNG whose chunk length runs past the end", () => {
    const lying = concat(
      png.subarray(0, 8),
      Uint8Array.of(0x7f, 0xff, 0xff, 0xff),
      png.subarray(12)
    );

    expect(tagOf("image/png", lying)).toBe("Unreadable");
  });

  it("refuses a PNG that does not begin with IHDR", () => {
    expect(
      tagOf(
        "image/png",
        concat(pngSignature, pngChunk("tEXt", encoder.encode("a\0b")), png.subarray(8))
      )
    ).toBe("Unreadable");
  });
});

describe("stripping a GIF", () => {
  it("keeps a GIF with nothing to strip byte for byte", () => {
    expect(kept("image/gif", gif)).toStrictEqual(gif);
  });

  it("drops a comment, plain text and XMP, keeping the frames, their controls and looping", () => {
    expect(kept("image/gif", gifWithComment)).toStrictEqual(gif);
  });

  it("keeps the ICC colour profile extension byte for byte", () => {
    const out = kept("image/gif", gifWithIcc);

    expect({
      kept: out,
      profile: Buffer.from(out).includes(gifIccExtension),
    }).toStrictEqual({ kept: gifWithIcc, profile: true });
  });

  it("drops a graphic control with the plain text it applies to, not leaving it on the image", () => {
    const pixels = [0, 1, 2, 3];

    expect(
      kept("image/gif", gifOf(gifControl(true), gifPlainText, gifImage(pixels)))
    ).toStrictEqual(gifOf(gifImage(pixels)));
  });

  it("keeps the graphic control that follows plain text for the image it precedes", () => {
    const pixels = [0, 1, 2, 3];

    expect(
      kept("image/gif", gifOf(gifControl(true), gifPlainText, gifControl(false), gifImage(pixels)))
    ).toStrictEqual(gifOf(gifControl(false), gifImage(pixels)));
  });

  it("keeps a graphic control for its image across a comment", () => {
    const pixels = [0, 1, 2, 3];

    expect(kept("image/gif", gifOf(gifControl(true), gifComment, gifImage(pixels)))).toStrictEqual(
      gifOf(gifControl(true), gifImage(pixels))
    );
  });

  it("keeps the frames walked whole when cut short after the first", () => {
    const [first] = gifImages(gif);
    const firstEnd = Buffer.from(gif).indexOf(first ?? new Uint8Array()) + (first?.length ?? 0);
    const out = kept("image/gif", gif.subarray(0, firstEnd + 12));

    expect(gifImages(out)).toStrictEqual(gifImages(gif).slice(0, 1));
  });

  it("refuses a GIF cut short before its first image is whole", () => {
    expect(tagOf("image/gif", gif.subarray(0, 50))).toBe("Unreadable");
  });

  it("refuses a GIF whose colour table runs past the end", () => {
    expect(tagOf("image/gif", gif.subarray(0, 20))).toBe("Unreadable");
  });
});

describe("stripping a WebP", () => {
  it("keeps a simple lossless WebP byte for byte", () => {
    expect(kept("image/webp", webpLossless)).toStrictEqual(webpLossless);
  });

  it("keeps an animated WebP's frames and ICC, and an EXIF of Orientation only, rewriting VP8X and the RIFF size", () => {
    const out = kept("image/webp", animatedWebp);
    const chunks = webpChunks(out);
    const original = webpChunks(animatedWebp);

    expect({
      exif: webpData(chunks, "EXIF"),
      flags: webpData(chunks, "VP8X")[0]?.[0],
      fourCCs: chunks.map(({ fourCC }) => fourCC),
      frames: webpData(chunks, "ANMF"),
      icc: webpData(chunks, "ICCP"),
      planted: Object.values(planted).filter((text) => holds(out, text)),
      riffSize: new DataView(out.buffer, out.byteOffset).getUint32(4, true),
    }).toStrictEqual({
      exif: [orientationExif(6)],
      // ICC, EXIF, and animation.
      flags: 0x2a,
      fourCCs: ["VP8X", "ICCP", "ANIM", "ANMF", "ANMF", "EXIF"],
      frames: webpData(original, "ANMF"),
      icc: [iccProfile],
      planted: [],
      riffSize: out.length - 8,
    });
  });

  it("clears the EXIF flag when no Orientation is kept", () => {
    const original = webpOf(
      // EXIF and XMP.
      vp8x(0x0c),
      riffChunk("VP8 ", vp8First),
      riffChunk("EXIF", phoneExif("II", undefined))
    );

    expect(kept("image/webp", original)).toStrictEqual(
      webpOf(vp8x(0), riffChunk("VP8 ", vp8First))
    );
  });

  it("walks odd-sized chunks by their padding, dropping an unknown one", () => {
    const alpha = riffChunk("ALPH", Uint8Array.of(0, 1, 2));

    const original = webpOf(
      vp8x(0x10),
      alpha,
      riffChunk("UNKN", encoder.encode("odd")),
      riffChunk("VP8 ", vp8First)
    );

    expect(kept("image/webp", original)).toStrictEqual(
      webpOf(vp8x(0x10), alpha, riffChunk("VP8 ", vp8First))
    );
  });

  it("strips a WebP of two hundred thousand empty unknown chunks to the same as one without them", () => {
    const junkChunk = riffChunk("JUNK", new Uint8Array());
    const count = 200_000;
    const junk = new Uint8Array(count * junkChunk.length);

    for (let i = 0; i < count; i += 1) {
      junk.set(junkChunk, i * junkChunk.length);
    }

    expect(
      kept("image/webp", webpOf(vp8x(0), junk, riffChunk("VP8 ", vp8First), junk))
    ).toStrictEqual(webpOf(vp8x(0), riffChunk("VP8 ", vp8First)));
  });

  it("keeps only the first of a chunk that a file holds once", () => {
    const icc = riffChunk("ICCP", iccProfile);
    const other = riffChunk("ICCP", encoder.encode("a second profile"));

    expect(
      kept("image/webp", webpOf(vp8x(0x20), icc, other, riffChunk("VP8 ", vp8First)))
    ).toStrictEqual(webpOf(vp8x(0x20), icc, riffChunk("VP8 ", vp8First)));
  });

  it("accepts a final odd-sized chunk whose padding byte is missing, and pads it", () => {
    const padded = webpOf(riffChunk("VP8L", concat(vp8l, Uint8Array.of(0))));
    const unpadded = Uint8Array.from(padded.subarray(0, -1));

    unpadded.set([unpadded.length - 8], 4);

    expect(kept("image/webp", unpadded)).toStrictEqual(padded);
  });

  it("drops what follows the RIFF", () => {
    expect(kept("image/webp", concat(webpLossless, encoder.encode(planted.video)))).toStrictEqual(
      webpLossless
    );
  });

  it("keeps the frames walked whole when cut short inside the second", () => {
    const secondFrame = Buffer.from(animatedWebp).lastIndexOf("ANMF");
    const cut = animatedWebp.subarray(0, secondFrame + 30);
    const frames = webpChunks(kept("image/webp", cut)).filter(({ fourCC }) => fourCC === "ANMF");

    expect(frames.map(({ data }) => data)).toStrictEqual(
      webpChunks(animatedWebp)
        .filter(({ fourCC }) => fourCC === "ANMF")
        .slice(0, 1)
        .map(({ data }) => data)
    );
  });

  it("refuses a WebP cut short before its image data", () => {
    expect(tagOf("image/webp", animatedWebp.subarray(0, 100))).toBe("Unreadable");
  });

  it("refuses a WebP that begins with neither VP8, VP8L nor VP8X", () => {
    expect(
      tagOf(
        "image/webp",
        webpOf(riffChunk("XMP ", encoder.encode(planted.xmp)), riffChunk("VP8L", vp8l))
      )
    ).toBe("Unreadable");
  });
});

// Peak memory is read in a process of its own, where nothing else has raised it, from the
// resource usage the operating system keeps, so that what a walk retains for each part of an
// image shows however the collector is timed.
const imagesModule = new URL("../../testing/images.ts", import.meta.url).href;
const stripModule = new URL("strip.ts", import.meta.url).href;

const measuring = `
import * as images from ${JSON.stringify(imagesModule)};
import { stripperFor } from ${JSON.stringify(stripModule)};

const [kind, count] = [process.argv[1], Number(process.argv[2])];
const cat = (...parts) => {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { whole.set(part, at); at += part.length; }
  return whole;
};
const repeat = (unit, times) => {
  const whole = new Uint8Array(unit.length * times);
  for (let i = 0; i < times; i += 1) whole.set(unit, i * unit.length);
  return whole;
};
const frame = images.riffChunk("ANMF", cat(new Uint8Array(16), images.riffChunk("VP8 ", images.vp8First)));
const looping = Uint8Array.of(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);
const inputs = {
  "image/gif": () => images.gifOf(repeat(looping, count), images.gifImage([0, 1, 2, 3])),
  "image/jpeg": () => cat(images.jpeg.subarray(0, 2), repeat(images.jpegSegment(0xdb, new Uint8Array()), count), images.jpeg.subarray(2)),
  "image/png": () => cat(images.png.subarray(0, 33), repeat(images.pngChunk("IDAT", new Uint8Array()), count), images.png.subarray(33)),
  "image/webp": () => images.webpOf(images.vp8x(0x02), repeat(frame, count)),
};
const input = inputs[kind]();
Bun.gc(true);
const before = process.resourceUsage().maxRSS;
const result = stripperFor(kind)(input);
const after = process.resourceUsage().maxRSS;
console.log(JSON.stringify({ grew: (after - before) * 1024, input: input.length, tag: result._tag }));
`;

const decodeMeasure = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ grew: Schema.Finite, input: Schema.Finite, tag: Schema.String })
  )
);

const peakGrowth = async (type: string, count: number) => {
  const child = Bun.spawn([process.execPath, "-e", measuring, type, String(count)], {
    stderr: "inherit",
    stdout: "pipe",
  });

  const text = await new Response(child.stdout).text();

  await child.exited;

  return decodeMeasure(text);
};

describe("stripping an image of very many small parts", () => {
  // A part, an empty `IDAT` of 12 bytes at the smallest, costs a walker that keeps an object
  // for it a hundred bytes more, so a few million parts in a file of tens of megabytes would
  // cost it gigabytes. Stripping holds one output buffer the size of the input, whatever the
  // parts, so it may peak above the input by that and a constant, never by a multiple of it.
  it.each([
    ["image/gif", 1_000_000],
    ["image/jpeg", 1_000_000],
    ["image/png", 1_000_000],
    ["image/webp", 200_000],
  ] as const)(
    "holds nothing for each part of a %s of %i parts",
    async (type, count) => {
      const { grew, input, tag } = await peakGrowth(type, count);

      expect(tag).toBe("Stripped");
      expect(grew).toBeLessThan(input + 24 * 1024 * 1024);
    },
    30_000
  );
});

describe("stripping in general", () => {
  it("keeps any type but JPEG, PNG, GIF and WebP as it is", () => {
    expect(
      ["image/avif", "image/heic", "video/mp4", "text/plain; charset=utf-8"].map(stripperFor)
    ).toStrictEqual([undefined, undefined, undefined, undefined]);
  });

  it("strips what it stripped to the same bytes", () => {
    const again = fixtures.map(([type, bytes]) => {
      const once = kept(type, bytes);

      return (
        kept(type, once).length === once.length &&
        kept(type, once).every((byte, i) => byte === once[i])
      );
    });

    expect(again.every(Boolean)).toBeTruthy();
  });

  it("never throws, nor keeps planted text, on any prefix of an image", () => {
    const survivors = fixtures.flatMap(([type, bytes]) =>
      Array.from({ length: bytes.length + 1 }, (_, length) => {
        const result = strip(type, bytes.subarray(0, length));

        return result._tag === "Stripped"
          ? Object.values(planted)
              .filter((text) => holds(result.bytes, text))
              .map((text) => `${type} ${length}: ${text}`)
          : [];
      }).flat()
    );

    expect(survivors).toStrictEqual([]);
  });

  it("never throws on corrupted bytes", () => {
    // Every byte of every image set to each of a few values, one at a time: lengths, markers
    // and sizes turned to zero, to all ones, and to something in between.
    const outcomes = new Set(
      fixtures.flatMap(([type, bytes]) =>
        [0x00, 0xff, 0x7f, 0x01].flatMap((value) =>
          Array.from({ length: bytes.length }, (_, at) => {
            const corrupted = Uint8Array.from(bytes);

            corrupted[at] = value;

            return strip(type, corrupted)._tag;
          })
        )
      )
    );

    expect([...outcomes].toSorted()).toStrictEqual(["Stripped", "Unreadable"]);
  });

  it("never throws on bytes that only begin like an image", () => {
    const garbage = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 256);

    const heads = [
      jpeg.subarray(0, 4),
      pngSignature,
      gif.subarray(0, 13),
      webpLossless.subarray(0, 12),
    ];

    const types = ["image/jpeg", "image/png", "image/gif", "image/webp"];

    const outcomes = heads.map((head, i) =>
      Array.from(
        { length: 64 },
        (_, n) => strip(types[i] ?? "", concat(head, garbage.subarray(n * 61)))._tag
      )
    );

    expect(
      outcomes.flat().filter((tag) => tag !== "Stripped" && tag !== "Unreadable")
    ).toStrictEqual([]);
  });
});
