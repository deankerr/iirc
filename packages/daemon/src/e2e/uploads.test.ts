/**
 * An Upload through a real Daemon, kept in a private MinIO and opened at its link through
 * the link listener. Run with `bun run e2e`.
 */
import { Upload } from "@iirc/api";
import { Effect, Schema } from "effect";
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
          const dataDir = yield* temporaryDirectory;
          const key = yield* makeKey(dataDir);
          const daemon = yield* startDaemon({ dataDir }, key);

          const send = (path: string, method: string, body: Uint8Array | string) =>
            Effect.promise(
              async () =>
                await fetch(`${daemon.base}${path}`, {
                  body,
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
            "store.s3.bucket": minio.bucket,
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

          return {
            bytes: new Uint8Array(yield* Effect.promise(async () => await opened.arrayBuffer())),
            // Every header but `Date`, which says nothing of what was served.
            headers: Object.fromEntries(
              opened.headers.entries().filter(([name]) => name !== "date")
            ),
            kept: kept.status,
            opened: opened.status,
            record,
            statuses: [...held, ...set].map((response) => response.status),
          };
        })
      )
    );

    expect(result).toStrictEqual({
      bytes: png,
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
        "content-disposition": `inline; filename="cat.png"; filename*=UTF-8''cat.png`,
        "content-length": String(png.length),
        "content-security-policy": "sandbox allow-downloads; default-src 'none'",
        "content-type": "image/png",
        "cross-origin-resource-policy": "cross-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
      kept: 200,
      opened: 200,
      record: {
        ...result.record,
        link: `https://up.example/${result.record.id}/cat.png`,
        name: "cat.png",
        safeName: "cat.png",
        size: png.length,
        type: "image/png",
      },
      statuses: [204, 204, 200, 200, 200, 200, 200, 200, 200],
    });
  });
});
