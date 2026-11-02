import { Data, Schema } from "effect";

/** Another process holds this data directory, so two Daemons would share one Log. */
export class DataDirectoryLocked extends Data.TaggedError("DataDirectoryLocked")<{
  readonly dataDir: string;
}> {
  override readonly message = `The data directory ${this.dataDir} is locked by another process`;
}

/** The Log's storage refused a read or could not be opened. */
export class StorageFailed extends Data.TaggedError("StorageFailed")<{
  readonly cause: unknown;
}> {}

/**
 * A read used up its time budget, so it was stopped and returned nothing (LOG-11). The
 * Log is fine, and a narrower read may succeed. It crosses from the reader's Worker, so
 * it is a Schema.
 */
export class ReadTimedOut extends Schema.TaggedError<
  ReadTimedOut,
  { readonly brand: unique symbol }
>()("ReadTimedOut", { budgetMillis: Schema.Int }) {}

/**
 * A read waited behind other reads for longer than its budget allows, so it was given up
 * on without running (LOG-11). The Log and the read are fine, and the reader is busy: the
 * same read may succeed if tried again. `waitedMillis` is how long it waited.
 */
export class ReaderBusy extends Schema.TaggedError<ReaderBusy, { readonly brand: unique symbol }>()(
  "ReaderBusy",
  { waitedMillis: Schema.Int }
) {}

/** The reader's Worker could not read, as it says over RPC, where a cause cannot go. */
export class ReadFailed extends Schema.TaggedError<ReadFailed, { readonly brand: unique symbol }>()(
  "ReadFailed",
  { reason: Schema.String }
) {}

/** No Entry has that sequence, so there is nothing to redact (LOG-7). */
export class EntryNotFound extends Data.TaggedError("EntryNotFound")<{
  readonly sequence: number;
}> {}

/** Only a Line or a Dropped Entry has bytes to redact, and this Entry is `kind` (LOG-7). */
export class EntryNotRedactable extends Data.TaggedError("EntryNotRedactable")<{
  readonly kind: "Change" | "Connection" | "Daemon" | "Deadline";
  readonly sequence: number;
}> {}

/** The Entry's bytes are already gone, taken by the Change at `change` (LOG-7). */
export class EntryAlreadyRedacted extends Data.TaggedError("EntryAlreadyRedacted")<{
  readonly change: number;
  readonly sequence: number;
}> {}
