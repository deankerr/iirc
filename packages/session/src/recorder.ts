import { Array as Arr, Context, Data, Effect, Layer, pipe, Queue, Stream } from "effect";
import type { Cause, Scope } from "effect";

import type { Entry, NetworkId, NewEntry } from "./entry.ts";
import { foldStandings, noStanding, noStandings } from "./standing.ts";
import type { Standing } from "./standing.ts";

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
 * A run of Entries a watcher fell too far behind to be given, from `missedFrom` to
 * `missedTo`, both included. It stands where they would have, so every Entry before it
 * and after it is one the watcher was given, and nothing else was missed.
 */
export interface Overflowed {
  readonly _tag: "Overflowed";
  readonly missedFrom: number;
  readonly missedTo: number;
}

/** What a watch gives: each Entry as it commits, or a run of them it missed. */
export type Watched = Entry | Overflowed;

/** How far one watcher may fall behind, in Entries, unless it asks otherwise. */
export const defaultWatchCapacity = 4096;

/** The most Entries one watcher may ask to hold, which is far more than any reader needs. */
export const maxWatchCapacity = 1_000_000;

/** A watcher asked for a capacity that is not a whole number of Entries from 1 to {@link maxWatchCapacity}. */
export class InvalidWatchCapacity extends Data.TaggedError("InvalidWatchCapacity")<{
  readonly capacity: number;
}> {}

// Parsed once, where a watch begins, so that no watcher can hold a bound that never binds,
// such as `NaN` or `Infinity`, which no comparison with a size ever meets.
const parseCapacity = (
  capacity: number | undefined
): Effect.Effect<number, InvalidWatchCapacity> => {
  if (capacity === undefined) {
    return Effect.succeed(defaultWatchCapacity);
  }

  return Number.isSafeInteger(capacity) && capacity >= 1 && capacity <= maxWatchCapacity
    ? Effect.succeed(capacity)
    : Effect.fail(new InvalidWatchCapacity({ capacity }));
};

/**
 * Watches Entries as they commit, so that a library user who hosts a Network can act on
 * its traffic without polling, or knowing how a Recorder records.
 *
 * - **Ordering:** a watch gives Entries in sequence order, each only once its commit has
 *   landed, so nothing it gives can be rolled back.
 * - **Timing:** it gives every Entry committed after `watch` returns, and none from
 *   before, so it subscribes then, and not when the Stream is first run. Anything older
 *   is a read of the Recorder's own, such as {@link MemoryEntries} or the Log's, by
 *   cursor. A read made after subscribing leaves no gap, and the sequence settles any
 *   overlap.
 * - **Overflow:** no watcher can hold up a commit. Each holds at most `capacity` Entries
 *   it has not taken yet, `defaultWatchCapacity` unless it says, and past that it misses
 *   them, until it has taken all it holds. Then it is given one {@link Overflowed} for the
 *   whole run it missed, in its place, and Entries again after it. A miss is never silent.
 *   A `capacity` that is not a whole number from 1 to `maxWatchCapacity` fails the watch
 *   with {@link InvalidWatchCapacity}, as it would bound nothing.
 * - **Lifetime:** the Stream ends once the Scope `watch` ran in closes, after what it
 *   already holds.
 */
export class Committed extends Context.Service<
  Committed,
  {
    readonly watch: (options?: {
      readonly capacity?: number;
    }) => Effect.Effect<Stream.Stream<Watched>, InvalidWatchCapacity, Scope.Scope>;
  }
>()("@iirc/session/Committed") {}

// A miss in progress. It stands in a watcher's queue where the run began, and grows until
// the watcher takes it.
interface Missed {
  readonly from: number;
  to: number;
}

interface Watcher {
  readonly capacity: number;
  // What it has not taken: Entries, then at most one miss, which is last while it lasts.
  readonly queue: Queue.Queue<Entry | Missed, Cause.Done>;
  missed: Missed | undefined;
}

const isMissed = (item: Entry | Missed): item is Missed => !("_tag" in item);

const offerTo = (watcher: Watcher, entry: Entry) => {
  if (watcher.missed !== undefined) {
    watcher.missed.to = entry.sequence;
  } else if (Queue.sizeUnsafe(watcher.queue) >= watcher.capacity) {
    watcher.missed = { from: entry.sequence, to: entry.sequence };
    Queue.offerUnsafe(watcher.queue, watcher.missed);
  } else {
    Queue.offerUnsafe(watcher.queue, entry);
  }
};

// Whatever the watcher missed up to now is in this one element. What commits after it
// is queued after it.
const takeMissed = (watcher: Watcher, missed: Missed): Overflowed => {
  watcher.missed = undefined;

  return { _tag: "Overflowed", missedFrom: missed.from, missedTo: missed.to };
};

/**
 * What a Recorder needs to offer {@link Committed}: `publish`, which it calls with each
 * commit's Entries once the commit has landed, one commit at a time in sequence order, and
 * the `watch` it offers. Publishing never waits.
 * @returns A set of watchers, empty to begin with.
 */
export const makeWatchers = () => {
  const watchers = new Set<Watcher>();

  const publish = (entries: readonly Entry[]) => {
    for (const watcher of watchers) {
      for (const entry of entries) {
        offerTo(watcher, entry);
      }
    }
  };

  const watch: Committed["Service"]["watch"] = (options) =>
    Effect.flatMap(parseCapacity(options?.capacity), (capacity) =>
      Effect.acquireRelease(
        Effect.map(Queue.unbounded<Entry | Missed, Cause.Done>(), (queue): Watcher => {
          const watcher: Watcher = { capacity, missed: undefined, queue };

          watchers.add(watcher);

          return watcher;
        }),
        (watcher) =>
          Effect.suspend(() => {
            watchers.delete(watcher);

            return Queue.end(watcher.queue);
          })
      ).pipe(
        Effect.map((watcher) =>
          Stream.fromQueue(watcher.queue).pipe(
            Stream.map((item) => (isMissed(item) ? takeMissed(watcher, item) : item))
          )
        )
      )
    );

  return { publish, watch };
};

/**
 * Appends Entries before anything acts on them, which keeps `session` ignorant of
 * how they are stored. `record` appends atomically and runs `within` synchronously
 * in the same transaction, then returns its result after commit. If `within`
 * throws, the whole transaction rolls back and `record` dies. Recording nothing is
 * not a thing, so whoever holds what was recorded holds at least one Entry.
 *
 * `standing` reads a Network's {@link Standing} as of the last commit. It updates in the
 * same transaction as the Entries and is published only after commit, so a rollback
 * leaves nothing behind, and a host holds no copy of its own.
 */
export class Recorder extends Context.Service<
  Recorder,
  {
    readonly record: <A>(
      entries: Arr.NonEmptyReadonlyArray<NewEntry>,
      within: (recorded: Arr.NonEmptyReadonlyArray<Entry>) => A
    ) => Effect.Effect<A, RecordFailed>;
    readonly standing: (network: NetworkId) => Effect.Effect<Standing, RecordFailed>;
  }
>()("@iirc/session/Recorder") {
  /** {@link Recorder.memory}, plus {@link MemoryEntries} to read what it kept. */
  static readonly memoryReadable: Layer.Layer<Committed | MemoryEntries | Recorder> =
    Layer.syncContext(() => {
      const log: Entry[] = [];
      let standings = noStandings;
      const { publish, watch } = makeWatchers();

      return Context.make(MemoryEntries, { entries: Effect.sync(() => [...log]) }).pipe(
        Context.add(Committed, { watch }),
        Context.add(Recorder, {
          record: (entries, within) =>
            Effect.clockWith((clock) =>
              Effect.sync(() => {
                const at = clock.currentTimeMillisUnsafe();

                const recorded = pipe(
                  entries,
                  Arr.map((entry, index): Entry => ({
                    ...entry,
                    at,
                    sequence: log.length + index + 1,
                  }))
                );

                // Committing only after `within` returns is what rolls a throw back.
                const result = within(recorded);

                // Not a spread: one read can hold more Lines than a call has arguments.
                for (const entry of recorded) {
                  log.push(entry);
                }

                standings = foldStandings(standings, recorded);
                publish(recorded);

                return result;
              })
            ),
          standing: (network) => Effect.sync(() => standings.get(network) ?? noStanding),
        })
      );
    });

  /**
   * Keeps Entries in memory, for library users who want no storage, and offers
   * {@link Committed} to watch them as they commit.
   */
  static readonly memory: Layer.Layer<Committed | Recorder> = this.memoryReadable;
}
