/**
 * An Upload through a real Daemon, kept in a private MinIO and opened at its link through
 * the link listener. Run with `bun run e2e`.
 */
import { Upload } from "@iirc/api";
import { Sha256 } from "@iirc/byte-store";
import { makeS3ByteStore } from "@iirc/byte-store-s3";
import { Effect, Redacted, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { freePort, loopback } from "../testing/children.ts";
import { startMinio } from "../testing/minio.ts";
import type { Minio } from "../testing/minio.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

vi.setConfig({ testTimeout: 30_000 });

let minio: Minio;

/** A 1×1 PNG. */
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  )
);

const decodeUpload = Schema.decodeUnknownSync(Schema.fromJsonString(Upload));

/**
 * A real Daemon with Uploads on, kept in a bucket of the MinIO, and its link listener at a
 * port, for as long as the Scope lives.
 * @param bucket - The bucket.
 * @param listen - The link listener's port.
 * @returns How to send it a request with its key, and the statuses its setup was answered with.
 */
const configured = (bucket: string, listen: number) =>
  Effect.gen(function* () {
    const dataDir = yield* temporaryDirectory;
    const key = yield* makeKey(dataDir);
    const daemon = yield* startDaemon({ dataDir }, key);

    const send = (path: string, method: string, body?: Uint8Array | string) =>
      Effect.promise(
        async () =>
          await fetch(`${daemon.base}${path}`, {
            body: body ?? null,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            method,
          })
      );

    const credentials = {
      "minio-key": minio.accessKeyId,
      "minio-secret": minio.secretAccessKey,
    };

    const options = {
      "store.s3.accessKeyId": "minio-key",
      "store.s3.bucket": bucket,
      "store.s3.endpoint": minio.endpoint,
      "store.s3.region": minio.region,
      "store.s3.secretAccessKey": "minio-secret",
      "uploads.listen": `${loopback}:${listen}`,
      "uploads.publicUrl": "https://up.example",
    };

    const held = yield* Effect.forEach(Object.entries(credentials), ([name, value]) =>
      send(`/api/credentials/${name}`, "PUT", JSON.stringify({ value }))
    );

    const set = yield* Effect.forEach(Object.entries(options), ([option, value]) =>
      send(`/api/options/${option}`, "PUT", JSON.stringify({ value }))
    );

    return { send, statuses: [...held, ...set].map((response) => response.status) };
  });

/**
 * Whether a bucket of the MinIO holds bytes under a hash, read by an S3 byte store of its own.
 * @param bucket - The bucket.
 * @param hash - The hash.
 * @returns Whether it does.
 */
const inBucket = (bucket: string, hash: string) =>
  Effect.gen(function* () {
    const store = yield* makeS3ByteStore({
      accessKeyId: minio.accessKeyId,
      bucket,
      endpoint: minio.endpoint,
      region: minio.region,
      secretAccessKey: Redacted.make(minio.secretAccessKey),
    });

    return yield* store.read(Sha256.make(hash)).pipe(
      Effect.as(true),
      Effect.catchTag("ByteStoreNotFound", () => Effect.succeed(false)),
      Effect.orDie
    );
  });

describe("Uploads through a real Daemon and MinIO", () => {
  beforeAll(async () => {
    minio = await startMinio();
  }, 60_000);

  afterAll(async () => {
    await minio.stop();
  });

  it("keeps an upload in the bucket and serves it at its link", async () => {
    const listen = freePort();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { send, statuses } = yield* configured(minio.bucket, listen);

          // The type is read from the bytes, so whatever `Content-Type` came is never read.
          const kept = yield* send("/api/uploads?name=cat.png", "POST", png);
          const record = decodeUpload(yield* Effect.promise(async () => await kept.text()));

          const opened = yield* eventually(
            Effect.tryPromise(
              async () => await fetch(`http://${loopback}:${listen}/${record.id}/cat.png`)
            ),
            () => true,
            "5 seconds"
          );

          // A seek, and a revalidation, of what the bucket holds.
          const ask = (headers: Record<string, string>) =>
            Effect.promise(async () => {
              const answer = await fetch(`http://${loopback}:${listen}/${record.id}/cat.png`, {
                headers,
              });

              return {
                bytes: [...new Uint8Array(await answer.arrayBuffer())],
                range: answer.headers.get("content-range"),
                status: answer.status,
              };
            });

          const part = yield* ask({ range: "bytes=1-3" });
          const unchanged = yield* ask({ "if-none-match": `"${record.id}"` });

          return {
            bytes: new Uint8Array(yield* Effect.promise(async () => await opened.arrayBuffer())),
            // Every header but `Date`, which says nothing of what was served.
            headers: Object.fromEntries(
              opened.headers.entries().filter(([name]) => name !== "date")
            ),
            kept: kept.status,
            opened: opened.status,
            part,
            record,
            statuses,
            unchanged,
          };
        })
      )
    );

    expect(result).toStrictEqual({
      bytes: png,
      headers: {
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
        "content-disposition": `inline; filename="cat.png"; filename*=UTF-8''cat.png`,
        "content-length": String(png.length),
        "content-security-policy": "sandbox allow-downloads; default-src 'none'",
        "content-type": "image/png",
        "cross-origin-resource-policy": "cross-origin",
        etag: `"${result.record.id}"`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
      kept: 200,
      opened: 200,
      part: { bytes: [...png.subarray(1, 4)], range: `bytes 1-3/${png.length}`, status: 206 },
      record: {
        ...result.record,
        link: `https://up.example/${result.record.id}/cat.png`,
        name: "cat.png",
        safeName: "cat.png",
        size: png.length,
        type: "image/png",
      },
      statuses: [204, 204, 200, 200, 200, 200, 200, 200, 200],
      unchanged: { bytes: [], range: null, status: 304 },
    });
  });

  it("deletes an Upload: its bytes leave the bucket and its link answers 404", async () => {
    const listen = freePort();
    const bucket = await minio.freshBucket();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { send, statuses } = yield* configured(bucket, listen);
          const kept = yield* send("/api/uploads?name=cat.png", "POST", png);
          const record = decodeUpload(yield* Effect.promise(async () => await kept.text()));
          const link = `http://${loopback}:${listen}/${record.id}/cat.png`;

          const opened = yield* eventually(
            Effect.tryPromise(async () => await fetch(link)),
            () => true,
            "5 seconds"
          );

          const heldBefore = yield* inBucket(bucket, record.hash);
          const deleted = yield* send(`/api/uploads/${record.id}`, "DELETE");
          const gone = yield* Effect.promise(async () => await fetch(link));

          return {
            deleted: deleted.status,
            gone: gone.status,
            heldAfter: yield* inBucket(bucket, record.hash),
            heldBefore,
            opened: opened.status,
            statuses,
          };
        })
      )
    );

    expect(result).toStrictEqual({
      deleted: 200,
      gone: 404,
      heldAfter: false,
      heldBefore: true,
      opened: 200,
      statuses: [204, 204, 200, 200, 200, 200, 200, 200, 200],
    });
  });
});
