/**
 * The in-memory Preview cache, for tests.
 *
 * @packageDocumentation
 */
import { Effect, Option, Ref } from "effect";

import type { Held, Kept, PreviewCacheService } from "../cache.ts";

/**
 * A record with its image dropped and its time of fetching the epoch.
 * @param kept - The record.
 * @returns The record, as an eviction leaves it.
 */
const evicted = (kept: Kept): Kept => ({
  ...kept,
  fetched: 0,
  image: null,
  state:
    kept.state._tag === "Ready"
      ? { ...kept.state, preview: { ...kept.state.preview, image: null } }
      : kept.state,
});

// Least recently shown first, and by hash, in code point order, among those shown together.
const leastRecentlyShown = (a: Held, b: Held): number => {
  if (a.shown !== b.shown) {
    return a.shown - b.shown;
  }

  if (a.hash === b.hash) {
    return 0;
  }

  return a.hash < b.hash ? -1 : 1;
};

/** A fresh, empty Preview cache in memory. */
export const makeMemoryPreviewCache: Effect.Effect<PreviewCacheService> = Effect.gen(function* () {
  const kept = yield* Ref.make<ReadonlyMap<string, Kept>>(new Map());

  return {
    evict: (hash) =>
      Ref.update(
        kept,
        (now) =>
          new Map([...now].map(([link, one]) => [link, one.image === hash ? evicted(one) : one]))
      ),
    get: (link) => Effect.map(Ref.get(kept), (now) => Option.fromUndefinedOr(now.get(link))),
    images: Effect.map(Ref.get(kept), (now) => {
      const held = new Map<string, Held>();

      for (const { image, state, shown } of now.values()) {
        if (image !== null) {
          const before = held.get(image);
          const size = state._tag === "Ready" ? (state.preview.image?.size ?? 0) : 0;

          held.set(image, {
            hash: image,
            shown: Math.max(before?.shown ?? shown, shown),
            size: Math.max(before?.size ?? size, size),
          });
        }
      }

      return [...held.values()].toSorted(leastRecentlyShown);
    }),
    put: (record) => Ref.update(kept, (now) => new Map([...now, [record.link, record]])),
    refers: (hash) =>
      Effect.map(Ref.get(kept), (now) => [...now.values()].some((one) => one.image === hash)),
    shown: (link, at) =>
      Ref.modify(kept, (now): readonly [Option.Option<Kept>, ReadonlyMap<string, Kept>] => {
        const held = now.get(link);

        if (held === undefined) {
          return [Option.none(), now];
        }

        const moved: Kept = { ...held, shown: Math.max(held.shown, at) };

        return [Option.some(moved), new Map([...now, [link, moved]])];
      }),
  };
});
