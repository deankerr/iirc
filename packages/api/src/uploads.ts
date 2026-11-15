/**
 * Uploads on the wire: an Upload's id and record, the name it may be given, and whether
 * Uploads are on (ADR 0016).
 *
 * @packageDocumentation
 */
import { Instant } from "@iirc/client";
import { Schema } from "effect";

import { ByteCount, OwnerOptionName } from "./options.ts";
import { After, Limit } from "./schemas.ts";

/**
 * An Upload's id: 16 lower-case characters of Crockford's base32, 80 random bits, which
 * holds no character a URL would change.
 */
export const UploadId = Schema.String.check(
  Schema.isPattern(/^[0-9a-hjkmnp-tv-z]{16}$/u, {
    message: "must be 16 lower-case Crockford base32 characters",
  })
).pipe(Schema.brand("UploadId"));

/** The decoded form of {@link UploadId}. */
export type UploadId = typeof UploadId.Type;

/** The most code units a name given to an Upload may have. */
export const uploadNameMaxLength = 1024;

/**
 * The name an Upload is given, as the Owner gave it: any text of 1 to 1024 code units. It
 * decides nothing but the safe name its link and download use.
 */
export const UploadName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(uploadNameMaxLength)
).annotate({
  description:
    "The file's name, such as cat.png. Its type is read from its bytes, never from this.",
  identifier: "UploadName",
});

/** The query of an upload: the name, when there is one. */
export const UploadQuery = Schema.Struct({ name: Schema.optionalKey(UploadName) });

/**
 * An Upload: its id, the name it was given, if any, the safe name its link and download
 * use, the type read from its bytes, their size and SHA-256 hash, when it was uploaded, and
 * its link, `<uploads.publicUrl>/<id>/<safeName>` from the public URL in force, or `null`
 * while none is set.
 */
export const Upload = Schema.Struct({
  at: Instant,
  hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  id: UploadId,
  link: Schema.NullOr(Schema.String),
  name: Schema.optionalKey(Schema.String),
  safeName: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  type: Schema.String,
});

/** The decoded form of {@link Upload}. */
export type Upload = typeof Upload.Type;

/**
 * Whether Uploads are on, and the largest one may be. They are on exactly when the bucket,
 * its keys, and `uploads.publicUrl` are all set, and otherwise `Off` names each of those
 * options that is not.
 */
export const UploadsStatus = Schema.TaggedUnion({
  Off: { maxSize: ByteCount, missing: Schema.Array(OwnerOptionName) },
  On: { maxSize: ByteCount },
});

/** The decoded form of {@link UploadsStatus}. */
export type UploadsStatus = typeof UploadsStatus.Type;

/**
 * Where the next page of Uploads begins: just after an Upload, as the text a page gave as
 * `next`. A Frontend never reads anything into it, and one naming no Upload the Daemon
 * holds is refused.
 */
export const UploadsAfter = UploadId.annotate({
  description: "Where the next page of Uploads begins, as a page gave it in `next`.",
  identifier: "UploadsAfter",
});

/** A page of the Uploads: those after `after`, newest first, up to `limit`. */
export const UploadsQuery = Schema.Struct({
  after: Schema.optionalKey(UploadsAfter),
  limit: Schema.optionalKey(Limit),
});

/** The decoded form of {@link UploadsQuery}. */
export type UploadsQuery = typeof UploadsQuery.Type;

/** A page of the Uploads, newest first, and whether more follow. */
export const UploadPage = Schema.Struct({
  more: Schema.Boolean,
  /** Where the next page begins, to give as `after`, or `null` when no more follow. */
  next: Schema.NullOr(UploadsAfter),
  uploads: Schema.Array(Upload),
});

/** The decoded form of {@link UploadPage}. */
export type UploadPage = typeof UploadPage.Type;

/**
 * One event of the stream of Upload Changes: `changed` carries an Upload whole, as it is
 * after the Change, with the Change's sequence as its id, so a Frontend replaces what it
 * holds under that id; and `heartbeat` says the stream is alive.
 */
export const UploadsEvent = Schema.Union([
  Schema.Struct({
    data: Schema.fromJsonString(Upload),
    event: Schema.Literal("changed"),
    id: After,
  }),
  Schema.Struct({
    data: Schema.fromJsonString(Schema.Struct({})),
    event: Schema.Literal("heartbeat"),
  }),
]);

/** The decoded form of {@link UploadsEvent}. */
export type UploadsEvent = typeof UploadsEvent.Type;
