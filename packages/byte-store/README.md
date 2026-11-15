# @iirc/byte-store

The byte store port: keeps bytes by their hash. It knows nothing of names, types, links, or what refers to the bytes it keeps. Whatever keeps those keeps the hash, and asks for the bytes by it.

The in-memory adapter and the laws are exported from `@iirc/byte-store/testing`.

```ts
import { ByteStore } from "@iirc/byte-store";

put(bytes: Stream<Uint8Array, E>): Effect<{ hash: Sha256, size }, E | ByteStoreUnavailable>
read(hash, { start, end }?): Effect<Stream<Uint8Array, ByteStoreUnavailable>, ByteStoreNotFound | ByteStoreUnavailable>
delete(hash): Effect<void, ByteStoreUnavailable>
held: Effect<number, ByteStoreUnavailable>         // bytes held in all

Sha256                                             // a Schema: 64 lower-case hex digits
```

`ByteStore` is an Effect service. An adapter provides it as a Layer from its own package: `@iirc/byte-store-s3` keeps the bytes in an S3-compatible bucket.

## What it promises

- **A hash is the SHA-256 of the bytes,** so the same bytes are always under the same hash, and putting bytes already held is safe and gives the same answer.
- **`put` may run its stream more than once,** so the stream must give the same bytes each time it runs, as one that reads a file does. A failure of the stream is the caller's own, and fails the put as itself. A put that fails leaves nothing readable under the hash that was not there before.
- **A range is `[start, end)`,** as `Blob.slice` takes it, clamped to what is held. A range that holds nothing reads as no bytes.
- **Whether the bytes are held is decided before any byte flows,** so a caller can answer "not found" or begin an answer before reading the stream.
- **Deleting what is not held succeeds.**

## Failure

`ByteStoreNotFound` means the store confirmed it holds nothing by that hash. `ByteStoreUnavailable` is everything else: a store that cannot be reached, that refuses what is asked, or that fails in any other way. An adapter never says "not found" unless it is sure, since a caller may take it to mean the bytes are gone.

## The laws

`@iirc/byte-store/testing` holds `byteStoreLaws`, the laws every adapter keeps, as data, and `makeMemoryByteStore`, the in-memory adapter that keeps them. Each law is checked against a harness of two views of one fresh, empty store: `store`, which reaches it, and `unreachable`, which cannot, so the laws can show that an unreachable store is unavailable and never not found, and that what it held is still there once reached. A law is checked with `holds` from `@iirc/runtime/testing`, as the Runtime's ports' laws are.

```ts
it.each(byteStoreLaws)("$name", async (law) => {
  await expect(Effect.runPromise(holds(law, makeMemoryByteStore))).resolves.toBeUndefined();
});
```

Production code may not import `@iirc/byte-store/testing`.
