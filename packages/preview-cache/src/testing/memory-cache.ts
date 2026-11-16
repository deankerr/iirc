/**
 * The in-memory Preview cache, for tests.
 *
 * @packageDocumentation
 */
import { Effect, Option, Ref } from "effect";

import type { Kept, PreviewCacheService } from "../cache.ts";

/** A fresh, empty Preview cache in memory. */
export const makeMemoryPreviewCache: Effect.Effect<PreviewCacheService> = Effect.gen(function* () {
  const kept = yield* Ref.make<ReadonlyMap<string, Kept>>(new Map());

  return {
    get: (link) => Effect.map(Ref.get(kept), (now) => Option.fromUndefinedOr(now.get(link))),
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
