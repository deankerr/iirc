/**
 * The Journal port: append records durably, read them back in order, and follow the
 * tail. Everything else is derived from it, so a record is a Schema and every adapter
 * stores its encoding.
 *
 * @packageDocumentation
 */
import { Input, Instant, Output } from "@iirc/client";
import { CredentialName } from "@iirc/protocol/line";
import { Context, Schema } from "effect";
import type { Effect, Stream } from "effect";

/**
 * The version of the records below. An adapter that finds a Journal of another version
 * refuses it with {@link JournalVersionMismatch}. Nothing is migrated until the shape
 * has settled. A change an earlier Journal would not decode bumps it, and one that only
 * widens what a record can be does not.
 */
export const journalVersion = 1;

/** A Network, by the id the Owner gave it. Each Network has its own Configuration and Client. */
export const NetworkId = Schema.String.pipe(Schema.brand("NetworkId"));

/** The decoded form of {@link NetworkId}. */
export type NetworkId = typeof NetworkId.Type;

/** An Entry's place in the Journal. Sequences only increase, and may skip numbers. */
export const Sequence = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("Sequence")
);

/** The decoded form of {@link Sequence}. */
export type Sequence = typeof Sequence.Type;

/**
 * Something the Owner altered that no Client takes in, or that the Daemon altered on the
 * Owner's behalf. The Journal knows nothing of which options exist, nor what an Upload's
 * fields mean: the Daemon parses them by the contract's Schemas before it journals them,
 * and folds the Changes.
 *
 * Options are each the whole value of one option, so applying one twice is applying it
 * once and the latest for an option wins (ADR 0015):
 *
 * - `UiSet`: an option under `ui` set to a value, by its name under `ui`, such as `time`.
 * - `UiUnset`: an option under `ui` back to its default.
 * - `OptionSet`: an option under another root set to a value, by its full name, such as
 *   `storage.s3.bucket`.
 * - `OptionUnset`: an option under another root back to its default, or to none.
 *
 * An Upload's Changes are records keyed by its id instead (ADR 0016):
 *
 * - `Uploaded`: an Upload was kept. Its `id`, the `name` it was given, if any, the
 *   `safeName` its link uses, the `type` read from its bytes, their `size` and SHA-256
 *   `hash`, and `at`, when it was uploaded, since an Entry carries no time of its own.
 * - `Renamed`: an earlier `Uploaded`'s Upload was given a new `name`, with the `safeName`
 *   made from it, at `at`. Its link's id is unchanged, so links already said still work.
 * - `Deleted`: an earlier `Uploaded`'s Upload was deleted at `at`, `why` says by whom: the
 *   `owner`, or the Daemon on the Owner's behalf once it `expired`. Its record stays, and its
 *   hold on its bytes is released.
 *
 * A Timeline no Client can name, a detached Direct Message Timeline or one a removed
 * Network kept, is marked by a Change keyed by its id and the Network it is one of, which
 * the Timelines projection folds and no Client steps (ADR 0018):
 *
 * - `TimelineRead`: the Owner has read the Timeline up to the instant `read`.
 * - `TimelineClosed`: the Owner closed the Timeline.
 */
export const Change = Schema.TaggedUnion({
  Deleted: { at: Instant, id: Schema.String, why: Schema.Literals(["owner", "expired"]) },
  OptionSet: { option: Schema.String, value: Schema.Json },
  OptionUnset: { option: Schema.String },
  Renamed: { at: Instant, id: Schema.String, name: Schema.String, safeName: Schema.String },
  TimelineClosed: { network: NetworkId, timeline: Schema.String },
  TimelineRead: { network: NetworkId, read: Instant, timeline: Schema.String },
  UiSet: { option: Schema.String, value: Schema.Json },
  UiUnset: { option: Schema.String },
  Uploaded: {
    at: Instant,
    hash: Schema.String,
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    safeName: Schema.String,
    size: Schema.Int,
    type: Schema.String,
  },
});

/** The decoded form of {@link Change}. */
export type Change = typeof Change.Type;

/** What one Entry records. */
export const JournalRecord = Schema.TaggedUnion({
  /**
   * A Change the Owner made that no Client takes in, or the Daemon made on the Owner's
   * behalf. The Runtime never steps one.
   */
  Change: { change: Change },
  /**
   * The Credentials a removed Network's Configuration named were forgotten, but those a
   * Network still held named, which were spared. Journaled once the Vault has let go of
   * them, so a removal whose Credentials were never forgotten is found on restart.
   */
  Forgotten: { credentials: Schema.Array(CredentialName), network: NetworkId },
  /** An input to a Network's Client, journaled before it is stepped. */
  Input: { input: Input, network: NetworkId },
  /** What the Client asked for when it stepped the input at `of`, as it was carried out. */
  Outputs: { network: NetworkId, of: Sequence, outputs: Schema.Array(Output) },
});

/** The decoded form of {@link JournalRecord}. */
export type JournalRecord = typeof JournalRecord.Type;

/**
 * The Network a record belongs to, or none for a Change.
 * @param record - The record.
 * @returns Its Network.
 */
export const networkOf = (record: JournalRecord): NetworkId | undefined =>
  record._tag === "Change" ? undefined : record.network;

/** One numbered record. */
export const Entry = Schema.Struct({ record: JournalRecord, sequence: Sequence });

/** The decoded form of {@link Entry}. */
export type Entry = typeof Entry.Type;

/**
 * Where to start reading, and which Network's Entries to read. Left out, from the start and
 * for every Network, Changes included. A Network named leaves out every Change, since a
 * Change belongs to none.
 */
export interface Position {
  readonly after?: Sequence | undefined;
  readonly network?: NetworkId | undefined;
}

/** The Journal could not be written or read. The Runtime stops the Network rather than step an input it did not keep. */
export class JournalFailed extends Schema.TaggedError<
  JournalFailed,
  { readonly brand: unique symbol }
>()("JournalFailed", {
  reason: Schema.String,
}) {}

/** The Journal was written by another version, so an adapter refuses to open it. */
export class JournalVersionMismatch extends Schema.TaggedError<
  JournalVersionMismatch,
  { readonly brand: unique symbol }
>()("JournalVersionMismatch", { expected: Schema.Int, found: Schema.Int }) {}

/** What a Journal adapter provides. */
export interface JournalService {
  /** Records durably, then gives the Entry's sequence. Appends are numbered in the order they complete. */
  readonly append: (record: JournalRecord) => Effect.Effect<Sequence, JournalFailed>;
  /** The Entries after a position, in order, up to the end as it stood when reading began. */
  readonly read: (from: Position) => Stream.Stream<Entry, JournalFailed>;
  /** The Entries after a position, then each new one as it is appended. Each once, in order, and it never ends. */
  readonly follow: (from: Position) => Stream.Stream<Entry, JournalFailed>;
}

/** The Journal port. */
export class Journal extends Context.Service<Journal, JournalService>()("@iirc/runtime/Journal") {}
