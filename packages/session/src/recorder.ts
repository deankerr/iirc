import { Context, Data, Effect, Layer } from "effect";

import type { Entry, NewEntry } from "./entry.ts";

/** Entries could not be recorded, so nothing may act on them. */
export class RecordFailed extends Data.TaggedError("RecordFailed")<{ readonly cause: unknown }> {}

/** Reads back what {@link Recorder.memoryReadable} has kept, in sequence order. */
export class MemoryEntries extends Context.Service<
  MemoryEntries,
  {
    readonly entries: Effect.Effect<readonly Entry[]>;
  }
>()("@iirc/session/MemoryEntries") {}

/**
 * Appends Entries before anything acts on them, which keeps `session` ignorant of
 * how they are stored. `record` appends atomically and runs `within` synchronously
 * in the same transaction, then returns its result after commit. If `within`
 * throws, the whole transaction rolls back and `record` dies.
 */
export class Recorder extends Context.Service<
  Recorder,
  {
    readonly record: <A>(
      entries: readonly NewEntry[],
      within: (recorded: readonly Entry[]) => A
    ) => Effect.Effect<A, RecordFailed>;
  }
>()("@iirc/session/Recorder") {
  /** {@link Recorder.memory}, plus {@link MemoryEntries} to read what it kept. */
  static readonly memoryReadable: Layer.Layer<MemoryEntries | Recorder> = Layer.syncContext(() => {
    const log: Entry[] = [];

    return Context.make(MemoryEntries, { entries: Effect.sync(() => [...log]) }).pipe(
      Context.add(Recorder, {
        record: (entries, within) =>
          Effect.clockWith((clock) =>
            Effect.sync(() => {
              const at = clock.currentTimeMillisUnsafe();

              const recorded = entries.map((entry, index): Entry => ({
                ...entry,
                at,
                sequence: log.length + index + 1,
              }));

              // Committing only after `within` returns is what rolls a throw back.
              const result = within(recorded);

              // Not a spread: one read can hold more Lines than a call has arguments.
              for (const entry of recorded) {
                log.push(entry);
              }

              return result;
            })
          ),
      })
    );
  });

  /** Keeps Entries in memory, for library users who want no storage. */
  static readonly memory: Layer.Layer<Recorder> = this.memoryReadable;
}
