/**
 * Room in the store for Previews' images, within `previews.maxTotal`: before an image is put,
 * the least recently shown Previews lose theirs until it fits. A Preview that loses its image
 * keeps its text, and is fetched again, image included, the next time it is asked.
 *
 * @packageDocumentation
 */
import type { ByteStoreService, Sha256 } from "@iirc/byte-store";
import { PreviewCache } from "@iirc/preview-cache";
import type { PreviewCacheFailed } from "@iirc/preview-cache";
import { Data, Effect, Scope, Semaphore } from "effect";

import { OwnerConfiguration } from "../options.ts";
import { StoreBytes } from "../store-bytes.ts";
import { Uploads } from "../uploads/uploads.ts";

/** An image that no eviction could make room for. */
export class NoRoom extends Data.TaggedError("NoRoom")<{ readonly reason: string }> {}

/**
 * What makes room, needing the Preview cache, the shared bytes, the Uploads, and the Owner's
 * options.
 * @returns `fit`, which makes room for an image: it takes the one turn there is to put images
 * until `holding` closes, so what the cache refers to is exactly what is counted from the
 * moment room is made until the image is recorded. It fails with `NoRoom` for an image
 * larger than `previews.maxTotal`, evicting nothing, and with `PreviewCacheFailed` when the
 * cache cannot be read or written.
 */
export const makeRoom = Effect.gen(function* () {
  const cache = yield* PreviewCache;
  const shared = yield* StoreBytes;
  const uploads = yield* Uploads;
  const owner = yield* OwnerConfiguration;
  const turn = yield* Semaphore.make(1);

  // Each Preview that loses its image gives up its reference first, and then its bytes are
  // released, which leaves them in the store while a live Upload, a claim, or another Preview
  // has them. An image a record already holds adds nothing, so nothing is dropped for it.
  const dropping = (hash: Sha256, size: number, store: ByteStoreService, maxTotal: number) =>
    Effect.gen(function* () {
      const held = yield* cache.images;
      let total = held.reduce((sum, one) => sum + one.size, 0);

      for (const one of held.some((kept) => kept.hash === hash) ? [] : held) {
        if (total + size > maxTotal) {
          yield* cache.evict(one.hash);
          yield* Effect.logInfo("Dropped a Preview's image to make room", {
            hash: one.hash,
            shown: one.shown,
            size: one.size,
          });
          yield* shared.release(one.hash, {
            store: Effect.succeed(store),
            uploaded: uploads.holds(one.hash),
          });
          total -= one.size;
        }
      }
    });

  /**
   * Makes room for an image, the Previews shown least recently dropping theirs first.
   * @param hash - The image's hash.
   * @param size - Its size in bytes.
   * @param store - The store it is put to.
   * @param holding - The Scope the turn lasts for.
   * @returns An Effect that ends once the image fits.
   */
  const fit = (
    hash: Sha256,
    size: number,
    store: ByteStoreService,
    holding: Scope.Scope
  ): Effect.Effect<void, NoRoom | PreviewCacheFailed> =>
    Effect.gen(function* () {
      yield* Scope.provide(Semaphore.takeScoped(turn, 1), holding);
      const { options } = yield* owner.inForce;
      const maxTotal = options["previews.maxTotal"];

      return yield* size > maxTotal
        ? Effect.fail(new NoRoom({ reason: "it is larger than previews.maxTotal" }))
        : dropping(hash, size, store, maxTotal);
    });

  return { fit };
});
