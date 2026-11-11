/**
 * The Journal port: append records durably, read them back in order, and follow the
 * tail. Everything else is derived from it, so a record is a Schema and every adapter
 * stores its encoding.
 *
 * @packageDocumentation
 */
import { Input, Output } from "@iirc/client";
import { Context, Schema } from "effect";
import type { Effect, Stream } from "effect";

/**
 * The version of the records below. An adapter that finds a Journal of another version
 * refuses it with {@link JournalVersionMismatch}. Nothing is migrated until the shape
 * has settled.
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
 * Something the Owner altered that belongs to no Network, as the whole value of one
 * option, so applying it twice is applying it once and the latest for an option wins
 * (ADR 0015). The Journal holds an option by its name and its value as JSON, and knows
 * nothing of which options exist: the Daemon parses a value by the contract's Schema before
 * it is journaled, and folds Changes into the Owner's Configuration.
 *
 * - `UiSet`: an option under `ui` set to a value.
 * - `UiUnset`: an option under `ui` back to its default.
 */
export const Change = Schema.TaggedUnion({
  UiSet: { option: Schema.String, value: Schema.Json },
  UiUnset: { option: Schema.String },
});

/** The decoded form of {@link Change}. */
export type Change = typeof Change.Type;

/** What one Entry records. */
export const JournalRecord = Schema.TaggedUnion({
  /** A Change the Owner made that belongs to no Network. The Runtime never steps one. */
  Change: { change: Change },
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
