/**
 * The Uploads: a projection of the Journal's Upload Changes (ADR 0016), in the order they
 * were uploaded, whether they are on, derived from the options in force, the byte store
 * those options name, the path from an arriving body to a kept, recorded Upload, and
 * renaming one, and deleting one, which the Owner does and `uploads.expireAfter` does once
 * an Upload is old enough. An upload that would take the distinct bytes of the live Uploads
 * past `uploads.maxTotal` is refused, and nothing is ever evicted to make room. Beside the projection, and never journaled, it holds which bytes a
 * read of the store confirmed are gone from it, a fact about the store, which marks each live
 * Upload holding them missing (ADR 0016).
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
import type { ByteRange, ByteStoreService } from "@iirc/byte-store";
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
  Duration,
  Effect,
  FileSystem,
  HashMap,
  HashSet,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { SecureRandom } from "effect/crypto";

import { DataDirectoryFailed } from "../lock.ts";
import { OwnerConfiguration } from "../options.ts";
import { StoreBytes } from "../store-bytes.ts";
import { encodeUploadId, idBytes } from "./id.ts";
import { detectKind, kindOfType } from "./kind.ts";
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

/** When an Upload was deleted, and why: by the `owner`, or by the Daemon once it `expired`. */
const Deletion = Schema.Struct({ at: Instant, why: Schema.Literals(["owner", "expired"]) });

/**
 * An Upload as its Changes leave it: what its `Uploaded` gave, with the name and safe name
 * of its latest `Renamed` and when that was, and when and why it was deleted, if it was.
 */
export const Recorded = Schema.Struct({
  ...Kept.fields,
  deleted: Schema.optionalKey(Deletion),
  renamedAt: Schema.optionalKey(Instant),
});

/** The decoded form of {@link Recorded}. */
export type Recorded = typeof Recorded.Type;

/** An Upload found for its link: its record, and a read of its bytes, or one range of them. */
export interface Opened {
  readonly record: Recorded;
  readonly read: (
    range?: ByteRange
  ) => Effect.Effect<
    Stream.Stream<Uint8Array, ByteStoreUnavailable>,
    NoSuchUpload | ByteStoreUnavailable
  >;
}

/** A `Renamed` Change, parsed. */
const Renaming = Schema.Struct({
  at: Instant,
  id: UploadId,
  name: Schema.String,
  safeName: Schema.String,
});

/** A `Deleted` Change, parsed. */
const Deleting = Schema.Struct({ at: Instant, id: UploadId, why: Deletion.fields.why });

/**
 * What a Frontend is shown of an Upload: its record, its link while there is a public URL
 * and it is not deleted, and whether it is live and a read of the store confirmed its bytes
 * are gone.
 */
export interface Shown {
  readonly record: Recorded;
  readonly link: string | undefined;
  readonly missing: boolean;
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
  "storage.s3.endpoint",
  "storage.s3.bucket",
  "storage.s3.region",
  "storage.s3.accessKeyId",
  "storage.s3.secretAccessKey",
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
    "storage.s3.accessKeyId": accessKeyId,
    "storage.s3.bucket": bucket,
    "storage.s3.endpoint": endpoint,
    "storage.s3.region": region,
    "storage.s3.secretAccessKey": secretAccessKey,
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

/**
 * Keeping the bytes would take the distinct bytes of the live Uploads past `maxTotal`,
 * `uploads.maxTotal` as it was when they were counted.
 */
export class PastMaxTotal extends Data.TaggedError("PastMaxTotal")<{
  readonly maxTotal: number;
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
    /** One Upload by its id, with its link, or none. A deleted one is found, with no link. */
    readonly find: (id: UploadId) => Effect.Effect<Option.Option<Shown>>;
    /**
     * Up to `limit` Uploads, with their links, newest first: the newest, or those older
     * than the Upload `after` names, read with the sequence of the latest Upload Change,
     * from the same holdings, so `changes` after it gives exactly what the page could not.
     * Deleted ones are passed over unless `withDeleted`, though `after` may name one. One no
     * Upload has is `NoSuchUpload`.
     */
    readonly page: (
      after: UploadId | undefined,
      limit: number,
      withDeleted: boolean
    ) => Effect.Effect<Page, NoSuchUpload>;
    /**
     * Each Upload as a Change makes it, whole, with its link as it is sent, and the Change's
     * sequence: every one after `after`, oldest first, and then each as it is made, with no
     * gap and none twice. An `Uploaded`, a `Renamed`, and a `Deleted` each make one. Without
     * `after`, only those made from now.
     */
    readonly changes: (after: number | undefined) => Stream.Stream<Changed>;
    /**
     * The ids of every live Upload whose bytes a read of the store confirmed are gone,
     * oldest first: as they are now, and then whole again each time they change. A read that
     * finds the bytes, an upload that puts them again, and a change of the store's options
     * each take the mark away, and a store that cannot be reached neither makes nor takes
     * one. None is journaled, so after a restart each is learnt again on the next read.
     */
    readonly missing: Stream.Stream<readonly UploadId[]>;
    /**
     * Stages a body, reads its type from its bytes, strips it if it is an image, puts it to
     * the store, and journals its `Uploaded`, in that order, with `uploads.maxSize` read once
     * as it begins. A body that passes it is cut off unread, and an image that cannot be
     * walked is refused. Before the bytes are put, room is reserved for them under
     * `uploads.maxTotal`, as it is then: the distinct bytes of the live Uploads, and of the
     * uploads already holding room, count once each, and bytes among them add nothing. Bytes
     * that would pass it are `PastMaxTotal`, and nothing is put, journaled, or evicted. The
     * room is held until the upload ends, however it ends. The staged file is gone however it
     * ends, and nothing is journaled unless the bytes were kept.
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
      | PastMaxTotal
      | UnreadableImage
      | ByteStoreUnavailable
      | JournalFailed
    >;
    /**
     * An Upload's record, and how to read its bytes, or one range of them, for its link. A
     * deleted one is `NoSuchUpload`, as an id no Upload has, before the store is asked. Each
     * read asks the store, and bytes it confirms are gone are `NoSuchUpload` too, and mark
     * the Upload missing, as a read that finds them takes the mark away. Whether they are
     * held is decided before any flows.
     */
    readonly open: (id: UploadId) => Effect.Effect<Opened, NoSuchUpload | ByteStoreUnavailable>;
    /**
     * Gives an Upload a new name, journaling its `Renamed` with the safe name made again from
     * it and the type its bytes were read as. Its id, and so every link already said, is
     * unchanged. One no Upload has, or one deleted, is `NoSuchUpload`.
     */
    readonly rename: (
      id: UploadId,
      name: string
    ) => Effect.Effect<Shown, NoSuchUpload | JournalFailed>;
    /**
     * Deletes an Upload for the Owner, journaling its `Deleted`, so its link and its bytes
     * are answered as an id no Upload has from then on. Its record stays. Its bytes are then
     * released from the store unless a live Upload, an upload still being kept, or a Preview
     * has the same, and a store that cannot release them is logged, not failed. One no Upload has is
     * `NoSuchUpload`, and one already deleted is answered as it is, with nothing journaled.
     * The Daemon deletes the same way, `why` `expired`, once an Upload is older than
     * `uploads.expireAfter` days, when it starts and every hour after.
     */
    readonly delete: (id: UploadId) => Effect.Effect<Shown, NoSuchUpload | JournalFailed>;
    /** Whether a live Upload, one not deleted, has the bytes under a hash. */
    readonly holds: (hash: Sha256) => Effect.Effect<boolean>;
  }
>()("@iirc/daemon/Uploads") {}

/** A day, which `uploads.expireAfter` counts in. */
const dayMillis = 86_400_000;

/** How often the Uploads are checked for any that have expired, as well as once at start. */
const expiryEvery = Duration.hours(1);

const keptOf = Schema.decodeUnknownOption(Kept);

const renamingOf = Schema.decodeUnknownOption(Renaming);

const deletingOf = Schema.decodeUnknownOption(Deleting);

/** An Upload as held: its record, and its place in `order`. */
interface HeldUpload {
  readonly record: Recorded;
  readonly place: number;
}

/** One Upload Change that changed an Upload: its sequence, and the Upload's id. */
interface Logged {
  readonly sequence: number;
  readonly id: UploadId;
}

/**
 * The Uploads held: each by its id, their ids oldest first, which is the order their
 * `Uploaded` Changes were journaled, and every Upload Change that changed one, in the
 * Journal's order. All are persistent, so holding one more never copies the rest.
 */
interface Held {
  readonly byId: HashMap.HashMap<UploadId, HeldUpload>;
  readonly order: Chunk.Chunk<UploadId>;
  readonly log: Chunk.Chunk<Logged>;
}

const nothingHeld: Held = { byId: HashMap.empty(), log: Chunk.empty(), order: Chunk.empty() };

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
        byId: HashMap.set(held.byId, record.id, { place: Chunk.size(held.order), record }),
        log: Chunk.append(held.log, { id: record.id, sequence }),
        order: Chunk.append(held.order, record.id),
      };

/**
 * Changes one held Upload. One not held, or that `amend` leaves as it was, is passed over.
 * @param held - The Uploads so far.
 * @param id - The Upload's id.
 * @param sequence - The sequence of the Change.
 * @param amend - The Upload after the Change, or `undefined` for one the Change does not apply to.
 * @returns The Uploads after it.
 */
const amending = (
  held: Held,
  id: UploadId,
  sequence: number,
  amend: (record: Recorded) => Recorded | undefined
): Held => {
  const found = HashMap.get(held.byId, id);
  const record = Option.isNone(found) ? undefined : amend(found.value.record);

  return Option.isNone(found) || record === undefined
    ? held
    : {
        byId: HashMap.set(held.byId, id, { place: found.value.place, record }),
        log: Chunk.append(held.log, { id, sequence }),
        order: held.order,
      };
};

/**
 * Folds one Change into the Uploads, and passes over any other. One that does not parse,
 * or that names no Upload held, changes nothing, and nothing changes a deleted Upload, so a
 * `Deleted` applied twice is applied once.
 * @param held - The Uploads so far.
 * @param change - The Change.
 * @param sequence - Its sequence.
 * @returns The Uploads after it.
 */
const foldUpload = (held: Held, change: Change, sequence: number): Held => {
  if (change._tag === "Uploaded") {
    const kept = keptOf(change);

    return Option.isNone(kept) ? held : holding(held, kept.value, sequence);
  }

  if (change._tag === "Renamed") {
    const renaming = renamingOf(change);

    return Option.isNone(renaming)
      ? held
      : amending(held, renaming.value.id, sequence, (record) =>
          record.deleted === undefined
            ? {
                ...record,
                name: renaming.value.name,
                renamedAt: renaming.value.at,
                safeName: renaming.value.safeName,
              }
            : undefined
        );
  }

  if (change._tag === "Deleted") {
    const deleting = deletingOf(change);

    return Option.isNone(deleting)
      ? held
      : amending(held, deleting.value.id, sequence, (record) =>
          record.deleted === undefined
            ? { ...record, deleted: { at: deleting.value.at, why: deleting.value.why } }
            : undefined
        );
  }

  return held;
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
 * Up to `limit` Uploads, newest first, below the place `before`, passing over deleted ones
 * unless `withDeleted`.
 * @param held - The Uploads.
 * @param before - The place the page begins below.
 * @param limit - How many at most.
 * @param withDeleted - Whether deleted ones are given too.
 * @returns The page, and whether more follow.
 */
const pageOf = (held: Held, before: number, limit: number, withDeleted: boolean) => {
  const given = (one: HeldUpload) => withDeleted || one.record.deleted === undefined;
  const uploads: HeldUpload[] = [];
  let place = before - 1;

  for (; place >= 0 && uploads.length < limit; place -= 1) {
    const one = at(held, place);

    if (given(one)) {
      uploads.push(one);
    }
  }

  let more = false;

  for (; place >= 0 && !more; place -= 1) {
    more = given(at(held, place));
  }

  return { more, uploads };
};

/**
 * Every Upload Change after a sequence, oldest first, each with its Upload as it is now.
 * The newest are last in `log`, so only those are read.
 * @param held - The Uploads.
 * @param after - The sequence.
 * @returns Them.
 */
const changedAfter = (held: Held, after: number) => {
  const found: { readonly sequence: number; readonly record: Recorded }[] = [];

  for (let index = Chunk.size(held.log) - 1; index >= 0; index -= 1) {
    const { id, sequence } = Chunk.getUnsafe(held.log, index);

    if (sequence <= after) {
      break;
    }

    found.push({ record: HashMap.getUnsafe(held.byId, id).record, sequence });
  }

  return found.toReversed();
};

/**
 * Whether a live Upload, one not deleted, has the bytes under a hash.
 * @param held - The Uploads.
 * @param hash - The hash.
 * @returns Whether one does.
 */
const liveHas = (held: Held, hash: string) => {
  for (const { record } of HashMap.values(held.byId)) {
    if (record.hash === hash && record.deleted === undefined) {
      return true;
    }
  }

  return false;
};

/**
 * The size of each distinct bytes the live Uploads hold, by hash.
 * @param held - The Uploads.
 * @returns Each hash's size.
 */
const liveSizes = (held: Held) => {
  const sizes = new Map<string, number>();

  for (const { record } of HashMap.values(held.byId)) {
    if (record.deleted === undefined) {
      sizes.set(record.hash, record.size);
    }
  }

  return sizes;
};

/**
 * The hashes a read of the store confirmed are gone from it, how many times the store has
 * changed, and how many times each hash was put, so a read answered by a store since
 * changed marks nothing and takes nothing away, and one begun before its own bytes were put
 * again marks nothing.
 */
interface Marks {
  readonly gone: HashSet.HashSet<Sha256>;
  readonly store: number;
  readonly puts: HashMap.HashMap<Sha256, number>;
}

/**
 * What a read is answered against: the store it asked, and the puts of its hash then.
 * @param marks - The marks as the read begins.
 * @param hash - The hash it reads.
 * @returns Them.
 */
const askedOf = (marks: Marks, hash: Sha256) => ({
  puts: Option.getOrElse(HashMap.get(marks.puts, hash), () => 0),
  store: marks.store,
});

/**
 * The ids of the live Uploads whose bytes are gone, oldest first.
 * @param held - The Uploads.
 * @param gone - The hashes confirmed gone.
 * @returns Them.
 */
const missingOf = (held: Held, gone: HashSet.HashSet<Sha256>): readonly UploadId[] =>
  HashSet.isEmpty(gone)
    ? []
    : Chunk.toReadonlyArray(held.order).filter((id) => {
        const { record } = HashMap.getUnsafe(held.byId, id);

        return record.deleted === undefined && HashSet.has(gone, record.hash);
      });

const sameIds = (one: readonly UploadId[], other: readonly UploadId[]) =>
  one.length === other.length && one.every((id, index) => id === other[index]);

/**
 * The sequence of the latest Upload Change, or `0` with none.
 * @param held - The Uploads.
 * @returns It.
 */
const newestOf = (held: Held) =>
  Chunk.isEmpty(held.log) ? 0 : Chunk.getUnsafe(held.log, Chunk.size(held.log) - 1).sequence;

/**
 * The Uploads folded from every Change in the Journal as it starts, and kept as each
 * Upload Change is journaled through it, which is the only way one is. Staging is emptied
 * as it starts.
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
      const bytes = yield* StoreBytes;
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

      const marks = yield* SubscriptionRef.make<Marks>({
        gone: HashSet.empty(),
        puts: HashMap.empty(),
        store: 0,
      });

      const turn = yield* Semaphore.make(1);

      // The room uploads hold for bytes they have checked and not yet recorded, by hash, with
      // how many hold each. Counted by hash with the live Uploads', so one whose Upload is
      // recorded while its upload is still ending is never counted twice. It is read and changed
      // only under `counting`, which is held for one count and never for an upload.
      const counting = yield* Semaphore.make(1);
      const reservations = new Map<string, { readonly size: number; readonly holders: number }>();

      // Bytes were put again, so they are held, and a read of them begun before this marks
      // nothing.
      const put = (hash: Sha256) =>
        SubscriptionRef.update(marks, (now) => ({
          ...now,
          gone: HashSet.remove(now.gone, hash),
          puts: HashMap.set(now.puts, hash, askedOf(now, hash).puts + 1),
        }));

      // The store moved, so nothing learnt of the one before holds, and a read it answers
      // marks nothing and takes nothing away.
      const moved = SubscriptionRef.update(marks, (now) => ({
        gone: HashSet.empty(),
        puts: now.puts,
        store: now.store + 1,
      }));

      // A read found the bytes, so they are not missing, unless the store it asked has moved.
      const found = (hash: Sha256, asked: ReturnType<typeof askedOf>) =>
        SubscriptionRef.updateSome(marks, (now) =>
          now.store === asked.store && HashSet.has(now.gone, hash)
            ? Option.some({ ...now, gone: HashSet.remove(now.gone, hash) })
            : Option.none()
        );

      // A read confirmed the bytes are gone, and neither a move of the store nor a put of
      // these bytes came between its asking and its answer.
      const lost = (hash: Sha256, asked: ReturnType<typeof askedOf>) =>
        SubscriptionRef.updateSome(marks, (now) => {
          const at = askedOf(now, hash);

          return at.store === asked.store && at.puts === asked.puts && !HashSet.has(now.gone, hash)
            ? Option.some({ ...now, gone: HashSet.add(now.gone, hash) })
            : Option.none();
        });

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
                      ? `the credential ${error.credential} is not held`
                      : "the credentials could not be read",
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
      // new Uploads may be made, and until the Upload is deleted.
      const shown = (record: Recorded): Effect.Effect<Shown> =>
        Effect.all([owner.inForce, SubscriptionRef.get(marks)]).pipe(
          Effect.map(([{ options }, { gone }]) => {
            const publicUrl = options["uploads.publicUrl"];

            return {
              link:
                publicUrl === undefined || record.deleted !== undefined
                  ? undefined
                  : linkOf(publicUrl, record),
              missing: record.deleted === undefined && HashSet.has(gone, record.hash),
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

      // Bytes leave the store only once no live Upload and no Preview has them. An upload
      // claims its hash before it puts, until it has journaled or failed, since what is held
      // cannot say an upload of the same bytes is on its way.
      const release = (hash: Sha256) =>
        bytes.release(hash, {
          store: switchNow.pipe(
            Effect.flatMap((now) =>
              now._tag === "On"
                ? storeOf(now.bucket)
                : Effect.fail(new ByteStoreUnavailable({ reason: "Uploads are off" }))
            )
          ),
          uploaded: Effect.map(SubscriptionRef.get(held), (all) => liveHas(all, hash)),
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
              yield* Effect.logInfo("Saved upload", {
                size: kept.size,
                type: kept.type,
                upload: kept.id,
              });
            })
          )
        );

      // Holds room for bytes until the Scope closes, if `uploads.maxTotal`, as it is now, has
      // it: the distinct bytes of the live Uploads and of the room already held, with these
      // added unless among them. Bytes that add nothing are always kept, since they cannot pass
      // a limit, whatever it was lowered to. The reservations are read before the Uploads, so
      // an upload that records and lets go between the two is counted in one of them.
      const reserved = (hash: Sha256, size: number) =>
        Effect.acquireRelease(
          counting.withPermit(
            Effect.gen(function* () {
              const { options } = yield* owner.inForce;
              const maxTotal = options["uploads.maxTotal"];

              const sizes = new Map(
                [...reservations].map(([each, { size: held }]) => [each, held] as const)
              );

              for (const [each, one] of liveSizes(yield* SubscriptionRef.get(held))) {
                sizes.set(each, one);
              }

              const adds = sizes.has(hash) ? 0 : size;
              const total = sizes.values().reduce((sum, one) => sum + one, 0);

              return maxTotal !== undefined && adds > 0 && total + adds > maxTotal
                ? yield* new PastMaxTotal({ maxTotal })
                : reservations.set(hash, {
                    holders: (reservations.get(hash)?.holders ?? 0) + 1,
                    size,
                  });
            })
          ),
          () =>
            Effect.sync(() => {
              const left = (reservations.get(hash)?.holders ?? 1) - 1;

              if (left === 0) {
                reservations.delete(hash);
              } else {
                reservations.set(hash, { holders: left, size });
              }
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
          const keeping = yield* keepable(staged, kind.type);

          yield* reserved(Sha256.make(keeping.hash), keeping.size);
          yield* bytes.claimed(Sha256.make(keeping.hash));
          const store = yield* storeOf(now.bucket);
          const stored = yield* store.put(keeping.bytes);

          if (stored.hash !== keeping.hash || stored.size !== keeping.size) {
            return yield* Effect.die(new Error("the store kept other bytes than were meant"));
          }

          // Every live Upload holding these bytes is served again.
          yield* put(stored.hash);

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

          return { link: linkOf(now.publicUrl, kept), missing: false, record: kept };
        }).pipe(Effect.scoped, Effect.provideContext(provided));

      const open = (id: UploadId) =>
        Effect.gen(function* () {
          const kept = HashMap.get((yield* SubscriptionRef.get(held)).byId, id);

          // A deleted Upload is answered before the store is asked, as one never made is.
          if (Option.isNone(kept) || kept.value.record.deleted !== undefined) {
            return yield* new NoSuchUpload();
          }

          const { record } = kept.value;

          const now = yield* switchNow;

          if (now._tag === "Off") {
            return yield* new ByteStoreUnavailable({ reason: "Uploads are off" });
          }

          const store = yield* storeOf(now.bucket);

          // Only a store that answered says whether the bytes are held: one that could not
          // be reached marks nothing, and takes no mark away.
          const opened: Opened = {
            read: (range) =>
              Effect.gen(function* () {
                const asked = askedOf(yield* SubscriptionRef.get(marks), record.hash);

                return yield* store.read(record.hash, range).pipe(
                  Effect.tap(() => found(record.hash, asked)),
                  Effect.catchTag("ByteStoreNotFound", () =>
                    Effect.andThen(lost(record.hash, asked), Effect.fail(new NoSuchUpload()))
                  )
                );
              }),
            record,
          };

          return opened;
        });

      // Journals the Change `change` makes from an Upload's record, if it makes one, and
      // holds what it left, in one uninterruptible step and one turn, as `record` does.
      const amend = (
        id: UploadId,
        change: (record: Recorded) => Effect.Effect<Option.Option<Change>, NoSuchUpload>,
        done: string
      ) =>
        turn.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const found = HashMap.get((yield* SubscriptionRef.get(held)).byId, id);

              if (Option.isNone(found)) {
                return yield* new NoSuchUpload();
              }

              const making = yield* change(found.value.record);

              if (Option.isNone(making)) {
                return found.value.record;
              }

              const made = making.value;

              const sequence = yield* journal.append({ _tag: "Change", change: made });

              const after = yield* SubscriptionRef.updateAndGet(held, (all) =>
                foldUpload(all, made, sequence)
              );

              yield* Effect.logInfo(done, { upload: id });

              return HashMap.getUnsafe(after.byId, id).record;
            })
          )
        );

      // A deleted Upload is renamed no more than one never made.
      const rename = (id: UploadId, name: string) =>
        amend(
          id,
          (record) =>
            Effect.gen(function* () {
              if (record.deleted !== undefined) {
                return yield* new NoSuchUpload();
              }

              const change: Change = {
                _tag: "Renamed",
                at: Instant.make(yield* Clock.currentTimeMillis),
                id,
                name,
                safeName: safeName(name, kindOfType(record.type)),
              };

              return Option.some(change);
            }),
          "Renamed upload"
        ).pipe(Effect.flatMap(shown));

      // One already deleted is answered as it is, and its bytes released again, which does
      // nothing when they already were, and releases them when the store failed before.
      const remove = (id: UploadId) =>
        amend(
          id,
          (record) =>
            Effect.gen(function* () {
              if (record.deleted !== undefined) {
                return Option.none();
              }

              const change: Change = {
                _tag: "Deleted",
                at: Instant.make(yield* Clock.currentTimeMillis),
                id,
                why: "owner",
              };

              return Option.some(change);
            }),
          "Deleted upload"
        ).pipe(
          Effect.tap((record) => release(record.hash)),
          Effect.flatMap(shown)
        );

      // Deletes each live Upload strictly older than `uploads.expireAfter` days, by the
      // Daemon's own clock, and releases its bytes as the Owner's delete does. None is old
      // while the option is unset. Each Upload is judged again inside its own turn, by the
      // option and the clock then, so one the Owner deleted meanwhile is left to them, and
      // none expires under an option changed while an earlier one's bytes were released.
      const expiryOf = (record: Recorded) =>
        Effect.gen(function* () {
          const { options } = yield* owner.inForce;
          const days = options["uploads.expireAfter"];
          const now = yield* Clock.currentTimeMillis;

          return days === undefined ||
            record.deleted !== undefined ||
            now - record.at <= days * dayMillis
            ? Option.none<Change>()
            : Option.some<Change>({
                _tag: "Deleted",
                at: Instant.make(now),
                id: record.id,
                why: "expired",
              });
        });

      const expire = Effect.gen(function* () {
        const all = yield* SubscriptionRef.get(held);

        // Each is its own turn, in the order uploaded.
        for (const id of all.order) {
          const { record } = HashMap.getUnsafe(all.byId, id);

          if (Option.isSome(yield* expiryOf(record))) {
            const expired = yield* amend(id, expiryOf, "Expired upload");

            if (expired.deleted?.why === "expired") {
              yield* release(expired.hash);
            }
          }
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not expire uploads; will try again", { error: error._tag })
        )
      );

      yield* expire.pipe(Effect.repeat(Schedule.spaced(expiryEvery)), Effect.forkScoped);

      // What was learnt of one store says nothing of another, so a change of where the
      // bucket is, or of its keys, forgets it, and Uploads going off and on again too.
      yield* owner.changes.pipe(
        Stream.map(({ options }) => {
          const now = switchOf(options);

          return now._tag === "On" ? JSON.stringify(now.bucket) : "";
        }),
        Stream.changes,
        Stream.drop(1),
        Stream.runForEach(() => moved),
        Effect.forkScoped
      );

      const page = (after: UploadId | undefined, limit: number, withDeleted: boolean) =>
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

          const { more, uploads } = pageOf(all, before, limit, withDeleted);

          return {
            next: more ? uploads.at(-1)?.record.id : undefined,
            through: newestOf(all),
            // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
            uploads: yield* Effect.forEach(uploads, ({ record: one }) => shown(one)),
          };
        });

      // A follower reads the Uploads whole each time one changes, and sends each Change after
      // the last it sent, with its Upload as it is now, so none is missed or sent twice
      // however the holdings arrive. Without `after`, it begins after the latest held as it starts.
      const changes = (after: number | undefined) =>
        SubscriptionRef.changes(held).pipe(
          Stream.mapAccum(
            () => after,
            (sent, now): readonly [number, ReturnType<typeof changedAfter>] =>
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
        delete: remove,
        find: (id: UploadId) =>
          SubscriptionRef.get(held).pipe(
            Effect.flatMap((all) =>
              Option.match(HashMap.get(all.byId, id), {
                onNone: () => Effect.succeedNone,
                onSome: (found) => Effect.asSome(shown(found.record)),
              })
            )
          ),
        holds: (hash: Sha256) => Effect.map(SubscriptionRef.get(held), (all) => liveHas(all, hash)),
        missing: Stream.zipLatest(
          SubscriptionRef.changes(held),
          SubscriptionRef.changes(marks)
        ).pipe(
          Stream.map(([all, { gone }]) => missingOf(all, gone)),
          Stream.changesWith(sameIds)
        ),
        open,
        page,
        rename,
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
