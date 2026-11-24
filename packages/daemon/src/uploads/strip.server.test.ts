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
  holds,
  iccProfile,
  jpegScans,
  jpegSegments,
  jpegWithGps,
  orientationExif,
  planted,
} from "../testing/images.ts";
import {
  box,
  cat,
  clipMov,
  clipMp4,
  itemData,
  itemsOf,
  mdatOf,
  photoAvif,
  propertyTypes,
  text,
  u,
} from "../testing/isobmff.ts";
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
  /** Fetches a path from the link listener. */
  readonly fromLinks: (path: string) => Effect.Effect<Response>;
  /** The id of the Upload made to find the link listener, before the test's own. */
  readonly probe: string;
}

const publicUrl = "https://up.example";

/** What the probe Upload holds, which the link listener serves back unchanged. */
const probeText = "probe\n";

const serve = Effect.gen(function* () {
  const dataDir = yield* temporaryDirectory;
  const key = yield* makeKey(dataDir);
  const world = yield* makeWorld(yield* makeMemoryJournal);

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
  ] as const) {
    yield* put(`/api/options/${option}`, value, 200);
  }

  // A free port can be taken by anything between being found and being bound, even another
  // test's link listener, and this one then stays closed. So upload a probe, and keep a port
  // only once the probe's link answers there with its bytes, which only this listener holds.
  const probe = decodeUpload(
    yield* Effect.promise(async () => {
      const answer = await fetch(`${base}/api/uploads?name=probe.txt`, {
        body: probeText,
        headers: { authorization: `Bearer ${key}` },
        method: "POST",
      });

      return await answer.text();
    })
  );

  const probePath = new URL(probe.link ?? "http://invalid/").pathname;

  const listenForLinks = (tries: number): Effect.Effect<number> =>
    Effect.gen(function* () {
      const port = freePort();

      yield* put("/api/options/uploads.listen", `${loopback}:${port}`, 200);

      const bound = yield* Effect.tryPromise(async () => {
        const answer = await fetch(`http://${loopback}:${port}${probePath}`);

        return answer.status === 200 && (await answer.text()) === probeText;
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
        Effect.orElseSucceed(() => false)
      );

      if (bound) {
        return port;
      }

      return tries > 1
        ? yield* listenForLinks(tries - 1)
        : yield* Effect.die(new Error("the link listener bound at none of the ports it was given"));
    });

  const port = yield* listenForLinks(5);

  const fromLinks = (path: string): Effect.Effect<Response> =>
    Effect.promise(async () => await fetch(`http://${loopback}:${port}${path}`));

  const served: Served = { dataDir, fromLinks, probe: probe.id, request, world };

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
              ({ record }) =>
                record._tag === "Change" &&
                record.change._tag === "Uploaded" &&
                record.change.id !== served.probe
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
        reason: "JPEG segment runs past the end of file",
        type: "image/jpeg",
      },
      journaled: 0,
      staged: [],
      status: 422,
    });
  });
});

describe("stripping HEIC, AVIF, MP4 and MOV as they are uploaded", () => {
  const imageItems = new Set(["hvc1", "av01", "grid", "iden"]);

  // What of a photo is image must come out where it went in, byte for byte, with the
  // properties a decoder needs, and what is Exif or XMP must come out of the file.
  it("drops an AVIF's Exif and XMP items and their bytes, keeping its images and av1C colour", async () => {
    const { bytes, recorded } = await run((served) => servedBack(served, photoAvif, "photo.avif"));
    const kept = itemsOf(photoAvif).filter(({ type }) => imageItems.has(type));

    expect({
      keptData: kept.map((item) => itemData(bytes, item)),
      length: bytes.length,
      properties: [
        ...new Set(propertyTypes(bytes).filter((type) => ["av1C", "colr", "irot"].includes(type))),
      ].toSorted(),
      recorded,
      survivors: ["Exif", "PLANTED-", "iPhone", "Apple", "GPS", "xpacket"].filter((word) =>
        holds(bytes, word)
      ),
      types: itemsOf(bytes)
        .map(({ type }) => type)
        .toSorted(),
    }).toStrictEqual({
      keptData: kept.map((item) => itemData(photoAvif, item)),
      length: photoAvif.length,
      properties: ["av1C", "colr", "irot"].toSorted(),
      recorded: true,
      survivors: [],
      types: kept.map(({ type }) => type).toSorted(),
    });
  });

  // What a phone and an editor leave in a video, which a reader of metadata would find: boxes
  // of metadata, and a timed-metadata track of where it was shot, whose samples follow the
  // picture and sound in an mdat of their own.
  it.each([
    [
      "an MP4",
      "clip.mp4",
      clipMp4,
      ["PLANTED-MAKE", "PLANTED-TITLE", "PLANTED-XMP", "xpacket", "loci"],
    ],
    ["a MOV", "clip.mov", clipMov, ["PLANTED-SOFTWARE", "PLANTED-XMP", "+51.5007", "ISO6709"]],
  ] as const)(
    "drops %s's location track and metadata boxes, keeping its length and its picture and sound",
    async (_, name, clip, planted) => {
      const words = [...planted, "+35.689", "mebx", Uint8Array.of(0xa9, 0x6d, 0x61, 0x6b)];
      const { bytes, recorded } = await run((served) => servedBack(served, clip, name));

      expect({
        kept: words.filter((word) => Buffer.from(bytes).includes(word)),
        length: bytes.length,
        mdat: mdatOf(bytes),
        recorded,
      }).toStrictEqual({
        kept: [],
        length: clip.length,
        mdat: mdatOf(clip),
        recorded: true,
      });
    }
  );

  it("zeroes a large box that is on no keep-list in pieces, keeping the media after it", async () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 5).fill(0x41);
    const after = box("mdat", text("MEDIA-AFTER"));
    const file = cat(clipMp4, box("uuid", big), after);
    const { bytes, recorded } = await run((served) => servedBack(served, file, "big.mp4"));

    expect({
      after: bytes.subarray(-after.length),
      length: bytes.length,
      mdat: mdatOf(bytes),
      recorded,
      untouched: holds(bytes, "AAAA"),
    }).toStrictEqual({
      after,
      length: file.length,
      mdat: mdatOf(file),
      recorded: true,
      untouched: false,
    });
  });

  it("refuses a video it cannot walk with 422, keeping nothing", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const answer = yield* served.request("/api/uploads?name=broken.mp4", {
          body: cat(clipMp4.subarray(0, 32), u(4, 4), text("moov")),
          method: "POST",
        });

        return {
          body: decodeJson(yield* Effect.promise(async () => await answer.text())),
          staged: readdirSync(`${served.dataDir}/staging`),
          status: answer.status,
        };
      })
    );

    expect(result).toStrictEqual({
      body: {
        _tag: "UploadUnreadable",
        reason: "box is smaller than its header",
        type: "video/mp4",
      },
      staged: [],
      status: 422,
    });
  });
});
