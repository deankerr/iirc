import { Array as Arr, Effect } from "effect";

import type { NewEntry } from "./entry.ts";
import type { RecordFailed } from "./recorder.ts";

/** What the close of a Connection records, in this order, before its `closed`. */
interface Owed {
  /** Lines read that the Log would not take when they came (LOG-4, LOG-9). */
  readonly unrecorded: readonly NewEntry[];
  /**
   * Lines never sent, then Lines recorded as outbound whose write did not complete, each
   * as a Dropped Entry (OBS-1, LOG-2).
   */
  readonly dropped: readonly NewEntry[];
}

/**
 * The Entries a Connection owes the Log and has not recorded yet. Each kind waits for its
 * own moment: what was Dropped while the lanes are open goes with the next flush, one
 * commit for a batch, so that a flood costs no commit for each, and the rest waits for the
 * close, which records everything still owed.
 */
export interface Pending {
  /** A Line that will not be sent, as its Dropped Entry. */
  readonly dropped: (entry: NewEntry) => void;
  /** A Line recorded as outbound whose write did not complete, as its Dropped Entry. */
  readonly unwritten: (entry: NewEntry) => void;
  /** Lines read that the Log would not take. Only the close records them. */
  readonly unrecorded: (entries: readonly NewEntry[]) => void;
  /**
   * Records what was Dropped so far, in one commit. If the Log refuses, the batch is owed
   * again, ahead of anything Dropped while it was tried.
   */
  readonly flush: (
    commit: (batch: Arr.NonEmptyReadonlyArray<NewEntry>) => Effect.Effect<unknown, RecordFailed>
  ) => Effect.Effect<void, RecordFailed>;
  /** Takes the Lines read and not recorded, which the close records first. */
  readonly takeUnrecorded: () => readonly NewEntry[];
  /** Takes everything still owed, which leaves nothing. */
  readonly takeAll: () => Owed;
}

/**
 * Starts the bookkeeping for one Connection. It never waits and never fails, so any fiber
 * of the Connection may tell it something, and only the one that flushes or closes takes.
 * @returns The bookkeeping, owing nothing.
 */
export const makePending = (): Pending => {
  let dropped: NewEntry[] = [];
  let unrecorded: NewEntry[] = [];
  let unwritten: NewEntry[] = [];

  return {
    dropped: (entry) => {
      dropped.push(entry);
    },
    flush: (commit) =>
      Effect.suspend(() => {
        if (!Arr.isReadonlyArrayNonEmpty(dropped)) {
          return Effect.void;
        }

        const batch = dropped;

        dropped = [];

        return Effect.asVoid(commit(batch)).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              dropped = [...batch, ...dropped];
            })
          )
        );
      }),
    takeAll: () => {
      const owed = { dropped: [...dropped, ...unwritten], unrecorded };

      dropped = [];
      unrecorded = [];
      unwritten = [];

      return owed;
    },
    takeUnrecorded: () => {
      const taken = unrecorded;

      unrecorded = [];

      return taken;
    },
    unrecorded: (entries) => {
      unrecorded = [...unrecorded, ...entries];
    },
    unwritten: (entry) => {
      unwritten.push(entry);
    },
  };
};
