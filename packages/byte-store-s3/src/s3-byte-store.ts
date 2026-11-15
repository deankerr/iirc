/**
 * The byte store in an S3-compatible bucket, on Bun's own S3 client.
 *
 * @packageDocumentation
 */
import { ByteStore, ByteStoreNotFound, ByteStoreUnavailable, Sha256 } from "@iirc/byte-store";
import type { ByteStoreService, Stored } from "@iirc/byte-store";
import { Effect, Layer, Option, Redacted, Ref, Schema, Stream } from "effect";

/** Where the bucket is, and the keys to it. */
export interface S3Options {
  /** The service's URL, such as `https://s3.us-east-1.amazonaws.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted;
}

/** Every object this store keeps is under this prefix, so the bucket may hold other things. */
const prefix = "sha256/";

const keyOf = (hash: Sha256) => `${prefix}${hash}`;

// Bun's S3 errors carry no HTTP status: an `S3Error` carries the `code` of the XML body S3
// answered with, or one of Bun's own, such as `ConnectionRefused`, or `UnknownError` for an
// answer with no body. So the store decides from the code alone, never from the message.
const S3Failure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  name: Schema.Literal("S3Error"),
});

const decodeFailure = Schema.decodeUnknownOption(S3Failure);

const unavailable = (cause: unknown) =>
  new ByteStoreUnavailable({
    reason: Option.match(decodeFailure(cause), {
      onNone: () => (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)),
      onSome: ({ code, message }) => `${code}: ${message}`,
    }),
  });

const missingKey = (cause: unknown) =>
  Option.exists(decodeFailure(cause), ({ code }) => code === "NoSuchKey");

const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ catch: unavailable, try: f });

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** One page of a listing, as far as `held` reads it. */
const Page = Schema.Struct({
  contents: Schema.optional(Schema.Array(Schema.Struct({ size: Schema.Int }))),
  isTruncated: Schema.optional(Schema.Boolean),
  nextContinuationToken: Schema.optional(Schema.String),
});

const decodePage = Schema.decodeUnknownEffect(Page);

const streamOf = (file: Bun.S3File) =>
  Stream.fromReadableStream({ evaluate: () => file.stream(), onError: unavailable });

// Hashes and counts bytes as they pass.
const tally = () => {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;

  return {
    add: (chunk: Uint8Array) => {
      hasher.update(chunk);
      size += chunk.length;
    },
    stored: (): Stored => ({ hash: Sha256.make(hasher.digest("hex")), size }),
  };
};

const digest = <E>(bytes: Stream.Stream<Uint8Array, E>) =>
  Effect.suspend(() => {
    const seen = tally();

    return Stream.runForEach(bytes, (chunk) =>
      Effect.sync(() => {
        seen.add(chunk);
      })
    ).pipe(Effect.map(() => seen.stored()));
  });

/**
 * Makes the byte store over a bucket. Each hash is kept as the object `sha256/<hex>`.
 * @param options - The bucket, and the keys to it.
 * @returns The store.
 */
export const makeS3ByteStore = (options: S3Options): Effect.Effect<ByteStoreService> =>
  Effect.sync(() => {
    const client = new Bun.S3Client({
      accessKeyId: options.accessKeyId,
      bucket: options.bucket,
      endpoint: options.endpoint,
      region: options.region,
      secretAccessKey: Redacted.value(options.secretAccessKey),
    });

    // A HEAD of an object in a bucket that does not exist answers 404 too, which `exists`
    // reads as false, so an object is missing only once the bucket is seen to be there. A
    // wrong bucket must never look like every object gone.
    const bucketThere = attempt(async () => await client.list({ maxKeys: 1, prefix }));

    // Runs the stream again into the bucket, hashing what it gives as it goes. A failure of
    // the stream is the caller's, and anything else is the bucket's.
    const upload = <E>(key: string, bytes: Stream.Stream<Uint8Array, E>) =>
      Effect.gen(function* () {
        const seen = tally();
        const failed = yield* Ref.make(Option.none<E>());

        const passing = bytes.pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              seen.add(chunk);
            })
          ),
          Stream.tapError((error) => Ref.set(failed, Option.some(error)))
        );

        yield* attempt(
          async () => await client.write(key, new Response(Stream.toReadableStream(passing)))
        ).pipe(
          Effect.catch((error) =>
            Ref.get(failed).pipe(
              Effect.flatMap((own) => Effect.fail(Option.getOrElse(own, () => error)))
            )
          )
        );

        return seen.stored();
      });

    const put: ByteStoreService["put"] = (bytes) =>
      Effect.gen(function* () {
        // The key is the hash, and a write needs its key first, so the stream runs once to
        // hash it, and again to write it, unless the bytes are already held.
        const stored = yield* digest(bytes);
        const key = keyOf(stored.hash);

        if (yield* attempt(async () => await client.exists(key))) {
          return stored;
        }

        const written = yield* upload(key, bytes);

        if (written.hash !== stored.hash || written.size !== stored.size) {
          const removed = yield* Effect.exit(
            attempt(async () => {
              await client.delete(key);
            })
          );

          return yield* Effect.die(
            new Error(
              `a stream put to the byte store gave different bytes when run again (${stored.hash}, then ${written.hash}); what it wrote was ${removed._tag === "Success" ? "removed" : "not removed"}`
            )
          );
        }

        return stored;
      });

    // What is held under the prefix, from one page of the listing on.
    const listed = (
      continuationToken: string | undefined
    ): Effect.Effect<number, ByteStoreUnavailable> =>
      attempt(
        async () =>
          await client.list(
            continuationToken === undefined ? { prefix } : { continuationToken, prefix }
          )
      ).pipe(
        Effect.flatMap((page) =>
          decodePage(page).pipe(
            Effect.mapError(
              (error) =>
                new ByteStoreUnavailable({
                  reason: `a listing that does not decode: ${error.message}`,
                })
            )
          )
        ),
        Effect.flatMap((page) => {
          const here = (page.contents ?? []).reduce((sum, object) => sum + object.size, 0);

          if (page.isTruncated !== true) {
            return Effect.succeed(here);
          }

          if (page.nextContinuationToken === undefined) {
            return Effect.fail(
              new ByteStoreUnavailable({ reason: "a truncated listing with no token to go on" })
            );
          }

          return listed(page.nextContinuationToken).pipe(Effect.map((rest) => here + rest));
        })
      );

    const store: ByteStoreService = {
      delete: (hash) =>
        Effect.tryPromise({
          // A key that is not there is deleted already.
          catch: (cause) => (missingKey(cause) ? Option.none() : Option.some(unavailable(cause))),
          try: async () => {
            await client.delete(keyOf(hash));
          },
        }).pipe(
          Effect.catch(Option.match({ onNone: () => Effect.void, onSome: Effect.fail })),
          Effect.asVoid
        ),
      held: listed(undefined),
      put,
      read: (hash, range) =>
        Effect.gen(function* () {
          const key = keyOf(hash);

          if (!(yield* attempt(async () => await client.exists(key)))) {
            yield* bucketThere;

            return yield* new ByteStoreNotFound({ hash });
          }

          if (range === undefined) {
            return streamOf(client.file(key));
          }

          // S3 refuses a range that holds nothing, so an empty one never reaches it.
          const size = yield* attempt(async () => await client.size(key));
          const start = clamp(range.start, 0, size);
          const end = clamp(range.end, start, size);

          return start === end ? Stream.empty : streamOf(client.file(key).slice(start, end));
        }),
    };

    return store;
  });

/**
 * Provides the byte store over a bucket.
 * @param options - The bucket, and the keys to it.
 * @returns A Layer providing the store.
 */
export const layerS3ByteStore = (options: S3Options) =>
  Layer.effect(ByteStore)(makeS3ByteStore(options));
