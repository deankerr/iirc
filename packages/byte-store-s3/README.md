# @iirc/byte-store-s3

An adapter of the byte store port that keeps bytes in an S3-compatible bucket, on Bun's own S3 client, with no SDK. It provides `ByteStore` given where the bucket is and the keys to it.

```ts
import { layerS3ByteStore, makeS3ByteStore } from "@iirc/byte-store-s3";

layerS3ByteStore({ endpoint, bucket, region, accessKeyId, secretAccessKey }): Layer<ByteStore>
makeS3ByteStore({ endpoint, bucket, region, accessKeyId, secretAccessKey }): Effect<ByteStoreService>
```

The secret is `Redacted`, and the region is always given, never read from the environment. Nothing reaches the bucket until the store is used, so a bucket that is wrong shows as `ByteStoreUnavailable` on the first operation.

## The bucket

- **Each hash is the object `sha256/<hex>`,** so the bucket may hold other things beside them. `held` sums the sizes of everything under `sha256/`, a page of a listing at a time.
- **A put runs its stream twice.** A write names its key first, and the key is the hash, so the first run hashes the bytes. When the object is already there, that is the answer. Otherwise the second run writes them, hashed again as they go. S3 makes an object readable only once its write completes, so a put that fails leaves nothing. A second run that gives other bytes than the first is a defect of the caller's stream: what it wrote is deleted, and the put dies.
- **A range that holds nothing never reaches S3,** which refuses one, so the store reads the object's size first and clamps the range to it.

## Missing or unreachable

Bun's S3 errors carry no HTTP status. An `S3Error` carries the `code` from the body S3 answered with, or one of Bun's own, such as `ConnectionRefused`, or `UnknownError` for an answer with no body, as a refused `HEAD` gives. So the store decides from the `code` alone, never from a message:

- **An object is missing** only when `exists` says it is not there, and a listing of the bucket then succeeds. A `HEAD` of an object in a bucket that does not exist answers 404 too, so a wrong bucket must never look like every object gone.
- **A delete of what is not there** succeeds, and so does one answered with `NoSuchKey`.
- **Everything else is unavailable:** a closed port, refused keys, a bucket that does not exist, a failure while the bytes stream, and a listing that does not decode.

The port's laws, and a test for each of these cases, run against a private MinIO in `bun run e2e`.

## Not yet

- **Making the bucket.** Bun's S3 client cannot, so the bucket must exist.
