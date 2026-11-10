/**
 * The Timeline store port: where the fold's changes are kept, and what Frontends read
 * Timelines from. It is derived, so it can be emptied and rebuilt from the Journal at any
 * time.
 *
 * @packageDocumentation
 */
import type { Change, Content, Descriptor, Directory, Position, TimelineId } from "@iirc/timelines";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

/** One step's changes, the sequence they were folded through, and the directory after it. */
export interface Applied {
  readonly changes: readonly Change[];
  readonly through: number;
  readonly directory: Directory;
}

/**
 * How far the store has folded: the last sequence, and the projection version it was built
 * with. A freshly made store has neither. `reset` sets only the version, so a store reset and
 * not yet applied to has a version and no sequence.
 */
export interface Folded {
  readonly version: number | undefined;
  readonly through: number | undefined;
}

/** A Timeline as a store holds it, with its latest item's position and the last sequence that changed it. */
export interface Summary extends Descriptor {
  /** The position of its last item, or `undefined` while it has none. */
  readonly latest: Position | undefined;
  /** The last sequence that changed it or any of its items. */
  readonly changed: number;
}

/** One item, as it stands now. */
export interface Item {
  readonly network: string;
  readonly timeline: TimelineId;
  readonly position: Position;
  readonly content: Content;
  /** The last sequence that changed it: added, confirmed, marked unsent, or moved. */
  readonly changed: number;
}

/** A Timeline merged into another, and where it went. It always names a Timeline that exists. */
export interface Tombstone {
  readonly network: string;
  readonly id: TimelineId;
  readonly into: TimelineId;
  readonly changed: number;
}

/** A Gap, from where it began to where it ended, or `undefined` while it goes on. */
export interface Gap {
  readonly network: string;
  readonly from: Position;
  readonly to: Position | undefined;
  readonly changed: number;
}

/**
 * Which items a window reads:
 *
 * - `Before`: the last `limit` before `position`, or the last of all when it is left out.
 * - `After`: the first `limit` after `position`, or the first of all when it is left out.
 * - `Around`: up to `limit` about `position`: as many from it on as before it, and more
 *   from whichever side has them when the other runs out.
 */
export type Anchor =
  | { readonly _tag: "Before"; readonly position?: Position | undefined }
  | { readonly _tag: "After"; readonly position?: Position | undefined }
  | { readonly _tag: "Around"; readonly position: Position };

/** A window's items in position order, and whether more lie beyond each end. */
export interface Window {
  /** The Timeline read, which is the one a merged id went to. */
  readonly timeline: TimelineId;
  readonly items: readonly Item[];
  readonly earlier: boolean;
  readonly later: boolean;
}

/**
 * What changed after a sequence, as it stands now. Each list is ordered by `changed`, and
 * among what changed in one sequence:
 *
 * - `timelines` and `merged` by Timeline id, which a tombstone's is the merged one's.
 * - `items` by their Timeline's id, then by position.
 * - `gaps` by Network id, compared by code point, then by where they began.
 *
 * Each order is total, so every adapter gives the same lists. Each sequence is given whole.
 * A reader resumes after `through`.
 */
export interface Changed {
  readonly timelines: readonly Summary[];
  readonly items: readonly Item[];
  readonly merged: readonly Tombstone[];
  readonly gaps: readonly Gap[];
  /** Everything changed through this sequence has been given. */
  readonly through: number | undefined;
  /** Whether more changed after `through`. */
  readonly more: boolean;
}

/** The store could not be written or read. */
export class TimelineStoreFailed extends Schema.TaggedError<
  TimelineStoreFailed,
  { readonly brand: unique symbol }
>()("TimelineStoreFailed", { reason: Schema.String }) {}

/** What a Timeline store adapter provides. */
export interface TimelineStoreService {
  /**
   * Applies one step's changes, and records `through` and the directory, whole or not
   * at all. A step at or before the last one folded changes nothing.
   */
  readonly apply: (applied: Applied) => Effect.Effect<void, TimelineStoreFailed>;
  /** How far it has folded, and with which projection version. */
  readonly folded: Effect.Effect<Folded, TimelineStoreFailed>;
  /** The directory as of the last step folded, to restore the fold without folding again. */
  readonly directory: Effect.Effect<Directory, TimelineStoreFailed>;
  /**
   * Every Timeline of a Network, merged ones aside, in the order they were opened, which is
   * by id.
   */
  readonly timelines: (network: string) => Effect.Effect<readonly Summary[], TimelineStoreFailed>;
  /** A window of a Timeline's items, following a merged id to where it went. */
  readonly window: (
    timeline: TimelineId,
    anchor: Anchor,
    limit: number
  ) => Effect.Effect<Option.Option<Window>, TimelineStoreFailed>;
  /** The items a step made, in position order, and at one position by Timeline id. */
  readonly locate: (
    network: string,
    sequence: number
  ) => Effect.Effect<readonly Item[], TimelineStoreFailed>;
  /**
   * A Network's Gaps that overlap a range of positions, either end of which may be open, in
   * the order they began.
   */
  readonly gaps: (
    network: string,
    range: { readonly from?: Position | undefined; readonly to?: Position | undefined }
  ) => Effect.Effect<readonly Gap[], TimelineStoreFailed>;
  /**
   * The Timelines, items, tombstones, and Gaps changed after a sequence, as they stand now,
   * each list ordered by `changed` and then as {@link Changed} says. With a limit, whole
   * sequences are given until at least `limit` things have been.
   */
  readonly changedAfter: (
    after: number | undefined,
    limit?: number
  ) => Effect.Effect<Changed, TimelineStoreFailed>;
  /** Empties the store, to be folded again from the start by a projection version. */
  readonly reset: (version: number) => Effect.Effect<void, TimelineStoreFailed>;
}

/** The Timeline store port. */
export class TimelineStore extends Context.Service<TimelineStore, TimelineStoreService>()(
  "@iirc/timeline-store/TimelineStore"
) {}
