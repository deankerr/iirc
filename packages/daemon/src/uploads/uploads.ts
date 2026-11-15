/**
 * The Uploads: a projection of the Journal's `Uploaded` Changes (ADR 0016), in the order
 * they were journaled, whether they are on, derived from the options in force, the byte
 * store those options name, and the path from an arriving body to a kept, recorded Upload.
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
  Chunk,
  Clock,
  Context,
  Data,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { SecureRandom } from "effect/crypto";

import { DataDirectoryFailed } from "../lock.ts";
import { OwnerConfiguration } from "../options.ts";
import { encodeUploadId, idBytes } from "./id.ts";
import { detectKind } from "./kind.ts";
import { safeName } from "./names.ts";
import type { BodyTooLarge, UnreadableImage } from "./staging.ts";
import { clearStaging, keepable, stage } from "./staging.ts";

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

/**
 * A page of the Uploads, newest first, the id the next begins after, when more follow, and
 * the sequence of the newest Upload's Change when it was read, or `0` with none.
 */
export interface Page {
  readonly uploads: readonly Shown[];
  readonly next: UploadId | undefined;
  readonly through: number;
}

/** An Upload, as a Frontend is shown it, and the sequence of the Change that made it so. */
export interface Changed {
  readonly shown: Shown;
  readonly sequence: number;
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
     * Up to `limit` Uploads, with their links, newest first: the newest, or those older
     * than the Upload `after` names, read with the sequence of the newest Upload's Change,
     * from the same holdings, so `changes` after it gives exactly what the page could not.
     * One no Upload has is `NoSuchUpload`.
     */
    readonly page: (
      after: UploadId | undefined,
      limit: number
    ) => Effect.Effect<Page, NoSuchUpload>;
    /**
     * Each Upload as a Change makes it, with its link as it is sent, and the Change's
     * sequence: every one after `after`, oldest first, and then each as it is made, with no
     * gap and none twice. Without `after`, only those made from now.
     */
    readonly changes: (after: number | undefined) => Stream.Stream<Changed>;
    /**
     * Stages a body, reads its type from its bytes, strips it if it is an image, puts it to
     * the store, and journals its `Uploaded`, in that order, with `uploads.maxSize` read once
     * as it begins. A body that passes it is cut off unread, and an image that cannot be
     * walked is refused. The staged file is gone however it ends, and nothing is journaled
     * unless the bytes were kept.
     */
    readonly upload: <E>(
      body: Stream.Stream<Uint8Array, E>,
      name: string | undefined
    ) => Effect.Effect<
      Shown,
      | E
      | UploadsAreOff
      | EmptyUpload
      | BodyTooLarge
      | UnreadableImage
      | ByteStoreUnavailable
      | JournalFailed
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

/** An Upload as held: its record, the sequence of its Change, and its place in `order`. */
interface HeldUpload {
  readonly record: Kept;
  readonly sequence: number;
  readonly place: number;
}

/**
 * The Uploads held: each by its id, and their ids oldest first, which is the order their
 * Changes were journaled. Both are persistent, so holding one more never copies the rest.
 */
interface Held {
  readonly byId: HashMap.HashMap<UploadId, HeldUpload>;
  readonly order: Chunk.Chunk<UploadId>;
}

const nothingHeld: Held = { byId: HashMap.empty(), order: Chunk.empty() };

/**
 * Holds one more Upload, the newest. One already held stays as it was, so an `Uploaded`
 * applied twice is applied once.
 * @param held - The Uploads so far.
 * @param record - The Upload.
 * @param sequence - The sequence of its Change.
 * @returns The Uploads after it.
 */
const holding = (held: Held, record: Kept, sequence: number): Held =>
  HashMap.has(held.byId, record.id)
    ? held
    : {
        byId: HashMap.set(held.byId, record.id, {
          place: Chunk.size(held.order),
          record,
          sequence,
        }),
        order: Chunk.append(held.order, record.id),
      };

/**
 * Folds one Change into the Uploads, and passes over any other. One that does not parse
 * adds nothing.
 * @param held - The Uploads so far.
 * @param change - The Change.
 * @param sequence - Its sequence.
 * @returns The Uploads after it.
 */
const foldUpload = (held: Held, change: Change, sequence: number) => {
  if (change._tag !== "Uploaded") {
    return held;
  }

  const kept = keptOf(change);

  return Option.isNone(kept) ? held : holding(held, kept.value, sequence);
};

/**
 * The Upload at a place in `order`.
 * @param held - The Uploads.
 * @param place - Its place, which `order` has.
 * @returns It.
 */
const at = (held: Held, place: number) =>
  HashMap.getUnsafe(held.byId, Chunk.getUnsafe(held.order, place));

/**
 * Up to `limit` Uploads, newest first, below the place `before`.
 * @param held - The Uploads.
 * @param before - The place the page begins below.
 * @param limit - How many at most.
 * @returns The page, and whether more follow.
 */
const pageOf = (held: Held, before: number, limit: number) => {
  const last = Math.max(0, before - limit);

  return {
    more: last > 0,
    uploads: Array.from({ length: before - last }, (_, index) => at(held, before - 1 - index)),
  };
};

/**
 * Every Upload whose Change is after a sequence, oldest first. The newest are last in
 * `order`, so only those are read.
 * @param held - The Uploads.
 * @param after - The sequence.
 * @returns Them.
 */
const changedAfter = (held: Held, after: number) => {
  const found: HeldUpload[] = [];

  for (let place = Chunk.size(held.order) - 1; place >= 0; place -= 1) {
    const one = at(held, place);

    if (one.sequence <= after) {
      break;
    }

    found.push(one);
  }

  return found.toReversed();
};

/**
 * The sequence of the newest Upload's Change, or `0` with none.
 * @param held - The Uploads.
 * @returns It.
 */
const newestOf = (held: Held) =>
  Chunk.isEmpty(held.order) ? 0 : at(held, Chunk.size(held.order) - 1).sequence;

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

      const folded = yield* journal.read({}).pipe(
        Stream.runFold(
          () => nothingHeld,
          (all, { record, sequence }) =>
            record._tag === "Change" ? foldUpload(all, record.change, sequence) : all
        )
      );

      const held = yield* SubscriptionRef.make(folded);
      const turn = yield* Semaphore.make(1);
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

      // A link needs only the public URL, so it is shown while one is set, whether or not
      // new Uploads may be made.
      const shown = (record: Kept) =>
        owner.inForce.pipe(
          Effect.map(({ options }) => {
            const publicUrl = options["uploads.publicUrl"];

            return {
              link: publicUrl === undefined ? undefined : linkOf(publicUrl, record),
              record,
            };
          })
        );

      // An id no Upload has, though two drawn alike are a one in 2^80 chance.
      const freshId: Effect.Effect<UploadId> = Effect.gen(function* () {
        const id = UploadId.make(encodeUploadId(yield* random.randomBytes(idBytes)));
        const taken = HashMap.has((yield* SubscriptionRef.get(held)).byId, id);

        return taken ? yield* freshId : id;
      });

      // An append is whole or absent, and holding it is in the same uninterruptible step, so
      // what is held never differs from the Journal. It is one turn, so Uploads are held in
      // the order they were journaled.
      const record = (kept: Kept) =>
        turn.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const sequence = yield* journal.append({
                _tag: "Change",
                change: { _tag: "Uploaded", ...kept },
              });

              yield* SubscriptionRef.update(held, (all) => holding(all, kept, sequence));
              yield* Effect.logInfo("Kept an Upload", {
                size: kept.size,
                type: kept.type,
                upload: kept.id,
              });
            })
          )
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
          const keeping = yield* keepable(staged, kind.type);
          const store = yield* storeOf(now.bucket);
          const stored = yield* store.put(keeping.bytes);

          if (stored.hash !== keeping.hash || stored.size !== keeping.size) {
            return yield* Effect.die(new Error("the store kept other bytes than were meant"));
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
          const kept = HashMap.get((yield* SubscriptionRef.get(held)).byId, id);

          if (Option.isNone(kept)) {
            return yield* new NoSuchUpload();
          }

          const found = kept.value.record;

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

      const page = (after: UploadId | undefined, limit: number) =>
        Effect.gen(function* () {
          const all = yield* SubscriptionRef.get(held);
          let before = Chunk.size(all.order);

          if (after !== undefined) {
            const from = HashMap.get(all.byId, after);

            if (Option.isNone(from)) {
              return yield* new NoSuchUpload();
            }

            before = from.value.place;
          }

          const { more, uploads } = pageOf(all, before, limit);

          return {
            next: more ? uploads.at(-1)?.record.id : undefined,
            through: newestOf(all),
            // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
            uploads: yield* Effect.forEach(uploads, ({ record: one }) => shown(one)),
          };
        });

      // A follower reads the Uploads whole each time one is held, and sends those after the
      // last it sent, so none is missed or sent twice however the holdings arrive. Without
      // `after`, it begins after the newest held as it starts.
      const changes = (after: number | undefined) =>
        SubscriptionRef.changes(held).pipe(
          Stream.mapAccum(
            () => after,
            (sent, now): readonly [number, readonly HeldUpload[]] =>
              sent === undefined
                ? [newestOf(now), []]
                : [Math.max(sent, newestOf(now)), changedAfter(now, sent)]
          ),
          Stream.mapEffect(({ record: one, sequence }) =>
            Effect.map(shown(one), (now) => ({ sequence, shown: now }))
          )
        );

      return {
        changes,
        find: (id: UploadId) =>
          SubscriptionRef.get(held).pipe(
            Effect.flatMap((all) =>
              Option.match(HashMap.get(all.byId, id), {
                onNone: () => Effect.succeedNone,
                onSome: (found) => Effect.asSome(shown(found.record)),
              })
            )
          ),
        open,
        page,
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
