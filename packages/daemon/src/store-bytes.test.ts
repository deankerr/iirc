import type { ByteStoreService, ByteStoreUnavailable } from "@iirc/byte-store";
import { makeMemoryByteStore } from "@iirc/byte-store/testing";
import { PreviewCache, PreviewCacheFailed } from "@iirc/preview-cache";
import type { PreviewCacheService } from "@iirc/preview-cache";
import { makeMemoryPreviewCache } from "@iirc/preview-cache/testing";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { StoreBytes, hashOf, layerStoreBytes } from "./store-bytes.ts";

// No logger, so what the code under test logs is not printed over the test run.
const quiet = Logger.layer([]);

const bytes = new TextEncoder().encode("shared bytes");
const hash = hashOf(bytes);

interface Setup {
  readonly cache?: PreviewCacheService;
}

/**
 * Runs a test with the shared bytes over a memory store already holding `bytes`, and a
 * Preview cache.
 * @param test - The test.
 * @param setup - The Preview cache to use instead of an empty one in memory.
 * @returns What the test returned.
 */
const run = async <A>(
  test: (
    shared: StoreBytes["Service"],
    store: ByteStoreService,
    cache: PreviewCacheService
  ) => Effect.Effect<A, never, Scope.Scope>,
  setup: Setup = {}
) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { store } = yield* makeMemoryByteStore;
        const cache = setup.cache ?? (yield* makeMemoryPreviewCache);

        yield* Effect.orDie(store.put(Stream.make(bytes)));

        const shared = yield* StoreBytes.pipe(
          Effect.provide(layerStoreBytes.pipe(Layer.provide(Layer.succeed(PreviewCache, cache))))
        );

        return yield* test(shared, store, cache);
      })
    ).pipe(Effect.provide(quiet))
  );

const held = (store: ByteStoreService) => Effect.orDie(store.held);

const releasing = (
  uploaded: boolean,
  store: Effect.Effect<ByteStoreService, ByteStoreUnavailable>
) => ({ store, uploaded: Effect.succeed(uploaded) });

describe("the bytes Uploads and Previews share", () => {
  it("releases bytes nothing refers to", async () => {
    const left = await run((shared, store) =>
      Effect.andThen(shared.release(hash, releasing(false, Effect.succeed(store))), held(store))
    );

    expect(left).toBe(0);
  });

  it("keeps bytes a live Upload has", async () => {
    const left = await run((shared, store) =>
      Effect.andThen(shared.release(hash, releasing(true, Effect.succeed(store))), held(store))
    );

    expect(left).toBe(bytes.length);
  });

  it("keeps bytes a Preview kept refers to, and releases them once it no longer does", async () => {
    const left = await run((shared, store, cache) =>
      Effect.gen(function* () {
        const kept = {
          fetched: 1,
          image: hash,
          link: "https://example.com/",
          shown: 1,
          state: { _tag: "Failed", reason: "NothingToShow" },
        } as const;

        yield* Effect.orDie(cache.put(kept));
        yield* shared.release(hash, releasing(false, Effect.succeed(store)));
        const whileReferred = yield* held(store);

        yield* Effect.orDie(cache.put({ ...kept, image: null }));
        yield* shared.release(hash, releasing(false, Effect.succeed(store)));

        return [whileReferred, yield* held(store)];
      })
    );

    expect(left).toStrictEqual([bytes.length, 0]);
  });

  it("keeps bytes when the Preview cache cannot be read", async () => {
    const left = await Effect.runPromise(makeMemoryPreviewCache).then(
      async (memory) =>
        await run(
          (shared, store) =>
            Effect.andThen(
              shared.release(hash, releasing(false, Effect.succeed(store))),
              held(store)
            ),
          {
            cache: {
              ...memory,
              refers: () => Effect.fail(new PreviewCacheFailed({ reason: "locked" })),
            },
          }
        )
    );

    expect(left).toBe(bytes.length);
  });

  it("keeps claimed bytes until the claim ends", async () => {
    const left = await run((shared, store) =>
      Effect.gen(function* () {
        const claim = yield* Scope.make();

        yield* Scope.provide(shared.claimed(hash), claim);
        yield* shared.release(hash, releasing(false, Effect.succeed(store)));
        const whileClaimed = yield* held(store);

        yield* Scope.close(claim, Exit.void);
        yield* shared.release(hash, releasing(false, Effect.succeed(store)));

        return [whileClaimed, yield* held(store)];
      })
    );

    expect(left).toStrictEqual([bytes.length, 0]);
  });

  it("makes a claim wait for a release in progress to end", async () => {
    const order = await run((shared, store) =>
      Effect.gen(function* () {
        const steps: string[] = [];
        const deleting = yield* Deferred.make<undefined>();
        const finish = yield* Deferred.make<undefined>();

        const slow: ByteStoreService = {
          ...store,
          delete: (key) =>
            Deferred.succeed(deleting, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(store.delete(key)),
              Effect.andThen(Effect.sync(() => steps.push("released")))
            ),
        };

        const release = yield* Effect.forkChild(
          shared.release(hash, releasing(false, Effect.succeed(slow)))
        );

        yield* Deferred.await(deleting);

        const claim = yield* Effect.forkChild(
          Effect.scoped(
            Effect.andThen(
              shared.claimed(hash),
              Effect.sync(() => steps.push("claimed"))
            )
          )
        );

        yield* Effect.yieldNow;
        steps.push("finishing");
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(release);
        yield* Fiber.join(claim);

        return steps;
      })
    );

    expect(order).toStrictEqual(["finishing", "released", "claimed"]);
  });
});
