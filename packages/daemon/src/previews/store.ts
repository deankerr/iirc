/**
 * The byte store Previews keep their images in: the bucket the `store.s3.*` options name,
 * with the keys the Vault holds now. It is made each time it is used, so it always follows
 * the options and the Credentials. Uploads make theirs the same way, and need a public URL
 * besides, which Previews do not.
 *
 * @packageDocumentation
 */
import { ByteStoreUnavailable } from "@iirc/byte-store";
import type { ByteStoreService } from "@iirc/byte-store";
import { Vault } from "@iirc/runtime/vault";
import { Effect, Redacted } from "effect";

import { OwnerConfiguration } from "../options.ts";
import { ByteStoreMaker } from "../uploads/uploads.ts";

/**
 * What makes the store Previews keep their images in, needing the options, the Vault, and
 * what makes a store.
 * @returns `made`, which makes the store as the options and the Credentials are when it is
 * run, or fails with `ByteStoreUnavailable` when no bucket is set or a key is not held.
 */
export const previewStore = Effect.gen(function* () {
  const owner = yield* OwnerConfiguration;
  const vault = yield* Vault;
  const makeStore = yield* ByteStoreMaker;

  const made: Effect.Effect<ByteStoreService, ByteStoreUnavailable> = Effect.gen(function* () {
    const { options } = yield* owner.inForce;

    const {
      "store.s3.accessKeyId": accessKeyId,
      "store.s3.bucket": bucket,
      "store.s3.endpoint": endpoint,
      "store.s3.region": region,
      "store.s3.secretAccessKey": secretAccessKey,
    } = options;

    if (
      accessKeyId === undefined ||
      bucket === undefined ||
      endpoint === undefined ||
      region === undefined ||
      secretAccessKey === undefined
    ) {
      return yield* new ByteStoreUnavailable({ reason: "no bucket is set" });
    }

    const keys = yield* Effect.all([vault.reveal(accessKeyId), vault.reveal(secretAccessKey)]).pipe(
      Effect.mapError(
        (error) =>
          new ByteStoreUnavailable({
            reason:
              error._tag === "CredentialMissing"
                ? `the credential ${error.credential} is not held`
                : "the credentials could not be read",
          })
      )
    );

    return yield* makeStore({
      accessKeyId: Redacted.value(keys[0]),
      bucket,
      endpoint,
      region,
      secretAccessKey: keys[1],
    });
  });

  return { made };
});
