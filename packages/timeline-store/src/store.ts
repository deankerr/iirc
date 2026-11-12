/**
 * The Timeline store port: where the fold's changes are kept, and what Frontends read
 * Timelines from. It is derived, so it can be emptied and rebuilt from the Journal at any
 * time.
 *
 * @packageDocumentation
 */
import type { Instant } from "@iirc/client";
import type {
  Change,
  Content,
  Descriptor,
  Directory,
  Level,
  Position,
  SearchText,
  TimelineId,
} from "@iirc/timelines";
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

/**
 * How many items of each level stand after a Timeline's Read Marker, or in it at all when
 * it has none, each at most `unreadCap + 1` from `@iirc/timelines`, which means more than
 * `unreadCap`.
 */
export interface Unread {
  readonly highlights: number;
  readonly direct: number;
  readonly messages: number;
  readonly activity: number;
}

/** Which count of {@link Unread} each level is counted in. */
export const unreadOf = {
  Activity: "activity",
  Direct: "direct",
  Highlight: "highlights",
  Message: "messages",
} as const satisfies { readonly [L in Level]: keyof Unread };

/** No items unread. */
export const noneUnread: Unread = { activity: 0, direct: 0, highlights: 0, messages: 0 };

/**
 * A Timeline as a store holds it, with its latest item's position, its Read Marker, what
 * stands after it, when its head last changed, and the last sequence that changed it.
 */
export interface Summary extends Descriptor {
  /** The position of its last item, or `undefined` while it has none. */
  readonly latest: Position | undefined;
  /** How far the Owner has read it, or `undefined` before any Read Marker. */
  readonly read: Instant | undefined;
  /** How many items of each level stand after `read`, capped. */
  readonly unread: Unread;
  /**
   * The last sequence that changed what the Client knows of its Channel in a way no item
   * says, as `HeadChanged` reports, or `undefined` while none has.
   */
  readonly head: number | undefined;
  /** The last sequence that changed it, its Read Marker, its head, or any of its items. */
  readonly changed: number;
}

/** One item, as it stands now. */
export interface Item {
  readonly network: string;
  readonly timeline: TimelineId;
  readonly position: Position;
  readonly content: Content;
  /** How much it calls for the Owner, or `undefined` for a Message Self said. */
  readonly level: Level | undefined;
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
  /** The Network the Timeline is one of. */
  readonly network: string;
  readonly items: readonly Item[];
  readonly earlier: boolean;
  readonly later: boolean;
}

/**
 * A step that changed more than a page holds, given without what it changed: its sequence,
 * and the ids of the Timelines it touched or merged, in id order, or `undefined` when even
 * they are more than the page holds, which says to read everything again.
 */
export interface Overflowed {
  readonly sequence: number;
  readonly timelines: readonly TimelineId[] | undefined;
}

/**
 * What changed after a sequence, as it stands now. Each list is ordered by `changed`, and
 * among what changed in one sequence:
 *
 * - `timelines` and `merged` by Timeline id, which a tombstone's is the merged one's.
 * - `items` by their Timeline's id, then by position.
 * - `gaps` by Network id, compared by code point, then by where they began.
 *
 * Each order is total, so every adapter gives the same lists. Each sequence is given whole,
 * or, when it alone is more than the page holds, as `overflowed` with every list empty.
 * A reader resumes after `through`.
 */
export interface Changed {
  readonly timelines: readonly Summary[];
  readonly items: readonly Item[];
  readonly merged: readonly Tombstone[];
  readonly gaps: readonly Gap[];
  /** The one step this page gives, when it changed more than the page holds. */
  readonly overflowed: Overflowed | undefined;
  /** Everything changed through this sequence has been given. */
  readonly through: number | undefined;
  /** Whether more changed after `through`. */
  readonly more: boolean;
}

/**
 * Consecutive Gaps of a Network with no item of the Timeline read between them, as one:
 * from where the first began to where the last ended, or `undefined` while it goes on, and
 * how many there were.
 */
export interface CollapsedGap {
  readonly from: Position;
  readonly to: Position | undefined;
  readonly count: number;
}

/**
 * Reads made against one state of the store, with the last sequence folded into that state
 * and the projection version it was folded by.
 */
export interface Consistent<A> {
  readonly value: A;
  /** The last sequence folded when the reads were made, or `undefined` before any was. */
  readonly through: number | undefined;
  /** The projection version the state was folded by, or `undefined` for a store never reset. */
  readonly version: number | undefined;
}

/** Where an item stands, and in which Timeline: what a page of items resumes after. */
export interface ItemPlace {
  readonly position: Position;
  readonly timeline: TimelineId;
}

/**
 * A search of the Messages in Timelines, newest first: by position, latest first, and at
 * one position by Timeline id, last first.
 */
export interface Search {
  /** What a Message's text holds, compared folded by `foldForSearch`. */
  readonly text: SearchText;
  /** Only this Network's. */
  readonly network?: string | undefined;
  /** Only this Timeline's, or, for a merged id, the Timeline it went to. */
  readonly timeline?: TimelineId | undefined;
  /** Only those said by this nick, compared folded by `foldForSearch`. */
  readonly from?: string | undefined;
  /** Only those whose position's time is at or after this instant. */
  readonly since?: Instant | undefined;
  /** Only those whose position's time is before this instant. */
  readonly until?: Instant | undefined;
  /** Only those after this item, in the order given: where the page before ended. */
  readonly after?: ItemPlace | undefined;
  /** The most to give. */
  readonly limit: number;
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
   * A Network's Timelines, merged ones aside, in the order they were opened, which is by id:
   * those after `after`, up to `limit` of them, or every one without a page.
   */
  readonly timelines: (
    network: string,
    page?: { readonly after?: TimelineId | undefined; readonly limit?: number | undefined }
  ) => Effect.Effect<readonly Summary[], TimelineStoreFailed>;
  /**
   * One Timeline, following a merged id to the Timeline it went to, or `None` when no
   * Timeline ever had the id.
   */
  readonly timeline: (
    timeline: TimelineId
  ) => Effect.Effect<Option.Option<Summary>, TimelineStoreFailed>;
  /** A window of a Timeline's items, following a merged id to where it went. */
  readonly window: (
    timeline: TimelineId,
    anchor: Anchor,
    limit: number
  ) => Effect.Effect<Option.Option<Window>, TimelineStoreFailed>;
  /**
   * The items a step made, in position order, and at one position by Timeline id: those
   * after the item `after` names in that order, up to `limit`, or every one without a page.
   */
  readonly locate: (
    network: string,
    sequence: number,
    page?: {
      readonly after?: { readonly position: Position; readonly timeline: TimelineId } | undefined;
      readonly limit?: number | undefined;
    }
  ) => Effect.Effect<readonly Item[], TimelineStoreFailed>;
  /**
   * The Messages whose text holds the search's text, folded, newest first, with its
   * filters, up to its limit, after the item it names.
   */
  readonly search: (search: Search) => Effect.Effect<readonly Item[], TimelineStoreFailed>;
  /**
   * A Network's Gaps that overlap a range of positions, either end of which may be open, in
   * the order they began. A Network's Gaps do not overlap, except that one may begin exactly
   * where the one before it ended, so of those that began before `from`, only the last can
   * reach it, and every one that began at or after `from` is in.
   */
  readonly gaps: (
    network: string,
    range: { readonly from?: Position | undefined; readonly to?: Position | undefined }
  ) => Effect.Effect<readonly Gap[], TimelineStoreFailed>;
  /**
   * A Network's Gaps that overlap a range, split at each of a Timeline's item positions,
   * `at`, in order, and each run between two of them collapsed into one, so there are at
   * most one more than there are positions. A run is the Gaps that began after one
   * position and at or before the next, the first run those that began at or before the
   * first, and the last those that began after the last. A run with none is left out.
   *
   * A page read at a cursor fits against the window that holds the cursor's item, which
   * keeps every Gap that reaches that item. So `beganAfter` keeps only the Gaps that began
   * after it, for a page read after a cursor, and `endedBefore` only those that ended before
   * it, for a page read before one: a Gap that reaches the cursor is the other side's.
   */
  readonly collapsedGaps: (
    network: string,
    range: {
      readonly from?: Position | undefined;
      readonly to?: Position | undefined;
      readonly at: readonly Position[];
      readonly beganAfter?: Position | undefined;
      readonly endedBefore?: Position | undefined;
    }
  ) => Effect.Effect<readonly CollapsedGap[], TimelineStoreFailed>;
  /**
   * The Timelines, items, tombstones, and Gaps changed after a sequence, as they stand now,
   * each list ordered by `changed` and then as {@link Changed} says. With a limit, whole
   * sequences are given while they come to at most `limit` things together, and a first
   * sequence that alone is more is given as `overflowed`, so a page never holds more than
   * `limit` things, and is found without reading more than that. Without one, everything.
   */
  readonly changedAfter: (
    after: number | undefined,
    limit?: number
  ) => Effect.Effect<Changed, TimelineStoreFailed>;
  /**
   * Runs reads of this store against one state of it, which no `apply` or `reset` changes
   * while they run, and gives what they read with the last sequence folded into that state,
   * and the projection version it was folded by. A reader that follows `changedAfter` from
   * that `through` misses nothing the reads did not show. It is for this store's own reads:
   * a write inside it waits on itself.
   */
  readonly consistent: <A>(
    reads: Effect.Effect<A, TimelineStoreFailed>
  ) => Effect.Effect<Consistent<A>, TimelineStoreFailed>;
  /** Empties the store, to be folded again from the start by a projection version. */
  readonly reset: (version: number) => Effect.Effect<void, TimelineStoreFailed>;
}

/** The Timeline store port. */
export class TimelineStore extends Context.Service<TimelineStore, TimelineStoreService>()(
  "@iirc/timeline-store/TimelineStore"
) {}
