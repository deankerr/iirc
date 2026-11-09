/**
 * The Journal port: append records durably, read them back in order, and follow the
 * tail. Everything else is derived from it, so a record is a Schema and every adapter
 * stores its encoding.
 *
 * @packageDocumentation
 */
import { Input, Output } from "@iirc/client";
import { CredentialName } from "@iirc/protocol/line";
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

/** What one Entry records. */
export const JournalRecord = Schema.TaggedUnion({
  /** An input to a Network's Client, journaled before it is stepped. */
  Input: { input: Input, network: NetworkId },
  /** What the Client asked for when it stepped the input at `of`, as it was carried out. */
  Outputs: { network: NetworkId, of: Sequence, outputs: Schema.Array(Output) },
  /**
   * A `SendSecret` the Runtime could not fill, because the Vault does not hold the
   * Credential. Nothing was sent. The Client learns of it only from the Ircd.
   */
  Unfilled: { credential: CredentialName, network: NetworkId, of: Sequence },
});

/** The decoded form of {@link JournalRecord}. */
export type JournalRecord = typeof JournalRecord.Type;

/** One numbered record. */
export const Entry = Schema.Struct({ record: JournalRecord, sequence: Sequence });

/** The decoded form of {@link Entry}. */
export type Entry = typeof Entry.Type;

/** Where to start reading, and which Network's Entries to read. Left out, from the start and for every Network. */
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
