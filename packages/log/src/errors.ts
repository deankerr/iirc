import { Data } from "effect";

/** Another process holds this data directory, so two Daemons would share one Log. */
export class DataDirectoryLocked extends Data.TaggedError("DataDirectoryLocked")<{
  readonly dataDir: string;
}> {}

/** The Log's storage refused a read or could not be opened. */
export class StorageFailed extends Data.TaggedError("StorageFailed")<{
  readonly cause: unknown;
}> {}
