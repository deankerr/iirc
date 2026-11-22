/**
 * A Pane's open Timeline, as a log anchored to the bottom like a chat: it opens on the latest,
 * stays at the bottom while live items arrive there, keeps what is in view still when
 * older items are added above or its rows wrap again, and asks for older items as the
 * Owner nears the top, or while what it draws cannot be scrolled at all. Away from the
 * latest, it tells the core so, which then leaves new items to be read when the Owner
 * scrolls back down, and with newer items beyond what it holds, it offers to jump to the
 * latest.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId, TimelineItem } from "@iirc/api";
import { dividerShown, olderUnasked, pageSize, rowsOf, targetKey } from "@iirc/frontend/timelines";
import type { Divider, Row, Window } from "@iirc/frontend/timelines";
import { showsIn } from "@iirc/frontend/ui";
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { LookupCard } from "../lookup/lookup-card.tsx";
import { activityShown, leadingShown, lineShown, sizeShown, spacingShown } from "../options/ui.ts";
import { movedEvent } from "../panes/atoms.ts";
import { ScrollerProvider } from "../previews/near-view.ts";
import { leaveTarget } from "../search/atoms.ts";
import { TailView } from "../tail/tail-view.tsx";
import { Button } from "../ui/button.tsx";
import { zone } from "../ui/dates.ts";
import {
  following,
  latest,
  newer,
  older,
  paneTimeline,
  quietBotsShown,
  selfNick,
  windowCapOf,
} from "./atoms.ts";
import { ColumnsLeast, Line, NickEdge } from "./line.tsx";

import styles from "./timeline-view.module.css";

/** How near the top, in pixels, the Owner must scroll for older items to be asked for. */
const nearTop = 240;

/** How near the bottom counts as at it, in pixels. */
const nearBottom = 8;

/** The least room under a Timeline's last row, as a multiple of the text's size. */
const minimumRoomUnder = 0.5;

/** How long, in milliseconds, the Owner's input or a move it made lets a scroll be theirs. */
const gestureLife = 1000;

/**
 * How far, in pixels, the log may move in a box that changed and still be the browser's
 * doing, which rounds where it stands to its new box.
 */
const jitter = 1;

/** The keys that scroll a log, which the Owner pressing means they moved from the target. */
const scrollKeys: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

/**
 * A row as the view shows it: one of the window's, the start of the Timeline, or, where
 * the page before is no longer read without asking, a way to read it on purpose, which
 * says whether every item the window holds is hidden.
 */
type Shown =
  | Row
  | { readonly _tag: "Start"; readonly key: string }
  | { readonly _tag: "Held"; readonly key: string; readonly hidden: boolean };

const start: Shown = { _tag: "Start", key: "start" };

/** A row as it was last laid out: its key, and where it started. */
interface LaidOut {
  readonly key: string;
  readonly start: number;
}

/**
 * Whether a scroller is in the page and has a height, so what it draws can be seen: a
 * Pane zoomed out or hidden on a compact screen is neither, and asks for nothing.
 * @param element - The scroller.
 * @returns Whether it is.
 */
const visible = (element: HTMLDivElement) => element.isConnected && element.clientHeight > 0;

/**
 * Whether a log is too narrow for columns: its own width, not the screen's, as Panes split,
 * against the least a row in columns takes, as {@link ColumnsLeast} lays it out in the text's
 * own font and size, so this holds whatever the font, the size, the time's format, and the
 * nick column. The width is its border box's, which, as the log has no border or padding,
 * is what a container query on it measured: a scrollbar's gutter counts.
 * @param element - The log.
 * @param width - Its border box's width, unrounded, as its ResizeObserver last reported it,
 * or none before it has, when its rounded width stands in until the observer reports.
 * @param least - The least row in columns.
 * @returns Whether it is.
 */
const tooNarrow = (element: HTMLElement, width: number | undefined, least: HTMLElement | null) =>
  least !== null && (width ?? element.offsetWidth) < least.offsetWidth;

/**
 * The room under a Timeline's last row, past the half of the room between rows it keeps
 * itself, so it stands as far from the Composer as from the row above, and never nearer than
 * half the text's size.
 * @param size - The text's size, in pixels.
 * @param spacing - The room between rows, as a multiple of it.
 * @returns The room, in pixels.
 */
const roomUnder = (size: number, spacing: number) =>
  size * Math.max(minimumRoomUnder, spacing) - (size * spacing) / 2;

/** Where an item stands. */
type Position = TimelineItem["position"];

/** A row in view, and how far below the top of the view it starts. */
interface Anchor {
  readonly key: string;
  readonly offset: number;
}

/** The scroller's box, as the view last laid it out. */
interface Box {
  readonly height: number;
  readonly width: number;
}

/**
 * The row the view holds still while rows change around it, as when they wrap again at a
 * new width or text size: the first whose top is in view, the line the Owner reads from,
 * or, with none, as when one row is taller than the view, the row across its top edge.
 * The rows are laid out in order, so their tops only grow.
 * @param laid - Where each row starts and ends, in order.
 * @param top - How far the view is scrolled.
 * @param height - How tall the view is.
 * @returns The row's index, or none with no rows.
 */
const anchorIndex = (
  laid: readonly { readonly end: number; readonly start: number }[],
  top: number,
  height: number
): number | undefined => {
  // The first row that starts at the top of the view or below it.
  let low = 0;
  let high = laid.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if ((laid[middle]?.start ?? 0) < top) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const first = laid[low];

  if (first !== undefined && first.start < top + height) {
    return low;
  }

  return low > 0 ? low - 1 : undefined;
};

/**
 * Which rows measured at a new size move the view by as much: those before the row the view
 * holds still, or, at the bottom, all of them, so the rows wrapping again at a new width or
 * text size move nothing in view, however many change at once. The virtualizer's own rule
 * leaves a row alone while it thinks the Owner scrolls up, which it does for a moment after
 * any scroll, and so lost the place.
 * @param pinned - Whether the view stays at the bottom, as it is asked.
 * @returns The rule, as the virtualizer asks it.
 */
const keepsStill =
  (pinned: () => boolean) =>
  (
    item: { readonly index: number },
    _delta: number,
    instance: {
      readonly measurementsCache: readonly { readonly end: number; readonly start: number }[];
      readonly scrollOffset: number | null;
      readonly scrollRect: { readonly height: number } | null;
    }
  ): boolean => {
    if (pinned()) {
      return true;
    }

    const held = anchorIndex(
      instance.measurementsCache,
      instance.scrollOffset ?? 0,
      instance.scrollRect?.height ?? 0
    );

    return held !== undefined && item.index < held;
  };

/**
 * A row of the log: the start of the Timeline, a way to read the page before on purpose,
 * or one of the window's.
 * @param props - The row, and its Timeline.
 * @returns The row.
 */
const ShownRow = ({ row, timeline }: { readonly row: Shown; readonly timeline: TimelineId }) => {
  const askOlder = useAtomSet(older);

  switch (row._tag) {
    case "Start": {
      // Nothing is before it, so nothing is drawn: a screen reader alone is told.
      return <p className={styles.unseen}>The start of this Timeline</p>;
    }

    case "Held": {
      return (
        <p className={styles.held}>
          {row.hidden
            ? "Older history here is hidden activity."
            : "Older history lies beyond what this view holds."}{" "}
          <Button
            onPress={() => {
              askOlder({ mode: "Asked", timeline });
            }}
            size="small"
          >
            Load older
          </Button>
        </p>
      );
    }

    case "Item":
    case "Gap":
    case "New":
    case "Day": {
      return <Line row={row} />;
    }

    default: {
      return row satisfies never;
    }
  }
};

/**
 * Jumps to the latest of a Timeline whose window has newer items beyond it.
 * @param props - The Timeline.
 * @returns The control.
 */
const JumpToLatest = ({ timeline }: { readonly timeline: TimelineId }) => {
  const jump = useAtomSet(latest);

  return (
    <div className={styles.jump}>
      <Button
        onPress={() => {
          jump(timeline);
        }}
        size="small"
      >
        Jump to latest
      </Button>
    </div>
  );
};

/**
 * The rows of a window, virtualized, with the "new" divider and where the day changes, as the core puts them.
 * @param props - The window, its Timeline, and its divider.
 * @returns The log.
 */
const Lines = ({
  divider: opened,
  kind,
  label,
  timeline,
  window,
}: {
  readonly divider: Divider | undefined;
  readonly kind: "Network" | "Channel" | "Direct" | undefined;
  readonly label: string;
  readonly timeline: TimelineId;
  readonly window: Window;
}) => {
  const activity = useAtomValue(activityShown);
  const quietBots = useAtomValue(quietBotsShown);
  // The "new" divider for what only bots said is not drawn while bots are quieted.
  const divider = dividerShown(opened, quietBots);
  const self = useAtomValue(selfNick(window.network));
  const size = useAtomValue(sizeShown);
  const leading = useAtomValue(leadingShown);
  const spacing = useAtomValue(spacingShown);
  const line = useAtomValue(lineShown);
  const cap = useAtomValue(windowCapOf);
  // Whether the page before can be read without asking, as scrolling near the top, or a
  // view that cannot be scrolled, reads it. Where it cannot, the view offers to read it on
  // purpose, at the top.
  const unasked = olderUnasked(window, cap);

  // With nothing earlier, the first row says so to a screen reader alone, inside the list,
  // so it is anchored and measured as every row is, and takes no room. The items
  // `ui.timeline.activity` leaves out are not drawn, and are counted all the same.
  const { rows, target } = useMemo(() => {
    const shows = showsIn(activity, kind, window.items, self);
    const drawn = rowsOf(window, divider, shows, zone, self);
    const landed = targetKey(window, drawn);

    if (!window.earlier) {
      return { rows: [start, ...drawn] satisfies readonly Shown[], target: landed };
    }

    const held: Shown = { _tag: "Held", hidden: !window.items.some(shows), key: "held" };

    return {
      rows: unasked ? drawn : ([held, ...drawn] satisfies readonly Shown[]),
      target: landed,
    };
  }, [activity, divider, kind, self, unasked, window]);

  const scroller = useRef<HTMLDivElement>(null);

  // The scroller as state too, so the Previews in its rows, which watch against it, find it
  // once it is in the page, and how tall its view is, which sets how many rows are drawn.
  const [scrollerElement, setScrollerElement] = useState<HTMLDivElement | null>(null);
  const [viewHeight, setViewHeight] = useState(0);
  // Whether the log is too narrow for columns, as it was last laid out.
  const [narrow, setNarrow] = useState(false);
  // Whether this log's nick grip is being dragged, which keeps it in columns till let go.
  const [nickDragged, setNickDragged] = useState(false);
  // The log's width as its ResizeObserver last reported it: the DOM's, not state.
  const logWidth = useRef<number | undefined>(undefined);
  // The least a row in columns takes, laid out unseen beside the log.
  const least = useRef<HTMLDivElement>(null);

  const attach = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element;
    setScrollerElement(element);
  }, []);

  const leave = useAtomSet(leaveTarget);
  const askOlder = useAtomSet(older);
  const askNewer = useAtomSet(newer);
  const tellFollowing = useAtomSet(following);

  // Where the view stands, kept as the Owner scrolls, to restore after rows change. These
  // are the DOM's, not state: nothing renders from them.
  const atBottom = useRef(true);
  const anchor = useRef<Anchor | undefined>(undefined);
  const firstKey = useRef<string | undefined>(undefined);
  // The rows as they were last laid out, and which Activity they showed, so a row hidden by
  // `ui.timeline.activity` is found among the rows around it.
  const laidOut = useRef<readonly LaidOut[]>([]);
  const shownActivity = useRef(activity);
  // What the core was last told: of which window, at the latest or away, and the last item
  // in view. Nothing yet, so the view says so once it has first laid out.
  const told = useRef<string | undefined>(undefined);
  // The scroller's box when the view last stood itself in it, so a scroll the browser makes
  // as the box changes, before the view has stood itself again, is told from the Owner's.
  const laidBox = useRef<Box | undefined>(undefined);
  // Whose a scroll is, kept in one place: where the view last put the log itself, which
  // the scroll event that follows reports, where the log last stood, when a scroll was last
  // the Owner's, or their input, which a gesture's run of scrolls carries on from, and their
  // input alone: when they last pressed, touched, wheeled, or pressed a key in the log that
  // the view has not yet answered, and whether a pointer is held down on it.
  const placed = useRef<number | undefined>(undefined);
  const stood = useRef(0);
  const gestureAt = useRef<number | undefined>(undefined);
  const inputAt = useRef<number | undefined>(undefined);
  const pressed = useRef(false);
  // The window as last committed, which the view reads between renders, never one a render
  // that was not committed saw.
  const shown = useRef({ following: window.following, later: window.later });

  /**
   * Puts the log at a position, as the view's own doing: the scroll event it causes is
   * never the Owner's. Setting where it already stands causes no event, so records none.
   * @param element - The scroller.
   * @param top - Where to put it.
   */
  const place = (element: HTMLElement, top: number) => {
    const before = element.scrollTop;

    element.scrollTop = top;

    if (element.scrollTop !== before) {
      placed.current = element.scrollTop;
      stood.current = element.scrollTop;
    }
  };

  /**
   * Whether the Owner has given input the view has not answered: a pointer held down on the
   * log, as on its scrollbar, or the wheel, a touch, a press, or a key that scrolls, within
   * the last second and since the view last stood itself again in a box that changed and
   * found that the Owner had moved nothing.
   * @returns Whether they have.
   */
  const fresh = () =>
    pressed.current ||
    (inputAt.current !== undefined && performance.now() - inputAt.current <= gestureLife);

  /**
   * Whether a scroll event is the Owner's: not where the view last put the log, a move from
   * where it last stood, and with input of theirs fresh, or within a second of the last move
   * their input made, as a wheel's or a drag's run of scrolls is. A scroll that does none of
   * that, or comes later, ends the run.
   * @param element - The scroller.
   * @returns Whether it is.
   */
  const scrolledByOwner = (element: HTMLElement): boolean => {
    const top = element.scrollTop;
    const now = performance.now();
    const own = top === placed.current;
    const moved = top !== stood.current;
    const live = gestureAt.current !== undefined && now - gestureAt.current <= gestureLife;
    const owned = !own && moved && (live || fresh());

    placed.current = undefined;
    stood.current = top;
    gestureAt.current = owned ? now : undefined;

    return owned;
  };

  /**
   * Whether the view stays at the bottom as rows change: it was there, or the Owner jumped
   * to the latest, with nothing beyond the last row, as the window last committed says.
   * @returns Whether it does.
   */
  const pinned = () => (atBottom.current || shown.current.following) && !shown.current.later;

  // Made once, and reading where the view stands as it is called, so no render, committed
  // or not, leaves its own values behind in the virtualizer.
  const { current: adjusts } = useRef(keepsStill(pinned));

  const estimated = Math.ceil(size * (leading + spacing));

  // TanStack Virtual hands back new functions each render, which nothing here memoizes.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    // A line of text, as `--line-height` sets it, and the room each row keeps about it, as
    // `--row-padding` sets it, until a row is measured.
    estimateSize: () => estimated,
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => scroller.current,
    // A screen of rows beyond the view each way, as a row is at least a line tall, for the
    // Previews of rows a screen away to be asked for and loaded; never fewer than 24.
    overscan: Math.max(24, Math.ceil(viewHeight / Math.ceil(size * leading))),
    paddingEnd: roomUnder(size, spacing),
    // Its corrections, as rows above the view are measured, are the view's own scrolls.
    scrollToFn: (offset, options, instance) => {
      const element = instance.scrollElement;
      const before = element?.scrollTop;

      elementScroll(offset, options, instance);

      if (element !== null && element.scrollTop !== before) {
        placed.current = element.scrollTop;
        stood.current = element.scrollTop;
      }
    },
  });

  // The rule is a field of the virtualizer's, not an option. Every render sets the same one.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = adjusts;

  const items = virtualizer.getVirtualItems();
  const total = virtualizer.getTotalSize();

  const remember = (element: HTMLDivElement) => {
    const laid = virtualizer.measurementsCache;
    const index = anchorIndex(laid, element.scrollTop, element.clientHeight);
    const held = index === undefined ? undefined : laid[index];

    atBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= nearBottom;
    anchor.current =
      held === undefined
        ? undefined
        : { key: String(held.key), offset: held.start - element.scrollTop };
  };

  /**
   * The last item in view: of the rows drawn, the last item that overlaps the view, none
   * when the view has no height or shows only other rows, such as a Gap, the divider, or
   * the start of the Timeline. Rows fewer than the view holds sit at its bottom, so they
   * stand lower by the room left above them.
   * @param element - The scroller.
   * @returns Its position, or none when no item is in view.
   */
  const lastInView = (element: HTMLDivElement): Position | undefined => {
    const top = element.scrollTop;
    const height = element.clientHeight;
    const below = Math.max(0, height - virtualizer.getTotalSize());

    if (height <= 0) {
      return undefined;
    }

    for (const item of virtualizer.getVirtualItems().toReversed()) {
      const row = rows[item.index];
      const overlaps = item.start + below < top + height && item.end + below > top;

      if (overlaps && row?._tag === "Item") {
        return row.item.position;
      }
    }

    return undefined;
  };

  /**
   * Tells the core whether the Owner is at the latest, and the last item in view, at the
   * latest or not, when either changed. Only this says what the Owner has seen: opening a
   * Timeline never does. A window read around a result says nothing of the latest until
   * the Owner moved the view there themselves, so a jump near the latest, or to a Timeline
   * that fits the view, is told as away from it.
   * @param element - The scroller.
   * @param owned - Whether the Owner moved the view, by the wheel, a touch, a press, or a key.
   */
  const tell = (element: HTMLDivElement, owned = false) => {
    const atLatest =
      element.scrollHeight - element.scrollTop - element.clientHeight <= nearBottom &&
      !window.later;

    const latest = atLatest && (window.anchor === undefined || owned);
    const seen = lastInView(element);
    // A window read again holds nothing seen, so it is told again even where it stands.
    const at = seen === undefined ? "none" : `${seen.at} ${seen.sequence} ${seen.n}`;
    const now = `${window.generation} ${latest ? "latest" : "away"} ${at}`;

    if (now !== told.current) {
      told.current = now;
      tellFollowing({ following: latest, owned, seen, timeline });
    }
  };

  /**
   * Where a row the view was anchored to stands now, and how far below the top of the view
   * it should: its own place at its offset, or, when it is no longer drawn, as when
   * `ui.timeline.activity` hides it, the nearest row before it that still is, at the same offset,
   * or with none before, the nearest after it, where that one stood.
   * @param anchored - The row, and its offset.
   * @returns The index and offset, or none when no row it was laid out with is drawn.
   */
  const survivorOf = (anchored: Anchor): Anchor | undefined => {
    const now = new Map(rows.map((row, index) => [row.key, index]));
    const before = laidOut.current;
    const at = before.findIndex((row) => row.key === anchored.key);
    const own = now.get(anchored.key);

    if (own !== undefined) {
      return { key: anchored.key, offset: anchored.offset };
    }

    if (at === -1) {
      return undefined;
    }

    for (let index = at - 1; index >= 0; index -= 1) {
      const key = before[index]?.key ?? "";

      if (now.has(key)) {
        return { key, offset: anchored.offset };
      }
    }

    const from = before[at]?.start ?? 0;

    for (let index = at + 1; index < before.length; index += 1) {
      const row = before[index];

      if (row !== undefined && now.has(row.key)) {
        return { key: row.key, offset: anchored.offset + row.start - from };
      }
    }

    return undefined;
  };

  /**
   * Puts the view back where it stood: at the bottom with nothing beyond, as when it was
   * there or the Owner jumped to the latest, or the row that was in view where it was, or
   * the row nearest it still drawn, within what can be scrolled.
   * @param element - The scroller.
   * @param shifted - Whether rows were added above, dropped, or hidden, moving every row.
   */
  const standBack = (element: HTMLDivElement, shifted: boolean) => {
    const kept = anchor.current;
    const survivor = shifted && kept !== undefined ? survivorOf(kept) : undefined;

    // Pinned only with nothing more beyond the last row.
    if (pinned()) {
      atBottom.current = true;
      place(element, element.scrollHeight);
    } else if (survivor !== undefined) {
      const index = rows.findIndex((row) => row.key === survivor.key);
      const begins = virtualizer.measurementsCache[index]?.start;
      const furthest = Math.max(0, element.scrollHeight - element.clientHeight);

      if (begins !== undefined) {
        place(element, Math.min(furthest, Math.max(0, begins - survivor.offset)));
      }
    }
  };

  /**
   * Brings the item jumped to into the middle of the view, within what can be scrolled, as
   * the virtualizer has measured the rows so far, so it stays there as rows are measured
   * or added. It does so until the Owner scrolls, which lets the target go.
   * @param element - The scroller.
   * @returns Whether the target is drawn, and was brought into view.
   */
  const centre = (element: HTMLDivElement): boolean => {
    const index = target === undefined ? -1 : rows.findIndex((row) => row.key === target);
    const measured = virtualizer.measurementsCache[index];

    if (measured === undefined) {
      return false;
    }

    const furthest = Math.max(0, element.scrollHeight - element.clientHeight);
    const middle = measured.start + measured.size / 2 - element.clientHeight / 2;

    place(element, Math.min(furthest, Math.max(0, middle)));
    atBottom.current = false;
    remember(element);

    return true;
  };

  /**
   * Stands the view where it belongs: the item jumped to in the middle, until the Owner
   * scrolls, or else where it stood, and notes the box it stood in.
   * @param element - The scroller.
   * @param shifted - Whether rows were added above, dropped, or hidden, moving every row.
   */
  const stand = (element: HTMLDivElement, shifted: boolean) => {
    if (target === undefined || !centre(element)) {
      standBack(element, shifted);
    }

    laidBox.current = { height: element.clientHeight, width: element.clientWidth };
  };

  /**
   * Stands the view again in a box that changed under it, where the browser may have moved
   * the log. The browser alone moves it from where it stood only as far as the new box
   * makes it, so with the Owner's input fresh, any move beyond that is theirs: the view
   * stands again first, then makes that move from there, so they end where they scrolled
   * to. With no fresh input, or no move beyond that, where the view stands again is no move
   * of the Owner's, the scroll the browser reports of it says nothing, and their input, if
   * any, is answered and no longer fresh.
   *
   * A box that grows takes up the Owner's move as far as it grew, and that is the truth of
   * where they stand, not a move lost: scrolled up from the latest by less than the box
   * grew by, the top of the view shows all they scrolled up to see and its foot is still
   * the latest, so the view is at the latest and goes on following.
   * @param element - The scroller.
   * @returns Whether the Owner moved the log.
   */
  const restandIn = (element: HTMLDivElement): boolean => {
    const furthest = Math.max(0, element.scrollHeight - element.clientHeight);
    const alone = Math.min(furthest, Math.max(0, stood.current));
    const by = fresh() ? element.scrollTop - alone : 0;

    placed.current = undefined;
    stand(element, true);
    stood.current = element.scrollTop;

    if (Math.abs(by) <= jitter) {
      inputAt.current = undefined;

      return false;
    }

    place(element, element.scrollTop + by);
    gestureAt.current = performance.now();
    remember(element);

    return true;
  };

  /**
   * Whether the scroller's box changed since the view last stood in it, as when its Pane
   * is resized: the rows have not been measured at the new size yet, and a scroll the
   * browser makes meanwhile says nothing of where the Owner stands.
   * @param element - The scroller.
   * @returns Whether it did.
   */
  const reboxed = (element: HTMLDivElement) =>
    laidBox.current !== undefined &&
    (laidBox.current.height !== element.clientHeight ||
      laidBox.current.width !== element.clientWidth);

  /**
   * Notes the Owner's input, the wheel, a touch, a press, or a key that scrolls, which lets
   * a scroll it makes within a second be theirs, and lets the item jumped to go.
   */
  const moved = () => {
    gestureAt.current = performance.now();
    inputAt.current = gestureAt.current;

    if (window.target !== undefined) {
      leave(timeline);
    }
  };

  /**
   * Reads the page before without asking, one at a time, as `Auto`, so the latest of a
   * window that holds it is never dropped for it, and only while `olderUnasked` says it
   * can: the view offers the rest on purpose.
   */
  const readOlder = () => {
    if (unasked && window.older === undefined && !window.reading) {
      askOlder({ mode: "Auto", timeline });
    }
  };

  /**
   * Reads on without asking while what is drawn cannot be scrolled to reach more: no item
   * drawn, or less than fills the view, as when `ui.timeline.activity` hides a whole page. It reads
   * the page before, except while a jump's window draws no item at all, as after a jump
   * before a Timeline's first item onto Activity hidden: what it jumped to lies at or after
   * its first item, so it reads the page after instead, until an item is drawn, and only
   * while that drops nothing past the cap, so nothing held, a Gap's edge included, is let
   * go. Only in a view that can be seen, in the page and with a height.
   * @param element - The scroller.
   */
  const fill = (element: HTMLDivElement) => {
    const drawsNoItem = !rows.some((row) => row._tag === "Item");

    if (!visible(element) || !(drawsNoItem || total < element.clientHeight)) {
      return;
    }

    if (!(drawsNoItem && window.target !== undefined && window.later)) {
      readOlder();
    } else if (!window.newer && !window.reading && window.items.length + pageSize <= cap) {
      askNewer(timeline);
    }
  };

  /**
   * Puts the view back after its Pane moved, and tells the core what is in view there now,
   * as a Pane shown again after a zoom shows what it did not while hidden.
   * @param element - The scroller.
   */
  const shownAgain = (element: HTMLDivElement) => {
    standBack(element, true);
    tell(element);
    fill(element);
  };

  /**
   * Stands the view again in a scroller whose box changed, at the bottom or around the item
   * jumped to, tells the core what is in view there now, and reads on while what is drawn
   * falls short of filling it, as when a Pane is shown again or a window made taller.
   * @param element - The scroller.
   */
  const resized = (element: HTMLDivElement) => {
    tell(element, restandIn(element));
    fill(element);
  };

  // The latest way back, for the Pane's move, and the latest stand, for a change of the
  // scroller's size, each of which happens between renders, and the window, as committed:
  // first, so every effect after reads them.
  const back = useRef(shownAgain);
  const restand = useRef(resized);

  useLayoutEffect(() => {
    back.current = shownAgain;
    restand.current = resized;
    shown.current = { following: window.following, later: window.later };
  });

  // A pointer held down on the log, as on its scrollbar, is input until it is let go,
  // wherever that is.
  useLayoutEffect(() => {
    const released = () => {
      pressed.current = false;
    };

    globalThis.addEventListener("pointerup", released);
    globalThis.addEventListener("pointercancel", released);

    return () => {
      globalThis.removeEventListener("pointerup", released);
      globalThis.removeEventListener("pointercancel", released);
    };
  }, []);

  // A change of the scroller's size alone, the rows' sizes aside, which the virtualizer
  // answers, may leave the view short of the bottom or of filling it.
  useLayoutEffect(() => {
    const element = scroller.current;

    setViewHeight(element?.clientHeight ?? 0);

    const observer =
      element === null || typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver((entries) => {
            setViewHeight(element.clientHeight);
            logWidth.current = entries.at(-1)?.borderBoxSize[0]?.inlineSize ?? logWidth.current;
            // Drawn before the frame is painted, so no frame shows the rows in columns.
            flushSync(() => {
              setNarrow(tooNarrow(element, logWidth.current, least.current));
            });
            restand.current(element);
          });

    if (element !== null) {
      observer?.observe(element);
    }

    return () => {
      observer?.disconnect();
    };
  }, []);

  // Too narrow for columns from the first frame, and again as what the columns take changes,
  // with the text's font or size, the time's format, or the nick column, none of which
  // changes the log's box.
  useLayoutEffect(() => {
    const element = scroller.current;
    const measured = least.current;

    if (element !== null) {
      setNarrow(tooNarrow(element, logWidth.current, measured));
    }

    const observer =
      element === null || measured === null || typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            flushSync(() => {
              setNarrow(tooNarrow(element, logWidth.current, measured));
            });
          });

    if (measured !== null) {
      observer?.observe(measured);
    }

    return () => {
      observer?.disconnect();
    };
  }, []);

  // A Pane's node moved into another Panel loses its scroll position: put it back.
  useLayoutEffect(() => {
    const host = scroller.current?.closest("[data-pane-host]");

    const moved = () => {
      const element = scroller.current;

      if (element !== null) {
        back.current(element);
      }
    };

    host?.addEventListener(movedEvent, moved);

    return () => {
      host?.removeEventListener(movedEvent, moved);
    };
  }, []);

  // After rows change: at the bottom, stay there; with rows added above, or hidden or shown
  // again by `ui.timeline.activity`, put the row that was in view back where it was. A row above the
  // view that changes height is kept still by the virtualizer itself.
  useLayoutEffect(() => {
    const element = scroller.current;
    const first = rows[0]?.key;

    // Rows added above, the oldest dropped past the cap, or rows hidden or shown again move
    // every row.
    const shifted =
      (firstKey.current !== undefined && first !== firstKey.current) ||
      shownActivity.current !== activity;

    firstKey.current = first;
    shownActivity.current = activity;

    if (element !== null) {
      // The item jumped to stays in the middle until the Owner scrolls.
      stand(element, shifted);

      // Laid out: what is in view now is what the Owner can see.
      tell(element);
      fill(element);
    }

    laidOut.current = rows.map((row, index) => ({
      key: row.key,
      start: virtualizer.measurementsCache[index]?.start ?? 0,
    }));
  });

  // A log too narrow for columns draws its rows as `inline` does, but for while its own nick
  // grip is dragged, so the grip stays under the pointer until it lets go. Another log keeps
  // to its own width.
  const drawn = line === "columns" && narrow && !nickDragged ? "inline" : line;

  return (
    <div className={styles.log}>
      {/* Keys, a press, a touch, and the wheel only say the Owner moved the log themselves. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        aria-label={label}
        className={styles.scroller}
        // The rows' CSS reads this, so every row is one run of text, as `inline` and a log too
        // narrow for columns draw it, and under stacked, a run's Messages are drawn under one nick.
        data-line={drawn === "columns" ? undefined : drawn}
        onScroll={(event) => {
          const element = event.currentTarget;

          // The log's box changed before the view stood itself in it again: it does so now,
          // and keeps no more of the move than the Owner's fresh input made.
          if (reboxed(element)) {
            const owned = restandIn(element);

            tell(element, owned);

            if (!owned) {
              return;
            }
          } else {
            remember(element);
            tell(element, scrolledByOwner(element));
          }

          const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < nearTop;

          if (element.scrollTop < nearTop && window.earlier) {
            readOlder();
          } else if (nearEnd && window.later && !window.reading) {
            askNewer(timeline);
          }
        }}
        onKeyDown={(event) => {
          if (scrollKeys.has(event.key)) {
            moved();
          }
        }}
        onPointerDown={() => {
          pressed.current = true;
          moved();
        }}
        onTouchMove={moved}
        onWheel={moved}
        ref={attach}
        role="log"
        // The log scrolls by keyboard, as any page does.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <ScrollerProvider value={scrollerElement}>
          <div className={styles.rows} style={{ height: total }}>
            {items.map((item) => {
              const row = rows[item.index];

              return row === undefined ? null : (
                <div
                  className={row.key === target ? `${styles.row} ${styles.target}` : styles.row}
                  data-index={item.index}
                  data-target={row.key === target ? "" : undefined}
                  key={item.key}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <ShownRow row={row} timeline={timeline} />
                </div>
              );
            })}
          </div>
        </ScrollerProvider>
      </div>
      <ColumnsLeast ref={least} />
      {drawn === "columns" ? <NickEdge onHeld={setNickDragged} /> : null}
    </div>
  );
};

/**
 * A Pane's open Timeline, or what stands in for it: the Tail with none open.
 * @param props - The Pane.
 * @returns The view.
 */
export const TimelineView = ({ pane }: { readonly pane: string }) => {
  const shown = useAtomValue(paneTimeline(pane));

  switch (shown._tag) {
    // A Pane with nothing open shows iirc's own view.
    case "Closed": {
      return <TailView />;
    }

    case "Vanished": {
      return <p className={styles.placeholder}>The Daemon has no such Timeline.</p>;
    }

    // The layout this device kept is not taken yet, so the Pane is not known to be empty.
    case "Restoring":
    case "Reading": {
      return <p className={styles.placeholder}>Reading…</p>;
    }

    case "Shown": {
      const label = shown.description?.name ?? "Timeline";

      return (
        <section aria-label={label} className={styles.view}>
          <LookupCard pane={pane} />
          <Lines
            divider={shown.divider}
            key={shown.timeline}
            kind={shown.description?.kind}
            label={label}
            timeline={shown.timeline}
            window={shown.window}
          />
          {shown.window.later || shown.window.anchor !== undefined ? (
            <JumpToLatest timeline={shown.timeline} />
          ) : null}
        </section>
      );
    }

    default: {
      return shown satisfies never;
    }
  }
};
