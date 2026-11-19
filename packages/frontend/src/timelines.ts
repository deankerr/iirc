/**
 * The Timelines a Frontend shows, as a reducer over what it read and what the changes
 * stream said. It holds each Network's Timelines, a window of each Timeline opened, and how
 * each Network's connection stands, and it says which reads the runtime should make next.
 * It never folds News: the Daemon does that, and this only keeps what it read up to date.
 *
 * @packageDocumentation
 */
import type {
  Activity,
  EndReason,
  Gap,
  NetworkEntry,
  NetworkId,
  NetworkStatus,
  SearchResults,
  PartnerKnowledge,
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
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";
import { comparePositions, cursorOf, TimelineId as TimelineIdSchema } from "@iirc/timelines";
import type { Position } from "@iirc/timelines";
import { Option, Schema, SchemaGetter } from "effect";

import { churnOf, foldNick, selfChurn } from "./churn.ts";
import type { Parsed } from "./commands.ts";
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
import type { Standing } from "./removal.ts";
import { initialSearch, reduceSearch, searchWanted } from "./search.ts";
import type { Search, SearchEvent, SearchFilters, SearchRequest } from "./search.ts";

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

/**
 * How a page before a window was wanted: `Asked`, by the Owner on purpose, as "Load older"
 * does, or `Auto`, by the view on its own, as scrolling near the top or a view that cannot
 * be scrolled does. An `Auto` page merged into a window that holds the latest never drops
 * its newest past the cap: it drops its own oldest instead, and `earlier` says more lie
 * before. An `Asked` page may drop the newest, and `later` then says more lie after.
 */
export type OlderMode = "Auto" | "Asked";

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
 * - `Connected`: in a Session, since it began, and whether it carries tags, by
 *   `message-tags`, as `known` said: `undefined` from a `SessionBegan`, which does not say,
 *   until `known` is read again.
 * - `Offline`: no Session, since when and why, when an item said so.
 */
export type Connection =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Connecting"; readonly since: number }
  | {
      readonly _tag: "Connected";
      readonly since: number;
      readonly tags: boolean | undefined;
    }
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

/**
 * One Network as the Frontend holds it, in one life: everything held of it is of that life,
 * the sequence of the `Configured` that began it, as the API names it. An answer or a step
 * of an older life changes nothing of it, and one of a newer life replaces it.
 */
export interface NetworkView {
  readonly network: NetworkId;
  readonly life: number;
  /** Whether the Daemon runs it, as `GET /api/networks` said, until it is read. */
  readonly running: NetworkStatus | undefined;
  /**
   * Whether its life was removed with its Timelines kept, as the Network list
   * the changes, or the Daemon's answer to removing it said. Its Timelines flagged
   * `removed` say so too, and {@link isRemoved} reads both.
   */
  readonly kept: boolean;
  readonly connection: Connection;
  /** The sequence of the last Session item that set `connection`, or `known`'s place. */
  readonly connectionAt: number;
  /**
   * Self's nick on the Network, as `known` last said, a `SessionBegan` said, or a change of
   * nick in the Network's own Timeline moved it, and none until one has. It is kept when the
   * Session ends, so a Timeline read while offline still says which items are Self's.
   */
  readonly self: string | undefined;
  /** The sequence of the last Session item or change of nick that set `self`, or `known`'s place. */
  readonly selfAt: number;
  /** Whether Self is away, as `known` last said, or a Session item since. */
  readonly away: SelfAway;
  /**
   * Which Direct Message partners are on the Network, as `known` last said, by the key of
   * their Timeline. A partner `known` did not say is there or gone is not in it.
   */
  readonly partners: ReadonlyMap<string, boolean>;
  /**
   * The sequence of the last step `known` is read again for: an `AwayChanged` in the
   * Network's own Timeline, or a partner coming, going, quitting, or changing nick in a
   * Direct Message Timeline, or what is learned of whether they are there, which moves its
   * `head`.
   */
  readonly statusAt: number;
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
  /** What lies before the first item is wanted, and how, or it is not. */
  readonly older: OlderMode | undefined;
  /** The Owner asked for what lies after the last item. */
  readonly newer: boolean;
  /**
   * The Owner is at the latest, so a live item past the end is kept, and the oldest go
   * past the cap. When not, one is left for reading after the end, and `later` says so.
   */
  readonly following: boolean;
  /**
   * The last item the view said is in view, at the latest or scrolled up from it, or none
   * until it says so. Only the view knows what was shown: opening a Timeline never sets it.
   */
  readonly seen: Position | undefined;
  /**
   * Where the window is read from when it is read again: around this position, as a jump
   * to a search's result reads it, until the Owner reaches the latest or asks for it, or
   * the latest with none.
   */
  readonly anchor: Position | undefined;
  /**
   * The item the Owner jumped to, which the view brings to the middle and marks, until the
   * Owner scrolls, jumps to the latest, or opens the Timeline again.
   */
  readonly target: Position | undefined;
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
 * What a Pane shows: its open Timeline, the options with what filters them, the Uploads,
 * the search, or a Direct Message not yet begun, with the nick it is to. Opening a Timeline, a placement
 * included, shows it. Each of the others keeps what the Pane showed before it as `back`,
 * which closing it shows again.
 */
export type MainView =
  | { readonly _tag: "Timeline" }
  | { readonly _tag: "Options"; readonly filter: string; readonly back: BackView }
  | { readonly _tag: "Uploads"; readonly back: BackView }
  | { readonly _tag: "Search"; readonly back: BackView }
  | ({ readonly _tag: "DirectDraft"; readonly back: BackView } & Drafted);

/**
 * A Direct Message not yet begun: the nick it is to, on a Network, and how that Network
 * folded names when `/query` read it, `null` when no Ircd had declared it, so `rfc1459`,
 * as the Daemon keys Timelines. Its Timeline is found by that mapping alone, never one read
 * at another time, which an Ircd's `005` may have changed since.
 */
export interface Drafted {
  readonly network: NetworkId;
  readonly nick: string;
  readonly declared: Casemapping | null;
}

/**
 * What a Pane showed before the options, the Uploads, the search, or a Direct Message not
 * yet begun, which closing it shows again: one step back, so nothing grows however often
 * they show.
 */
export type BackView =
  | { readonly _tag: "Timeline" }
  | { readonly _tag: "Options"; readonly filter: string }
  | { readonly _tag: "Uploads" }
  | ({ readonly _tag: "DirectDraft" } & Drafted);

/** The Timeline, as what a Pane shows or showed. */
const timelineMain = { _tag: "Timeline" } as const;

/**
 * What a Pane showing a view goes back to once another shows in front of it: the view
 * itself, one step deep, or, for the search, what it showed in front of.
 * @param main - What it shows.
 * @returns What it goes back to.
 */
const behind = (main: MainView): BackView => {
  switch (main._tag) {
    case "Timeline": {
      return timelineMain;
    }

    case "Options": {
      return { _tag: "Options", filter: main.filter };
    }

    case "Uploads": {
      return { _tag: "Uploads" };
    }

    case "DirectDraft": {
      return {
        _tag: "DirectDraft",
        declared: main.declared,
        network: main.network,
        nick: main.nick,
      };
    }

    case "Search": {
      return main.back;
    }

    default: {
      return main satisfies never;
    }
  }
};

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
  /**
   * Whether the Network list was ever read, apart from `entries`, which is not `fresh` again
   * each time the list is to be read once more, while what it held is still known.
   */
  readonly listed: boolean;
  readonly networks: ReadonlyMap<NetworkId, NetworkView>;
  /** Windows by the id of the Timeline they show. */
  readonly windows: ReadonlyMap<TimelineId, Window>;
  /** Each Timeline merged into another, and the one it went to. */
  readonly merged: ReadonlyMap<TimelineId, TimelineId>;
  /** Timelines the Daemon said it never had. */
  readonly vanished: ReadonlySet<TimelineId>;
  /**
   * The latest life of each Network known to be over with its Timelines dropped, which
   * nothing brings back: an answer of it, or of an older life, is of a life gone.
   */
  readonly over: ReadonlyMap<NetworkId, number>;
  /** The Timelines closed most recently, latest first, whose windows are kept. */
  readonly closed: readonly TimelineId[];
  /**
   * The Timeline the Daemon placed a Message the Owner said in, to open once its Network
   * lists it, if it is a Direct Message Timeline, and the Pane it was said from, as it was.
   */
  readonly located: Located | undefined;
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
  /**
   * The one search of the page, shown in at most one Pane, and kept while no Pane shows
   * it, so showing it again shows what it found.
   */
  readonly search: Search;
}

/**
 * Where a Say with `opens` was said from: the Pane, and what it showed then, as `shownIn`
 * gives it. Its placement opens only there, and only while the Pane still shows that.
 */
export interface Origin {
  readonly pane: string;
  readonly shown: string;
}

/** A placement waiting for its Timeline to be listed, and where it was said from. */
interface Located {
  readonly timeline: TimelineId;
  readonly from: Origin;
}

/**
 * What a Pane shows, as a key two views share only when they show the same thing: its open
 * Timeline, and what stands in front of it, a draft by its Network and nick.
 * @param view - The Pane's view.
 * @returns The key.
 */
const shownIn = (view: PaneView): string =>
  JSON.stringify([
    view.open ?? null,
    view.main._tag,
    view.main._tag === "DirectDraft" ? [view.main.network, view.main.nick] : null,
  ]);

/** How many items a window is read with, and the most a read again keeps. */
export const pageSize = 100;
const largestPage = 500;

/** The most items a window holds: past it, the end furthest from the Owner is dropped. */
export const windowCap = 1000;

/**
 * Whether a page before a window can be read without asking, as `Auto`, as a view does
 * near its top or while what it draws cannot be scrolled: only when there is one, and one
 * more page fits a window that holds the latest, since an `Auto` page never drops its
 * newest, so past that it would add nothing. Reading one on purpose, `Asked`, may.
 * @param window - The window, as shown.
 * @param cap - The most items a window holds.
 * @returns Whether it can.
 */
export const olderUnasked = (
  window: {
    readonly earlier: boolean;
    readonly later: boolean;
    readonly items: readonly unknown[];
  },
  cap: number
): boolean => window.earlier && (window.later || window.items.length + pageSize <= cap);

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
  | WindowRequest
  | SearchRequest;

/**
 * A read of a window: the latest, before its first item, after its last, or around a
 * position, for one generation of it. Its answer names it, so an answer for a window since dropped, or whose
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
      /** How it was wanted, which says what a merge past the cap drops. */
      readonly mode: OlderMode;
    }
  | {
      readonly _tag: "Newer";
      readonly timeline: TimelineId;
      readonly generation: number;
      readonly after: Position;
      readonly limit: number;
      readonly attempt: number;
    }
  | {
      readonly _tag: "Around";
      readonly timeline: TimelineId;
      readonly generation: number;
      readonly around: Position;
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
 * - `NetworksRead`, `ListRead`, `StatusRead`, `WindowRead`: what a read answered. The
 *   Network list is read with the Networks removed whose Timelines are kept.
 * - `NetworkRemoved`: the Daemon answered that it removed a life of a Network, keeping its
 *   Timelines or not, ahead of the step the changes stream gives for it.
 * - `Vanished`: a window's read was `UnknownTimeline`. `NetworkVanished`: a read of a
 *   Network's Timelines or Session was `UnknownNetwork`, which names no life, so only the
 *   Network list, read again, says whether the Network is gone.
 * - `Changed`, `Overflowed`, `Reset`: the changes stream's events, with the place each left.
 * - `Located`: the Daemon placed a Message the Owner said, as `/msg` does, in this Timeline,
 *   with the `navigation` its Say was submitted at, ignored once the Owner opened another,
 *   which opens once its Network lists it, if it is a Direct Message Timeline.
 * - `Opened`: the Owner opened a Timeline, which the main view then shows. `OlderWanted` and
 *   `NewerWanted`: they want what lies before or after what is held. `LatestWanted`: they
 *   want the latest, read again whole, and to follow it. `Following`: whether they are at
 *   the latest, which a window read around a result takes only when the Owner moved there.
 * - `OptionsShown`: the focused Pane shows the options, filtered as given, which counts as
 *   going elsewhere. `OptionsFiltered`: the Owner typed in their filter. `OptionsClosed`:
 *   the Pane they show in shows what it showed before them.
 * - `UploadsShown`: the Uploads show in the Pane they show in already, which takes the
 *   focus, or in the focused one, which counts as going elsewhere. `UploadsClosed`: the
 *   Pane they show in shows what it showed before them.
 * - `DraftShown`: the focused Pane shows a Direct Message not yet begun, to a nick on a
 *   Network. `DraftClosed`: the focused Pane shows what it showed before it.
 * - `Pane`: the Owner changed the Panes, as a command or a drag of a divider did.
 * - `Restore`: the layout this device kept, read as the page starts.
 * - `SearchShown`: the search shows in the Pane it shows in already, or the focused one,
 *   searching the query when one was read. `SearchClosed`: it shows what it showed before.
 *   `SearchChanged`: the Owner typed, asked for more, or moved through the results.
 * - `SearchRead`, `SearchFailed`: a page of the search, or why it gave up, in words.
 * - `Jumped`: the Owner chose a result: its Timeline opens read around its position.
 *   `TargetLeft`: the Owner scrolled away from the item jumped to.
 */
export type TimelinesEvent =
  | { readonly _tag: "ReadStarted"; readonly read: Read }
  | { readonly _tag: "Requesting"; readonly read: Read }
  | {
      readonly _tag: "NetworksRead";
      readonly entries: readonly NetworkEntry[];
    }
  | {
      readonly _tag: "NetworkRemoved";
      readonly network: NetworkId;
      readonly keep: boolean;
      /** The life it ended. */
      readonly life: number;
    }
  | {
      readonly _tag: "ListRead";
      readonly network: NetworkId;
      readonly after: TimelineId | undefined;
      readonly page: TimelineList;
    }
  | {
      readonly _tag: "StatusRead";
      readonly network: NetworkId;
      /** The life `known` is of. */
      readonly life: number;
      readonly session: SessionKnowledge;
      readonly self: UserKnowledge | null;
      readonly partners: readonly PartnerKnowledge[];
    }
  | {
      readonly _tag: "WindowRead";
      readonly read: WindowRequest;
      readonly window: TimelineWindow;
    }
  | { readonly _tag: "Vanished"; readonly timeline: TimelineId }
  | {
      readonly _tag: "NetworkVanished";
      readonly network: NetworkId;
      /** The read the Daemon answered `UnknownNetwork`: its Timelines, or its Session. */
      readonly of: "List" | "Status";
    }
  | { readonly _tag: "Changed"; readonly place: Place; readonly change: TimelineChange }
  | { readonly _tag: "Overflowed"; readonly place: Place; readonly overflow: TimelineOverflow }
  | { readonly _tag: "Reset"; readonly reset: TimelineReset }
  | { readonly _tag: "Opened"; readonly timeline: TimelineId }
  | {
      readonly _tag: "Located";
      readonly timeline: TimelineId;
      readonly navigation: number;
      readonly from: Origin;
    }
  | { readonly _tag: "OlderWanted"; readonly timeline: TimelineId; readonly mode: OlderMode }
  | { readonly _tag: "NewerWanted"; readonly timeline: TimelineId }
  | { readonly _tag: "LatestWanted"; readonly timeline: TimelineId }
  | {
      readonly _tag: "Following";
      readonly timeline: TimelineId;
      readonly following: boolean;
      readonly seen: Position | undefined;
      /**
       * The Owner moved the view there themselves, by the wheel, a touch, a press, or a
       * key, rather than a layout or a scroll the view made. Only that takes a window read
       * around a result to the latest.
       */
      readonly owned?: boolean;
    }
  | { readonly _tag: "OptionsShown"; readonly filter: string }
  | { readonly _tag: "OptionsFiltered"; readonly filter: string }
  | { readonly _tag: "OptionsClosed" }
  | { readonly _tag: "UploadsShown" }
  | { readonly _tag: "UploadsClosed" }
  | ({ readonly _tag: "DraftShown" } & Drafted)
  | { readonly _tag: "DraftClosed" }
  | { readonly _tag: "Pane"; readonly change: PaneChange }
  | { readonly _tag: "Restore"; readonly layout: Layout<PaneView> }
  | {
      readonly _tag: "SearchShown";
      readonly query: string | undefined;
      readonly parsed: Parsed<SearchFilters> | undefined;
    }
  | { readonly _tag: "SearchClosed" }
  | {
      readonly _tag: "SearchChanged";
      readonly change: Extract<SearchEvent, { readonly _tag: "Typed" | "More" | "Selected" }>;
    }
  | { readonly _tag: "SearchRead"; readonly read: SearchRequest; readonly page: SearchResults }
  | { readonly _tag: "SearchFailed"; readonly read: SearchRequest; readonly message: string }
  | { readonly _tag: "Jumped"; readonly timeline: TimelineId; readonly position: Position }
  | { readonly _tag: "TargetLeft"; readonly timeline: TimelineId };

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
  listed: false,
  located: undefined,
  merged: new Map(),
  navigation: 0,
  networks: new Map(),
  nextGeneration: 0,
  over: new Map(),
  restoring: undefined,
  search: initialSearch,
  vanished: new Set(),
  windowCap: cap,
  windows: new Map(),
});

/** Before anything is read. */
export const initialTimelines: Timelines = timelinesWith(windowCap);

const newNetwork = (network: NetworkId, life: number): NetworkView => ({
  away: { _tag: "Unknown" },
  connection: { _tag: "Unknown" },
  connectionAt: 0,
  kept: false,
  life,
  list: unreadList,
  network,
  partners: new Map(),
  running: undefined,
  self: undefined,
  selfAt: 0,
  status: unreadStatus,
  statusAt: 0,
  timelines: new Map(),
});

/**
 * Whether a Network was removed with its Timelines kept: the Daemon said so, or its
 * Timelines are flagged `removed`, as the step that removed it flags them. Nothing further
 * is said or done there, and its Timelines are only read.
 * @param network - The Network.
 * @returns Whether it was.
 */
export const isRemoved = (network: NetworkView): boolean =>
  network.kept || [...network.timelines.values()].some((timeline) => timeline.removed);

/**
 * Self's nick on a Network, as `known` said, a Session said it began with, or a change of it
 * in the Network's own Timeline moved it, and kept after the Session ends.
 * @param state - The Timelines.
 * @param id - The Network.
 * @returns The nick, or none while it is not known.
 */
export const selfOf = (state: Timelines, id: NetworkId): string | undefined =>
  state.networks.get(id)?.self;

/**
 * Whether a Network's Session carries tags, by `message-tags`, so a Message can answer
 * another there: connected, as `known` said, and neither stopped nor removed.
 * @param state - The Timelines.
 * @param id - The Network.
 * @returns Whether it does.
 */
export const carriesTags = (state: Timelines, id: NetworkId): boolean => {
  const network = state.networks.get(id);

  return (
    network !== undefined &&
    !isRemoved(network) &&
    network.running?._tag !== "Stopped" &&
    network.connection._tag === "Connected" &&
    network.connection.tags === true
  );
};

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
      return { _tag: "Connected", since: session.since, tags: session.tags };
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
      return { _tag: "Connected", since: content.at, tags: undefined };
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
      timeline.life === network.life &&
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
 * Whether an Activity in a Direct Message Timeline may have changed whether its partner is
 * on the Network.
 * @param activity - The Activity.
 * @returns Whether it may have.
 */
const changesPartner = (activity: Activity): boolean =>
  activity._tag === "CameOnline" ||
  activity._tag === "WentOffline" ||
  activity._tag === "Quit" ||
  activity._tag === "NickChanged";

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
 * Whether a connection is in a Session that has not said whether it carries tags, which a
 * `SessionBegan` does not, so `known` is read again.
 * @param connection - The connection.
 * @returns Whether it is.
 */
const tagsUnknown = (connection: Connection): boolean =>
  connection._tag === "Connected" && connection.tags === undefined;

/**
 * The sequence of the last step that learned whether a partner is there, which no item
 * says, as a change moves their Direct Message Timeline's `head`.
 * @param network - The Network.
 * @param change - The step's changes.
 * @returns The sequence, or 0 when none did.
 */
const partnerLearnedAt = (network: NetworkView, change: TimelineChange): number =>
  Math.max(
    0,
    ...change.timelines.flatMap((timeline) =>
      timeline.network === network.network &&
      timeline.life === network.life &&
      timeline.kind === "Direct" &&
      timeline.head !== null
        ? [timeline.head]
        : []
    )
  );

/**
 * Self's nick as an item says it, if it does: the one a Session begins with, or the one a
 * change of nick gives, when it is of the nick held, in the Network's own Timeline, where the
 * Client routes Self's changes of nick and no one else's.
 * @param item - The item.
 * @param kind - The kind of Timeline it is in.
 * @param held - Self's nick as held.
 * @returns The nick, or none.
 */
const selfFromItem = (
  item: TimelineItem,
  kind: Timeline["kind"] | undefined,
  held: string | undefined
): string | undefined => {
  const { content } = item;

  if (content._tag === "SessionBegan") {
    return content.nick;
  }

  return kind === "Network" &&
    held !== undefined &&
    content._tag === "Activity" &&
    content.activity._tag === "NickChanged" &&
    foldNick(content.activity.from) === foldNick(held)
    ? content.activity.to
    : undefined;
};

/**
 * Whether an item may have changed what `known` says besides the Session: Self's away, in the
 * Network's own Timeline, which User it was and what the Ircd confirmed being `known`'s to say,
 * or whether a partner is there, which a few Activities in their Direct Message Timeline may
 * have changed.
 * @param item - The item.
 * @param kind - The kind of Timeline it is in.
 * @returns Whether `known` is to be read again.
 */
const changesStatus = (item: TimelineItem, kind: Timeline["kind"] | undefined): boolean =>
  item.content._tag === "Activity" &&
  ((kind === "Network" && item.content.activity._tag === "AwayChanged") ||
    (kind === "Direct" && changesPartner(item.content.activity)));

/**
 * Brings a Network's connection up to date with the Session items of one step, when they
 * are later than what set it and of the life held: an item of a Timeline of an older life,
 * as the step names it or as one let go of when that life ended, says nothing of it.
 * @param network - The Network.
 * @param change - The step's changes.
 * @param vanished - The Timelines let go of, those of lives over among them.
 * @returns The Network.
 */
const changeConnection = (
  network: NetworkView,
  change: TimelineChange,
  vanished: ReadonlySet<TimelineId>
): NetworkView => {
  let { connection, connectionAt, self, selfAt, statusAt } = network;

  const older = (timeline: TimelineId) =>
    vanished.has(timeline) ||
    change.timelines.some((one) => one.id === timeline && one.life < network.life);

  for (const item of change.items) {
    const ours = item.network === network.network && !older(item.timeline);
    const said = ours ? connectionFromItem(item) : undefined;

    // A Session begins or ends, with every partner's presence new to it.
    if (said !== undefined && item.sequence > connectionAt) {
      connection = said;
      connectionAt = item.sequence;
      statusAt = Math.max(statusAt, item.sequence);
    }

    const kind = ours ? network.timelines.get(item.timeline)?.kind : undefined;

    const nick = ours && item.sequence > selfAt ? selfFromItem(item, kind, self) : undefined;

    if (nick !== undefined) {
      self = nick;
      selfAt = item.sequence;
    }

    if (ours && changesStatus(item, kind)) {
      statusAt = Math.max(statusAt, item.sequence);
    }
  }

  statusAt = Math.max(statusAt, partnerLearnedAt(network, change));

  const heldSelf =
    self === network.self && selfAt === network.selfAt ? network : { ...network, self, selfAt };

  const connected =
    connectionAt === network.connectionAt
      ? heldSelf
      : {
          ...heldSelf,
          away: awayOfConnection(connection),
          connection,
          connectionAt,
          partners: new Map(),
        };

  // Whether the Session carries tags, Self's away, and the partners are `known`'s to say.
  return statusAt === network.statusAt && !tagsUnknown(connected.connection)
    ? connected
    : { ...connected, status: { ...connected.status, fresh: false }, statusAt };
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
 * Which Direct Message partners are on the Network, as `known` says: only those it says,
 * while registered.
 * @param session - The Session, as `known` says.
 * @param partners - The partners, as `known` says.
 * @returns Whether each is, by the key of their Timeline.
 */
const partnersOfKnown = (
  session: SessionKnowledge,
  partners: readonly PartnerKnowledge[]
): ReadonlyMap<string, boolean> =>
  new Map(
    session._tag === "Registered"
      ? partners.flatMap(({ here, key }) => (here._tag === "Known" ? [[key, here.value]] : []))
      : []
  );

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
 * Lets go of Networks removed without keeping their Timelines, and of every Timeline of
 * theirs: no route reads them again. Their windows go, a Pane that showed one shows
 * nothing, as a split with nothing to show does, and the search begins again, so nothing
 * it found of them stays.
 * @param state - The state.
 * @param gone - The Networks.
 * @param named - The Timelines the Daemon named as dropped, besides those the Networks hold.
 * @returns The state.
 */
const dropped = (
  state: Timelines,
  gone: ReadonlySet<NetworkId>,
  named: readonly TimelineId[]
): Timelines => {
  const ids = new Set(named);

  for (const network of gone) {
    for (const id of state.networks.get(network)?.timelines.keys() ?? []) {
      ids.add(id);
    }
  }

  for (const [id, window] of state.windows) {
    if (window.network !== undefined && gone.has(window.network)) {
      ids.add(id);
    }
  }

  const isDropped = (timeline: TimelineId) =>
    ids.has(timeline) || ids.has(resolve(state, timeline));

  return {
    ...state,
    closed: state.closed.filter((one) => !isDropped(one)),
    layout: mapViews(state.layout, ({ view }) =>
      view.open !== undefined && isDropped(view.open)
        ? { ...view, divider: undefined, open: undefined }
        : view
    ),
    networks: new Map([...state.networks].filter(([network]) => !gone.has(network))),
    search: reduceSearch(state.search, { _tag: "Restarted" }),
    vanished: new Set([...state.vanished, ...ids]),
    windows: new Map([...state.windows].filter(([id]) => !ids.has(id))),
  };
};

/**
 * How a life compares with the one held of a Network: `Older`, the `Same`, or `Newer`, as
 * any life is when none is held.
 * @param state - The state.
 * @param network - The Network.
 * @param life - The life an answer or a step names.
 * @returns How it compares.
 */
const compareLife = (
  state: Timelines,
  network: NetworkId,
  life: number
): "Older" | "Same" | "Newer" => {
  const held = state.networks.get(network)?.life;

  if (life <= (state.over.get(network) ?? 0) || (held !== undefined && life < held)) {
    return "Older";
  }

  return life === held ? "Same" : "Newer";
};

/**
 * Lets go of a life of a Network that is over, with its Timelines, and remembers it is,
 * so no answer of it brings it back.
 * @param state - The state.
 * @param network - The Network.
 * @param life - The life.
 * @returns The state.
 */
const forgotten = (state: Timelines, network: NetworkId, life: number): Timelines => {
  const gone = dropped(state, new Set([network]), []);

  return life <= (state.over.get(network) ?? 0)
    ? gone
    : { ...gone, over: setIn(state.over, network, life) };
};

/** The state once a life is held, and whether it is the life held now. */
interface Lived {
  readonly state: Timelines;
  readonly held: boolean;
}

/**
 * Holds a life of a Network: an older one than held changes nothing, and a newer one
 * replaces what is held, its Timelines let go of as a drop does, and begins afresh, to be
 * read.
 * @param state - The state.
 * @param network - The Network.
 * @param life - The life.
 * @returns The state, and whether the life is the one held now.
 */
const living = (state: Timelines, network: NetworkId, life: number): Lived => {
  switch (compareLife(state, network, life)) {
    case "Older": {
      return { held: false, state };
    }

    case "Same": {
      return { held: true, state };
    }

    case "Newer": {
      const old = state.networks.get(network);
      const cleared = old === undefined ? state : forgotten(state, network, old.life);

      return {
        held: true,
        state: {
          ...cleared,
          networks: setIn(cleared.networks, network, newNetwork(network, life)),
        },
      };
    }

    default: {
      return { held: false, state };
    }
  }
};

/**
 * Ends a life of a Network: kept, it is only read from then on, and not kept, it and its
 * Timelines are let go of. A removal of an older life than the one held changes nothing.
 * One of a newer life, or of a Network not held, as one added elsewhere disabled and with no
 * Channels, which no Timeline ever named, holds that life first, so a kept one is read from
 * now on, and a dropped one is known to be over.
 * @param state - The state.
 * @param removal - The Network, the life it ended, and whether its Timelines were kept.
 * @returns The state.
 */
const ended = (
  state: Timelines,
  removal: { readonly network: NetworkId; readonly life: number; readonly keep: boolean }
): Timelines => {
  const lived = living(state, removal.network, removal.life);
  const held = lived.state.networks.get(removal.network);

  if (!lived.held || held === undefined) {
    return state;
  }

  return removal.keep
    ? {
        ...lived.state,
        networks: setIn(lived.state.networks, removal.network, { ...held, kept: true }),
      }
    : forgotten(lived.state, removal.network, removal.life);
};

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

  // A Timeline of a life newer than held, or of a Network not held: that life began since,
  // so it is held, and its list and connection are read.
  let lived = state;

  for (const timeline of change.timelines) {
    ({ state: lived } = living(lived, timeline.network, timeline.life));
  }

  let { networks } = lived;

  const touched = new Set([
    ...change.timelines.map((timeline) => timeline.network),
    ...change.merged.map((tombstone) => tombstone.network),
    ...change.items.map((item) => item.network),
  ]);

  networks = mapValues(networks, (network) =>
    touched.has(network.network)
      ? changeConnection(changeList(network, change, merged), change, lived.vanished)
      : network
  );

  const windows = new Map<TimelineId, Window>();

  // The window of a Timeline merged into another goes, and the Timeline it went to is read
  // when it is open.
  for (const [id, window] of lived.windows) {
    if (!merged.has(id)) {
      windows.set(id, changeWindow(window, change, state.windowCap));
    }
  }

  // A merge moves items into a Timeline with a lower id, so a page read after it may repeat
  // what one read before it found: the search begins again.
  const search =
    change.merged.length > 0 ? reduceSearch(lived.search, { _tag: "Restarted" }) : lived.search;

  let changed: Timelines = { ...lived, merged, networks, search, windows };

  // A life removed, whether or not it had Timelines, and the Timelines dropped with one,
  // which go whatever life is held, since none is of a newer one.
  for (const removal of [
    ...change.removals,
    ...change.dropped.map((one) => ({ keep: false, life: one.life, network: one.network })),
  ]) {
    changed = ended(changed, removal);
  }

  return change.dropped.length === 0
    ? changed
    : dropped(
        changed,
        new Set(),
        change.dropped.map((one) => one.id)
      );
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
 * overflow that touched it, whose changes never came. An answer that is not current leaves
 * what it is of stale, to be read again. Which life of a Network an answer is of is the
 * other rule, `living`.
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
    // What overflowed may have been a merge, whose changes never came.
    search: reduceSearch(state.search, { _tag: "Restarted" }),
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
    search: reduceSearch(state.search, { _tag: "Restarted" }),
    vanished: new Set(),
    windows: mapValues(state.windows, (window) => ({
      ...window,
      earlier: false,
      fresh: false,
      gaps: [],
      items: [],
      later: false,
      newer: false,
      older: undefined,
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

    case "Search": {
      return { ...state, search: reduceSearch(state.search, { _tag: "Started", read }) };
    }

    case "Latest":
    case "Older":
    case "Newer":
    case "Around": {
      const window = state.windows.get(read.timeline);

      // A read for a window since dropped starts nothing.
      if (window !== undefined && window.generation !== read.generation) {
        return state;
      }

      // A Timeline read for the first time holds a window with nothing in it yet, which
      // takes no changes until it is read, and is a generation of its own.
      const placeholder: Window = window ?? {
        ...unread,
        anchor: undefined,
        earlier: false,
        following: true,
        gaps: [],
        generation: read.generation,
        items: [],
        later: false,
        network: undefined,
        newer: false,
        older: undefined,
        seen: undefined,
        target: undefined,
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
 * Takes the Network list: every Network the Daemon holds, live or removed with its
 * Timelines kept, read in one pass.
 * @param state - The state.
 * @param entries - Each Network, its life, and whether it runs or is kept.
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

  let read = state;

  /**
   * Takes what the list says of a life of a Network, unless it is of a life gone.
   * @param network - The Network.
   * @param life - The life.
   * @param change - What the list says of it.
   */
  const take = (network: NetworkId, life: number, change: (view: NetworkView) => NetworkView) => {
    const lived = living(read, network, life);
    const held = lived.state.networks.get(network);

    read =
      lived.held && held !== undefined
        ? { ...lived.state, networks: setIn(lived.state.networks, network, change(held)) }
        : lived.state;
  };

  // A Network removed with its Timelines kept is read as any other, but for its Session,
  // which it has no more. A life once removed stays so, whatever an older list said.
  for (const entry of entries) {
    take(entry.network, entry.life, (view) =>
      entry._tag === "Kept" ? { ...view, kept: true } : { ...view, running: entry.status }
    );
  }

  // The one list names every Network the Daemon holds, live or kept, as one state of it, so
  // a Network it does not name, whose life began before the list was asked for, is over,
  // with its Timelines dropped. One begun since, as the stream gave it, is not in the list
  // yet. Before the stream is followed, every Network held came of a read.
  const listed = new Set(entries.map((one) => one.network));
  const asked = state.follow._tag === "Following" ? state.entries.from : Number.POSITIVE_INFINITY;

  for (const held of read.networks.values()) {
    if (!listed.has(held.network) && held.life <= asked) {
      read = forgotten(read, held.network, held.life);
    }
  }

  return {
    ...read,
    entries: { ...state.entries, attempt: 0, fresh: true, reading: false },
    listed: true,
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
 * Reads a Network's Timelines again from the first page, after a wait.
 * @param state - The state.
 * @param id - The Network.
 * @returns The state.
 */
const readAgain = (state: Timelines, id: NetworkId): Timelines => {
  const network = state.networks.get(id);

  if (network === undefined) {
    return state;
  }

  const stale = staleList(network);

  return {
    ...state,
    networks: setIn(state.networks, id, {
      ...stale,
      list: { ...stale.list, attempt: network.list.attempt + 1, reading: false },
    }),
  };
};

/**
 * A Network with a page of its Timelines taken: the first page of a round replacing what
 * is held, and the rest adding to it, each Timeline the one changed last.
 * @param network - The Network.
 * @param page - The page.
 * @param after - The Timeline the page was read after, or `undefined` for the first.
 * @param merged - Every Timeline merged so far.
 * @returns The Network.
 */
const pageTaken = (
  network: NetworkView,
  page: TimelineList,
  after: TimelineId | undefined,
  merged: ReadonlyMap<TimelineId, TimelineId>
): NetworkView => {
  const first = after === undefined;
  const timelines = first ? new Map<TimelineId, Timeline>() : new Map(network.timelines);

  for (const timeline of page.timelines) {
    const held = timelines.get(timeline.id);

    if (!merged.has(timeline.id) && (held === undefined || timeline.changed > held.changed)) {
      timelines.set(timeline.id, timeline);
    }
  }

  const last = page.timelines.at(-1);
  const more = page.more && last !== undefined;

  return {
    ...network,
    list: {
      attempt: 0,
      fresh: !more,
      next: more ? last.id : undefined,
      reading: false,
      through: minOf(first ? undefined : network.list.through, page.through ?? 0),
    },
    timelines,
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
  // A page of a newer life begins it, and one of an older life is of a life gone: its
  // Timelines are never installed, and the life now is read from its first page.
  const life = page.timelines[0]?.life;
  const lived = life === undefined ? { held: true, state } : living(state, id, life);

  if (!lived.held) {
    return readAgain(state, id);
  }

  const current = lived.state.networks.get(id);

  // A page of a round given up since, because the list was marked to be read again.
  if (current === undefined || after !== current.list.next) {
    return current === undefined
      ? lived.state
      : {
          ...lived.state,
          networks: setIn(lived.state.networks, id, {
            ...current,
            list: { ...current.list, reading: false },
          }),
        };
  }

  const through = page.through ?? 0;
  const versioned = waitingFor(lived.state, page.version);
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

  let caughtUp = pageTaken(network, page, after, versioned.merged);

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
 * @param event - What `known` said: the Network, its Session, and Self.
 * @returns The state.
 */
const statusRead = (
  state: Timelines,
  {
    life,
    network: id,
    partners,
    self,
    session,
  }: Extract<TimelinesEvent, { readonly _tag: "StatusRead" }>
): Timelines => {
  // Of a newer life, held or not, it begins that life, whose Timelines and Session are
  // read afresh. Of an older one, it says nothing of the life held, whose Session is read
  // again.
  const comparison = compareLife(state, id, life);

  if (comparison === "Newer") {
    return living(state, id, life).state;
  }

  const network = state.networks.get(id);

  if (network === undefined) {
    return state;
  }

  const { from } = network.status;
  const newer = network.connectionAt > from;

  // Begun before a reset, or an overflow of its Network, either of which may have held a
  // Session item `known` does not reflect and the stream never gave: read it again.
  if (comparison === "Older" || !isCurrent(state, from, { _tag: "Network", network: id })) {
    return {
      ...state,
      networks: setIn(state.networks, id, {
        ...network,
        status: { ...network.status, attempt: network.status.attempt + 1, reading: false },
      }),
    };
  }

  const connection = newer ? network.connection : connectionOf(session);

  return {
    ...state,
    networks: setIn(state.networks, id, {
      ...network,
      away: newer ? network.away : awayOfKnown(session, self),
      connection,
      connectionAt: Math.max(network.connectionAt, from),
      partners: newer ? network.partners : partnersOfKnown(session, partners),
      // What known says, unless a Session item or a change of nick after its read began did.
      // With no Session it says none, which leaves the nick Self had.
      self: from >= network.selfAt && self !== null ? self.nick : network.self,
      selfAt: from >= network.selfAt && self !== null ? from : network.selfAt,
      // A step after the read began may not be in it, nor whether a Session that
      // began after it carries tags, so it is read again.
      status: {
        ...network.status,
        attempt: 0,
        fresh: network.statusAt <= from && !tagsUnknown(connection),
        reading: false,
      },
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
 * joined again, and past the cap, the end furthest from where the page went dropped, but
 * for a page the view read on its own before a window that holds the latest, which drops
 * its own oldest instead, so the latest is never lost to a read the Owner did not ask for.
 * @param window - The window.
 * @param read - The page, brought up to date on its own.
 * @param request - How it was read: before or after the window, and how it was wanted.
 * @param cap - The most items a window holds.
 * @returns The window.
 */
const mergePage = (
  window: Window,
  read: Window,
  request: Extract<WindowRequest, { readonly _tag: "Older" | "Newer" }>,
  cap: number
): Window => {
  const side = request._tag;
  const keepsLatest = request._tag === "Older" && request.mode === "Auto" && !window.later;

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
    side === "Newer" || keepsLatest
  );
};

/**
 * Whether a page was read from the window's edge as it is now: before its first item, or
 * after its last. The latest, and a window around a position, are read from no edge.
 * @param window - The window.
 * @param read - The read the page answers.
 * @returns Whether it fits.
 */
const atEdge = (window: Window, read: WindowRequest): boolean => {
  switch (read._tag) {
    case "Latest":
    case "Around": {
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
 * Takes a window read. The latest, or a window around a position, replaces what is held,
 * and older or newer items join it. Either
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

  if (read._tag === "Older" || read._tag === "Newer") {
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
        ? mergePage(done, page, read, state.windowCap)
        : { ...done, fresh: false };
    }

    return {
      ...state,
      windows: setIn(state.windows, requested, { ...merged, newer: false, older: undefined }),
    };
  }

  const fresh: Window = {
    anchor: held.anchor,
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
    older: undefined,
    reading: false,
    seen: held.seen,
    target: held.target,
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
 * A view of iirc's own, which a Pane shows in front of its Timeline, and the sidebar lists
 * as a row, as it does a Timeline. Each shows in one Pane at most.
 */
export type OwnView = "Search" | "Uploads" | "Options";

/**
 * Which view of iirc's own a Pane shows, if one.
 * @param main - What it shows.
 * @returns The view, or none.
 */
const ownViewOf = (main: MainView): OwnView | undefined =>
  main._tag === "Search" || main._tag === "Uploads" || main._tag === "Options"
    ? main._tag
    : undefined;

/**
 * What the sidebar marks as chosen: what the focused Pane shows, a view of iirc's own or
 * its Timeline, or nothing, as for a Direct Message not yet begun, which has no row. A
 * Timeline open behind something else is not chosen, so choosing it shows it.
 */
export type Chosen =
  | { readonly _tag: OwnView }
  | { readonly _tag: "Timeline"; readonly timeline: TimelineId }
  | { readonly _tag: "Nothing" };

/**
 * What the sidebar marks as chosen, derived from what the focused Pane shows.
 * @param state - The state.
 * @returns What it marks.
 */
export const chosenOf = (state: Timelines): Chosen => {
  const view = focusedView(state);
  const own = ownViewOf(view.main);

  if (own !== undefined) {
    return { _tag: own };
  }

  return view.main._tag === "Timeline" && view.open !== undefined
    ? { _tag: "Timeline", timeline: resolve(state, view.open) }
    : { _tag: "Nothing" };
};

/**
 * What the sidebar marks, more quietly than what is chosen: each Timeline, and each view of
 * iirc's own, that a Pane other than the focused one shows, with that Pane's number, counted
 * as the Panes lie. A Timeline behind something else is not shown, as for `chosenOf`.
 * @param state - The state.
 * @returns Each Timeline or view shown elsewhere, with its Pane's number.
 */
export const elsewhereOf = (state: Timelines): ReadonlyMap<TimelineId | OwnView, number> =>
  new Map(
    panesOf(state.layout.root).flatMap(
      (pane, index): (readonly [TimelineId | OwnView, number])[] => {
        const own = ownViewOf(pane.view.main);

        if (pane.id === state.layout.focused) {
          return [];
        }

        if (own !== undefined) {
          return [[own, index + 1] as const];
        }

        return pane.view.main._tag !== "Timeline" || pane.view.open === undefined
          ? []
          : [[resolve(state, pane.view.open), index + 1] as const];
      }
    )
  );

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
        anchor: undefined,
        following: true,
        fresh: window.fresh && !window.later && window.anchor === undefined,
        seen: undefined,
        target: undefined,
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
  event: Extract<
    TimelinesEvent,
    { readonly _tag: "OlderWanted" | "NewerWanted" | "LatestWanted" | "Following" }
  >
): Timelines => {
  const id = resolve(state, event.timeline);
  const window = state.windows.get(id);

  if (window === undefined) {
    return state;
  }

  switch (event._tag) {
    // Asked once, it stays asked until read, whatever else wants it meanwhile.
    case "OlderWanted": {
      const mode = window.older === "Asked" ? "Asked" : event.mode;

      return {
        ...state,
        windows: setIn(state.windows, id, { ...window, older: window.earlier ? mode : undefined }),
      };
    }

    case "NewerWanted": {
      return { ...state, windows: setIn(state.windows, id, { ...window, newer: window.later }) };
    }

    // Read again from the latest, which replaces what is held, followed from there.
    case "LatestWanted": {
      return {
        ...state,
        windows: setIn(state.windows, id, {
          ...window,
          anchor: undefined,
          following: true,
          fresh: false,
          newer: false,
          older: undefined,
          target: undefined,
        }),
      };
    }

    case "Following": {
      // A window read around a result stays where the jump put it, and is not at the latest,
      // until the Owner moves it there themselves.
      if (window.anchor !== undefined && event.following && event.owned !== true) {
        return state;
      }

      return {
        ...state,
        windows: setIn(state.windows, id, {
          ...window,
          // At the latest, it is read from the latest again.
          anchor: event.following ? undefined : window.anchor,
          following: event.following,
          seen: event.seen,
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
 * Opens a placed Timeline in the Pane its Say was said from, and only while that Pane
 * still shows what it showed then, or the Timeline already: else it is let go, with the
 * Timeline listed. In the focused Pane it opens as opening one does. In another, which the
 * focus left for one showing the same, it takes that Pane's place without the focus, unless
 * another Pane has it open.
 * @param state - The state.
 * @param from - Where it was said from.
 * @param timeline - The Timeline.
 * @returns The state.
 */
const placing = (state: Timelines, from: Origin, timeline: TimelineId): Timelines => {
  const pane = panesOf(state.layout.root).find((one) => one.id === from.pane);

  if (pane === undefined) {
    return state;
  }

  const showsIt =
    pane.view.open !== undefined && resolve(state, pane.view.open) === resolve(state, timeline);

  if (shownIn(pane.view) !== from.shown && !showsIt) {
    return state;
  }

  if (pane.id === state.layout.focused) {
    return opening(state, timeline);
  }

  return paneOf(state, timeline) === undefined
    ? retained(state, {
        ...state,
        layout: withView(state.layout, pane.id, viewOf(state, timeline)),
      })
    : state;
};

/**
 * Where a Say said now is said from: the focused Pane, and what it shows.
 * @param state - The state.
 * @returns The origin, which its placement carries.
 */
export const originOf = (state: Timelines): Origin => ({
  pane: state.layout.focused,
  shown: shownIn(focusedView(state)),
});

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
    const timeline = network.timelines.get(located.timeline);

    if (timeline !== undefined) {
      const unset = { ...state, located: undefined };

      return timeline.kind === "Direct" && !timeline.detached
        ? placing(unset, located.from, timeline.id)
        : unset;
    }
  }

  return state;
};

/** Every mapping, for a draft made before its Network declared one. */
const casemappings: readonly Casemapping[] = ["ascii", "rfc1459", "rfc1459-strict", "rfc8265"];

/**
 * The Direct Message Timeline a draft's nick keys on its Network, once one is listed: one
 * that follows its partner, under the key the nick folds to by the mapping the draft was
 * made with, as `/query` read it, never one held from another time. A draft made before any
 * mapping was declared meets a Timeline only when every mapping folds its nick alike, since
 * the Ircd may yet declare one under which `[bob]` and `{bob}` are two Users. Until then it
 * stays a draft, which still sends to the nick as typed.
 * @param state - The state.
 * @param draft - The draft.
 * @returns The Timeline, or none.
 */
export const draftTimeline = (state: Timelines, draft: Drafted): TimelineId | undefined => {
  const key = casefold(draft.declared ?? defaultCasemapping, draft.nick);

  if (
    draft.declared === null &&
    casemappings.some((casemapping) => casefold(casemapping, draft.nick) !== key)
  ) {
    return undefined;
  }

  return [...(state.networks.get(draft.network)?.timelines.values() ?? [])].find(
    (one) => one.kind === "Direct" && !one.detached && one.key === key
  )?.id;
};

/**
 * Each draft shown whose Timeline is listed now shows it in its place, in the same Pane,
 * as when the partner spoke first or another Frontend said something to them. Neither the
 * focus nor `navigation` moves, since the Owner went nowhere. A draft whose Timeline another
 * Pane has open stays.
 * @param state - The state.
 * @returns The state.
 */
const draftsMet = (state: Timelines): Timelines => {
  let after = state;

  for (const pane of panesOf(state.layout.root)) {
    const { main } = pane.view;

    const timeline = main._tag === "DirectDraft" ? draftTimeline(state, main) : undefined;

    if (timeline !== undefined && paneOf(after, timeline) === undefined) {
      after = retained(after, {
        ...after,
        layout: withView(after.layout, pane.id, viewOf(after, timeline)),
      });
    }
  }

  return after;
};

/**
 * The draft a Pane holds: shown, or behind the options, the Uploads, or the search, which
 * closing shows.
 * @param main - What the Pane shows.
 * @returns The draft, or none.
 */
const draftIn = (main: MainView): Drafted | undefined => {
  if (main._tag === "DirectDraft") {
    return main;
  }

  return main._tag !== "Timeline" && main.back._tag === "DirectDraft" ? main.back : undefined;
};

/**
 * The drafts that came to show their Timeline between two states, by the Pane they were
 * held in, shown or behind the options or the search, whose closing shows the Timeline in
 * one step: so the runtime can carry a draft's unsent text, and anything said of it later,
 * to its Timeline's composer.
 * @param before - The state before.
 * @param after - The state after.
 * @returns Each draft met, with its Timeline.
 */
export const draftsMetBetween = (
  before: Timelines,
  after: Timelines
): readonly (Drafted & { readonly timeline: TimelineId })[] =>
  panesOf(before.layout.root).flatMap((pane) => {
    const draft = draftIn(pane.view.main);
    const now = panesOf(after.layout.root).find((one) => one.id === pane.id)?.view;

    if (draft === undefined || now?.main._tag !== "Timeline" || now.open === undefined) {
      return [];
    }

    const timeline = draftTimeline(after, draft);

    return timeline !== undefined && resolve(after, now.open) === timeline
      ? [{ declared: draft.declared, network: draft.network, nick: draft.nick, timeline }]
      : [];
  });

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
    readonly _tag:
      | "Opened"
      | "Located"
      | "OptionsShown"
      | "OptionsFiltered"
      | "OptionsClosed"
      | "UploadsShown"
      | "UploadsClosed"
      | "DraftShown"
      | "DraftClosed"
      | "Pane"
      | "Restore"
      | "SearchShown"
      | "SearchClosed"
      | "Jumped";
  }
>;

const navigations: ReadonlySet<string> = new Set([
  "Opened",
  "Located",
  "OptionsShown",
  "OptionsFiltered",
  "OptionsClosed",
  "UploadsShown",
  "UploadsClosed",
  "DraftShown",
  "DraftClosed",
  "Pane",
  "Restore",
  "SearchShown",
  "SearchClosed",
  "Jumped",
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
 * A Pane's view.
 * @param layout - The layout.
 * @param pane - The Pane's id.
 * @returns Its view, or an empty one.
 */
const viewIn = (layout: Layout<PaneView>, pane: string): PaneView =>
  panesOf(layout.root).find((one) => one.id === pane)?.view ?? emptyView;

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
  const view = viewIn(layout, at);
  const before = view.main._tag === "Options" ? view.main.back : behind(view.main);
  // Options shown again in front of the search they were behind go back to its Timeline.
  const back = before._tag === "Options" ? timelineMain : before;

  return {
    ...state,
    layout: withView({ ...layout, focused: at }, at, {
      ...view,
      main: { _tag: "Options", back, filter },
    }),
  };
};

/**
 * What a Pane shows once what stood in front of it closes: what it showed before, the
 * options or the Uploads only while no other Pane shows them since, as each shows in one
 * Pane at most.
 * @param layout - The layout.
 * @param at - The Pane.
 * @param back - What it showed before.
 * @returns What it shows.
 */
const backTo = (layout: Layout<PaneView>, at: string, back: BackView): MainView => {
  switch (back._tag) {
    case "Timeline": {
      return timelineMain;
    }

    case "Options": {
      const elsewhere = panesOf(layout.root).some(
        (pane) => pane.id !== at && pane.view.main._tag === "Options"
      );

      return elsewhere ? timelineMain : { ...back, back: timelineMain };
    }

    case "Uploads": {
      const elsewhere = panesOf(layout.root).some(
        (pane) => pane.id !== at && pane.view.main._tag === "Uploads"
      );

      return elsewhere ? timelineMain : { _tag: "Uploads", back: timelineMain };
    }

    case "DirectDraft": {
      return { ...back, back: timelineMain };
    }

    default: {
      return back satisfies never;
    }
  }
};

/**
 * Closes the options, showing what their Pane showed before them.
 * @param state - The state.
 * @returns The state.
 */
const closingOptions = (state: Timelines): Timelines => {
  const { layout } = state;
  const at = optionsPane(layout);

  if (at === undefined) {
    return state;
  }

  const view = viewIn(layout, at);
  const back = view.main._tag === "Options" ? view.main.back : timelineMain;

  return { ...state, layout: withView(layout, at, { ...view, main: backTo(layout, at, back) }) };
};

/**
 * The Pane the Uploads show in, if any.
 * @param layout - The layout.
 * @returns Its id, or none.
 */
const uploadsPane = (layout: Layout<PaneView>): string | undefined =>
  panesOf(layout.root).find((pane) => pane.view.main._tag === "Uploads")?.id;

/**
 * Shows the Uploads: in the Pane they show in already, which takes the focus, or else in
 * the focused Pane, in front of what it showed, which closing them shows again.
 * @param state - The state.
 * @returns The state.
 */
const showingUploads = (state: Timelines): Timelines => {
  const { layout } = state;
  const at = uploadsPane(layout) ?? layout.focused;
  const view = viewIn(layout, at);
  const before = view.main._tag === "Uploads" ? view.main.back : behind(view.main);
  // Shown again in front of the search they were behind go back to its Timeline.
  const back = before._tag === "Uploads" ? timelineMain : before;

  return {
    ...state,
    layout: withView({ ...layout, focused: at }, at, { ...view, main: { _tag: "Uploads", back } }),
  };
};

/**
 * Closes the Uploads, showing what their Pane showed before them.
 * @param state - The state.
 * @returns The state.
 */
const closingUploads = (state: Timelines): Timelines => {
  const { layout } = state;
  const at = uploadsPane(layout);

  if (at === undefined) {
    return state;
  }

  const view = viewIn(layout, at);
  const back = view.main._tag === "Uploads" ? view.main.back : timelineMain;

  return { ...state, layout: withView(layout, at, { ...view, main: backTo(layout, at, back) }) };
};

/**
 * Shows a Direct Message not yet begun in the focused Pane, in front of what it showed,
 * which closing it shows again.
 * @param state - The state.
 * @param draft - The nick it is to, its Network, and how that folded names.
 * @returns The state.
 */
const showingDraft = (state: Timelines, { declared, network, nick }: Drafted): Timelines => {
  const { layout } = state;
  const view = focusedView(state);
  const back = view.main._tag === "DirectDraft" ? view.main.back : behind(view.main);

  return {
    ...state,
    layout: withView(layout, layout.focused, {
      ...view,
      main: { _tag: "DirectDraft", back, declared, network, nick },
    }),
  };
};

/**
 * Closes the focused Pane's Direct Message not yet begun, showing what it showed before.
 * @param state - The state.
 * @returns The state.
 */
const closingDraft = (state: Timelines): Timelines => {
  const { layout } = state;
  const view = focusedView(state);

  return view.main._tag === "DirectDraft"
    ? {
        ...state,
        layout: withView(layout, layout.focused, {
          ...view,
          main: backTo(layout, layout.focused, view.main.back),
        }),
      }
    : state;
};

/**
 * The Pane the search shows in, if any.
 * @param layout - The layout.
 * @returns Its id, or none.
 */
const searchPane = (layout: Layout<PaneView>): string | undefined =>
  panesOf(layout.root).find((pane) => pane.view.main._tag === "Search")?.id;

/**
 * Shows the search: in the Pane it shows in already, which takes the focus, or else in the
 * focused Pane, in place of what it showed, which closing it shows again. A query read is
 * searched, from its first page.
 * @param state - The state.
 * @param event - The query, as typed, and read, if one was given.
 * @returns The state.
 */
const showingSearch = (
  state: Timelines,
  event: Extract<TimelinesEvent, { readonly _tag: "SearchShown" }>
): Timelines => {
  const { layout } = state;
  const at = searchPane(layout) ?? layout.focused;
  const view = viewIn(layout, at);
  const back = behind(view.main);

  const search =
    event.query === undefined || event.parsed === undefined
      ? state.search
      : reduceSearch(state.search, {
          _tag: "Submitted",
          parsed: event.parsed,
          query: event.query,
        });

  return {
    ...state,
    layout: withView({ ...layout, focused: at }, at, { ...view, main: { _tag: "Search", back } }),
    search,
  };
};

/**
 * Closes the search, showing what its Pane showed before: the options, unless they show
 * in another Pane since, or its Timeline. What it found is kept.
 * @param state - The state.
 * @returns The state.
 */
const closingSearch = (state: Timelines): Timelines => {
  const { layout } = state;
  const at = searchPane(layout);

  if (at === undefined) {
    return state;
  }

  const view = viewIn(layout, at);
  const back = view.main._tag === "Search" ? view.main.back : behind(view.main);

  return { ...state, layout: withView(layout, at, { ...view, main: backTo(layout, at, back) }) };
};

/**
 * Opens a Timeline read around a position, as choosing a search's result does: in the
 * Pane that has it open already, or the Pane the search shows in, or the focused Pane,
 * which takes the focus. Its window is read again, as a new generation, around the
 * position, never following, so live items wait beyond it and the latest stays a jump
 * away, and the item there is the one to bring into view and mark. Nothing is marked read
 * by it: only the view says what was seen.
 * @param state - The state.
 * @param event - The Timeline and the position.
 * @returns The state.
 */
const jumping = (
  state: Timelines,
  event: Extract<TimelinesEvent, { readonly _tag: "Jumped" }>
): Timelines => {
  const id = resolve(state, event.timeline);
  const { layout } = state;
  const at = paneOf(state, id) ?? searchPane(layout) ?? layout.focused;
  const view = viewIn(layout, at);

  const shown: PaneView =
    view.open !== undefined && resolve(state, view.open) === id
      ? { ...view, main: { _tag: "Timeline" } }
      : viewOf(state, event.timeline);

  const after = retained(state, {
    ...state,
    layout: withView({ ...layout, focused: at }, at, shown),
  });

  const window: Window = {
    ...unread,
    anchor: event.position,
    earlier: false,
    following: false,
    gaps: [],
    generation: after.nextGeneration,
    items: [],
    later: false,
    network: after.windows.get(id)?.network,
    newer: false,
    older: undefined,
    seen: undefined,
    target: event.position,
    through: 0,
    timeline: id,
  };

  return {
    ...after,
    nextGeneration: after.nextGeneration + 1,
    windows: setIn(after.windows, id, window),
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

  // A Timeline is open in one Pane at most, and the options and the Uploads show in one
  // each: a second is a Timeline.
  const open = new Set<TimelineId>();
  const shown = new Set<string>();

  const layout = mapViews(kept, ({ view }): PaneView => {
    const main =
      (view.main._tag === "Options" || view.main._tag === "Uploads") && shown.has(view.main._tag)
        ? { _tag: "Timeline" as const }
        : view.main;

    shown.add(main._tag);

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
const wentElsewhere = (before: Timelines, after: Timelines): boolean =>
  shownIn(focusedView(before)) !== shownIn(focusedView(after));

/**
 * The options filtered or closed, or a Direct Message not yet begun shown or closed.
 * @param state - The state.
 * @param event - What the Owner did.
 * @returns The state.
 */
const inFront = (
  state: Timelines,
  event: Extract<
    Navigation,
    {
      readonly _tag:
        | "OptionsFiltered"
        | "OptionsClosed"
        | "UploadsClosed"
        | "DraftShown"
        | "DraftClosed";
    }
  >
): Timelines => {
  switch (event._tag) {
    case "OptionsFiltered": {
      const at = optionsPane(state.layout);
      const view = at === undefined ? undefined : viewIn(state.layout, at);

      return at === undefined || view?.main._tag !== "Options"
        ? state
        : {
            ...state,
            layout: withView(state.layout, at, {
              ...view,
              main: { ...view.main, filter: event.filter },
            }),
          };
    }

    case "OptionsClosed": {
      return optionsPane(state.layout) === undefined ? state : closingOptions(elsewhere(state));
    }

    case "UploadsClosed": {
      return uploadsPane(state.layout) === undefined ? state : closingUploads(elsewhere(state));
    }

    case "DraftShown": {
      return showingDraft(elsewhere(state), event);
    }

    case "DraftClosed": {
      return mainOf(state)._tag === "DirectDraft" ? closingDraft(elsewhere(state)) : state;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Has `known` read again for a Direct Message Timeline's Network, so whether its partner
 * is there is as the Daemon says now.
 * @param state - The state.
 * @param timeline - The Timeline.
 * @returns The state.
 */
const partnerAsked = (state: Timelines, timeline: TimelineId): Timelines => {
  const found = listed(state, resolve(state, timeline));
  const network = found?.kind === "Direct" ? state.networks.get(found.network) : undefined;

  return network === undefined
    ? state
    : {
        ...state,
        networks: setIn(state.networks, network.network, {
          ...network,
          status: { ...network.status, fresh: false },
        }),
      };
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
      return partnerAsked(opening(elsewhere(state), event.timeline), event.timeline);
    }

    case "Located": {
      return event.navigation === state.navigation
        ? { ...state, located: { from: event.from, timeline: event.timeline } }
        : state;
    }

    case "OptionsShown": {
      return showingOptions(elsewhere(state), event.filter);
    }

    case "UploadsShown": {
      return showingUploads(elsewhere(state));
    }

    case "OptionsFiltered":
    case "OptionsClosed":
    case "UploadsClosed":
    case "DraftShown":
    case "DraftClosed": {
      return inFront(state, event);
    }

    case "Pane": {
      const after = paned(state, event.change);

      return wentElsewhere(state, after) ? elsewhere(after) : after;
    }

    case "Restore": {
      return restored({ ...state, restoring: event.layout });
    }

    case "SearchShown": {
      return showingSearch(elsewhere(state), event);
    }

    case "SearchClosed": {
      return searchPane(state.layout) === undefined ? state : closingSearch(elsewhere(state));
    }

    case "Jumped": {
      return jumping(elsewhere(state), event);
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

/** An event of the search, or of the item jumped to. */
type Searching = Extract<
  TimelinesEvent,
  { readonly _tag: "SearchChanged" | "SearchRead" | "SearchFailed" | "TargetLeft" }
>;

const searchings: ReadonlySet<string> = new Set([
  "SearchChanged",
  "SearchRead",
  "SearchFailed",
  "TargetLeft",
]);

const isSearching = (event: TimelinesEvent): event is Searching => searchings.has(event._tag);

/**
 * The search after the Owner or a read changed it, or a window after the Owner scrolled
 * away from the item jumped to.
 * @param state - The state.
 * @param event - What happened.
 * @returns The state.
 */
const searched = (state: Timelines, event: Searching): Timelines => {
  switch (event._tag) {
    case "SearchChanged": {
      return { ...state, search: reduceSearch(state.search, event.change) };
    }

    case "SearchRead": {
      return {
        ...state,
        search: reduceSearch(state.search, { _tag: "Read", page: event.page, read: event.read }),
      };
    }

    case "SearchFailed": {
      return {
        ...state,
        search: reduceSearch(state.search, {
          _tag: "Failed",
          message: event.message,
          read: event.read,
        }),
      };
    }

    case "TargetLeft": {
      const id = resolve(state, event.timeline);
      const window = state.windows.get(id);

      return window?.target === undefined
        ? state
        : { ...state, windows: setIn(state.windows, id, { ...window, target: undefined }) };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * A read asked again after a wait.
 * @param load - The read.
 * @returns The read.
 */
const again = <L extends Load>(load: L): L => ({
  ...load,
  attempt: load.attempt + 1,
  reading: false,
});

/**
 * Takes a read of a Network's Timelines or Session answering `UnknownNetwork`, which names
 * no life, so lets nothing go on its own: the Network list is read again, and says whether
 * the Network is gone, and the read is asked again after a wait meanwhile.
 * @param state - The state.
 * @param id - The Network.
 * @param of - The read: its Timelines, or its Session.
 * @returns The state.
 */
const unknownNetwork = (state: Timelines, id: NetworkId, of: "List" | "Status"): Timelines => {
  const network = state.networks.get(id);

  if (network === undefined) {
    return state;
  }

  return {
    ...state,
    entries: { ...state.entries, fresh: false },
    networks: setIn(
      state.networks,
      id,
      of === "List"
        ? { ...network, list: again(network.list) }
        : { ...network, status: again(network.status) }
    ),
  };
};

type Gone = Extract<
  TimelinesEvent,
  { readonly _tag: "Vanished" | "NetworkVanished" | "NetworkRemoved" }
>;

const gones: ReadonlySet<string> = new Set(["Vanished", "NetworkVanished", "NetworkRemoved"]);

const isGone = (event: TimelinesEvent): event is Gone => gones.has(event._tag);

/**
 * The state after the Daemon said a Timeline or a Network is gone, or that it removed a
 * Network.
 * @param state - The state.
 * @param event - What it said.
 * @returns The state.
 */
const gone = (state: Timelines, event: Gone): Timelines => {
  switch (event._tag) {
    case "Vanished": {
      return {
        ...state,
        vanished: new Set(state.vanished).add(event.timeline),
        windows: deleteIn(state.windows, event.timeline),
      };
    }

    case "NetworkVanished": {
      return unknownNetwork(state, event.network, event.of);
    }

    case "NetworkRemoved": {
      return ended(state, event);
    }

    default: {
      return event satisfies never;
    }
  }
};

const apply = (state: Timelines, event: TimelinesEvent): Applied => {
  if (isNavigation(event)) {
    return { state: navigated(state, event) };
  }

  if (isSearching(event)) {
    return { state: searched(state, event) };
  }

  if (isGone(event)) {
    return { state: gone(state, event) };
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
      return { state: statusRead(state, event) };
    }

    case "WindowRead": {
      return { state: windowRead(state, event) };
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
    case "LatestWanted":
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

  return draftsMet(onePaneEach(restored(found(record(after, recorded)))));
};

// What to read.

/**
 * The read an open Timeline's window calls for, if any: the latest when it was never read
 * or missed something, or around where the Owner jumped while it is anchored there, or
 * what lies before or after it when the Owner asked. A window is
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

  if (window?.anchor !== undefined && !window.fresh) {
    return [
      {
        _tag: "Around",
        around: window.anchor,
        attempt: window.attempt,
        generation: window.generation,
        limit: limitFor(window, state.windowCap),
        timeline: id,
      },
    ];
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

  if (window.older !== undefined && window.earlier && first !== undefined) {
    return [
      {
        _tag: "Older",
        attempt: window.attempt,
        before: first.position,
        generation: window.generation,
        limit,
        mode: window.older,
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
 * Network's Timelines and, once the stream is followed, its connection, the window of
 * each Timeline open in a Pane, the focused Pane's first, latest first, or around where the
 * Owner jumped, and older when asked, once the stream is followed, and a page of the
 * search while one is wanted and a Pane shows it.
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

    // A removed Network has no Session, and `known` no longer answers for it.
    if (
      state.follow._tag === "Following" &&
      !network.status.fresh &&
      !network.status.reading &&
      !isRemoved(network)
    ) {
      reads.push({ _tag: "Status", attempt: network.status.attempt, network: network.network });
    }
  }

  const open = [...new Set(openIn(state.layout).map((one) => resolve(state, one)))];

  // A page of the search, only while a Pane shows it.
  const page = searchPane(state.layout) === undefined ? undefined : searchWanted(state.search);

  return [
    ...reads,
    ...open.flatMap((one) => wantedWindow(state, one)),
    ...(page === undefined ? [] : [page]),
  ];
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
export const sidebarOrder = (left: Timeline, right: Timeline): number =>
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
  /** Its Timelines the sidebar lists: every one but those closed and open in no Pane. */
  readonly timelines: readonly Timeline[];
  /**
   * Its Timelines closed, with nothing arrived in them since, that no Pane has open, which
   * the sidebar leaves out and the Composer's `/go` still lists.
   */
  readonly closed: readonly Timeline[];
  /**
   * Whether its Timelines are known: read, or some held from an earlier read while they are
   * read again. While none are held and they are read, having none says nothing.
   */
  readonly listed: boolean;
  /**
   * Whether every page of its Timelines is read, so a Timeline it does not hold is not
   * there, which `listed` alone does not say while later pages are still read.
   */
  readonly complete: boolean;
  /** It was removed with its Timelines kept, so they are only read. */
  readonly removed: boolean;
}

/**
 * The Networks, each with its Timelines in sidebar order: those not removed by id, then
 * those removed with their Timelines kept, by id. A Timeline closed, with nothing arrived
 * in it since, is left out while no Pane has it open, and listed while one does, so opening
 * it from `/go` or the search shows it for as long as it is open. One the Owner asked
 * to close counts as closed from when it is asked.
 * @param state - The state.
 * @param closing - The Timelines asked to be closed that the Daemon has yet to say are.
 * @returns The sidebar.
 */
export const sidebar = (
  state: Timelines,
  closing: ReadonlySet<TimelineId> = new Set()
): readonly SidebarNetwork[] => {
  const open = new Set(openIn(state.layout).map((one) => resolve(state, one)));

  const hidden = (timeline: Timeline) =>
    (timeline.closed || closing.has(timeline.id)) && !open.has(timeline.id);

  return [...state.networks.values()]
    .map((network) => {
      const all = [...network.timelines.values()].toSorted(sidebarOrder);

      return {
        away: network.away,
        closed: all.filter(hidden),
        complete: network.list.fresh,
        connection: network.connection,
        listed: network.list.fresh || network.timelines.size > 0,
        network: network.network,
        removed: isRemoved(network),
        running: network.running,
        timelines: all.filter((timeline) => !hidden(timeline)),
      };
    })
    .toSorted(
      (left, right) =>
        Number(left.removed) - Number(right.removed) || byCodeUnits(left.network, right.network)
    );
};

/**
 * Whether the Network list was ever read, so having no Network says none is configured.
 * @param state - The state.
 * @returns Whether it was.
 */
export const networksListed = (state: Timelines): boolean => state.listed;

/**
 * How a Network stands, for removing it: `Live`, configured; `Kept`, removed with its
 * Timelines kept, which removing again drops; or `Unknown`, not held at all.
 * @param state - The state.
 * @param network - The Network.
 * @returns How it stands.
 */
export const standingOf = (state: Timelines, network: NetworkId): Standing => {
  const held = state.networks.get(network);

  if (held === undefined) {
    return "Unknown";
  }

  return isRemoved(held) ? "Kept" : "Live";
};

/**
 * A Network as the sidebar's tree draws it: its row, which is its own Timeline, and the
 * Timelines under it, its Channels and Direct Messages.
 */
export interface NetworkTree {
  /** The Network's own Timeline, or none while it has none yet. */
  readonly own: Timeline | undefined;
  readonly children: readonly Timeline[];
}

/**
 * A Network's Timelines, as the sidebar's tree draws them: its own as its row, and every
 * other under it, in sidebar order.
 * @param network - The Network.
 * @returns Its tree.
 */
export const treeOf = (network: SidebarNetwork): NetworkTree => {
  const own = network.timelines.find((timeline) => timeline.kind === "Network");

  return { children: network.timelines.filter((timeline) => timeline !== own), own };
};

/**
 * A time zone, as the core is given it: the offset from UTC in force at an instant, in
 * milliseconds east of it, exact even for a historical offset of seconds, or none when the
 * instant cannot be placed, as one outside the range a `Date` holds. The core reads no zone
 * itself, so a Frontend gives it the device's.
 */
export type Zone = (at: number) => number | undefined;

/**
 * One row of a window as shown: an item, a collapsed Gap among them, the "new" divider
 * before the first item after the Read Marker the Timeline opened with, or a Day, where the
 * day changes.
 */
export type Row =
  | {
      readonly _tag: "Item";
      readonly key: string;
      readonly item: TimelineItem;
      /**
       * Failed Connections in a row to one Ircd for one reason are one row: the latest, with
       * how many there were and when the first was, so a reconnecting Network does not fill
       * its Timeline. Present only for more than one.
       */
      readonly repeated?: Repeated;
      /**
       * Joins, parts, quits, and changes of nick in a row are one row: the latest, under the
       * key of the first, which stays as the run grows, holding every item of the run, oldest
       * first, for a view to open. Present only for more than one, and never for Self's.
       */
      readonly folded?: readonly TimelineItem[];
      /**
       * A Message that continues a run: plain speech from the User who said the item drawn
       * just before it, within {@link runSpan} of it. Present only when it does, so a run's
       * head, and every other row, has none.
       */
      readonly continues?: true;
    }
  | { readonly _tag: "Gap"; readonly key: string; readonly gap: WindowGap }
  | { readonly _tag: "New"; readonly key: string }
  | {
      readonly _tag: "Day";
      readonly key: string;
      /** The instant of the first item of the day, which a view writes as a date. */
      readonly at: number;
    };

/** How many failed Connections one row stands for, and the instant of the first. */
export interface Repeated {
  readonly count: number;
  readonly from: number;
}

/**
 * Whether an item is a failed Connection that repeats another: to the same Ircd, for the
 * same reason.
 * @param item - The item.
 * @param before - The item before it.
 * @returns Whether it repeats it.
 */
const repeats = (item: TimelineItem, before: TimelineItem): boolean =>
  item.content._tag === "ConnectionFailed" &&
  before.content._tag === "ConnectionFailed" &&
  JSON.stringify(item.content.ircd) === JSON.stringify(before.content.ircd) &&
  JSON.stringify(item.content.reason) === JSON.stringify(before.content.reason);

/**
 * The rows with each run of failed Connections that repeat one another made one: the
 * latest item, which a view draws with its hint, under the key of the first, which stays
 * as the run grows, with how many there were and when the first was. Only items next to
 * one another join, so a Gap, the "new" divider, a Day, or anything else between ends a run.
 * @param rows - The rows.
 * @returns The rows, collapsed.
 */
const collapsed = (rows: readonly Row[]): readonly Row[] => {
  const out: Row[] = [];

  for (const row of rows) {
    const last = out.at(-1);

    if (row._tag === "Item" && last?._tag === "Item" && repeats(row.item, last.item)) {
      const first = last.repeated?.from ?? last.item.position.at;
      const count = (last.repeated?.count ?? 1) + 1;

      out[out.length - 1] = { ...row, key: last.key, repeated: { count, from: first } };
    } else {
      out.push(row);
    }
  }

  return out;
};

/**
 * The rows with each run of joins, parts, quits, and changes of nick made one: the latest
 * item, under the key of the first, with every item of the run. Only items next to one
 * another join, so a Message, any other Activity, a Gap, a Day, or the "new" divider between
 * ends a run, and Self's own are never in one, but split it. A run of one is a plain row.
 * @param rows - The rows.
 * @param ours - The items that are Self's.
 * @returns The rows, folded.
 */
const folding = (rows: readonly Row[], ours: ReadonlySet<TimelineItem>): readonly Row[] => {
  const out: Row[] = [];
  let run: (Row & { readonly _tag: "Item" })[] = [];

  const end = () => {
    const [first] = run;
    const last = run.at(-1);

    if (first !== undefined && last !== undefined) {
      out.push(
        run.length === 1 ? last : { ...last, folded: run.map((row) => row.item), key: first.key }
      );
    }

    run = [];
  };

  for (const row of rows) {
    if (row._tag === "Item" && churnOf(row.item.content) !== undefined && !ours.has(row.item)) {
      run.push(row);
    } else {
      end();
      out.push(row);
    }
  }

  end();

  return out;
};

/** The most time that may separate a Message from the one before it in a run: five minutes. */
const runSpan = 300_000;

/**
 * Who said an item, folded as a nick's colour is, if it is plain speech: a `PRIVMSG`, not an
 * action or a notice.
 * @param item - The item.
 * @returns Its sender, folded, or none.
 */
const speaker = (item: TimelineItem): string | undefined =>
  item.content._tag === "Message" && item.content.kind === "Privmsg"
    ? casefold(defaultCasemapping, item.content.sender)
    : undefined;

/**
 * Whether an item continues a run that the item drawn just before it is in: both are plain
 * speech, from one User, with no more than {@link runSpan} between their own times, in
 * either direction, since a Network's time can go back.
 * @param item - The item.
 * @param before - The item drawn just before it.
 * @returns Whether it continues the run.
 */
const continuesRun = (item: TimelineItem, before: TimelineItem): boolean => {
  const said = speaker(item);

  return (
    said !== undefined &&
    said === speaker(before) &&
    Math.abs(item.position.at - before.position.at) <= runSpan
  );
};

/**
 * The rows with each Message that continues a run marked so. Only rows next to one another
 * join, so anything drawn between two Messages ends a run: an Activity, a Gap, a Day, or the
 * "new" divider. An item that is not drawn is no row, and ends nothing. The first row has
 * nothing before it, so a window that starts mid-run heads it with its first Message.
 * @param rows - The rows.
 * @returns The rows, with each run's later Messages marked.
 */
const runs = (rows: readonly Row[]): readonly Row[] =>
  rows.map((row, index) => {
    const before = rows[index - 1];

    return row._tag === "Item" && before?._tag === "Item" && continuesRun(row.item, before.item)
      ? { ...row, continues: true }
      : row;
  });

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

const msPerDay = 86_400_000;

/**
 * The day an instant falls on in a zone, as a count of days since the epoch's.
 * @param zone - The zone.
 * @param at - The instant.
 * @returns The day, or none when the zone cannot place the instant.
 */
const dayOf = (zone: Zone, at: number): number | undefined => {
  const offset = zone(at);

  return offset === undefined ? undefined : Math.floor((at + offset) / msPerDay);
};

/**
 * A window's rows: its items in order, each collapsed Gap after the items at or before
 * where it began, and with a divider, the "new" divider before the first item after its
 * Read Marker, if the window holds one. Each row's key is stable as rows are added around it.
 *
 * Given a zone, a Day row stands before each item drawn on a different day from the item
 * drawn before it, in either direction since a Network's time can go back, and before the
 * first item drawn, so a window that begins mid-day says which day it is. A day begins at
 * midnight in the zone. An item the zone cannot place starts no day and does not end one.
 * A Day comes after any Gap and before the "new" divider that stand before the same item.
 * With no zone, there are no Day rows.
 *
 * Each Message that continues a run of plain speech from one User is marked, as `runs` says,
 * whatever layout a view draws. Each run of joins, parts, quits, and changes of nick is one
 * row, as `folding` says, except where they are Self's, which is told by Self's nick as the
 * Network holds it now, and a change of it in the window.
 *
 * A Gap that ended, with no item of the Timeline before it, in a window that holds the
 * Timeline's start, says nothing: nothing was there to miss. It is left out of the rows and
 * stays in the window. A Gap still open stays wherever it is, since it says why nothing is
 * arriving. Which items count as before a Gap is decided by every item the window holds,
 * not only those `shows` lets through, since an Activity a view hides was still there.
 * @param window - The window.
 * @param divider - The divider, if the Timeline opened with something unread.
 * @param shows - Which items are drawn, or every one.
 * @param zone - The zone a day is read in, if the rows should show where it changes.
 * @param self - Self's nick now, if known, as `selfOf` gives it.
 * @returns The rows.
 */
export const rowsOf = (
  window: Window,
  divider?: Divider,
  shows: (item: TimelineItem) => boolean = () => true,
  zone?: Zone,
  self?: string
): readonly Row[] => {
  const rows: Row[] = [];
  let next = 0;
  // Whether the divider still waits for its item: the first after the Read Marker.
  let waiting = divider !== undefined;
  // Whether an item stands before what comes next, drawn or not.
  let anyBefore = false;
  // The day of the last item drawn that the zone could place.
  let today: number | undefined;

  /**
   * Draws a Gap, unless it is one of nothing: one that ended before the start of a
   * Timeline held to its start.
   * @param gap - The Gap.
   */
  const drawGap = (gap: WindowGap) => {
    if (anyBefore || window.earlier || gap.to === null) {
      rows.push(gapRow(gap));
    }
  };

  for (const item of window.items) {
    for (
      let gap = window.gaps[next];
      gap !== undefined && comparePositions(gap.from, item.position) < 0;
      gap = window.gaps[next]
    ) {
      drawGap(gap);
      next += 1;
    }

    anyBefore = true;

    if (!shows(item)) {
      continue;
    }

    const day = zone === undefined ? undefined : dayOf(zone, item.position.at);

    if (day !== undefined && day !== today) {
      today = day;
      rows.push({ _tag: "Day", at: item.position.at, key: `day-${cursorOf(item.position)}` });
    }

    if (waiting && divider !== undefined && isNew(divider, item)) {
      waiting = false;
      rows.push({ _tag: "New", key: newKey });
    }

    rows.push({ _tag: "Item", item, key: cursorOf(item.position) });
  }

  for (const gap of window.gaps.slice(next)) {
    drawGap(gap);
  }

  // With Self's nick unknown, any of them could be Self's, so none is folded away.
  const shown = collapsed(rows);

  return runs(self === undefined ? shown : folding(shown, selfChurn(window.items, self)));
};

/**
 * The key of the row of the item the Owner jumped to, which a view brings into view and
 * marks, or none.
 * @param window - The window.
 * @returns The row's key, as `rowsOf` gives it.
 */
export const targetKey = (window: Window): string | undefined =>
  window.target === undefined ? undefined : cursorOf(window.target);

/** A Pane's open Timeline, as shown. */
export type Opened =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Restoring" }
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
 * A Pane's open Timeline: closed, waiting on the layout this device kept, gone, being read
 * for the first time, or its window, with the Timeline itself as its Network's list has it.
 * @param state - The state.
 * @param pane - The Pane's id: the focused Pane unless another is named.
 * @returns The open Timeline.
 */
export const opened = (state: Timelines, pane = state.layout.focused): Opened => {
  const view = panesOf(state.layout.root).find((one) => one.id === pane)?.view;

  if (view?.open === undefined) {
    // Until the layout kept is taken or let go, an empty Pane may yet show a Timeline.
    return state.restoring === undefined ? { _tag: "Closed" } : { _tag: "Restoring" };
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

/**
 * The Network a Pane's Timeline belongs to, when it was removed with its Timelines kept,
 * so the Pane says so and nothing is said there.
 * @param state - The state.
 * @param pane - The Pane's id: the focused Pane unless another is named.
 * @returns The Network, or none.
 */
export const removedIn = (state: Timelines, pane = state.layout.focused): NetworkId | undefined => {
  const shown = opened(state, pane);

  if (shown._tag !== "Shown" || shown.description === undefined) {
    return undefined;
  }

  const { network, removed } = shown.description;
  const held = state.networks.get(network);

  return removed || (held !== undefined && isRemoved(held)) ? network : undefined;
};

/**
 * A Pane's name, as the switcher, the composer's prompt, and its label say it: what it
 * shows, never what stands behind it. `options`, `uploads`, or `search` by name, a draft by its nick,
 * its Timeline by name, `…` while that is read, and `empty` with none open.
 * @param state - The state.
 * @param pane - The Pane's id: the focused Pane unless another is named.
 * @returns The name.
 */
export const paneName = (state: Timelines, pane = state.layout.focused): string => {
  const view = viewIn(state.layout, pane);

  switch (view.main._tag) {
    case "Options": {
      return "options";
    }

    case "Uploads": {
      return "uploads";
    }

    case "Search": {
      return "search";
    }

    case "DirectDraft": {
      return view.main.nick;
    }

    case "Timeline": {
      const shown = opened(state, pane);

      if (shown._tag === "Shown") {
        return shown.description?.name ?? "Timeline";
      }

      return shown._tag === "Closed" ? "empty" : "\u2026";
    }

    default: {
      return view.main satisfies never;
    }
  }
};

// The layout this device keeps.

/**
 * What a device keeps of a Pane's view: its open Timeline, as the Owner chose it, and the
 * options' filter while they show in its place, or whether the Uploads do. A divider is
 * never kept: it is taken afresh as the Timeline opens again. Neither is a search, which
 * comes back as what it showed in front of: its Timeline, the options, or the Uploads.
 */
export interface KeptView {
  readonly open: TimelineId | null;
  readonly options: string | null;
  readonly uploads: boolean;
}

/** A layout as a device keeps it: plain JSON. */
export type KeptLayout = Layout<KeptView>;

/** A Pane's view as JSON writes it: a Timeline's id is text. */
interface KeptViewJson {
  readonly open: string | null;
  readonly options: string | null;
  readonly uploads?: boolean;
}

const KeptViewSchema = Schema.Struct({
  open: Schema.NullOr(TimelineIdSchema),
  options: Schema.NullOr(Schema.String),
  // A layout kept before the Uploads had a view of their own has none.
  uploads: Schema.optionalKey(Schema.Boolean).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => false)),
      encode: SchemaGetter.passthrough(),
    })
  ),
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
    ? mapViews(state.layout, ({ view }): KeptView => {
        // A Pane kept comes back as the options, the Uploads, or else as its Timeline: a
        // search or a Direct Message not yet begun is never kept, so it comes back as what
        // it was in front of.
        const main =
          view.main._tag === "Search" || view.main._tag === "DirectDraft"
            ? view.main.back
            : view.main;

        return {
          open: view.open ?? null,
          options: main._tag === "Options" ? main.filter : null,
          uploads: main._tag === "Uploads",
        };
      })
    : undefined;

/**
 * A Pane's view, from what a device kept.
 * @param kept - What it kept.
 * @returns The view.
 */
const keptView = (kept: KeptView): PaneView => {
  const main = (): MainView => {
    if (kept.options !== null) {
      return { _tag: "Options", back: timelineMain, filter: kept.options };
    }

    return kept.uploads ? { _tag: "Uploads", back: timelineMain } : timelineMain;
  };

  return { divider: undefined, main: main(), open: kept.open ?? undefined };
};

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
