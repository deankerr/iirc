/**
 * The bytes Uploads and Previews share in the store: one copy of each hash, which either may
 * refer to, and which leaves the store only when neither does.
 *
 * @packageDocumentation
 */
import { createHash } from "node:crypto";

import { Sha256 } from "@iirc/byte-store";
import type { ByteStoreService, ByteStoreUnavailable } from "@iirc/byte-store";
import { PreviewCache } from "@iirc/preview-cache";
import type { Scope } from "effect";
import { Context, Deferred, Effect, Layer, Option, Semaphore } from "effect";

/** How a release asks what else refers to bytes, and reaches the store they are in. */
export interface Releasing {
  /** Whether a live Upload, one not deleted, has the bytes. */
  readonly uploaded: Effect.Effect<boolean>;
  /** The store, or why it cannot be reached. */
  readonly store: Effect.Effect<ByteStoreService, ByteStoreUnavailable>;
}

/** The bytes Uploads and Previews share in the store. */
export class StoreBytes extends Context.Service<
  StoreBytes,
  {
    /**
     * Claims a hash until the Scope closes, so its bytes are not released while they are put
     * and until whatever refers to them is recorded. It waits for a release of them in
     * progress to end first, so they are never put just before they are removed.
     */
    readonly claimed: (hash: Sha256) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Deletes bytes from the store unless something still refers to them: a live Upload, a
     * Preview kept, a claim, or a release of them already in progress. A Preview cache that
     * cannot be read keeps them, and a store that cannot delete them leaves them, each logged.
     */
    readonly release: (hash: Sha256, how: Releasing) => Effect.Effect<void>;
  }
>()("@iirc/daemon/StoreBytes") {}

/**
 * The hash a store keeps bytes under.
 * @param bytes - The bytes.
 * @returns Their SHA-256, as hex.
 */
export const hashOf = (bytes: Uint8Array) =>
  Sha256.make(createHash("sha256").update(bytes).digest("hex"));

/** The bytes Uploads and Previews share, needing the Preview cache. */
export const layerStoreBytes = Layer.effect(StoreBytes)(
  Effect.gen(function* () {
    const cache = yield* PreviewCache;
    // Claims and releases in progress are read and changed only under the turn, and so is
    // the decision to release, so a claim and a release of one hash never cross.
    const turn = yield* Semaphore.make(1);
    const claims = new Map<string, number>();
    const releasing = new Map<string, Deferred.Deferred<undefined>>();

    const claimed = (hash: Sha256): Effect.Effect<void, never, Scope.Scope> =>
      Effect.acquireRelease(
        turn.withPermit(
          Effect.sync(() => {
            const busy = releasing.get(hash);

            if (busy === undefined) {
              claims.set(hash, (claims.get(hash) ?? 0) + 1);
            }

            return Option.fromUndefinedOr(busy);
          })
        ),
        (busy) =>
          Option.isSome(busy)
            ? Effect.void
            : turn.withPermit(
                Effect.sync(() => {
                  const left = (claims.get(hash) ?? 1) - 1;

                  if (left === 0) {
                    claims.delete(hash);
                  } else {
                    claims.set(hash, left);
                  }
                })
              )
      ).pipe(
        Effect.flatMap((busy) =>
          Option.isSome(busy)
            ? Effect.andThen(Deferred.await(busy.value), claimed(hash))
            : Effect.void
        )
      );

    const release = (hash: Sha256, how: Releasing) =>
      Effect.gen(function* () {
        const free = yield* turn.withPermit(
          Effect.gen(function* () {
            if (claims.has(hash) || releasing.has(hash) || (yield* how.uploaded)) {
              return Option.none();
            }

            const previewed = yield* cache.refers(hash).pipe(
              Effect.catch((error) =>
                Effect.as(
                  Effect.logWarning("Could not ask the Preview cache, so the bytes stay", {
                    hash,
                    reason: error.reason,
                  }),
                  true
                )
              )
            );

            if (previewed) {
              return Option.none();
            }

            const done = yield* Deferred.make<undefined>();

            releasing.set(hash, done);

            return Option.some(done);
          })
        );

        if (Option.isNone(free)) {
          return;
        }

        yield* Effect.gen(function* () {
          const store = yield* how.store;

          yield* store.delete(hash);
          yield* Effect.logInfo("Released bytes from the store", { hash });
        }).pipe(
          Effect.catchTag("ByteStoreUnavailable", (error) =>
            Effect.logWarning("Could not release bytes, which stay in the store", {
              hash,
              reason: error.reason,
            })
          ),
          Effect.ensuring(
            turn.withPermit(
              Effect.sync(() => releasing.delete(hash)).pipe(
                Effect.andThen(Deferred.succeed(free.value, undefined))
              )
            )
          )
        );
      });

    return { claimed, release };
  })
);
