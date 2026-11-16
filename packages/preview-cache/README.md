# @iirc/preview-cache

The Preview cache port: keeps what a fetch of a link came to, by the link. It is a cache outside the Journal, so emptying it loses nothing but fetches. It decides nothing: when a record is too old to serve, or a failure worth fetching again, is for whatever asks.

The in-memory adapter and the laws are exported from `@iirc/preview-cache/testing`.

```ts
import { PreviewCache } from "@iirc/preview-cache";

get(link): Effect<Option<Kept>, PreviewCacheFailed>
put(kept): Effect<void, PreviewCacheFailed>
shown(link, at): Effect<Option<Kept>, PreviewCacheFailed>   // marks it shown, gives the record
refers(hash): Effect<boolean, PreviewCacheFailed>             // whether any record's image is it

Kept       // { link, state: Settled, image: Sha256 | null, fetched, shown }, times in ms since the epoch
Settled    // Ready with its Preview, or Failed with why; never a Preview still being fetched
```

`PreviewCache` is an Effect service. An adapter provides it as a Layer from its own package.

## What it promises

- **A record is whole.** `put` keeps a record under its link, replacing any record there, entirely or not at all, and `get` gives back exactly what was put.
- **Links are independent.** A record under one link is never changed by another.
- **`refers` reads every record kept.** It is true exactly while some record's `image` is the hash, so replacing the last record that held it makes it false.
- **`shown` only moves forward.** It moves when the link was last shown to `at`, unless that was already later, changes no other field, and gives the record as it then stands. A link with no record gets `None`, and nothing is kept for it.
- **A record that cannot be read back fails** with `PreviewCacheFailed`, rather than reading as absent.

## Not yet

- **Eviction.** `image` is only a hash a caller keeps; the cache neither fetches the bytes nor forgets old records.

## The laws

`@iirc/preview-cache/testing` holds `previewCacheLaws`, the laws every adapter keeps, as data, and `makeMemoryPreviewCache`, the in-memory adapter that keeps them. A law is checked against a fresh cache with `holds` from `@iirc/runtime/testing`.

```ts
it.each(previewCacheLaws)("$name", async (law) => {
  await expect(Effect.runPromise(holds(law, makeMemoryPreviewCache))).resolves.toBeUndefined();
});
```

Production code may not import `@iirc/preview-cache/testing`.
