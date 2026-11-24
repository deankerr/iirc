/**
 * What is new: each Timeline's unread counts and the highest level among them, as the
 * Daemon counted them, a Network's summed over its Timelines, the words and numbers a view
 * shows for them, and when the open Timeline is due to be marked read. The Daemon keeps
 * every Read Marker and every count (ADR 0014): this only reads them, and decides when
 * marking read is due, which stays a Frontend's decision.
 *
 * @packageDocumentation
 */
import { mutedCap } from "@iirc/api";
import type { Level, ReadRequest, ReadRule, Timeline, TimelineId, Unread } from "@iirc/api";
import { unreadCap } from "@iirc/timelines";

import type { MarkRead, Parsed } from "./commands.ts";
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

const none: Unread = {
  activity: 0,
  botDirect: 0,
  botMessages: 0,
  direct: 0,
  highlights: 0,
  messages: 0,
};

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
 * Two counts added, kept at most `unreadCap + 1`, which says more than `unreadCap`, as the
 * Daemon's own counts are.
 * @param left - One count.
 * @param right - The other.
 * @returns Their sum.
 */
const plus = (left: number, right: number): number => Math.min(left + right, unreadCap + 1);

/**
 * The counts a view shows, which is where a muted Timeline and the quiet of bots are
 * decided. A muted Timeline counts nothing but its Highlights, so what is said or done there
 * is not shown, though the Daemon still counts it. The Daemon counts what a bot said apart
 * from the rest, so with bots quieted `direct` and `messages` are the Daemon's, and
 * otherwise each adds its bot count, kept at most `unreadCap + 1`. A Highlight, which no bot
 * count holds, stays. The bot counts of what is shown are always 0, since what they hold is
 * either left out or in `direct` and `messages`.
 * @param unread - The counts the Daemon kept.
 * @param muted - Whether the Timeline is muted.
 * @param quietBots - Whether what bots say is left out of the counts.
 * @returns The counts to show.
 */
export const unreadShown = (unread: Unread, muted: boolean, quietBots = false): Unread => {
  if (muted) {
    return { ...none, highlights: unread.highlights };
  }

  return {
    ...unread,
    botDirect: 0,
    botMessages: 0,
    direct: quietBots ? unread.direct : plus(unread.direct, unread.botDirect),
    messages: quietBots ? unread.messages : plus(unread.messages, unread.botMessages),
  };
};

/**
 * What is unread in a Timeline, as a view shows it.
 * @param timeline - The Timeline, as its Network lists it.
 * @param muted - Whether it is muted.
 * @param quietBots - Whether what bots say is left out.
 * @returns Its activity.
 */
export const activityOf = (timeline: Timeline, muted = false, quietBots = false): Activity => {
  const unread = unreadShown(timeline.unread, muted, quietBots);

  return { level: levelOf(unread), unread };
};

/**
 * What is unread in a Network: each count shown, summed over its Timelines, and the
 * highest level. A muted Timeline adds only its Highlights, and with bots quieted none
 * adds what a bot said.
 * @param network - The Network, as the sidebar shows it.
 * @returns Its activity.
 */
export const networkActivity = (network: SidebarNetwork): Activity => {
  let unread = none;

  for (const timeline of network.timelines) {
    const shown = unreadShown(timeline.unread, network.muted.has(timeline.id), network.quietBots);

    unread = {
      activity: plus(unread.activity, shown.activity),
      botDirect: plus(unread.botDirect, shown.botDirect),
      botMessages: plus(unread.botMessages, shown.botMessages),
      direct: plus(unread.direct, shown.direct),
      highlights: plus(unread.highlights, shown.highlights),
      messages: plus(unread.messages, shown.messages),
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
 * dimmer name. A muted Timeline's ends `muted`.
 * @param name - The Timeline's or Network's name.
 * @param activity - What is unread in it, as shown.
 * @param muted - Whether it is muted.
 * @returns The label.
 */
export const labelOf = (name: string, activity: Activity, muted = false): string => {
  const said = saidCount(activity.unread);
  const { highlights } = activity.unread;

  return [
    name,
    ...(said > 0 ? [`${countText(said)} unread`] : []),
    ...(highlights > 0
      ? [`${countText(highlights)} ${highlights === 1 ? "highlight" : "highlights"}`]
      : []),
    ...(muted ? ["muted"] : []),
  ].join(", ");
};

/**
 * The Timelines the Owner muted, as the option `ui.unread.muted` should be after muting or
 * unmuting one.
 * @param muted - The list in force.
 * @param timeline - The Timeline.
 * @param wanted - Whether it should be muted.
 * @returns The whole new list, appending a Timeline newly muted, or none when it is
 * already as wanted, or why muting one more is refused: the list holds at most
 * `mutedCap`.
 */
export const muting = (
  muted: readonly TimelineId[],
  timeline: TimelineId,
  wanted: boolean
): Parsed<readonly TimelineId[] | undefined> => {
  if (muted.includes(timeline) === wanted) {
    return { _tag: "Parsed", value: undefined };
  }

  if (!wanted) {
    return { _tag: "Parsed", value: muted.filter((id) => id !== timeline) };
  }

  return muted.length >= mutedCap
    ? {
        _tag: "Invalid",
        message: `You can mute at most ${mutedCap} conversations. /unmute one first.`,
      }
    : { _tag: "Parsed", value: [...muted, timeline] };
};

/** The page's own title, which a count goes before. */
const appName = "iirc";

/**
 * The page's title: how many Highlights and Direct Messages are unread across every
 * Network not removed, such as `(3) iirc`, or the name alone when none are. A removed
 * Network's Timelines are only kept to read, so they call for nothing.
 * @param networks - The sidebar.
 * @returns The title.
 */
export const titleOf = (networks: readonly SidebarNetwork[]): string => {
  let calling = 0;

  for (const network of networks.filter((one) => !one.removed)) {
    calling = plus(calling, callingCount(networkActivity(network).unread));
  }

  return calling === 0 ? appName : `(${countText(calling)}) ${appName}`;
};

/**
 * The highest level of anything said that is unread, across every Network: Highlight,
 * then Direct, then Message, or none when nothing said is unread, but in a removed Network. Activity alone is none,
 * as a view shows it only as a dimmer name. A compact screen's sidebar button marks it.
 * @param networks - The sidebar.
 * @returns The level, or none.
 */
export const saidLevel = (networks: readonly SidebarNetwork[]): Level | undefined => {
  let highest: Level | undefined;

  for (const network of networks.filter((one) => !one.removed)) {
    const { level } = networkActivity(network);

    if (level !== "Activity" && rank(level) > rank(highest)) {
      highest = level;
    }
  }

  return highest;
};

/**
 * How the Daemon is asked to mark a Timeline read up to an instant, by its id, or nothing
 * when that would change nothing: the Timeline has nothing unread, or its Read Marker is
 * already there or later. A detached Direct Message, or a Timeline a removed Network kept,
 * is marked like any other.
 * @param timeline - The Timeline, as its Network lists it.
 * @param read - The instant to mark it read up to.
 * @returns The intent, or none.
 */
export const markOf = (timeline: Timeline, read: Instant): MarkRead | undefined => {
  // Whatever a bot said is unread too, though a view may leave it out.
  const unread = unreadShown(timeline.unread, false);

  const nothing =
    (timeline.read !== null && read <= timeline.read) ||
    (saidCount(unread) === 0 && unread.activity === 0);

  return nothing
    ? undefined
    : {
        _tag: "MarkRead",
        network: timeline.network,
        read,
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
 * How far the Owner has seen a Pane's Timeline, as the rule says: the Pane is shown with
 * its Timeline in it, not the options, its window is current, and the view said what is
 * in view. Under `latest`, the view must also have said it is at the latest, with nothing
 * beyond its last item; under `shown`, wherever it stands.
 * @param state - The Timelines.
 * @param pane - The Pane.
 * @param rule - When a Timeline is marked read, `shown` or `latest`.
 * @returns The Timeline's description and the instant of the last item the view showed,
 * when the Owner sees it.
 */
const seenIn = (
  state: Timelines,
  pane: string,
  rule: Exclude<ReadRule, "asked">
): { readonly at: Instant; readonly timeline: Timeline } | undefined => {
  const shown = opened(state, pane);
  const view = panesOf(state.layout.root).find((one) => one.id === pane)?.view;

  if (shown._tag !== "Shown" || shown.description === undefined || view === undefined) {
    return undefined;
  }

  const { window } = shown;
  const atLatest = window.following && !window.later;
  const sees = view.main._tag === "Timeline" && window.fresh && (rule === "shown" || atLatest);

  return sees && window.seen !== undefined
    ? { at: window.seen.at, timeline: shown.description }
    : undefined;
};

/**
 * Whether a Timeline the Owner sees is due to be marked read, and up to what, as
 * `ui.unread.markRead` says: under `latest`, when the view said the Owner sees its latest; under
 * `shown`, whenever the view said what is in view, scrolled up or not; under `asked`,
 * never, so only `/read` marks it. It is up to the instant of the last item the view
 * showed, which is never past what was shown and never before its Read Marker. Of several
 * Panes, the focused one's comes first, and the next once that is marked. The runtime
 * waits a moment before it carries this out, and asks again then.
 * @param state - The Timelines.
 * @param page - The page.
 * @param rule - When a Timeline is marked read.
 * @returns The intent, or none.
 */
export const markDue = (state: Timelines, page: Page, rule: ReadRule): MarkRead | undefined => {
  if (rule === "asked") {
    return undefined;
  }

  for (const pane of seenPanes(state, page)) {
    const seen = seenIn(state, pane, rule);
    const mark = seen === undefined ? undefined : markOf(seen.timeline, seen.at);

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

    return view?.main._tag === "Timeline" && "timeline" in shown && shown.timeline === timeline;
  });
