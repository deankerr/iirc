/**
 * The byte store's S3 adapter against a private MinIO: the port's laws, and how it tells
 * bytes that are missing from a bucket it cannot reach. Run with `bun run e2e`.
 */
import { Sha256 } from "@iirc/byte-store";
import type { ByteStoreService } from "@iirc/byte-store";
import { makeS3ByteStore } from "@iirc/byte-store-s3";
import type { S3Options } from "@iirc/byte-store-s3";
import { byteStoreLaws } from "@iirc/byte-store/testing";
import { holds } from "@iirc/runtime/testing";
import { Effect, Exit, Redacted, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { freePort, loopback } from "../testing/children.ts";
import { startMinio } from "../testing/minio.ts";
import type { Minio } from "../testing/minio.ts";

// A law carries its own ten-second guard against a hang (`holds`), so Vitest waits longer.
vi.setConfig({ testTimeout: 20_000 });

let minio: Minio;

const optionsFor = (bucket: string, changes: Partial<S3Options> = {}): S3Options => ({
  accessKeyId: minio.accessKeyId,
  bucket,
  endpoint: minio.endpoint,
  region: minio.region,
  secretAccessKey: Redacted.make(minio.secretAccessKey),
  ...changes,
});

// Where nothing listens: a port the kernel just said was free.
const closedEndpoint = () => `http://${loopback}:${freePort()}`;

const abc = Sha256.make("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
const neverPut = Sha256.make("0".repeat(64));

const bytes = () => Stream.make(new TextEncoder().encode("abc"));

// The tag an Effect fails with, or `succeeded`.
const tagOf = async <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) {
    return "succeeded";
  }

  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");

  return failure?._tag === "Fail" ? failure.error._tag : "a defect";
};

// The tag each operation fails with, or `succeeded`.
const outcomes = async (store: ByteStoreService, held: Sha256) => ({
  delete: await tagOf(store.delete(held)),
  held: await tagOf(store.held),
  put: await tagOf(store.put(bytes())),
  read: await tagOf(store.read(held)),
  readMissing: await tagOf(store.read(neverPut)),
  readRange: await tagOf(store.read(held, { end: 2, start: 1 })),
});

const unavailableEverywhere = {
  delete: "ByteStoreUnavailable",
  held: "ByteStoreUnavailable",
  put: "ByteStoreUnavailable",
  read: "ByteStoreUnavailable",
  readMissing: "ByteStoreUnavailable",
  readRange: "ByteStoreUnavailable",
};

const make = async (options: S3Options) => await Effect.runPromise(makeS3ByteStore(options));

// A bucket holding `abc`, through a store that reaches it.
const holdingAbc = async () => {
  const bucket = await minio.freshBucket();
  const store = await make(optionsFor(bucket));
  await Effect.runPromise(store.put(bytes()));

  return { bucket, store };
};

describe("the S3 byte store", () => {
  beforeAll(async () => {
    minio = await startMinio();
  }, 120_000);

  afterAll(async () => {
    await minio.stop();
  });

  // Each law has a bucket of its own, and `unreachable` is the same bucket through a port
  // where nothing listens.
  it.each(byteStoreLaws)("$name", async (law) => {
    const harness = Effect.promise(async () => await minio.freshBucket()).pipe(
      Effect.flatMap((bucket) =>
        Effect.all({
          store: makeS3ByteStore(optionsFor(bucket)),
          unreachable: makeS3ByteStore(optionsFor(bucket, { endpoint: closedEndpoint() })),
        })
      )
    );

    await expect(Effect.runPromise(holds(law, harness))).resolves.toBeUndefined();
  });

  it("a missing object is not found", async () => {
    const { store } = await holdingAbc();

    await expect(outcomes(store, neverPut)).resolves.toMatchObject({
      read: "ByteStoreNotFound",
      readMissing: "ByteStoreNotFound",
      readRange: "ByteStoreNotFound",
    });
  });

  it("a closed port is unavailable", async () => {
    const { bucket } = await holdingAbc();
    const closed = await make(optionsFor(bucket, { endpoint: closedEndpoint() }));

    await expect(outcomes(closed, abc)).resolves.toStrictEqual(unavailableEverywhere);
  });

  it("refused keys are unavailable", async () => {
    const { bucket, store } = await holdingAbc();

    const refused = await make(
      optionsFor(bucket, { secretAccessKey: Redacted.make("not-the-secret") })
    );

    await expect(outcomes(refused, abc)).resolves.toStrictEqual(unavailableEverywhere);
    await expect(Effect.runPromise(store.held)).resolves.toBe(3);
  });

  it("a stream that fails is the caller's failure, and leaves nothing held", async () => {
    const bucket = await minio.freshBucket();
    const store = await make(optionsFor(bucket));
    let runs = 0;

    const failing = Stream.suspend(() => {
      runs += 1;

      return runs === 1
        ? bytes()
        : Stream.concat(bytes(), Stream.fail("the caller's own" as const));
    });

    await expect(Effect.runPromise(Effect.flip(store.put(failing)))).resolves.toBe(
      "the caller's own"
    );
    await expect(Effect.runPromise(store.held)).resolves.toBe(0);
  });

  it("a stream that gives other bytes when run again is a defect, and leaves nothing held", async () => {
    const bucket = await minio.freshBucket();
    const store = await make(optionsFor(bucket));
    let runs = 0;

    const changing = Stream.suspend(() => {
      runs += 1;

      return Stream.make(new TextEncoder().encode(runs === 1 ? "abc" : "abd"));
    });

    const exit = await Effect.runPromiseExit(store.put(changing));

    expect(Exit.hasDies(exit)).toBeTruthy();
    await expect(Effect.runPromise(store.held)).resolves.toBe(0);
  });

  it("a bucket that does not exist is unavailable, not not found", async () => {
    const missing = await make(optionsFor("no-such-bucket"));

    await expect(outcomes(missing, abc)).resolves.toStrictEqual(unavailableEverywhere);
  });
});
