/**
 * What is new: each Timeline's unread counts and the highest level among them, as the
 * Daemon counted them, a Network's summed over its Timelines, the words and numbers a view
 * shows for them, and when the open Timeline is due to be marked read. The Daemon keeps
 * every Read Marker and every count (ADR 0014): this only reads them, and decides when
 * marking read is due, which stays a Frontend's decision.
 *
 * @packageDocumentation
 */
import type { Level, ReadRequest, Timeline, Unread } from "@iirc/api";
import { unreadCap } from "@iirc/timelines";

import type { MarkRead } from "./commands.ts";
import { panesOf, shownPanes } from "./layout.ts";
import { opened } from "./timelines.ts";
import type { SidebarNetwork, Timelines } from "./timelines.ts";

/** An instant, in milliseconds since the Unix epoch, as a Read Marker is. */
export type Instant = ReadRequest["read"];

/** The levels, highest first: what calls for the Owner most comes first. */
export const levels: readonly Level[] = ["Highlight", "Direct", "Message", "Activity"];

/**
 * How a level ranks: a higher number calls for the Owner more.
 * @param level - The level, or none.
 * @returns Its rank, 0 for none.
 */
export const rank = (level: Level | undefined): number =>
  level === undefined ? 0 : levels.length - levels.indexOf(level);

/** What is unread in a Timeline or a Network: the counts, and the highest level among them. */
export interface Activity {
  readonly unread: Unread;
  /** The highest level with anything unread, or none when nothing is. */
  readonly level: Level | undefined;
}

const none: Unread = { activity: 0, direct: 0, highlights: 0, messages: 0 };

/**
 * The count of a level.
 * @param unread - The counts.
 * @param level - The level.
 * @returns Its count.
 */
const countOf = (unread: Unread, level: Level): number => {
  switch (level) {
    case "Highlight": {
      return unread.highlights;
    }

    case "Direct": {
      return unread.direct;
    }

    case "Message": {
      return unread.messages;
    }

    case "Activity": {
      return unread.activity;
    }

    default: {
      return level satisfies never;
    }
  }
};

/**
 * The highest level with anything unread.
 * @param unread - The counts.
 * @returns The level, or none.
 */
export const levelOf = (unread: Unread): Level | undefined =>
  levels.find((level) => countOf(unread, level) > 0);

/**
 * What is unread in a Timeline.
 * @param timeline - The Timeline, as its Network lists it.
 * @returns Its activity.
 */
export const activityOf = (timeline: Timeline): Activity => ({
  level: levelOf(timeline.unread),
  unread: timeline.unread,
});

/**
 * Two counts added, kept at most `unreadCap + 1`, which says more than `unreadCap`, as the
 * Daemon's own counts are.
 * @param left - One count.
 * @param right - The other.
 * @returns Their sum.
 */
const plus = (left: number, right: number): number => Math.min(left + right, unreadCap + 1);

/**
 * What is unread in a Network: each count summed over its Timelines, and the highest level.
 * @param network - The Network, as the sidebar shows it.
 * @returns Its activity.
 */
export const networkActivity = (network: SidebarNetwork): Activity => {
  let unread = none;

  for (const timeline of network.timelines) {
    unread = {
      activity: plus(unread.activity, timeline.unread.activity),
      direct: plus(unread.direct, timeline.unread.direct),
      highlights: plus(unread.highlights, timeline.unread.highlights),
      messages: plus(unread.messages, timeline.unread.messages),
    };
  }

  return { level: levelOf(unread), unread };
};

/**
 * How many things said are unread: Highlights, Direct Messages, and Messages, and not
 * Activity, which a view shows only as a dimmer name.
 * @param unread - The counts.
 * @returns The count, at most `unreadCap + 1`.
 */
export const saidCount = (unread: Unread): number =>
  plus(plus(unread.highlights, unread.direct), unread.messages);

/**
 * How many unread things call for the Owner: Highlights and Direct Messages.
 * @param unread - The counts.
 * @returns The count, at most `unreadCap + 1`.
 */
export const callingCount = (unread: Unread): number => plus(unread.highlights, unread.direct);

/**
 * A count as a view shows it: the number, or `999+` past what the Daemon counts exactly.
 * @param count - The count.
 * @returns Its text.
 */
export const countText = (count: number): string =>
  count > unreadCap ? `${unreadCap}+` : String(count);

/**
 * A row's name with what is unread in it, for a screen reader, such as
 * `#iirc, 3 unread, 1 highlight`. Activity is left out, as a view shows it only as a
 * dimmer name.
 * @param name - The Timeline's or Network's name.
 * @param activity - What is unread in it.
 * @returns The label.
 */
export const labelOf = (name: string, activity: Activity): string => {
  const said = saidCount(activity.unread);
  const { highlights } = activity.unread;

  return [
    name,
    ...(said > 0 ? [`${countText(said)} unread`] : []),
    ...(highlights > 0
      ? [`${countText(highlights)} ${highlights === 1 ? "highlight" : "highlights"}`]
      : []),
  ].join(", ");
};

/** The page's own title, which a count goes before. */
const appName = "iirc";

/**
 * The page's title: how many Highlights and Direct Messages are unread across every
 * Network, such as `(3) iirc`, or the name alone when none are.
 * @param networks - The sidebar.
 * @returns The title.
 */
export const titleOf = (networks: readonly SidebarNetwork[]): string => {
  let calling = 0;

  for (const network of networks) {
    calling = plus(calling, callingCount(networkActivity(network).unread));
  }

  return calling === 0 ? appName : `(${countText(calling)}) ${appName}`;
};

/**
 * How the Daemon is asked to mark a Timeline read up to an instant, or nothing when that
 * would change nothing: the Timeline has nothing unread, its Read Marker is already there
 * or later, or it is a detached Direct Message, whose partner's nick now names another
 * Timeline, if any, so no Target names it.
 * @param timeline - The Timeline, as its Network lists it.
 * @param read - The instant to mark it read up to.
 * @returns The intent, or none.
 */
export const markOf = (timeline: Timeline, read: Instant): MarkRead | undefined => {
  const nothing =
    timeline.detached ||
    (timeline.read !== null && read <= timeline.read) ||
    (saidCount(timeline.unread) === 0 && timeline.unread.activity === 0);

  return nothing
    ? undefined
    : {
        _tag: "MarkRead",
        network: timeline.network,
        read,
        target: timeline.kind === "Network" ? null : timeline.name,
        timeline: timeline.id,
      };
};

/**
 * Marking a Timeline read up to its latest item, as the Daemon listed it.
 * @param timeline - The Timeline.
 * @returns The intent, or none when it has no item or nothing to mark.
 */
export const markLatest = (timeline: Timeline): MarkRead | undefined =>
  timeline.latest === null ? undefined : markOf(timeline, timeline.latest.at);

/**
 * Whether the Owner can see the page: it is shown, and it has the focus, and whether its
 * screen is compact, as a phone's is, showing only the focused Pane.
 */
export interface Page {
  readonly visible: boolean;
  readonly focused: boolean;
  readonly compact: boolean;
}

/**
 * The Panes the Owner can see: those shown, as the layout and the screen say, while the
 * page is visible and focused, and none otherwise.
 * @param state - The Timelines.
 * @param page - The page.
 * @returns The Panes' ids, the focused Pane's first.
 */
const seenPanes = (state: Timelines, page: Page): readonly string[] => {
  if (!page.visible || !page.focused) {
    return [];
  }

  const shown = shownPanes(state.layout, page.compact).map((pane) => pane.id);
  const { focused } = state.layout;

  return shown.includes(focused) ? [focused, ...shown.filter((id) => id !== focused)] : shown;
};

/**
 * How far the Owner has seen a Pane's Timeline: the page is visible and focused, the Pane
 * is shown with its Timeline in it, not the options, its window is current with nothing
 * beyond its last item, and the view said it is at the latest, with the last item it shows.
 * @param state - The Timelines.
 * @param pane - The Pane.
 * @returns The Timeline's description and the instant of the last item the view showed,
 * when the Owner sees it.
 */
const seenIn = (
  state: Timelines,
  pane: string
): { readonly at: Instant; readonly timeline: Timeline } | undefined => {
  const shown = opened(state, pane);
  const view = panesOf(state.layout.root).find((one) => one.id === pane)?.view;

  if (shown._tag !== "Shown" || shown.description === undefined || view === undefined) {
    return undefined;
  }

  const { window } = shown;

  const sees = view.main._tag === "Timeline" && window.fresh && window.following && !window.later;

  return sees && window.seen !== undefined
    ? { at: window.seen.at, timeline: shown.description }
    : undefined;
};

/**
 * Whether a Timeline the Owner sees is due to be marked read, and up to what: when the view
 * said the Owner sees its latest, up to the instant of the last item the view showed, which
 * is never past what was shown and never before its Read Marker. Of several Panes, the
 * focused one's comes first, and the next once that is marked. The runtime waits a moment
 * before it carries this out, and asks again then.
 * @param state - The Timelines.
 * @param page - The page.
 * @returns The intent, or none.
 */
export const markDue = (state: Timelines, page: Page): MarkRead | undefined => {
  for (const pane of seenPanes(state, page)) {
    const latest = seenIn(state, pane);
    const mark = latest === undefined ? undefined : markOf(latest.timeline, latest.at);

    if (mark !== undefined) {
      return mark;
    }
  }

  return undefined;
};

/**
 * Whether the Owner is looking at a Timeline now: a Pane they can see shows it, not the
 * options, and the page is visible and focused.
 * @param state - The Timelines.
 * @param page - The page.
 * @param timeline - The Timeline.
 * @returns Whether they are.
 */
export const lookingAt = (state: Timelines, page: Page, timeline: Timeline["id"]): boolean =>
  seenPanes(state, page).some((pane) => {
    const shown = opened(state, pane);
    const view = panesOf(state.layout.root).find((one) => one.id === pane)?.view;

    return view?.main._tag === "Timeline" && shown._tag !== "Closed" && shown.timeline === timeline;
  });
