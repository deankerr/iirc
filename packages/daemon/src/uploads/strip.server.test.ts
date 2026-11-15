import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

import { BunHttpServer } from "@effect/platform-bun";
import { Upload } from "@iirc/api";
import { makeMemoryJournal } from "@iirc/runtime/testing";
import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { describe, expect, it } from "vitest";

import { ApiRoutes, Stopping } from "../handlers.ts";
import { freePort, loopback } from "../testing/children.ts";
import {
  animatedWebp,
  apng,
  gif,
  gifIccExtension,
  gifImages,
  gifWithComment,
  gifWithIcc,
  holds,
  iccProfile,
  jpegScans,
  jpegSegments,
  jpegWithGps,
  motionPhoto,
  orientationExif,
  planted,
  pngChunks,
  pngData,
  pngWithText,
  webpChunks,
  webpData,
} from "../testing/images.ts";
import { layerWorld, makeKey, makeWorld, temporaryDirectory } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

const encoder = new TextEncoder();

const decodeUpload = Schema.decodeUnknownSync(Schema.fromJsonString(Upload));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** The API on a real Bun server over an in-memory world, with Uploads on and its link listener bound. */
interface Served {
  readonly world: World;
  readonly dataDir: string;
  /** Sends a request to the API with the key. */
  readonly request: (
    path: string,
    init?: { readonly method?: string; readonly body?: Uint8Array | string }
  ) => Effect.Effect<Response>;
  /** Fetches a path from the link listener, once it is bound. */
  readonly fromLinks: (path: string) => Effect.Effect<Response>;
}

const publicUrl = "https://up.example";

const serve = Effect.gen(function* () {
  const dataDir = yield* temporaryDirectory;
  const key = yield* makeKey(dataDir);
  const world = yield* makeWorld(yield* makeMemoryJournal);
  const port = freePort();

  const server = HttpRouter.serve(ApiRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({ gracefulShutdownTimeout: 100, hostname: loopback, port: 0 })
    ),
    Layer.provide(layerWorld(world, dataDir)),
    Layer.provide(Layer.succeed(Stopping, Effect.never))
  );

  const { address } = Context.get(yield* Layer.build(server), HttpServer.HttpServer);
  const base = `http://${loopback}:${address._tag === "UnixPathAddress" ? 0 : address.port}`;

  const request: Served["request"] = (path, init = {}) =>
    Effect.promise(
      async () =>
        await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${key}` } })
    );

  const put = (path: string, value: Schema.Json, status: number) =>
    Effect.flatMap(
      Effect.promise(
        async () =>
          await fetch(`${base}${path}`, {
            body: JSON.stringify({ value }),
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            method: "PUT",
          })
      ),
      (response) =>
        response.status === status
          ? Effect.void
          : Effect.die(new Error(`${path} answered ${response.status}`))
    );

  yield* put("/api/credentials/bucket-key-id", "AKIA-test", 204);
  yield* put("/api/credentials/bucket-secret", "s3cr3t", 204);

  for (const [option, value] of [
    ["store.s3.endpoint", "http://bucket.test"],
    ["store.s3.bucket", "uploads"],
    ["store.s3.region", "us-east-1"],
    ["store.s3.accessKeyId", "bucket-key-id"],
    ["store.s3.secretAccessKey", "bucket-secret"],
    ["uploads.publicUrl", publicUrl],
    ["uploads.listen", `${loopback}:${port}`],
  ] as const) {
    yield* put(`/api/options/${option}`, value, 200);
  }

  // The listener is bound as the options change, so ask until it answers.
  const fromLinks = (path: string): Effect.Effect<Response> =>
    Effect.tryPromise(async () => await fetch(`http://${loopback}:${port}${path}`)).pipe(
      Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
      Effect.orDie
    );

  const served: Served = { dataDir, fromLinks, request, world };

  return served;
});

const run = async <A, E>(test: (served: Served) => Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(serve.pipe(Effect.flatMap(test))));

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** What came back of an upload: its record, and the bytes its link serves. */
interface Back {
  readonly bytes: Uint8Array;
  /** Whether the record's hash and size are the served bytes'. */
  readonly recorded: boolean;
}

/**
 * Uploads bytes, and reads them back through the link listener.
 * @param served - The server.
 * @param body - The bytes.
 * @param name - The name to give.
 * @returns What came back.
 */
const servedBack = (served: Served, body: Uint8Array, name: string) =>
  Effect.gen(function* () {
    const answer = yield* served.request(`/api/uploads?name=${name}`, { body, method: "POST" });
    const text = yield* Effect.promise(async () => await answer.text());

    if (answer.status !== 200) {
      return yield* Effect.die(new Error(`answered ${answer.status}: ${text}`));
    }

    const record = decodeUpload(text);
    const got = yield* served.fromLinks(new URL(record.link ?? "http://invalid/").pathname);
    const bytes = new Uint8Array(yield* Effect.promise(async () => await got.arrayBuffer()));

    const back: Back = {
      bytes,
      recorded: record.hash === sha256(bytes) && record.size === bytes.length,
    };

    return back;
  });

const survivors = (bytes: Uint8Array) =>
  Object.values(planted).filter((text) => holds(bytes, text));

describe("stripping an image as it is uploaded", () => {
  it("drops a JPEG's GPS, Make, Model, XMP and comment, keeping Orientation, ICC and its scan", async () => {
    const { bytes, recorded } = await run((served) => servedBack(served, jpegWithGps, "photo.jpg"));
    const segments = jpegSegments(bytes);
    const app = (marker: number) => segments.filter((segment) => segment.marker === marker);

    expect({
      exif: app(0xe1).map(({ payload }) => payload),
      icc: app(0xe2).map(({ payload }) => payload.subarray(14)),
      recorded,
      scan: jpegScans(bytes),
      survivors: survivors(bytes),
    }).toStrictEqual({
      exif: [Uint8Array.from([...encoder.encode("Exif\0\0"), ...orientationExif(6)])],
      icc: [iccProfile],
      recorded: true,
      scan: jpegScans(jpegWithGps),
      survivors: [],
    });
  });

  it("cuts a motion photo at the end of its image, dropping its video, and keeps Orientation and ICC", async () => {
    const { bytes, recorded } = await run((served) =>
      servedBack(served, motionPhoto, "motion.jpg")
    );

    const markers = jpegSegments(bytes).map(({ marker }) => marker);

    expect({
      endsWithImage: bytes.subarray(-2),
      motion: holds(bytes, "ftyp") || holds(bytes, "MotionPhoto"),
      orientationAndIcc: markers.filter((marker) => marker === 0xe1 || marker === 0xe2),
      recorded,
      scan: jpegScans(bytes),
      survivors: survivors(bytes),
    }).toStrictEqual({
      endsWithImage: Uint8Array.of(0xff, 0xd9),
      motion: false,
      orientationAndIcc: [0xe1, 0xe2],
      recorded: true,
      scan: jpegScans(motionPhoto),
      survivors: [],
    });
  });

  it("keeps an APNG's frames, ICC and Orientation, and drops its text and GPS", async () => {
    const { bytes, recorded } = await run((served) => servedBack(served, apng, "moving.png"));
    const chunks = pngChunks(bytes);

    expect({
      crcsHold: chunks.every(({ crcHolds }) => crcHolds),
      exif: pngData(chunks, "eXIf"),
      frames: pngData(chunks, "acTL", "fcTL", "IDAT", "fdAT"),
      icc: pngData(chunks, "iCCP"),
      recorded,
      survivors: survivors(bytes),
      types: chunks.map(({ type }) => type),
    }).toStrictEqual({
      crcsHold: true,
      exif: [orientationExif(6)],
      frames: pngData(pngChunks(apng), "acTL", "fcTL", "IDAT", "fdAT"),
      icc: pngData(pngChunks(apng), "iCCP"),
      recorded: true,
      survivors: [],
      types: ["IHDR", "eXIf", "iCCP", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "IEND"],
    });
  });

  it("drops a PNG's text chunks and keeps its image data", async () => {
    const { bytes, recorded } = await run((served) => servedBack(served, pngWithText, "notes.png"));
    const chunks = pngChunks(bytes);

    expect({
      idat: chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data),
      recorded,
      survivors: survivors(bytes),
      types: chunks.map(({ type }) => type),
    }).toStrictEqual({
      idat: pngChunks(pngWithText)
        .filter(({ type }) => type === "IDAT")
        .map(({ data }) => data),
      recorded: true,
      survivors: [],
      types: ["IHDR", "gAMA", "IDAT", "IEND"],
    });
  });

  it("keeps an animated WebP's frames, ICC and Orientation, and drops its GPS and XMP", async () => {
    const { bytes, recorded } = await run((served) =>
      servedBack(served, animatedWebp, "moving.webp")
    );

    const chunks = webpChunks(bytes);

    expect({
      exif: webpData(chunks, "EXIF"),
      fourCCs: chunks.map(({ fourCC }) => fourCC),
      frames: webpData(chunks, "ANMF"),
      icc: webpData(chunks, "ICCP"),
      recorded,
      survivors: survivors(bytes),
    }).toStrictEqual({
      exif: [orientationExif(6)],
      fourCCs: ["VP8X", "ICCP", "ANIM", "ANMF", "ANMF", "EXIF"],
      frames: webpData(webpChunks(animatedWebp), "ANMF"),
      icc: [iccProfile],
      recorded: true,
      survivors: [],
    });
  });

  it("drops a GIF's comment, plain text and XMP, keeping its frames and looping", async () => {
    const { bytes, recorded } = await run((served) =>
      servedBack(served, gifWithComment, "moving.gif")
    );

    expect({
      frames: gifImages(bytes),
      looping: holds(bytes, "NETSCAPE2.0"),
      recorded,
      survivors: survivors(bytes),
    }).toStrictEqual({ frames: gifImages(gif), looping: true, recorded: true, survivors: [] });
  });

  it("keeps a GIF's ICC colour profile extension byte for byte", async () => {
    const { bytes, recorded } = await run((served) => servedBack(served, gifWithIcc, "colour.gif"));

    expect({
      frames: gifImages(bytes),
      profile: Buffer.from(bytes).includes(gifIccExtension),
      recorded,
    }).toStrictEqual({ frames: gifImages(gifWithIcc), profile: true, recorded: true });
  });

  it("keeps a file that is not an image byte for byte", async () => {
    const text = encoder.encode(`hello, world, ${planted.comment}\n`);
    const { bytes, recorded } = await run((served) => servedBack(served, text, "notes.txt"));

    expect({ bytes, recorded }).toStrictEqual({ bytes: text, recorded: true });
  });

  it("refuses an image it cannot walk with 422, keeping nothing and leaving nothing staged", async () => {
    const broken = jpegWithGps.subarray(0, 60);

    const result = await run((served) =>
      Effect.gen(function* () {
        const answer = yield* served.request("/api/uploads?name=broken.jpg", {
          body: broken,
          method: "POST",
        });

        const body = decodeJson(yield* Effect.promise(async () => await answer.text()));

        const journaled = yield* Stream.runCollect(served.world.journal.read({})).pipe(
          Effect.map((entries) =>
            entries.filter(
              ({ record }) => record._tag === "Change" && record.change._tag === "Uploaded"
            )
          )
        );

        return {
          body,
          journaled: journaled.length,
          staged: readdirSync(`${served.dataDir}/staging`),
          status: answer.status,
        };
      })
    );

    expect(result).toStrictEqual({
      body: {
        _tag: "UploadUnreadable",
        reason: "a JPEG segment runs past the end",
        type: "image/jpeg",
      },
      journaled: 0,
      staged: [],
      status: 422,
    });
  });
});
