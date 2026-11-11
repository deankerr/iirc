/**
 * The Timelines a Frontend shows, as a reducer over what it read and what the changes
 * stream said. It holds each Network's Timelines, a window of each Timeline opened, and how
 * each Network's connection stands, and it says which reads the runtime should make next.
 * It never folds News: the Daemon does that, and this only keeps what it read up to date.
 *
 * @packageDocumentation
 */
import type {
  EndReason,
  Gap,
  NetworkEntry,
  NetworkId,
  NetworkStatus,
  SessionKnowledge,
  Timeline,
  TimelineChange,
  TimelineId,
  TimelineItem,
  TimelineList,
  TimelineOverflow,
  TimelineReset,
  TimelineWindow,
  UserKnowledge,
  WindowGap,
} from "@iirc/api";
import { comparePositions, cursorOf, TimelineId as TimelineIdSchema } from "@iirc/timelines";
import type { Position } from "@iirc/timelines";
import { Option, Schema } from "effect";

import {
  deepestSplits,
  focusedPane,
  keeping,
  layoutFrom,
  mapViews,
  panesOf,
  reduceLayout,
  single,
  withView,
} from "./layout.ts";
import type { Axis, Layout, LayoutChange, Node } from "./layout.ts";

/** Where the changes stream stands: the projection version, and the last step it gave. */
export interface Place {
  readonly version: number;
  readonly sequence: number;
}

/**
 * Something read from the Daemon: whether what is held is current, whether a read is in
 * flight, and how many reads in a row came back too old to use, for the runtime to wait
 * longer before the next.
 */
interface Load {
  readonly fresh: boolean;
  readonly reading: boolean;
  readonly attempt: number;
}

/** A Network's list of Timelines, read a page at a time. */
interface ListLoad extends Load {
  /** The Timeline the next page follows, while a round of pages is not finished. */
  readonly next: TimelineId | undefined;
  /** The smallest `through` the pages of this round gave. */
  readonly through: number | undefined;
}

/** Whether `known` was read for a Network's connection. */
interface StatusLoad extends Load {
  /** The changes stream's place when the read started: `known` reflects every step up to it. */
  readonly from: number;
}

/**
 * How a Network's connection stands, from `known` once and then from the Session items the
 * changes carry.
 *
 * - `Unknown`: not yet read.
 * - `Connecting`: dialling or registering, as `known` said.
 * - `Connected`: in a Session, since it began, with Self's nick when a `SessionBegan` said it.
 * - `Offline`: no Session, since when and why, when an item said so.
 */
export type Connection =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Connecting"; readonly since: number }
  | { readonly _tag: "Connected"; readonly since: number; readonly nick: string | undefined }
  | {
      readonly _tag: "Offline";
      readonly since: number | undefined;
      readonly reason: EndReason | undefined;
    };

/**
 * Whether Self is away on a Network, as the Ircd confirmed it, from `known`: `Unknown`
 * before it is read or with no Session, `Here`, or `Away` with the message the Ircd
 * confirmed. A Session begins with Self here, and an `AwayChanged` in the Network's own
 * Timeline, where Self's belong, has `known` read again.
 */
export type SelfAway =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Here" }
  | { readonly _tag: "Away"; readonly message: string };

/** One Network as the Frontend holds it. */
export interface NetworkView {
  readonly network: NetworkId;
  /** Whether the Daemon runs it, as `GET /api/networks` said, until it is read. */
  readonly running: NetworkStatus | undefined;
  readonly connection: Connection;
  /** The sequence of the last Session item that set `connection`, or `known`'s place. */
  readonly connectionAt: number;
  /** Whether Self is away, as `known` last said, or a Session item since. */
  readonly away: SelfAway;
  /** The sequence of the last `AwayChanged` in the Network's own Timeline, which `known` is read again for. */
  readonly awayAt: number;
  readonly timelines: ReadonlyMap<TimelineId, Timeline>;
  readonly list: ListLoad;
  readonly status: StatusLoad;
}

/**
 * A window of one Timeline: its items in position order, its collapsed Gaps, and whether
 * more lie beyond each end. It reflects every step up to `through`, and the changes after.
 * A window that is not `fresh` missed something, keeps what it showed, ignores the changes
 * until it is read again, and is read again the next time it is open.
 */
export interface Window extends Load {
  readonly timeline: TimelineId;
  /**
   * Which window of the Timeline this is: a window dropped and read again is another, and a
   * read started for one is never taken into the other.
   */
  readonly generation: number;
  /** Its Network, once it was read. */
  readonly network: NetworkId | undefined;
  readonly items: readonly TimelineItem[];
  readonly gaps: readonly WindowGap[];
  readonly earlier: boolean;
  readonly later: boolean;
  readonly through: number;
  /** The Owner asked for what lies before the first item. */
  readonly older: boolean;
  /** The Owner asked for what lies after the last item. */
  readonly newer: boolean;
  /**
   * The Owner is at the latest, so a live item past the end is kept, and the oldest go
   * past the cap. When not, one is left for reading after the end, and `later` says so.
   */
  readonly following: boolean;
  /**
   * The last item the view said is in view while it is at the latest, or none until it says
   * so. Only the view knows what was shown: opening a Timeline never sets it.
   */
  readonly seen: Position | undefined;
}

/** What the changes stream gave, kept while reads are in flight, to bring them up to date. */
type Recorded =
  | { readonly _tag: "Changed"; readonly change: TimelineChange }
  | { readonly _tag: "Overflowed"; readonly overflow: TimelineOverflow };

/**
 * Whether the changes stream is followed yet.
 *
 * - `Waiting`: the first reads are not all in. `version` is the projection version they
 *   were read at.
 * - `Following`: from `place`, or from the start of the version when nothing was read to
 *   follow from. `recent` holds what the stream gave after `recentFrom` while any read was
 *   in flight, so a read that lands after the stream passed it is brought up to date.
 */
type Follow =
  | { readonly _tag: "Waiting"; readonly version: number | undefined }
  | {
      readonly _tag: "Following";
      readonly place: Place | undefined;
      readonly recent: readonly Recorded[];
      readonly recentFrom: number;
    };

/**
 * What a Pane shows: its open Timeline, or the options with what filters them. Opening a
 * Timeline, a placement included, shows it, and only showing the options leaves it.
 */
export type MainView =
  | { readonly _tag: "Timeline" }
  | { readonly _tag: "Options"; readonly filter: string };

/**
 * Where the "new" divider goes in an open Timeline: before the first item after `read`,
 * the Read Marker the Timeline had when it opened with something unread, or before the
 * first item held when it had none. It stays while the Timeline stays open, so it does not
 * move as the Daemon's Read Marker does.
 */
export interface Divider {
  readonly timeline: TimelineId;
  readonly read: Timeline["read"];
}

/**
 * What one Pane shows: its open Timeline, if any, as the Owner chose it, with its "new"
 * divider, and whether the Timeline or the options show in its place. A Timeline is open in
 * one Pane at most, so its window, where the Owner scrolled, and its divider are that Pane's.
 */
export interface PaneView {
  readonly main: MainView;
  readonly open: TimelineId | undefined;
  readonly divider: Divider | undefined;
}

/** A Pane with no Timeline open. */
export const emptyView: PaneView = {
  divider: undefined,
  main: { _tag: "Timeline" },
  open: undefined,
};

/** Everything the Frontend holds of the Timelines. */
export interface Timelines {
  /** The Panes, each showing a Timeline or the options, and the one with the focus. */
  readonly layout: Layout<PaneView>;
  /**
   * A layout this device kept, set aside until every Network's Timelines are read, so a Pane
   * whose Timeline no longer exists is dropped, and let go if the Owner went elsewhere first.
   */
  readonly restoring: Layout<PaneView> | undefined;
  /**
   * The highest step the stream gave that was considered for notifications, kept for the
   * page's life, through resets and overflows, so no step notifies twice. It is a Journal
   * sequence, which every projection version shares, and apart from the stream's place.
   */
  readonly considered: number;
  readonly follow: Follow;
  /** `GET /api/networks`, with the stream's place when it was read. */
  readonly entries: StatusLoad;
  readonly networks: ReadonlyMap<NetworkId, NetworkView>;
  /** Windows by the id of the Timeline they show. */
  readonly windows: ReadonlyMap<TimelineId, Window>;
  /** Each Timeline merged into another, and the one it went to. */
  readonly merged: ReadonlyMap<TimelineId, TimelineId>;
  /** Timelines the Daemon said it never had. */
  readonly vanished: ReadonlySet<TimelineId>;
  /** The Timelines closed most recently, latest first, whose windows are kept. */
  readonly closed: readonly TimelineId[];
  /**
   * The Timeline the Daemon placed a Message the Owner said in, to open once its Network
   * lists it, if it is a Direct Message Timeline.
   */
  readonly located: TimelineId | undefined;
  /**
   * How many times the Owner opened a Timeline, showed the options, or moved to another
   * Pane. A placement captures it when its Say is submitted, and one from before the Owner
   * went elsewhere is ignored.
   */
  readonly navigation: number;
  /** The most items a window holds. */
  readonly windowCap: number;
  /** How many windows of closed Timelines are kept. */
  readonly kept: number;
  /** The generation the next window made gets. */
  readonly nextGeneration: number;
}

/** How many items a window is read with, and the most a read again keeps. */
export const pageSize = 100;
const largestPage = 500;

/** The most items a window holds: past it, the end furthest from the Owner is dropped. */
export const windowCap = 1000;

/** How many windows of closed Timelines are kept, besides those open in a Pane. */
export const keptClosed = 4;

/** How many things the stream gave a read in flight may wait for, before it is read again. */
const recentLimit = 5000;

/** A read the runtime should make, with how many in a row came back too old to use. */
export type Read =
  | { readonly _tag: "Networks"; readonly attempt: number }
  | {
      readonly _tag: "List";
      readonly network: NetworkId;
      readonly after: TimelineId | undefined;
      readonly attempt: number;
    }
  | { readonly _tag: "Status"; readonly network: NetworkId; readonly attempt: number }
  | WindowRequest;

/**
 * A read of a window: the latest, before its first item, or after its last, for one
 * generation of it. Its answer names it, so an answer for a window since dropped, or whose
 * edge has moved, is told apart.
 */
export type WindowRequest =
  | {
      readonly _tag: "Latest";
      readonly timeline: TimelineId;
      readonly generation: number;
      readonly limit: number;
      readonly attempt: number;
    }
  | {
      readonly _tag: "Older";
      readonly timeline: TimelineId;
      readonly generation: number;
      readonly before: Position;
      readonly limit: number;
      readonly attempt: number;
    }
  | {
      readonly _tag: "Newer";
      readonly timeline: TimelineId;
      readonly generation: number;
      readonly after: Position;
      readonly limit: number;
      readonly attempt: number;
    };

/**
 * What happened, in the order it happened.
 *
 * - `ReadStarted`: the runtime took on a read {@link wanted} gave, so it is not asked for
 *   twice. It may wait before asking, as a read asked for again does.
 * - `Requesting`: the runtime is asking the Daemon now, after any wait, and again for each
 *   attempt after a failure: where the stream is then is where the answer is current from.
 * - `NetworksRead`, `ListRead`, `StatusRead`, `WindowRead`: what a read answered.
 * - `Vanished`: a window's read was `UnknownTimeline`. `NetworkVanished`: `UnknownNetwork`.
 * - `Changed`, `Overflowed`, `Reset`: the changes stream's events, with the place each left.
 * - `Located`: the Daemon placed a Message the Owner said, as `/msg` does, in this Timeline,
 *   with the `navigation` its Say was submitted at, ignored once the Owner opened another,
 *   which opens once its Network lists it, if it is a Direct Message Timeline.
 * - `Opened`: the Owner opened a Timeline, which the main view then shows. `OlderWanted` and
 *   `NewerWanted`: they want what lies before or after what is held. `Following`: whether
 *   they are at the latest.
 * - `OptionsShown`: the focused Pane shows the options, filtered as given, which counts as
 *   going elsewhere. `OptionsFiltered`: the Owner typed in their filter.
 * - `Pane`: the Owner changed the Panes, as a command or a drag of a divider did.
 * - `Restore`: the layout this device kept, read as the page starts.
 */
export type TimelinesEvent =
  | { readonly _tag: "ReadStarted"; readonly read: Read }
  | { readonly _tag: "Requesting"; readonly read: Read }
  | { readonly _tag: "NetworksRead"; readonly entries: readonly NetworkEntry[] }
  | {
      readonly _tag: "ListRead";
      readonly network: NetworkId;
      readonly after: TimelineId | undefined;
      readonly page: TimelineList;
    }
  | {
      readonly _tag: "StatusRead";
      readonly network: NetworkId;
      readonly session: SessionKnowledge;
      readonly self: UserKnowledge | null;
    }
  | {
      readonly _tag: "WindowRead";
      readonly read: WindowRequest;
      readonly window: TimelineWindow;
    }
  | { readonly _tag: "Vanished"; readonly timeline: TimelineId }
  | { readonly _tag: "NetworkVanished"; readonly network: NetworkId }
  | { readonly _tag: "Changed"; readonly place: Place; readonly change: TimelineChange }
  | { readonly _tag: "Overflowed"; readonly place: Place; readonly overflow: TimelineOverflow }
  | { readonly _tag: "Reset"; readonly reset: TimelineReset }
  | { readonly _tag: "Opened"; readonly timeline: TimelineId }
  | { readonly _tag: "Located"; readonly timeline: TimelineId; readonly navigation: number }
  | { readonly _tag: "OlderWanted"; readonly timeline: TimelineId }
  | { readonly _tag: "NewerWanted"; readonly timeline: TimelineId }
  | {
      readonly _tag: "Following";
      readonly timeline: TimelineId;
      readonly following: boolean;
      readonly seen: Position | undefined;
    }
  | { readonly _tag: "OptionsShown"; readonly filter: string }
  | { readonly _tag: "OptionsFiltered"; readonly filter: string }
  | { readonly _tag: "Pane"; readonly change: PaneChange }
  | { readonly _tag: "Restore"; readonly layout: Layout<PaneView> };

/**
 * A change to the Panes. A layout's own, but a split names the Timeline the new Pane
 * opens, or none for an empty one, rather than a view.
 */
export type PaneChange =
  | Exclude<LayoutChange<PaneView>, { readonly _tag: "Split" }>
  | { readonly _tag: "Split"; readonly axis: Axis; readonly timeline: TimelineId | undefined };

const unread: Load = { attempt: 0, fresh: false, reading: false };
const unreadList: ListLoad = { ...unread, next: undefined, through: undefined };
const unreadStatus: StatusLoad = { ...unread, from: 0 };

/**
 * Before anything is read, with windows of at most `cap` items, and `kept` windows of closed
 * Timelines.
 * @param cap - The most items a window holds.
 * @param kept - How many windows of closed Timelines are kept.
 * @returns The state.
 */
export const timelinesWith = (cap: number, kept = keptClosed): Timelines => ({
  closed: [],
  considered: 0,
  entries: unreadStatus,
  follow: { _tag: "Waiting", version: undefined },
  kept,
  layout: single(emptyView),
  located: undefined,
  merged: new Map(),
  navigation: 0,
  networks: new Map(),
  nextGeneration: 0,
  restoring: undefined,
  vanished: new Set(),
  windowCap: cap,
  windows: new Map(),
});

/** Before anything is read. */
export const initialTimelines: Timelines = timelinesWith(windowCap);

const newNetwork = (network: NetworkId): NetworkView => ({
  away: { _tag: "Unknown" },
  awayAt: 0,
  connection: { _tag: "Unknown" },
  connectionAt: 0,
  list: unreadList,
  network,
  running: undefined,
  status: unreadStatus,
  timelines: new Map(),
});

/**
 * A copy of a map with one entry set.
 * @param map - The map.
 * @param key - The key.
 * @param value - The value.
 * @returns The copy.
 */
const setIn = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  new Map(map).set(key, value);

/**
 * A copy of a map with one entry removed.
 * @param map - The map.
 * @param key - The key.
 * @returns The copy, or the map itself when the key was not there.
 */
const deleteIn = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  if (!map.has(key)) {
    return map;
  }

  const copy = new Map(map);
  copy.delete(key);

  return copy;
};

/**
 * A copy of a map with every value changed.
 * @param map - The map.
 * @param change - What becomes of each value.
 * @returns The copy.
 */
const mapValues = <K, V>(map: ReadonlyMap<K, V>, change: (value: V) => V): ReadonlyMap<K, V> =>
  new Map([...map].map(([key, value]) => [key, change(value)]));

const minOf = (left: number | undefined, right: number): number =>
  left === undefined ? right : Math.min(left, right);

/**
 * The Timeline an id stands for now, following merges.
 * @param state - The state.
 * @param timeline - The id, as the Owner chose it.
 * @returns The id of the Timeline it went to, or itself.
 */
export const resolve = (state: Timelines, timeline: TimelineId): TimelineId => {
  let current = timeline;

  // Merges never form a cycle, and the bound makes sure of it.
  for (let step = 0; step <= state.merged.size; step += 1) {
    const into = state.merged.get(current);

    if (into === undefined) {
      return current;
    }

    current = into;
  }

  return current;
};

/**
 * Whether any read is in flight.
 * @param state - The state.
 * @returns Whether one is.
 */
const inFlight = (state: Timelines): boolean =>
  state.entries.reading ||
  [...state.networks.values()].some((network) => network.list.reading || network.status.reading) ||
  [...state.windows.values()].some((window) => window.reading);

/**
 * The projection version what is held was read at.
 * @param state - The state.
 * @returns The version, or `undefined` before any read said one.
 */
const versionOf = (state: Timelines): number | undefined =>
  state.follow._tag === "Waiting" ? state.follow.version : state.follow.place?.version;

/**
 * Whether a read at `version` and `through` can be brought up to date with what was
 * followed: the same version, and no older than the oldest thing kept for reads in flight.
 * @param state - The state.
 * @param version - The read's version.
 * @param through - The read's `through`.
 * @returns Whether it can be used.
 */
const usable = (state: Timelines, version: number, through: number): boolean => {
  const held = versionOf(state);

  if (held !== undefined && held !== version) {
    return false;
  }

  return state.follow._tag === "Waiting" || through >= state.follow.recentFrom;
};

/**
 * What the stream gave after a read's `through`, to bring the read up to date.
 * @param state - The state.
 * @param through - The read's `through`.
 * @returns What came after it, in order.
 */
const recentAfter = (state: Timelines, through: number): readonly Recorded[] =>
  state.follow._tag === "Following"
    ? state.follow.recent.filter(
        (recorded) =>
          (recorded._tag === "Changed" ? recorded.change.sequence : recorded.overflow.sequence) >
          through
      )
    : [];

// Items and Gaps.

/**
 * Where an item at a position goes among items in position order.
 * @param items - The items.
 * @param position - The position.
 * @returns The index of the item at the position, found, or the index it would go to.
 */
interface Found {
  readonly index: number;
  readonly found: boolean;
}

const search = (items: readonly TimelineItem[], position: Position): Found => {
  let low = 0;
  let high = items.length;

  while (low < high) {
    // oxlint-disable-next-line no-bitwise -- the midpoint of two array indices
    const middle = (low + high) >>> 1;
    const order = comparePositions(items[middle]?.position ?? position, position);

    if (order === 0) {
      return { found: true, index: middle };
    }

    if (order < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return { found: false, index: low };
};

/**
 * Places an item in a window, where it belongs by position: in place of the one at its
 * position when it changed later, between the items loaded, or past an end with nothing
 * more beyond it. Anywhere else it is outside what the window holds. One inside a collapsed
 * Gap of several may split it, so the window is read again.
 * @param window - The window.
 * @param item - The item, as it stands now.
 * @returns The window.
 */
const placeItem = (window: Window, item: TimelineItem): Window => {
  const { found, index } = search(window.items, item.position);

  if (found) {
    const held = window.items[index];

    if (held === undefined || item.changed <= held.changed) {
      return window;
    }

    return { ...window, items: window.items.with(index, item) };
  }

  const beforeFirst = index === 0 && window.earlier;
  const afterLast = index === window.items.length && window.later;

  if (beforeFirst || afterLast) {
    return window;
  }

  // Late history inside a collapsed Gap of several may split it, and where is not known.
  const splits = window.gaps.some(
    (gap) =>
      gap.count > 1 &&
      comparePositions(gap.from, item.position) < 0 &&
      (gap.to === null || comparePositions(item.position, gap.to) < 0)
  );

  return {
    ...window,
    fresh: window.fresh && !splits,
    items: window.items.toSpliced(index, 0, item),
  };
};

/**
 * Keeps a window within the cap by dropping the end furthest from the Owner, and saying
 * that more lies beyond it, so what was dropped can be read again: the oldest, with their
 * Gaps that ended before the first item kept, or the newest, with the Gaps that began after
 * the last item kept.
 * @param window - The window.
 * @param cap - The most items it holds.
 * @param keepNewest - Whether the newest are kept, as when the Owner is at the latest.
 * @returns The window.
 */
const trim = (window: Window, cap: number, keepNewest: boolean): Window => {
  if (window.items.length <= cap) {
    return window;
  }

  if (keepNewest) {
    const items = window.items.slice(-cap);
    const [first] = items;

    // A collapsed Gap of several that reaches the first item kept from before it may hold
    // Gaps that ended before it, and which is not known, so the window is read again.
    const cut =
      first !== undefined &&
      window.gaps.some(
        (gap) =>
          gap.count > 1 &&
          comparePositions(gap.from, first.position) < 0 &&
          (gap.to === null || comparePositions(gap.to, first.position) >= 0)
      );

    return {
      ...window,
      earlier: true,
      fresh: window.fresh && !cut,
      gaps: window.gaps.filter(
        (gap) =>
          first === undefined || gap.to === null || comparePositions(gap.to, first.position) >= 0
      ),
      items,
    };
  }

  const items = window.items.slice(0, cap);
  const last = items.at(-1);

  return {
    ...window,
    gaps: window.gaps.filter(
      (gap) => last === undefined || comparePositions(gap.from, last.position) <= 0
    ),
    items,
    later: true,
  };
};

/**
 * Places an item the stream gave. One past the end, when the Owner is not at the latest,
 * is left to be read after the end, which `later` says. Past the cap, the end furthest
 * from the Owner goes.
 * @param window - The window.
 * @param item - The item, as it stands now.
 * @param cap - The most items the window holds.
 * @returns The window.
 */
const placeLive = (window: Window, item: TimelineItem, cap: number): Window => {
  const last = window.items.at(-1);

  if (
    !window.later &&
    !window.following &&
    last !== undefined &&
    comparePositions(item.position, last.position) > 0
  ) {
    // What lies past the end is read after it, Gaps that began after the last item too.
    return {
      ...window,
      gaps: window.gaps.filter((gap) => comparePositions(gap.from, last.position) <= 0),
      later: true,
    };
  }

  return trim(placeItem(window, item), cap, window.following);
};

/**
 * Places a Gap of the window's Network: one already counted may only have ended since, and
 * one after the last item joins a collapsed Gap already there, with no item between, or
 * begins one. A Gap among the items means history changed under the window, which is read
 * again.
 * @param window - The window.
 * @param gap - The Gap, as it stands now.
 * @returns The window.
 */
const placeGap = (window: Window, gap: Gap): Window => {
  const { gaps, items } = window;

  const containing = gaps.findIndex(
    (held) =>
      comparePositions(held.from, gap.from) <= 0 &&
      (held.to === null || comparePositions(gap.from, held.to) <= 0)
  );

  const held = gaps[containing];

  if (held !== undefined) {
    const extends_ = gap.to !== null && (held.to === null || comparePositions(gap.to, held.to) > 0);

    return extends_ ? { ...window, gaps: gaps.with(containing, { ...held, to: gap.to }) } : window;
  }

  const last = items.at(-1);

  if (last === undefined || comparePositions(gap.from, last.position) >= 0) {
    // One that began after the last item, with more beyond it, is read with what is beyond.
    // One that began at the last item is the window's.
    if (window.later && (last === undefined || comparePositions(gap.from, last.position) > 0)) {
      return window;
    }

    const trailing = gaps.at(-1);

    if (
      trailing !== undefined &&
      (last === undefined || comparePositions(trailing.from, last.position) >= 0)
    ) {
      return {
        ...window,
        gaps: gaps.with(gaps.length - 1, {
          count: trailing.count + 1,
          from: trailing.from,
          to: gap.to,
        }),
      };
    }

    return { ...window, gaps: [...gaps, { count: 1, from: gap.from, to: gap.to }] };
  }

  const [first] = items;

  if (first !== undefined && comparePositions(gap.from, first.position) < 0 && window.earlier) {
    return window;
  }

  return { ...window, fresh: false };
};

/**
 * Brings a window up to date with one step's changes, unless it already reflects the step
 * or is waiting to be read again.
 * @param window - The window.
 * @param change - The step's changes.
 * @param cap - The most items a window holds.
 * @returns The window.
 */
const changeWindow = (window: Window, change: TimelineChange, cap: number): Window => {
  if (!window.fresh || change.sequence <= window.through) {
    return window;
  }

  let changed = window;

  for (const item of change.items) {
    if (item.timeline === window.timeline) {
      changed = placeLive(changed, item, cap);
    }
  }

  for (const gap of change.gaps) {
    if (gap.network === window.network) {
      changed = placeGap(changed, gap);
    }
  }

  return changed;
};

/**
 * The Networks a step that overflowed touched: those whose Timelines it named. A Timeline
 * not held was opened by that step, and could be any Network's, or a new Network's, so
 * then, as when it named none, it touched them all.
 * @param state - The state.
 * @param overflow - What overflowed.
 * @returns The Networks, or `All`.
 */
const touchedBy = (
  state: Timelines,
  overflow: TimelineOverflow
): ReadonlySet<NetworkId> | "All" => {
  if (overflow.timelines === null) {
    return "All";
  }

  const touched = new Set<NetworkId>();

  for (const id of overflow.timelines) {
    const owner =
      [...state.networks.values()].find((network) => network.timelines.has(id))?.network ??
      state.windows.get(id)?.network;

    if (owner === undefined) {
      return "All";
    }

    touched.add(owner);
  }

  return touched;
};

/**
 * Whether a step that overflowed touched a Network.
 * @param touched - What it touched.
 * @param network - The Network.
 * @returns Whether it did.
 */
const hit = (touched: ReadonlySet<NetworkId> | "All", network: NetworkId | undefined): boolean =>
  touched === "All" || (network !== undefined && touched.has(network));

/**
 * Marks a window for reading again when a step that overflowed touched its Network: its
 * items may have changed, and a Gap is the whole Network's.
 * @param window - The window.
 * @param touched - What the step touched.
 * @returns The window.
 */
const overflowWindow = (window: Window, touched: ReadonlySet<NetworkId> | "All"): Window =>
  hit(touched, window.network) ? { ...window, fresh: false } : window;

/**
 * Brings a window up to date with what the stream gave after it was read.
 * @param state - The state.
 * @param window - The window.
 * @param recent - What the stream gave.
 * @returns The window.
 */
const catchUpWindow = (state: Timelines, window: Window, recent: readonly Recorded[]): Window => {
  let caughtUp = window;

  for (const recorded of recent) {
    caughtUp =
      recorded._tag === "Changed"
        ? changeWindow(caughtUp, recorded.change, state.windowCap)
        : overflowWindow(caughtUp, touchedBy(state, recorded.overflow));
  }

  return caughtUp;
};

// Networks.

/**
 * The connection `known` describes.
 * @param session - What the Client knows of its Session.
 * @returns The connection.
 */
const connectionOf = (session: SessionKnowledge): Connection => {
  switch (session._tag) {
    case "Connecting":
    case "Registering": {
      return { _tag: "Connecting", since: session.since };
    }

    case "Registered": {
      return { _tag: "Connected", nick: undefined, since: session.since };
    }

    case "Offline": {
      return { _tag: "Offline", reason: undefined, since: session.since ?? undefined };
    }

    default: {
      return session satisfies never;
    }
  }
};

/**
 * The connection a Session item says, if it is one.
 * @param item - The item.
 * @returns The connection, or `undefined` for a Message or an Activity.
 */
const connectionFromItem = (item: TimelineItem): Connection | undefined => {
  const { content } = item;

  switch (content._tag) {
    case "SessionBegan": {
      return { _tag: "Connected", nick: content.nick, since: content.at };
    }

    case "SessionEnded":
    case "ConnectionFailed": {
      return { _tag: "Offline", reason: content.reason, since: content.at };
    }

    case "Message":
    case "Activity":
    case "ActionRefused": {
      return undefined;
    }

    default: {
      return content satisfies never;
    }
  }
};

/**
 * Brings a Network's Timelines up to date with one step's changes: each Timeline kept by
 * its id, the one changed last winning, and each merged one gone.
 * @param network - The Network.
 * @param change - The step's changes.
 * @param merged - Every Timeline merged so far.
 * @returns The Network.
 */
const changeList = (
  network: NetworkView,
  change: TimelineChange,
  merged: ReadonlyMap<TimelineId, TimelineId>
): NetworkView => {
  const timelines = new Map(network.timelines);

  for (const timeline of change.timelines) {
    const held = timelines.get(timeline.id);

    if (
      timeline.network === network.network &&
      !merged.has(timeline.id) &&
      (held === undefined || timeline.changed > held.changed)
    ) {
      timelines.set(timeline.id, timeline);
    }
  }

  for (const tombstone of change.merged) {
    timelines.delete(tombstone.id);
  }

  return { ...network, timelines };
};

/**
 * Whether Self is away, once a Session item set the connection: here as a Session begins,
 * and unknown with none.
 * @param connection - The connection.
 * @returns Whether Self is away now.
 */
const awayOfConnection = (connection: Connection): SelfAway => {
  switch (connection._tag) {
    case "Connected": {
      return { _tag: "Here" };
    }

    case "Connecting":
    case "Offline":
    case "Unknown": {
      return { _tag: "Unknown" };
    }

    default: {
      return connection satisfies never;
    }
  }
};

/**
 * Brings a Network's connection up to date with the Session items of one step, when they
 * are later than what set it.
 * @param network - The Network.
 * @param change - The step's changes.
 * @returns The Network.
 */
const changeConnection = (network: NetworkView, change: TimelineChange): NetworkView => {
  let { awayAt, connection, connectionAt } = network;

  for (const item of change.items) {
    const ours = item.network === network.network;
    const said = ours ? connectionFromItem(item) : undefined;

    if (said !== undefined && item.sequence > connectionAt) {
      connection = said;
      connectionAt = item.sequence;
    }

    // Self's away changes belong to the Network's own Timeline. Which User it was, and
    // what the Ircd confirmed, `known` says.
    if (
      ours &&
      item.content._tag === "Activity" &&
      item.content.activity._tag === "AwayChanged" &&
      network.timelines.get(item.timeline)?.kind === "Network"
    ) {
      awayAt = Math.max(awayAt, item.sequence);
    }
  }

  const connected =
    connectionAt === network.connectionAt
      ? network
      : {
          ...network,
          away: awayOfConnection(connection),
          connection,
          connectionAt,
        };

  return awayAt === network.awayAt
    ? connected
    : { ...connected, awayAt, status: { ...connected.status, fresh: false } };
};

/**
 * Whether Self is away, as `known` says: as the Ircd confirmed it while registered.
 * @param session - The Session, as `known` says.
 * @param self - Self, as `known` says.
 * @returns Whether Self is away.
 */
const awayOfKnown = (session: SessionKnowledge, self: UserKnowledge | null): SelfAway => {
  const fact = self?.away;

  if (session._tag !== "Registered" || fact === undefined || fact._tag !== "Known") {
    return { _tag: "Unknown" };
  }

  return fact.value === null ? { _tag: "Here" } : { _tag: "Away", message: fact.value.message };
};

/**
 * Marks a Network's list for reading again from its first page.
 * @param network - The Network.
 * @returns The Network.
 */
const staleList = (network: NetworkView): NetworkView => ({
  ...network,
  list: { ...network.list, fresh: false, next: undefined, through: undefined },
});

// Applying the stream.

/**
 * Applies one step's changes to everything held.
 * @param state - The state.
 * @param change - The step's changes.
 * @returns The state.
 */
const applyChange = (state: Timelines, change: TimelineChange): Timelines => {
  const merged = new Map(state.merged);

  for (const tombstone of change.merged) {
    merged.set(tombstone.id, tombstone.into);
  }

  let { networks } = state;

  // A Timeline of a Network not held yet: the Network was configured since, so it is
  // added, and its list and connection are read.
  for (const timeline of change.timelines) {
    if (!networks.has(timeline.network)) {
      networks = setIn(networks, timeline.network, newNetwork(timeline.network));
    }
  }

  const touched = new Set([
    ...change.timelines.map((timeline) => timeline.network),
    ...change.merged.map((tombstone) => tombstone.network),
    ...change.items.map((item) => item.network),
  ]);

  networks = mapValues(networks, (network) =>
    touched.has(network.network)
      ? changeConnection(changeList(network, change, merged), change)
      : network
  );

  const windows = new Map<TimelineId, Window>();

  // The window of a Timeline merged into another goes, and the Timeline it went to is read
  // when it is open.
  for (const [id, window] of state.windows) {
    if (!merged.has(id)) {
      windows.set(id, changeWindow(window, change, state.windowCap));
    }
  }

  return { ...state, merged, networks, windows };
};

/**
 * What a read is of, so its answer can be checked against what happened while it was in
 * flight: the Network list, one Network's Timelines or connection, or one window.
 */
type Subject =
  | { readonly _tag: "NetworkList" }
  | { readonly _tag: "Network"; readonly network: NetworkId }
  | {
      readonly _tag: "Window";
      readonly network: NetworkId | undefined;
      readonly timeline: TimelineId;
    };

/**
 * Whether an overflow invalidates what a read is of: the Network list only when it touched
 * everything, a Network when it touched it, and a window when it touched its Network or
 * named its Timeline.
 * @param state - The state.
 * @param overflow - What overflowed.
 * @param subject - What the read is of.
 * @returns Whether it does.
 */
const invalidates = (state: Timelines, overflow: TimelineOverflow, subject: Subject): boolean => {
  const touched = touchedBy(state, overflow);

  switch (subject._tag) {
    case "NetworkList": {
      return touched === "All";
    }

    case "Network": {
      return hit(touched, subject.network);
    }

    case "Window": {
      return hit(touched, subject.network) || (overflow.timelines ?? []).includes(subject.timeline);
    }

    default: {
      return subject satisfies never;
    }
  }
};

/**
 * The one rule every answer is taken by: it is current only if nothing that invalidates
 * what it is of happened after its read began at `since`, neither a reset nor the stream
 * forgetting what it gave since then, which leave no record of what changed, nor an
 * overflow that touched it, whose changes never came. An answer that is not current
 * leaves what it is of stale, to be read again.
 * @param state - The state.
 * @param since - The stream's place the answer reflects: its `through`, or where the
 * stream was when the read began.
 * @param subject - What the read is of.
 * @returns Whether the answer is current.
 */
const isCurrent = (state: Timelines, since: number, subject: Subject): boolean =>
  state.follow._tag !== "Following" ||
  (since >= state.follow.recentFrom &&
    !recentAfter(state, since).some(
      (recorded) => recorded._tag === "Overflowed" && invalidates(state, recorded.overflow, subject)
    ));

/**
 * Applies an overflow: every Network it touched has its Timelines, its connection, and
 * its windows read again, and the Network list too when it touched them all.
 * @param state - The state.
 * @param overflow - What overflowed.
 * @returns The state.
 */
const applyOverflow = (state: Timelines, overflow: TimelineOverflow): Timelines => {
  const touched = touchedBy(state, overflow);

  return {
    ...state,
    entries: touched === "All" ? { ...state.entries, fresh: false } : state.entries,
    networks: mapValues(state.networks, (network) =>
      hit(touched, network.network)
        ? { ...staleList(network), status: { ...network.status, fresh: false } }
        : network
    ),
    windows: mapValues(state.windows, (window) => overflowWindow(window, touched)),
  };
};

/**
 * Applies a reset: what is held was folded by a projection that cannot be resumed, so
 * every list and window is dropped and read again, the Network list too, and the stream
 * follows from the reset's place. Each Network's connection is kept until `known` is read again, since it is not
 * part of the projection.
 * @param state - The state.
 * @param reset - The reset.
 * @returns The state.
 */
const applyReset = (state: Timelines, reset: TimelineReset): Timelines => {
  const place = { sequence: reset.through ?? 0, version: reset.version };

  return {
    ...state,
    // A Network configured while the stream was away may be in the state the reset reaches,
    // and its first step never comes on the stream, so the Network list is read again.
    entries: { ...state.entries, fresh: false },
    follow: { _tag: "Following", place, recent: [], recentFrom: place.sequence },
    merged: new Map(),
    networks: mapValues(state.networks, (network) => ({
      ...network,
      list: { ...unreadList, reading: network.list.reading },
      status: { ...network.status, fresh: false },
      timelines: new Map(),
    })),
    vanished: new Set(),
    windows: mapValues(state.windows, (window) => ({
      ...window,
      earlier: false,
      fresh: false,
      gaps: [],
      items: [],
      later: false,
      newer: false,
      older: false,
    })),
  };
};

/**
 * Records what the stream gave while a read is in flight, and forgets it once none is, so
 * a read that lands later is brought up to date from it.
 * @param state - The state after the event.
 * @param recorded - What the stream gave, if this event was the stream's.
 * @returns The state.
 */
const record = (state: Timelines, recorded: Recorded | undefined): Timelines => {
  const { follow } = state;

  if (follow._tag === "Waiting") {
    return state;
  }

  const place = follow.place?.sequence ?? 0;

  if (!inFlight(state)) {
    return follow.recent.length === 0 && follow.recentFrom === place
      ? state
      : { ...state, follow: { ...follow, recent: [], recentFrom: place } };
  }

  if (recorded === undefined) {
    return state;
  }

  const recent = [...follow.recent, recorded];

  // Past the limit, the oldest is forgotten, and a read older than what is kept is read
  // again.
  if (recent.length > recentLimit) {
    const [oldest, ...kept] = recent;
    let from = follow.recentFrom;

    if (oldest !== undefined) {
      from = oldest._tag === "Changed" ? oldest.change.sequence : oldest.overflow.sequence;
    }

    return { ...state, follow: { ...follow, recent: kept, recentFrom: from } };
  }

  return { ...state, follow: { ...follow, recent } };
};

/**
 * Moves the stream's place.
 * @param state - The state.
 * @param place - Where the event left the stream.
 * @returns The state, or `undefined` when the stream is not followed yet.
 */
const moved = (state: Timelines, place: Place): Timelines | undefined =>
  state.follow._tag === "Following" ? { ...state, follow: { ...state.follow, place } } : undefined;

// Reads.

/**
 * Marks a read as started.
 * @param state - The state.
 * @param read - The read.
 * @returns The state.
 */
const started = (state: Timelines, read: Read): Timelines => {
  switch (read._tag) {
    case "Networks": {
      const from = state.follow._tag === "Following" ? (state.follow.place?.sequence ?? 0) : 0;

      return { ...state, entries: { ...state.entries, from, reading: true } };
    }

    case "List": {
      const network = state.networks.get(read.network);

      return network === undefined
        ? state
        : {
            ...state,
            networks: setIn(state.networks, read.network, {
              ...network,
              list: { ...network.list, reading: true },
            }),
          };
    }

    case "Status": {
      const network = state.networks.get(read.network);
      const from = state.follow._tag === "Following" ? (state.follow.place?.sequence ?? 0) : 0;

      return network === undefined
        ? state
        : {
            ...state,
            networks: setIn(state.networks, read.network, {
              ...network,
              status: { ...network.status, from, reading: true },
            }),
          };
    }

    case "Latest":
    case "Older":
    case "Newer": {
      const window = state.windows.get(read.timeline);

      // A read for a window since dropped starts nothing.
      if (window !== undefined && window.generation !== read.generation) {
        return state;
      }

      // A Timeline read for the first time holds a window with nothing in it yet, which
      // takes no changes until it is read, and is a generation of its own.
      const placeholder: Window = window ?? {
        ...unread,
        earlier: false,
        following: true,
        gaps: [],
        generation: read.generation,
        items: [],
        later: false,
        network: undefined,
        newer: false,
        older: false,
        seen: undefined,
        through: 0,
        timeline: read.timeline,
      };

      return {
        ...state,
        nextGeneration: Math.max(state.nextGeneration, read.generation + 1),
        windows: setIn(state.windows, read.timeline, { ...placeholder, reading: true }),
      };
    }

    default: {
      return read satisfies never;
    }
  }
};

/**
 * Marks where an attempt at a read begins: the stream's place now, which the Network list
 * and `known` are current from, since neither says how far it was folded. A wait before
 * the attempt, as a read asked for again makes, is not counted, so what the stream gives
 * while the runtime waits never makes the answer stale. A page of Timelines or a window
 * says its own `through`, so nothing is marked for them.
 * @param state - The state.
 * @param read - The read being asked.
 * @returns The state.
 */
const requesting = (state: Timelines, read: Read): Timelines => {
  const from = state.follow._tag === "Following" ? (state.follow.place?.sequence ?? 0) : 0;

  if (read._tag === "Networks") {
    return state.entries.reading ? { ...state, entries: { ...state.entries, from } } : state;
  }

  if (read._tag === "Status") {
    const network = state.networks.get(read.network);

    return network === undefined || !network.status.reading
      ? state
      : {
          ...state,
          networks: setIn(state.networks, read.network, {
            ...network,
            status: { ...network.status, from },
          }),
        };
  }

  return state;
};

/**
 * Takes the Network list.
 * @param state - The state.
 * @param entries - Each Network and whether it runs.
 * @returns The state.
 */
const networksRead = (state: Timelines, entries: readonly NetworkEntry[]): Timelines => {
  // Begun before a reset, or an overflow that touched everything, either of which may have
  // configured a Network the stream never gave: read it again.
  if (!isCurrent(state, state.entries.from, { _tag: "NetworkList" })) {
    return {
      ...state,
      entries: { ...state.entries, attempt: state.entries.attempt + 1, reading: false },
    };
  }

  const networks = new Map(state.networks);

  for (const entry of entries) {
    networks.set(entry.network, {
      ...(networks.get(entry.network) ?? newNetwork(entry.network)),
      running: entry.status,
    });
  }

  return {
    ...state,
    entries: { ...state.entries, attempt: 0, fresh: true, reading: false },
    networks,
  };
};

/**
 * Starts following the stream once the Network list and every Network's Timelines are
 * read: after the smallest `through` the pages gave, so nothing after any of them is
 * missed. The Network list is read once more, so a Network configured while the pages were
 * read is not missed either.
 * @param state - The state.
 * @returns The state.
 */
const startFollowing = (state: Timelines): Timelines => {
  const { follow } = state;
  const networks = [...state.networks.values()];

  if (
    follow._tag !== "Waiting" ||
    !state.entries.fresh ||
    !networks.every((network) => network.list.fresh)
  ) {
    return state;
  }

  const throughs = networks.map((network) => network.list.through ?? 0);

  const place =
    follow.version === undefined || throughs.length === 0
      ? undefined
      : { sequence: Math.min(...throughs), version: follow.version };

  return {
    ...state,
    entries: { ...state.entries, fresh: false },
    follow: { _tag: "Following", place, recent: [], recentFrom: place?.sequence ?? 0 },
  };
};

/**
 * While the first reads come in, the version they were read at: the first to say one, or
 * a newer one, which drops every page read so far, since pages of different versions do
 * not fit together.
 * @param state - The state.
 * @param version - A read's version.
 * @returns The state.
 */
const waitingFor = (state: Timelines, version: number): Timelines => {
  const { follow } = state;

  if (follow._tag !== "Waiting" || (follow.version !== undefined && follow.version >= version)) {
    return state;
  }

  return {
    ...state,
    follow: { _tag: "Waiting", version },
    networks:
      follow.version === undefined
        ? state.networks
        : mapValues(state.networks, (network) => ({
            ...network,
            list: { ...unreadList, reading: network.list.reading },
            timelines: new Map(),
          })),
  };
};

/**
 * Takes a page of a Network's Timelines. The first page of a round replaces what is held,
 * since a Timeline merged since is not on it, and the rest add to it. What the stream gave
 * after the page's `through` is applied to it again, so nothing between is lost.
 * @param state - The state.
 * @param id - The Network.
 * @param after - The Timeline the page was read after, or `undefined` for the first.
 * @param page - The page.
 * @returns The state.
 */
const listRead = (
  state: Timelines,
  id: NetworkId,
  after: TimelineId | undefined,
  page: TimelineList
): Timelines => {
  const current = state.networks.get(id);

  // A page of a round given up since, because the list was marked to be read again.
  if (current === undefined || after !== current.list.next) {
    return current === undefined
      ? state
      : {
          ...state,
          networks: setIn(state.networks, id, {
            ...current,
            list: { ...current.list, reading: false },
          }),
        };
  }

  const through = page.through ?? 0;
  const versioned = waitingFor(state, page.version);
  const network = versioned.networks.get(id) ?? current;

  if (!usable(versioned, page.version, through) || after !== network.list.next) {
    return {
      ...versioned,
      networks: setIn(versioned.networks, id, {
        ...network,
        list: { ...network.list, attempt: network.list.attempt + 1, reading: false },
      }),
    };
  }

  const first = after === undefined;
  const timelines = first ? new Map<TimelineId, Timeline>() : new Map(network.timelines);

  for (const timeline of page.timelines) {
    const held = timelines.get(timeline.id);

    if (
      !versioned.merged.has(timeline.id) &&
      (held === undefined || timeline.changed > held.changed)
    ) {
      timelines.set(timeline.id, timeline);
    }
  }

  const last = page.timelines.at(-1);
  const more = page.more && last !== undefined;

  const read: NetworkView = {
    ...network,
    list: {
      attempt: 0,
      fresh: !more,
      next: more ? last.id : undefined,
      reading: false,
      through: minOf(first ? undefined : network.list.through, through),
    },
    timelines,
  };

  let caughtUp = read;

  for (const recorded of recentAfter(versioned, through)) {
    if (recorded._tag === "Changed") {
      caughtUp = changeList(caughtUp, recorded.change, versioned.merged);
    }
  }

  // An overflow of its Network since the page was folded leaves the list to be read again.
  if (!isCurrent(versioned, through, { _tag: "Network", network: id })) {
    caughtUp = {
      ...staleList(caughtUp),
      list: { ...staleList(caughtUp).list, attempt: network.list.attempt + 1 },
    };
  }

  return startFollowing({ ...versioned, networks: setIn(versioned.networks, id, caughtUp) });
};

/**
 * Takes what `known` said of a Network's Session, and whether Self is away, unless a
 * Session item later than the read's place already said more. A read started before the
 * oldest place kept for reads in flight, as one started before a reset is, is read again,
 * and so is one that began before Self's away changed again.
 * @param state - The state.
 * @param id - The Network.
 * @param session - What the Client knows of its Session.
 * @param self - What the Client knows of Self.
 * @returns The state.
 */
const statusRead = (
  state: Timelines,
  id: NetworkId,
  session: SessionKnowledge,
  self: UserKnowledge | null
): Timelines => {
  const network = state.networks.get(id);

  if (network === undefined) {
    return state;
  }

  const { from } = network.status;
  const newer = network.connectionAt > from;

  // Begun before a reset, or an overflow of its Network, either of which may have held a
  // Session item `known` does not reflect and the stream never gave: read it again.
  if (!isCurrent(state, from, { _tag: "Network", network: id })) {
    return {
      ...state,
      networks: setIn(state.networks, id, {
        ...network,
        status: { ...network.status, attempt: network.status.attempt + 1, reading: false },
      }),
    };
  }

  return {
    ...state,
    networks: setIn(state.networks, id, {
      ...network,
      away: newer ? network.away : awayOfKnown(session, self),
      connection: newer ? network.connection : connectionOf(session),
      connectionAt: Math.max(network.connectionAt, from),
      // An away change after the read began may not be in it, so it is read again.
      status: { ...network.status, attempt: 0, fresh: network.awayAt <= from, reading: false },
    }),
  };
};

/**
 * The most items a window read again keeps, so the Owner keeps most of what they loaded,
 * within the cap.
 * @param window - The window.
 * @param cap - The most items a window holds.
 * @returns The limit.
 */
const limitFor = (window: Window | undefined, cap: number) =>
  Math.min(cap, largestPage, Math.max(pageSize, window?.items.length ?? 0));

/**
 * A window's collapsed Gaps with each run that a cursor split joined again: a page read
 * at a cursor gives the run up to it, and the window holding the cursor's item the run
 * from it, so two Gaps with no item between them are one run. A Gap the same as one before
 * it, by where it began, is the same run, given twice.
 * @param items - The window's items, in position order.
 * @param gaps - Its collapsed Gaps, in the order they began.
 * @returns The Gaps, each run once.
 */
const joinRuns = (
  items: readonly TimelineItem[],
  gaps: readonly WindowGap[]
): readonly WindowGap[] => {
  const joined: WindowGap[] = [];

  for (const gap of gaps) {
    const last = joined.at(-1);

    if (last === undefined) {
      joined.push(gap);
    } else if (comparePositions(last.from, gap.from) === 0) {
      // The same run: keep the one held.
    } else {
      // The first item after where the last run began, and whether it comes before this one.
      const { found, index } = search(items, last.from);
      const after = items[found ? index + 1 : index];
      const between = after !== undefined && comparePositions(after.position, gap.from) <= 0;

      if (between) {
        joined.push(gap);
      } else {
        joined[joined.length - 1] = { count: last.count + gap.count, from: last.from, to: gap.to };
      }
    }
  }

  return joined;
};

/**
 * Merges a page read before or after a window into it: each item kept by its position,
 * the one changed last winning, the page's Gaps with the window's, a run the cursor split
 * joined again, and the end furthest from where the page went dropped past the cap.
 * @param window - The window.
 * @param read - The page, brought up to date on its own.
 * @param side - Whether it was read before or after the window.
 * @param cap - The most items a window holds.
 * @returns The window.
 */
const mergePage = (window: Window, read: Window, side: "Older" | "Newer", cap: number): Window => {
  let merged: Window =
    side === "Older" ? { ...window, earlier: false } : { ...window, later: false };

  for (const item of read.items) {
    merged = placeItem(merged, item);
  }

  const gaps = [...window.gaps, ...read.gaps].toSorted((left, right) =>
    comparePositions(left.from, right.from)
  );

  return trim(
    {
      ...merged,
      earlier: side === "Older" ? read.earlier : window.earlier,
      gaps: joinRuns(merged.items, gaps),
      later: side === "Newer" ? read.later : window.later,
    },
    cap,
    side === "Newer"
  );
};

/**
 * Whether a page was read from the window's edge as it is now: before its first item, or
 * after its last. The latest is read from no edge.
 * @param window - The window.
 * @param read - The read the page answers.
 * @returns Whether it fits.
 */
const atEdge = (window: Window, read: WindowRequest): boolean => {
  switch (read._tag) {
    case "Latest": {
      return true;
    }

    case "Older": {
      const [first] = window.items;

      return first !== undefined && comparePositions(first.position, read.before) === 0;
    }

    case "Newer": {
      const last = window.items.at(-1);

      return last !== undefined && comparePositions(last.position, read.after) === 0;
    }

    default: {
      return read satisfies never;
    }
  }
};

/**
 * Takes a window read. The latest replaces what is held, and older or newer items join it. Either
 * is then brought up to date with what the stream gave after its `through`. A merged
 * Timeline's id reads the Timeline it went to, which is held from then on.
 * @param state - The state.
 * @param event - The read.
 * @returns The state.
 */
const windowRead = (
  state: Timelines,
  event: Extract<TimelinesEvent, { readonly _tag: "WindowRead" }>
): Timelines => {
  const { read, window: answer } = event;
  const requested = read.timeline;
  const held = state.windows.get(requested);
  const through = answer.through ?? 0;

  // An answer for a window dropped since, and perhaps read again as another, is not this
  // window's, whose read, if any, is still in flight.
  if (held === undefined || held.generation !== read.generation) {
    return state;
  }

  const done = { ...held, reading: false };

  // A page for an edge the window no longer has, as when the oldest were dropped past the
  // cap while it was read, fits nowhere: it is asked for again from the edge there is now.
  if (!atEdge(held, read)) {
    return { ...state, windows: setIn(state.windows, requested, done) };
  }

  if (!usable(state, answer.version, through)) {
    return {
      ...state,
      windows: setIn(state.windows, requested, { ...done, attempt: done.attempt + 1 }),
    };
  }

  // An overflow of its Network or Timeline since the answer was folded: the window is read
  // again whole.
  if (
    !isCurrent(state, through, { _tag: "Window", network: answer.network, timeline: requested })
  ) {
    return {
      ...state,
      windows: setIn(state.windows, requested, {
        ...done,
        attempt: done.attempt + 1,
        fresh: false,
      }),
    };
  }

  if (read._tag !== "Latest") {
    // The page is brought up to date on its own, since the window already reflects what
    // the stream gave, and then joins it.
    const page = catchUpWindow(
      state,
      {
        ...done,
        earlier: answer.earlier,
        fresh: true,
        gaps: answer.gaps,
        items: answer.items,
        later: answer.later,
        through,
      },
      recentAfter(state, through)
    );

    let merged = done;

    if (answer.timeline === requested && held.fresh) {
      merged = page.fresh
        ? mergePage(done, page, read._tag, state.windowCap)
        : { ...done, fresh: false };
    }

    return {
      ...state,
      windows: setIn(state.windows, requested, { ...merged, newer: false, older: false }),
    };
  }

  const fresh: Window = {
    attempt: 0,
    earlier: answer.earlier,
    following: held.following,
    fresh: true,
    gaps: answer.gaps,
    generation: held.generation,
    items: answer.items,
    later: answer.later,
    network: answer.network,
    newer: false,
    older: false,
    reading: false,
    seen: held.seen,
    through,
    timeline: answer.timeline,
  };

  const caughtUp = catchUpWindow(state, fresh, recentAfter(state, through));

  if (answer.timeline === requested) {
    return { ...state, windows: setIn(state.windows, requested, caughtUp) };
  }

  // The id was merged into another, which the read gave.
  return {
    ...state,
    merged: setIn(state.merged, requested, answer.timeline),
    windows: setIn(deleteIn(state.windows, requested), answer.timeline, caughtUp),
  };
};

/**
 * A Timeline as its Network lists it.
 * @param state - The state.
 * @param timeline - Its id.
 * @returns The Timeline, or none while no Network lists it.
 */
const listed = (state: Timelines, timeline: TimelineId): Timeline | undefined => {
  for (const network of state.networks.values()) {
    const found = network.timelines.get(timeline);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};

/**
 * The divider a Timeline opens with: at its Read Marker when something said in it is
 * unread, Highlights, Direct Messages, or Messages, and none otherwise.
 * @param timeline - The Timeline, as its Network lists it.
 * @returns The divider, or none.
 */
const dividerOf = (timeline: Timeline | undefined): Divider | undefined => {
  if (timeline === undefined) {
    return undefined;
  }

  const { direct, highlights, messages } = timeline.unread;

  return direct + highlights + messages > 0
    ? { read: timeline.read, timeline: timeline.id }
    : undefined;
};

/**
 * The Timelines open in the Panes, as the Owner chose them, the focused Pane's first.
 * @param layout - The layout.
 * @returns Their ids.
 */
const openIn = (layout: Layout<PaneView>): readonly TimelineId[] => {
  const focused = focusedPane(layout);

  return [focused, ...panesOf(layout.root).filter((pane) => pane.id !== focused.id)].flatMap(
    (pane) => (pane.view.open === undefined ? [] : [pane.view.open])
  );
};

/**
 * The Pane a Timeline is open in.
 * @param state - The state.
 * @param timeline - The Timeline.
 * @returns The Pane's id, or none when no Pane has it open.
 */
export const paneOf = (state: Timelines, timeline: TimelineId): string | undefined => {
  const id = resolve(state, timeline);

  return panesOf(state.layout.root).find(
    (pane) => pane.view.open !== undefined && resolve(state, pane.view.open) === id
  )?.id;
};

/**
 * What the focused Pane shows.
 * @param state - The state.
 * @returns Its view.
 */
export const focusedView = (state: Timelines): PaneView => focusedPane(state.layout).view;

/**
 * The Timeline open in the focused Pane, as the Owner chose it, even while the options show
 * in its place. A merge is followed when it is read.
 * @param state - The state.
 * @returns Its id, or none.
 */
export const openOf = (state: Timelines): TimelineId | undefined => focusedView(state).open;

/**
 * What the focused Pane shows: its Timeline or the options.
 * @param state - The state.
 * @returns What it shows.
 */
export const mainOf = (state: Timelines): MainView => focusedView(state).main;

/**
 * Keeps the windows of what the Panes show, after they changed. A Timeline no Pane has open
 * any more joins the most recently closed, and only the windows of those open and of the
 * few closed most recently are kept: any other is read again when it opens. A Timeline
 * newly open opens on its latest: its window follows again, one left behind the latest is
 * read again, and what was seen of it, the view says again once it shows it.
 * @param before - The state before the Panes changed.
 * @param after - The state after.
 * @returns The state after, with its windows kept.
 */
const retained = (before: Timelines, after: Timelines): Timelines => {
  const was = new Set(openIn(before.layout).map((one) => resolve(after, one)));
  const now = openIn(after.layout);
  const shown = new Set(now.map((one) => resolve(after, one)));
  const left = openIn(before.layout).filter((one) => !shown.has(resolve(after, one)));
  const closed: TimelineId[] = [];

  for (const one of [...left, ...after.closed]) {
    const id = resolve(after, one);

    if (!shown.has(id) && !closed.some((other) => resolve(after, other) === id)) {
      closed.push(one);
    }
  }

  const kept = closed.slice(0, after.kept);
  const keep = new Set([...shown, ...kept.map((one) => resolve(after, one))]);
  const windows = new Map([...after.windows].filter(([one]) => keep.has(one)));

  for (const id of shown) {
    const window = windows.get(id);

    if (!was.has(id) && window !== undefined) {
      windows.set(id, {
        ...window,
        following: true,
        fresh: window.fresh && !window.later,
        seen: undefined,
      });
    }
  }

  return { ...after, closed: kept, windows };
};

/**
 * The view of a Pane a Timeline opens in: the Timeline, with the divider it opens with.
 * @param state - The state.
 * @param timeline - The Timeline.
 * @returns The view.
 */
const viewOf = (state: Timelines, timeline: TimelineId): PaneView => ({
  divider: dividerOf(listed(state, resolve(state, timeline))),
  main: { _tag: "Timeline" },
  open: timeline,
});

/**
 * Opens a Timeline, on its latest, in the focused Pane, in place of what it showed. Opened
 * with something unread, it remembers where its Read Marker was, for the "new" divider,
 * until another opens there. A Timeline already open in a Pane is not opened twice: that
 * Pane takes the focus and shows it again, changing nothing else, so where the Owner left it,
 * scrolled back or not, and its divider stay.
 * @param state - The state.
 * @param timeline - The Timeline opened.
 * @returns The state.
 */
const opening = (state: Timelines, timeline: TimelineId): Timelines => {
  const at = paneOf(state, timeline);
  const { layout } = state;

  if (at === layout.focused && focusedView(state).main._tag === "Timeline") {
    return state;
  }

  if (at !== undefined) {
    return {
      ...state,
      layout: mapViews({ ...layout, focused: at }, (pane): PaneView =>
        pane.id === at ? { ...pane.view, main: { _tag: "Timeline" } } : pane.view
      ),
    };
  }

  return retained(state, {
    ...state,
    layout: withView(layout, layout.focused, viewOf(state, timeline)),
  });
};

/**
 * Marks the open window as the Owner asked: for what lies before or after it, or as at the
 * latest or not.
 * @param state - The state.
 * @param event - What the Owner did.
 * @returns The state.
 */
const marked = (
  state: Timelines,
  event: Extract<TimelinesEvent, { readonly _tag: "OlderWanted" | "NewerWanted" | "Following" }>
): Timelines => {
  const id = resolve(state, event.timeline);
  const window = state.windows.get(id);

  if (window === undefined) {
    return state;
  }

  switch (event._tag) {
    case "OlderWanted": {
      return { ...state, windows: setIn(state.windows, id, { ...window, older: window.earlier }) };
    }

    case "NewerWanted": {
      return { ...state, windows: setIn(state.windows, id, { ...window, newer: window.later }) };
    }

    case "Following": {
      return {
        ...state,
        windows: setIn(state.windows, id, {
          ...window,
          following: event.following,
          seen: event.following ? event.seen : undefined,
        }),
      };
    }

    default: {
      return event satisfies never;
    }
  }
};

// The reducer.

/**
 * Opens the Timeline a Message the Owner said was placed in, once its Network lists it:
 * a Direct Message Timeline that still follows its partner. Any other kind is let go, so a
 * Message to a Channel opens nothing. The Daemon's routing chose it, so the Frontend never
 * matches a name itself.
 * @param state - The state.
 * @returns The state, with the Timeline open once it is listed.
 */
const found = (state: Timelines): Timelines => {
  const { located } = state;

  if (located === undefined) {
    return state;
  }

  for (const network of state.networks.values()) {
    const timeline = network.timelines.get(located);

    if (timeline !== undefined) {
      return timeline.kind === "Direct" && !timeline.detached
        ? opening({ ...state, located: undefined }, timeline.id)
        : { ...state, located: undefined };
    }
  }

  return state;
};

/**
 * The state after an event.
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after.
 */
interface Applied {
  readonly state: Timelines;
  /** What the stream gave, when the event was the stream's. */
  readonly recorded?: Recorded;
}

/** An event of where the Owner went. */
type Navigation = Extract<
  TimelinesEvent,
  {
    readonly _tag: "Opened" | "Located" | "OptionsShown" | "OptionsFiltered" | "Pane" | "Restore";
  }
>;

const navigations: ReadonlySet<string> = new Set([
  "Opened",
  "Located",
  "OptionsShown",
  "OptionsFiltered",
  "Pane",
  "Restore",
]);

const isNavigation = (event: TimelinesEvent): event is Navigation => navigations.has(event._tag);

/**
 * The state once the Owner went elsewhere: `navigation` bumped, so a placement from before
 * is let go.
 * @param state - The state.
 * @returns The state.
 */
const elsewhere = (state: Timelines): Timelines => ({
  ...state,
  located: undefined,
  navigation: state.navigation + 1,
});

/**
 * The Pane the options show in, if any.
 * @param layout - The layout.
 * @returns Its id, or none.
 */
const optionsPane = (layout: Layout<PaneView>): string | undefined =>
  panesOf(layout.root).find((pane) => pane.view.main._tag === "Options")?.id;

/**
 * Shows the options, filtered: in the Pane they show in already, which takes the focus, or
 * else in the focused Pane, in place of its Timeline, which stays open behind them.
 * @param state - The state.
 * @param filter - The filter.
 * @returns The state.
 */
const showingOptions = (state: Timelines, filter: string): Timelines => {
  const { layout } = state;
  const at = optionsPane(layout) ?? layout.focused;
  const view = panesOf(layout.root).find((pane) => pane.id === at)?.view ?? emptyView;

  return {
    ...state,
    layout: withView({ ...layout, focused: at }, at, {
      ...view,
      main: { _tag: "Options", filter },
    }),
  };
};

/**
 * Changes the Panes. A split opens the Timeline it names in the new Pane, unless a Pane has
 * it open already, when the new Pane is empty.
 * @param state - The state.
 * @param change - The change.
 * @returns The state.
 */
const paned = (state: Timelines, change: PaneChange): Timelines => {
  if (change._tag !== "Split") {
    const layout = reduceLayout(state.layout, change);

    return layout === state.layout ? state : retained(state, { ...state, layout });
  }

  const view =
    change.timeline === undefined || paneOf(state, change.timeline) !== undefined
      ? emptyView
      : viewOf(state, change.timeline);

  return retained(state, {
    ...state,
    layout: reduceLayout(state.layout, { _tag: "Split", axis: change.axis, view }),
  });
};

/**
 * Takes the layout this device kept, once every Network's Timelines are read, and only if
 * the Owner went nowhere meanwhile. A Pane whose Timeline no Network lists any more is
 * dropped, and with none left, the layout stays as it is. Each Timeline opens as opening
 * it does, with its divider.
 * @param state - The state.
 * @returns The state.
 */
const restored = (state: Timelines): Timelines => {
  const { restoring } = state;

  if (restoring === undefined || state.follow._tag !== "Following") {
    return state;
  }

  const unset = { ...state, restoring: undefined };

  if (state.navigation > 0) {
    return unset;
  }

  const kept = keeping(
    restoring,
    (pane) => pane.view.open === undefined || listed(state, pane.view.open) !== undefined
  );

  if (kept === undefined) {
    return unset;
  }

  // A Timeline is open in one Pane at most, and the options show in one: a second is empty.
  const open = new Set<TimelineId>();
  let options = false;

  const layout = mapViews(kept, ({ view }): PaneView => {
    const main =
      view.main._tag === "Options" && options ? { _tag: "Timeline" as const } : view.main;

    options ||= main._tag === "Options";

    if (view.open === undefined || open.has(resolve(state, view.open))) {
      return { ...emptyView, main };
    }

    open.add(resolve(state, view.open));

    return { ...viewOf(state, view.open), main };
  });

  return retained(unset, { ...unset, layout });
};

/**
 * Whether the Owner went elsewhere: the focused Pane shows something else, as when another
 * Pane takes the focus, but not when the view they were in moves with them, as a swap does.
 * @param before - The state before.
 * @param after - The state after.
 * @returns Whether they did.
 */
const wentElsewhere = (before: Timelines, after: Timelines): boolean => {
  const was = focusedView(before);
  const now = focusedView(after);

  return was.open !== now.open || was.main._tag !== now.main._tag;
};

/**
 * Where the Owner went: a Timeline opened, a placement to open, the options shown or
 * filtered, or the Panes changed.
 * @param state - The state.
 * @param event - Where they went.
 * @returns The state.
 */
const navigated = (state: Timelines, event: Navigation): Timelines => {
  switch (event._tag) {
    case "Opened": {
      return opening(elsewhere(state), event.timeline);
    }

    case "Located": {
      return event.navigation === state.navigation ? { ...state, located: event.timeline } : state;
    }

    case "OptionsShown": {
      return showingOptions(elsewhere(state), event.filter);
    }

    case "OptionsFiltered": {
      const at = optionsPane(state.layout);
      const view = panesOf(state.layout.root).find((pane) => pane.id === at)?.view;

      return at === undefined || view === undefined
        ? state
        : {
            ...state,
            layout: withView(state.layout, at, {
              ...view,
              main: { _tag: "Options", filter: event.filter },
            }),
          };
    }

    case "Pane": {
      const after = paned(state, event.change);

      return wentElsewhere(state, after) ? elsewhere(after) : after;
    }

    case "Restore": {
      return restored({ ...state, restoring: event.layout });
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Moves the notification boundary up to a step the stream gave, never down.
 * @param state - The state.
 * @param place - Where the step left the stream.
 * @returns The state.
 */
const considering = (state: Timelines, place: Place): Timelines =>
  place.sequence > state.considered ? { ...state, considered: place.sequence } : state;

const apply = (state: Timelines, event: TimelinesEvent): Applied => {
  if (isNavigation(event)) {
    return { state: navigated(state, event) };
  }

  switch (event._tag) {
    case "ReadStarted": {
      return { state: started(state, event.read) };
    }

    case "Requesting": {
      return { state: requesting(state, event.read) };
    }

    case "NetworksRead": {
      return { state: startFollowing(networksRead(state, event.entries)) };
    }

    case "ListRead": {
      return { state: listRead(state, event.network, event.after, event.page) };
    }

    case "StatusRead": {
      return { state: statusRead(state, event.network, event.session, event.self) };
    }

    case "WindowRead": {
      return { state: windowRead(state, event) };
    }

    case "Vanished": {
      return {
        state: {
          ...state,
          vanished: new Set(state.vanished).add(event.timeline),
          windows: deleteIn(state.windows, event.timeline),
        },
      };
    }

    case "NetworkVanished": {
      return {
        state: startFollowing({ ...state, networks: deleteIn(state.networks, event.network) }),
      };
    }

    case "Changed": {
      const at = moved(state, event.place);

      return at === undefined
        ? { state }
        : {
            recorded: { _tag: "Changed", change: event.change },
            state: applyChange(considering(at, event.place), event.change),
          };
    }

    case "Overflowed": {
      const at = moved(state, event.place);

      return at === undefined
        ? { state }
        : {
            recorded: { _tag: "Overflowed", overflow: event.overflow },
            state: applyOverflow(considering(at, event.place), event.overflow),
          };
    }

    case "Reset": {
      return { state: applyReset(state, event.reset) };
    }

    case "OlderWanted":
    case "NewerWanted":
    case "Following": {
      return { state: marked(state, event) };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Keeps each Timeline open in one Pane at most, after anything, a merge included, which
 * may resolve two Panes' Timelines to one: the focused Pane keeps it, or, with neither
 * focused, the first in reading order, and the other is emptied, as a split with nothing
 * to show is, its options kept if they show.
 * @param state - The state.
 * @returns The state, the same when no Timeline is open twice.
 */
const onePaneEach = (state: Timelines): Timelines => {
  const { layout } = state;
  const focused = focusedPane(layout);
  const ordered = [focused, ...panesOf(layout.root).filter((pane) => pane.id !== focused.id)];
  const keeper = new Map<TimelineId, string>();
  const emptied = new Set<string>();

  for (const pane of ordered) {
    if (pane.view.open !== undefined) {
      const id = resolve(state, pane.view.open);

      if (keeper.has(id)) {
        emptied.add(pane.id);
      } else {
        keeper.set(id, pane.id);
      }
    }
  }

  return emptied.size === 0
    ? state
    : {
        ...state,
        layout: mapViews(layout, ({ id, view }) =>
          emptied.has(id) ? { ...view, divider: undefined, open: undefined } : view
        ),
      };
};

/**
 * The state after an event.
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after.
 */
export const reduceTimelines = (state: Timelines, event: TimelinesEvent): Timelines => {
  const { recorded, state: after } = apply(state, event);

  return onePaneEach(restored(found(record(after, recorded))));
};

// What to read.

/**
 * The read an open Timeline's window calls for, if any: the latest when it was never read
 * or missed something, or what lies before or after it when the Owner asked. A window is
 * read only once the stream is followed, so its `through` is never before the place the
 * stream follows from.
 * @param state - The state.
 * @param open - The Timeline, as the Owner chose it.
 * @returns The read, or none.
 */
const wantedWindow = (state: Timelines, open: TimelineId): readonly Read[] => {
  if (state.follow._tag !== "Following") {
    return [];
  }

  const id = resolve(state, open);
  const window = state.windows.get(id);

  if (state.vanished.has(id) || window?.reading === true) {
    return [];
  }

  if (window === undefined || !window.fresh) {
    return [
      {
        _tag: "Latest",
        attempt: window?.attempt ?? 0,
        generation: window?.generation ?? state.nextGeneration,
        limit: limitFor(window, state.windowCap),
        timeline: id,
      },
    ];
  }

  const [first] = window.items;
  const last = window.items.at(-1);
  const limit = Math.min(pageSize, state.windowCap);

  if (window.older && window.earlier && first !== undefined) {
    return [
      {
        _tag: "Older",
        attempt: window.attempt,
        before: first.position,
        generation: window.generation,
        limit,
        timeline: id,
      },
    ];
  }

  return window.newer && window.later && last !== undefined
    ? [
        {
          _tag: "Newer",
          after: last.position,
          attempt: window.attempt,
          generation: window.generation,
          limit,
          timeline: id,
        },
      ]
    : [];
};

/**
 * The reads the state calls for, none of them already in flight: the Network list, each
 * Network's Timelines and, once the stream is followed, its connection, and the window of
 * each Timeline open in a Pane, the focused Pane's first, latest first and older when
 * asked, once the stream is followed.
 * @param state - The state.
 * @returns The reads.
 */
export const wanted = (state: Timelines): readonly Read[] => {
  const reads: Read[] = [];

  if (!state.entries.fresh && !state.entries.reading) {
    reads.push({ _tag: "Networks", attempt: state.entries.attempt });
  }

  for (const network of state.networks.values()) {
    if (!network.list.fresh && !network.list.reading) {
      reads.push({
        _tag: "List",
        after: network.list.next,
        attempt: network.list.attempt,
        network: network.network,
      });
    }

    if (state.follow._tag === "Following" && !network.status.fresh && !network.status.reading) {
      reads.push({ _tag: "Status", attempt: network.status.attempt, network: network.network });
    }
  }

  const open = [...new Set(openIn(state.layout).map((one) => resolve(state, one)))];

  return [...reads, ...open.flatMap((one) => wantedWindow(state, one))];
};

/**
 * Where the changes stream follows from, once it can.
 * @param state - The state.
 * @returns `undefined` while the first reads are not in. Otherwise the place, or `null` to
 * follow from the start of the current version, when there was nothing to read.
 */
export const followFrom = (state: Timelines): Place | null | undefined =>
  state.follow._tag === "Waiting" ? undefined : (state.follow.place ?? null);

// What to show.

const kindOrder: Readonly<Record<Timeline["kind"], number>> = { Channel: 1, Direct: 2, Network: 0 };

const byCodeUnits = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

/**
 * Orders Timelines as the sidebar shows them: the Network's own, then Channels, then Direct
 * Messages, each by name as the Network folds it, then by id.
 * @param left - One Timeline.
 * @param right - The other.
 * @returns Their order.
 */
const sidebarOrder = (left: Timeline, right: Timeline): number =>
  kindOrder[left.kind] - kindOrder[right.kind] ||
  byCodeUnits(left.key ?? left.name, right.key ?? right.name) ||
  byCodeUnits(left.id, right.id);

/** A Network as the sidebar shows it. */
export interface SidebarNetwork {
  readonly network: NetworkId;
  readonly running: NetworkStatus | undefined;
  readonly connection: Connection;
  /** Whether Self is away there, as the Ircd confirmed it. */
  readonly away: SelfAway;
  readonly timelines: readonly Timeline[];
  /** Its Timelines are not all read yet. */
  readonly reading: boolean;
}

/**
 * The Networks, by id, each with its Timelines in sidebar order.
 * @param state - The state.
 * @returns The sidebar.
 */
export const sidebar = (state: Timelines): readonly SidebarNetwork[] =>
  [...state.networks.values()]
    .toSorted((left, right) => byCodeUnits(left.network, right.network))
    .map((network) => ({
      away: network.away,
      connection: network.connection,
      network: network.network,
      reading: !network.list.fresh,
      running: network.running,
      timelines: [...network.timelines.values()].toSorted(sidebarOrder),
    }));

/**
 * One row of a window as shown: an item, a collapsed Gap among them, or the "new" divider
 * before the first item after the Read Marker the Timeline opened with.
 */
export type Row =
  | { readonly _tag: "Item"; readonly key: string; readonly item: TimelineItem }
  | { readonly _tag: "Gap"; readonly key: string; readonly gap: WindowGap }
  | { readonly _tag: "New"; readonly key: string };

/** The key of the "new" divider's row, which no item's or Gap's can be. */
const newKey = "new";

/**
 * Whether an item stands after a divider's Read Marker, as the Daemon counts it unread:
 * its position's time is later, or there was no Read Marker.
 * @param divider - The divider.
 * @param item - The item.
 * @returns Whether it does.
 */
const isNew = (divider: Divider, item: TimelineItem): boolean =>
  divider.read === null || item.position.at > divider.read;

const gapRow = (gap: WindowGap): Row => ({ _tag: "Gap", gap, key: `gap-${cursorOf(gap.from)}` });

/**
 * A window's rows: its items in order, each collapsed Gap after the items at or before
 * where it began, and with a divider, the "new" divider before the first item after its
 * Read Marker, if the window holds one. Each row's key is stable as rows are added around it.
 * @param window - The window.
 * @param divider - The divider, if the Timeline opened with something unread.
 * @returns The rows.
 */
export const rowsOf = (window: Window, divider?: Divider): readonly Row[] => {
  const rows: Row[] = [];
  let next = 0;
  // Whether the divider still waits for its item: the first after the Read Marker.
  let waiting = divider !== undefined;

  for (const item of window.items) {
    for (
      let gap = window.gaps[next];
      gap !== undefined && comparePositions(gap.from, item.position) < 0;
      gap = window.gaps[next]
    ) {
      rows.push(gapRow(gap));
      next += 1;
    }

    if (waiting && divider !== undefined && isNew(divider, item)) {
      waiting = false;
      rows.push({ _tag: "New", key: newKey });
    }

    rows.push({ _tag: "Item", item, key: cursorOf(item.position) });
  }

  for (const gap of window.gaps.slice(next)) {
    rows.push(gapRow(gap));
  }

  return rows;
};

/** A Pane's open Timeline, as shown. */
export type Opened =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Vanished"; readonly timeline: TimelineId }
  | { readonly _tag: "Reading"; readonly timeline: TimelineId }
  | {
      readonly _tag: "Shown";
      readonly timeline: TimelineId;
      readonly window: Window;
      readonly description: Timeline | undefined;
      /** The "new" divider, if it opened with something unread. */
      readonly divider: Divider | undefined;
    };

/**
 * A Pane's open Timeline: closed, gone, being read for the first time, or its window, with
 * the Timeline itself as its Network's list has it.
 * @param state - The state.
 * @param pane - The Pane's id: the focused Pane unless another is named.
 * @returns The open Timeline.
 */
export const opened = (state: Timelines, pane = state.layout.focused): Opened => {
  const view = panesOf(state.layout.root).find((one) => one.id === pane)?.view;

  if (view?.open === undefined) {
    return { _tag: "Closed" };
  }

  const timeline = resolve(state, view.open);
  const window = state.windows.get(timeline);

  if (state.vanished.has(timeline)) {
    return { _tag: "Vanished", timeline };
  }

  if (window === undefined || (window.items.length === 0 && !window.fresh)) {
    return { _tag: "Reading", timeline };
  }

  const { divider } = view;

  return {
    _tag: "Shown",
    description:
      window.network === undefined
        ? undefined
        : state.networks.get(window.network)?.timelines.get(timeline),
    divider:
      divider === undefined || resolve(state, divider.timeline) !== timeline ? undefined : divider,
    timeline,
    window,
  };
};

// The layout this device keeps.

/**
 * What a device keeps of a Pane's view: its open Timeline, as the Owner chose it, and the
 * options' filter while they show in its place. A divider is never kept: it is taken afresh
 * as the Timeline opens again.
 */
export interface KeptView {
  readonly open: TimelineId | null;
  readonly options: string | null;
}

/** A layout as a device keeps it: plain JSON. */
export type KeptLayout = Layout<KeptView>;

/** A Pane's view as JSON writes it: a Timeline's id is text. */
interface KeptViewJson {
  readonly open: string | null;
  readonly options: string | null;
}

const KeptViewSchema = Schema.Struct({
  open: Schema.NullOr(TimelineIdSchema),
  options: Schema.NullOr(Schema.String),
});

const KeptNode: Schema.Codec<Node<KeptView>, Node<KeptViewJson>> = Schema.Union([
  Schema.TaggedStruct("Pane", { id: Schema.String, view: KeptViewSchema }),
  Schema.TaggedStruct("Split", {
    axis: Schema.Literals(["Horizontal", "Vertical"]),
    children: Schema.Array(
      Schema.Struct({
        node: Schema.suspend((): Schema.Codec<Node<KeptView>, Node<KeptViewJson>> => KeptNode),
        ratio: Schema.Finite,
      })
    ),
    id: Schema.String,
  }),
]);

/**
 * The Schema of a layout as a device keeps it, which the runtime reads what it kept with,
 * at the boundary. What it reads may still be no layout: `layoutKept` says.
 */
export const KeptLayoutSchema: Schema.Codec<KeptLayout, Layout<KeptViewJson>> = Schema.Struct({
  focused: Schema.String,
  next: Schema.Finite,
  root: KeptNode,
  zoomed: Schema.Boolean,
});

/**
 * The layout as a device keeps it, or none while one it kept waits to be taken, so what it
 * kept is never written over by the layout the page starts with.
 * @param state - The state.
 * @returns The layout to keep, or none.
 */
export const keptLayout = (state: Timelines): KeptLayout | undefined =>
  state.restoring === undefined
    ? mapViews(state.layout, ({ view }): KeptView => ({
        open: view.open ?? null,
        options: view.main._tag === "Options" ? view.main.filter : null,
      }))
    : undefined;

/**
 * A Pane's view, from what a device kept.
 * @param kept - What it kept.
 * @returns The view.
 */
const keptView = (kept: KeptView): PaneView => ({
  divider: undefined,
  main: kept.options === null ? { _tag: "Timeline" } : { _tag: "Options", filter: kept.options },
  open: kept.open ?? undefined,
});

/**
 * The layout a device kept, for `Restore`, or none when it is not one: ids that are not a
 * Pane's or a Split's, or that two share.
 * @param kept - The layout as kept.
 * @returns The layout, or none.
 */
export const layoutKept = (kept: KeptLayout): Layout<PaneView> | undefined =>
  layoutFrom(kept, keptView);

/** The longest text a kept layout may be, 64 KB: anything longer is refused unread. */
export const longestKept = 65_536;

/**
 * How deep a kept layout's JSON may nest: an object, an array, and an object for each
 * Split, the layout's own, and a Pane's and its view's.
 */
const deepestKept = 3 * deepestSplits + 4;

/**
 * How deep a JSON text nests its objects and arrays, scanned without parsing it, so a text
 * nested too deep is refused before anything recurses into it.
 * @param text - The text.
 * @returns The deepest nesting.
 */
const nesting = (text: string): number => {
  let depth = 0;
  let deepest = 0;
  let quoted = false;
  let escaped = false;

  for (const character of text) {
    if (escaped) {
      escaped = false;
    } else if (quoted) {
      escaped = character === "\\";
      quoted = character !== '"';
    } else if (character === '"') {
      quoted = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      deepest = Math.max(deepest, depth);
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }

  return deepest;
};

const decodeKept = Schema.decodeUnknownOption(Schema.fromJsonString(KeptLayoutSchema));

/**
 * The layout a device kept, from the text it kept it as, for `Restore`, or none when it is
 * not one: longer than `longestKept`, nested deeper than a layout of `deepestSplits` could
 * be, not JSON, not of the Schema, or not a layout `layoutKept` takes, with more than
 * `mostPanes` Panes among what it refuses. Nothing it is given makes it throw.
 * @param text - The text.
 * @returns The layout, or none.
 */
export const layoutKeptText = (text: string): Layout<PaneView> | undefined => {
  if (text.length > longestKept || nesting(text) > deepestKept) {
    return undefined;
  }

  const kept = Option.getOrUndefined(decodeKept(text));

  return kept === undefined ? undefined : layoutKept(kept);
};
