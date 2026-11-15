/**
 * The Uploads: a projection of the Journal's `Uploaded` Changes (ADR 0016), whether they
 * are on, derived from the options in force, the byte store those options name, and the
 * path from an arriving body to a kept, recorded Upload.
 *
 * @packageDocumentation
 */
import { UploadId } from "@iirc/api";
import type {
  HttpUrl,
  ListenAddress,
  OwnerOptionName,
  OwnerOptions,
  UploadsStatus,
} from "@iirc/api";
import { ByteStoreUnavailable, Sha256 } from "@iirc/byte-store";
import type { ByteStoreService } from "@iirc/byte-store";
import type { S3Options } from "@iirc/byte-store-s3";
import { Instant } from "@iirc/client";
import type { CredentialName } from "@iirc/protocol/line";
import { Journal } from "@iirc/runtime/journal";
import type { Change, JournalFailed } from "@iirc/runtime/journal";
import { Vault } from "@iirc/runtime/vault";
import {
  Clock,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { SecureRandom } from "effect/crypto";

import { DataDirectoryFailed } from "../lock.ts";
import { OwnerConfiguration } from "../options.ts";
import { encodeUploadId, idBytes } from "./id.ts";
import { detectKind } from "./kind.ts";
import { safeName } from "./names.ts";
import type { BodyTooLarge } from "./staging.ts";
import { clearStaging, stage } from "./staging.ts";

/** An Upload as the Journal records it, parsed. */
export const Kept = Schema.Struct({
  at: Instant,
  hash: Sha256,
  id: UploadId,
  name: Schema.optionalKey(Schema.String),
  safeName: Schema.String,
  size: Schema.Int,
  type: Schema.String,
});

/** The decoded form of {@link Kept}. */
export type Kept = typeof Kept.Type;

/** What a Frontend is shown of an Upload: its record, and its link while there is a public URL. */
export interface Shown {
  readonly record: Kept;
  readonly link: string | undefined;
}

/** Where the bucket is, and the Credentials holding its keys, all set. */
interface Bucket {
  readonly endpoint: HttpUrl;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: CredentialName;
  readonly secretAccessKey: CredentialName;
}

/**
 * Whether Uploads are on, as the options in force say: `On` with everything they need, or
 * `Off` with the options that are missing. Both say the most an Upload may be.
 */
export type Switch =
  | {
      readonly _tag: "On";
      readonly maxSize: number;
      readonly bucket: Bucket;
      readonly publicUrl: HttpUrl;
      readonly listen: ListenAddress | undefined;
    }
  | { readonly _tag: "Off"; readonly maxSize: number; readonly missing: OwnerOptionName[] };

/** The options Uploads need, in the order an `Off` names them. */
const needed = [
  "store.s3.endpoint",
  "store.s3.bucket",
  "store.s3.region",
  "store.s3.accessKeyId",
  "store.s3.secretAccessKey",
  "uploads.publicUrl",
] as const satisfies readonly OwnerOptionName[];

/**
 * Whether Uploads are on under some options: on exactly when the bucket, its keys, and the
 * public URL are all set.
 * @param options - The options in force.
 * @returns The switch.
 */
export const switchOf = (options: OwnerOptions): Switch => {
  const {
    "store.s3.accessKeyId": accessKeyId,
    "store.s3.bucket": bucket,
    "store.s3.endpoint": endpoint,
    "store.s3.region": region,
    "store.s3.secretAccessKey": secretAccessKey,
    "uploads.listen": listen,
    "uploads.maxSize": maxSize,
    "uploads.publicUrl": publicUrl,
  } = options;

  if (
    accessKeyId === undefined ||
    bucket === undefined ||
    endpoint === undefined ||
    region === undefined ||
    secretAccessKey === undefined ||
    publicUrl === undefined
  ) {
    return { _tag: "Off", maxSize, missing: needed.filter((name) => options[name] === undefined) };
  }

  return {
    _tag: "On",
    bucket: { accessKeyId, bucket, endpoint, region, secretAccessKey },
    listen,
    maxSize,
    publicUrl,
  };
};

/**
 * An Upload's link: the public URL, its id, and its safe name. The name is decoration, and
 * holds only letters, digits, `.`, `-`, and `_`, so it needs no escaping to be one segment.
 * @param publicUrl - The public URL in force, with no trailing `/`.
 * @param record - The Upload.
 * @returns The link.
 */
const linkOf = (publicUrl: HttpUrl, record: Kept) => `${publicUrl}/${record.id}/${record.safeName}`;

/** Makes a byte store from where a bucket is and its keys. */
export class ByteStoreMaker extends Context.Service<
  ByteStoreMaker,
  (options: S3Options) => Effect.Effect<ByteStoreService>
>()("@iirc/daemon/ByteStoreMaker") {}

/** Uploads are off, since the options it names are not set. */
export class UploadsAreOff extends Data.TaggedError("UploadsAreOff")<{
  readonly missing: readonly OwnerOptionName[];
}> {}

/** The body held no bytes, however it was sent. */
export class EmptyUpload extends Data.TaggedError("EmptyUpload") {}

/** No Upload has the id, or its bytes are confirmed gone from the store. */
export class NoSuchUpload extends Data.TaggedError("NoSuchUpload") {}

/** What the Daemon holds of Uploads. */
export class Uploads extends Context.Service<
  Uploads,
  {
    /** Whether Uploads are on, from the options in force now. */
    readonly status: Effect.Effect<UploadsStatus>;
    /** One Upload by its id, with its link, or none. */
    readonly find: (id: UploadId) => Effect.Effect<Option.Option<Shown>>;
    /**
     * Stages a body, reads its type from its bytes, puts it to the store, and journals its
     * `Uploaded`, in that order, with `uploads.maxSize` read once as it begins. A body that
     * passes it is cut off unread. The staged file is gone however it ends, and nothing is
     * journaled unless the bytes were kept.
     */
    readonly upload: <E>(
      body: Stream.Stream<Uint8Array, E>,
      name: string | undefined
    ) => Effect.Effect<
      Shown,
      E | UploadsAreOff | EmptyUpload | BodyTooLarge | ByteStoreUnavailable | JournalFailed
    >;
    /**
     * An Upload's record and bytes, for its link. Whether the bytes are held is decided
     * before any flows.
     */
    readonly open: (
      id: UploadId
    ) => Effect.Effect<
      { readonly record: Kept; readonly bytes: Stream.Stream<Uint8Array, ByteStoreUnavailable> },
      NoSuchUpload | ByteStoreUnavailable
    >;
  }
>()("@iirc/daemon/Uploads") {}

const keptOf = Schema.decodeUnknownOption(Kept);

/**
 * Folds one Change into the Uploads by id, and passes over any other. An `Uploaded` applied
 * twice is applied once. One that does not parse adds nothing.
 * @param held - The Uploads so far.
 * @param change - The Change.
 * @returns The Uploads after it.
 */
const foldUpload = (held: ReadonlyMap<UploadId, Kept>, change: Change) => {
  if (change._tag !== "Uploaded") {
    return held;
  }

  const kept = keptOf(change);

  return Option.isNone(kept) ? held : new Map(held).set(kept.value.id, kept.value);
};

/**
 * The Uploads folded from every Change in the Journal as it starts, and kept as each
 * `Uploaded` is journaled through it, which is the only way one is. Staging is emptied as
 * it starts.
 * @param dataDir - The data directory, which holds staging.
 * @returns The Layer.
 */
export const layerUploads = (dataDir: string) =>
  Layer.effect(Uploads)(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const owner = yield* OwnerConfiguration;
      const vault = yield* Vault;
      const makeStore = yield* ByteStoreMaker;
      const fs = yield* FileSystem.FileSystem;
      const random = yield* SecureRandom.SecureRandom;

      const provided = Context.make(FileSystem.FileSystem, fs).pipe(
        Context.add(SecureRandom.SecureRandom, random)
      );

      yield* clearStaging(dataDir).pipe(
        Effect.mapError((error) => new DataDirectoryFailed({ dataDir, reason: error.message }))
      );

      const nothingKept: ReadonlyMap<UploadId, Kept> = new Map();

      const folded = yield* journal.read({}).pipe(
        Stream.runFold(
          () => nothingKept,
          (all, { record }) => (record._tag === "Change" ? foldUpload(all, record.change) : all)
        )
      );

      const held = yield* Ref.make(folded);
      const switchNow = owner.inForce.pipe(Effect.map(({ options }) => switchOf(options)));

      // The store the options in force name, with the keys the Vault holds now, made when
      // it is used, so it always follows the options and the Credentials.
      const storeOf = (bucket: Bucket) =>
        Effect.gen(function* () {
          const keys = yield* Effect.all([
            vault.reveal(bucket.accessKeyId),
            vault.reveal(bucket.secretAccessKey),
          ]).pipe(
            Effect.mapError(
              (error) =>
                new ByteStoreUnavailable({
                  reason:
                    error._tag === "CredentialMissing"
                      ? `the Credential ${error.credential} is not held`
                      : "the Credentials could not be read",
                })
            )
          );

          return yield* makeStore({
            accessKeyId: Redacted.value(keys[0]),
            bucket: bucket.bucket,
            endpoint: bucket.endpoint,
            region: bucket.region,
            secretAccessKey: keys[1],
          });
        });

      const shown = (record: Kept) =>
        switchNow.pipe(
          Effect.map((now) => ({
            link: now._tag === "On" ? linkOf(now.publicUrl, record) : undefined,
            record,
          }))
        );

      // An id no Upload has, though two drawn alike are a one in 2^80 chance.
      const freshId: Effect.Effect<UploadId> = Effect.gen(function* () {
        const id = UploadId.make(encodeUploadId(yield* random.randomBytes(idBytes)));
        const taken = (yield* Ref.get(held)).has(id);

        return taken ? yield* freshId : id;
      });

      // An append is whole or absent, and holding it is in the same uninterruptible step, so
      // what is held never differs from the Journal.
      const record = (kept: Kept) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* journal.append({ _tag: "Change", change: { _tag: "Uploaded", ...kept } });
            yield* Ref.update(held, (all) => new Map(all).set(kept.id, kept));
            yield* Effect.logInfo("Kept an Upload", {
              size: kept.size,
              type: kept.type,
              upload: kept.id,
            });
          })
        );

      const upload = <E>(body: Stream.Stream<Uint8Array, E>, name: string | undefined) =>
        Effect.gen(function* () {
          const now = yield* switchNow;

          if (now._tag === "Off") {
            return yield* new UploadsAreOff({ missing: now.missing });
          }

          const staged = yield* stage(dataDir, body, now.maxSize);

          if (staged.size === 0) {
            return yield* new EmptyUpload();
          }

          const kind = detectKind(staged.head);
          const store = yield* storeOf(now.bucket);
          const stored = yield* store.put(fs.stream(staged.path).pipe(Stream.orDie));

          if (stored.hash !== staged.hash || stored.size !== staged.size) {
            return yield* Effect.die(new Error("the store kept other bytes than were staged"));
          }

          const kept: Kept = {
            at: Instant.make(yield* Clock.currentTimeMillis),
            hash: stored.hash,
            id: yield* freshId,
            safeName: safeName(name, kind),
            size: stored.size,
            type: kind.type,
            ...(name !== undefined && { name }),
          };

          yield* record(kept);

          return { link: linkOf(now.publicUrl, kept), record: kept };
        }).pipe(Effect.scoped, Effect.provideContext(provided));

      const open = (id: UploadId) =>
        Effect.gen(function* () {
          const found = (yield* Ref.get(held)).get(id);

          if (found === undefined) {
            return yield* new NoSuchUpload();
          }

          const now = yield* switchNow;

          if (now._tag === "Off") {
            return yield* new ByteStoreUnavailable({ reason: "Uploads are off" });
          }

          const store = yield* storeOf(now.bucket);

          const bytes = yield* store
            .read(found.hash)
            .pipe(Effect.catchTag("ByteStoreNotFound", () => Effect.fail(new NoSuchUpload())));

          return { bytes, record: found };
        });

      return {
        find: (id: UploadId) =>
          Ref.get(held).pipe(
            Effect.flatMap((all) => {
              const found = all.get(id);

              return found === undefined ? Effect.succeedNone : Effect.asSome(shown(found));
            })
          ),
        open,
        status: switchNow.pipe(
          Effect.map((now): UploadsStatus =>
            now._tag === "On"
              ? { _tag: "On", maxSize: now.maxSize }
              : { _tag: "Off", maxSize: now.maxSize, missing: now.missing }
          )
        ),
        upload,
      };
    })
  );
