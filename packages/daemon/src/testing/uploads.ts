/**
 * What an end-to-end run does to Uploads that a running Daemon cannot do for it: keeping an
 * Upload in the Journal as if it had been made at another time, asking the bucket whether
 * bytes are in it, and taking them out of it behind the Daemon's back.
 *
 * @packageDocumentation
 */
import { Sha256 } from "@iirc/byte-store";
import { makeS3ByteStore } from "@iirc/byte-store-s3";
import { Instant } from "@iirc/client";
import { makeSqliteJournal } from "@iirc/journal-sqlite";
import { Effect, Redacted, Stream } from "effect";

import { encodeUploadId, idBytes } from "../uploads/id.ts";
import type { Minio } from "./minio.ts";

/**
 * An S3 byte store on a bucket of the MinIO, of its own.
 * @param minio - The MinIO.
 * @param bucket - The bucket.
 * @returns The store, for as long as the Scope lives.
 */
const storeIn = (minio: Minio, bucket: string) =>
  makeS3ByteStore({
    accessKeyId: minio.accessKeyId,
    bucket,
    endpoint: minio.endpoint,
    region: minio.region,
    secretAccessKey: Redacted.make(minio.secretAccessKey),
  });

/**
 * Keeps bytes in a bucket of the MinIO, and journals an `Uploaded` for them with a fresh id,
 * at a time the Daemon never saw. The Daemon on `dataDir` must be stopped, since it holds the
 * Journal's file.
 * @param minio - The MinIO.
 * @param bucket - The bucket the Daemon's Store names.
 * @param dataDir - The Daemon's data directory.
 * @param upload - The bytes, their type, the name the Upload was given, and when it was made.
 * @returns The Upload's id and its bytes' hash.
 */
export const seedUpload = async (
  minio: Minio,
  bucket: string,
  dataDir: string,
  upload: {
    readonly bytes: Uint8Array;
    readonly name: string;
    readonly type: string;
    readonly at: number;
  }
) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* storeIn(minio, bucket);
        const stored = yield* store.put(Stream.make(upload.bytes));
        const journal = yield* makeSqliteJournal(`${dataDir}/journal.sqlite`);
        const id = encodeUploadId(crypto.getRandomValues(new Uint8Array(idBytes)));

        yield* journal.append({
          _tag: "Change",
          change: {
            _tag: "Uploaded",
            at: Instant.make(upload.at),
            hash: stored.hash,
            id,
            name: upload.name,
            safeName: upload.name,
            size: stored.size,
            type: upload.type,
          },
        });

        return { hash: stored.hash, id };
      })
    ).pipe(Effect.orDie)
  );

/**
 * Whether a bucket of the MinIO holds bytes under a hash.
 * @param minio - The MinIO.
 * @param bucket - The bucket.
 * @param hash - The hash.
 * @returns Whether it does.
 */
export const holdsBytes = async (minio: Minio, bucket: string, hash: string) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* storeIn(minio, bucket);

        return yield* store.read(Sha256.make(hash)).pipe(
          Effect.as(true),
          Effect.catchTag("ByteStoreNotFound", () => Effect.succeed(false))
        );
      })
    ).pipe(Effect.orDie)
  );

/**
 * Removes bytes from a bucket of the MinIO, as a lifecycle rule or a mistake would, without
 * the Daemon being told.
 * @param minio - The MinIO.
 * @param bucket - The bucket.
 * @param hash - The bytes' hash.
 */
export const loseBytes = async (minio: Minio, bucket: string, hash: string) => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* storeIn(minio, bucket);

        yield* store.delete(Sha256.make(hash));
      })
    ).pipe(Effect.orDie)
  );
};
