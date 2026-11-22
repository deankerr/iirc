# @iirc/preview-cache

The Preview cache port: keeps what a fetch of a link came to, by the link. It is a cache outside the Journal, so emptying it loses nothing but fetches. It decides nothing: when a record is too old to serve, or a failure worth fetching again, is for whatever asks.

The in-memory adapter and the laws are exported from `@iirc/preview-cache/testing`.

```ts
import { PreviewCache } from "@iirc/preview-cache";

get(link): Effect<Option<Kept>, PreviewCacheFailed>
put(kept): Effect<void, PreviewCacheFailed>
shown(link, at): Effect<Option<Kept>, PreviewCacheFailed>   // marks it shown, gives the record
refers(hash): Effect<boolean, PreviewCacheFailed>             // whether any record's image is it
images: Effect<readonly Held[], PreviewCacheFailed>           // each image some record holds, least recently shown first
evict(hash): Effect<void, PreviewCacheFailed>                  // drops the image from every record that holds it

Kept       // { link, state: Settled, image: Sha256 | null, fetched: number | null, shown }, times in ms since the epoch
Settled    // Ready with its Preview, or Failed with why; never a Preview still being fetched
Held       // { hash, size, shown }: an image, its size in bytes, and when it was last shown
```

`PreviewCache` is an Effect service. An adapter provides it as a Layer from its own package.

## What it promises

- **A record is whole.** `put` keeps a record under its link, replacing any record there, entirely or not at all, and `get` gives back exactly what was put.
- **Links are independent.** A record under one link is never changed by another.
- **`refers` reads every record kept.** It is true exactly while some record's `image` is the hash, so replacing the last record that held it makes it false.
- **`shown` only moves forward.** It moves when the link was last shown to `at`, unless that was already later, changes no other field, and gives the record as it then stands. A link with no record gets `None`, and nothing is kept for it.
- **`images` gives each image once.** Its `size` is what the Ready Preview holding it says, or 0 when only a Failed record holds it, and its `shown` is the latest of the records that hold it. They come least recently shown first, and by hash among those shown together.
- **`evict` is whole too.** In one write, every record whose image is the hash loses it, in `image` and in its Ready Preview, and its `fetched` becomes `null`, so whatever asks can tell it was evicted, never mistaking an old record for one, and fetch it again, serving its text meanwhile. When it was shown, and everything else, is as it was. A hash no record holds changes nothing.
- **A record that cannot be read back fails** with `PreviewCacheFailed`, rather than reading as absent.

## Not yet

- **Forgetting records.** `image` is only a hash a caller keeps, and `evict` drops it on request; the cache neither fetches the bytes nor chooses what to evict, and a record is never forgotten, however old.

## The laws

`@iirc/preview-cache/testing` holds `previewCacheLaws`, the laws every adapter keeps, as data, and `makeMemoryPreviewCache`, the in-memory adapter that keeps them. A law is checked against a fresh cache with `holds` from `@iirc/runtime/testing`.

```ts
it.each(previewCacheLaws)("$name", async (law) => {
  await expect(Effect.runPromise(holds(law, makeMemoryPreviewCache))).resolves.toBeUndefined();
});
```

Production code may not import `@iirc/preview-cache/testing`.
