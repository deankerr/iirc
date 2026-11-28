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
import { Cause, Deferred, Effect, Exit, Fiber, Redacted, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { freePort, loopback } from "../testing/children.ts";
import { startMinio } from "../testing/minio.ts";
import type { Minio } from "../testing/minio.ts";

// A law carries its own thirty-second guard against a hang (`holds`), so Vitest waits longer.
vi.setConfig({ testTimeout: 60_000 });

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

  it("a stream that dies when run again dies the put, never an outage, and leaves nothing held", async () => {
    const bucket = await minio.freshBucket();
    const store = await make(optionsFor(bucket));
    let runs = 0;
    const bug = new Error("the caller's bug");

    const dying = Stream.suspend(() => {
      runs += 1;

      return runs === 1 ? bytes() : Stream.concat(bytes(), Stream.die(bug));
    });

    const exit = await Effect.runPromiseExit(store.put(dying));

    expect(Exit.hasDies(exit)).toBeTruthy();
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBeFalsy();
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

  // The second run gives its first chunk and then waits, until long after the put is
  // interrupted. A large first chunk makes Bun begin a multipart upload before the wait.
  it.each([
    { first: 1, what: "a small" },
    { first: 6 * 1024 * 1024, what: "a multipart" },
  ])(
    "$what put interrupted while its stream waits closes the stream and leaves nothing",
    async ({ first }) => {
      const bucket = await minio.freshBucket();
      const store = await make(optionsFor(bucket));
      const waiting = Deferred.makeUnsafe<undefined>();
      const released = Deferred.makeUnsafe<undefined>();
      const whole = new Uint8Array(first + 3).fill(97);
      let runs = 0;
      let closed = false;

      const blocking = Stream.suspend(() => {
        runs += 1;

        if (runs === 1) {
          return Stream.make(whole);
        }

        return Stream.make(whole.subarray(0, first)).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(waiting, undefined).pipe(
                Effect.andThen(Deferred.await(released)),
                Effect.as(whole.subarray(first))
              )
            )
          ),
          Stream.ensuring(
            Effect.sync(() => {
              closed = true;
            })
          )
        );
      });

      const putting = Effect.runFork(store.put(blocking));
      await Effect.runPromise(Deferred.await(waiting));
      await Effect.runPromise(Fiber.interrupt(putting));

      expect(closed).toBeTruthy();

      await Effect.runPromise(Deferred.succeed(released, undefined));
      await Bun.sleep(500);

      const hash = Sha256.make(new Bun.CryptoHasher("sha256").update(whole).digest("hex"));
      await expect(tagOf(store.read(hash))).resolves.toBe("ByteStoreNotFound");
      await expect(Effect.runPromise(store.held)).resolves.toBe(0);
    }
  );

  // S3 lists a thousand keys a page, so this takes more than one page, and what the bucket
  // holds beside the store's own objects is not counted.
  it("held sums every page of the store's objects and nothing else", async () => {
    const bucket = await minio.freshBucket();
    const store = await make(optionsFor(bucket));
    const texts = Array.from({ length: 1005 }, (_, index) => `object ${index}`);

    await Effect.runPromise(
      Effect.forEach(texts, (text) => store.put(Stream.make(new TextEncoder().encode(text))), {
        concurrency: 32,
        discard: true,
      })
    );

    const raw = new Bun.S3Client({
      accessKeyId: minio.accessKeyId,
      bucket,
      endpoint: minio.endpoint,
      region: minio.region,
      secretAccessKey: minio.secretAccessKey,
    });

    await raw.write("elsewhere/beside", "not the store's");
    await raw.write("sha256-but-not-under-it", "nor this");

    const expected = texts.reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);
    await expect(Effect.runPromise(store.held)).resolves.toBe(expected);
  });

  it("a bucket that does not exist is unavailable, not not found", async () => {
    const missing = await make(optionsFor("no-such-bucket"));

    await expect(outcomes(missing, abc)).resolves.toStrictEqual(unavailableEverywhere);
  });
});
