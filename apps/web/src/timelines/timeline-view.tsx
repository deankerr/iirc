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
import { olderUnasked, rowsOf, targetKey } from "@iirc/frontend/timelines";
import type { Divider, Row, Window } from "@iirc/frontend/timelines";
import { showsItem } from "@iirc/frontend/ui";
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useMemo, useRef } from "react";

import { LookupCard } from "../lookup/lookup-card.tsx";
import { activityShown, sizeShown } from "../options/ui.ts";
import { movedEvent } from "../panes/atoms.ts";
import { leaveTarget } from "../search/atoms.ts";
import { Button } from "../ui/button.tsx";
import { following, latest, newer, older, paneTimeline, windowCapOf } from "./atoms.ts";
import { Line } from "./line.tsx";

import styles from "./timeline-view.module.css";

/** How near the top, in pixels, the Owner must scroll for older items to be asked for. */
const nearTop = 240;

/** How near the bottom counts as at it, in pixels. */
const nearBottom = 8;

/** A line's height, in ems, as `--line-height` in `theme.css` gives it. */
const lineHeight = 1.45;

/** How long, in milliseconds, the Owner's input or a move it made lets a scroll be theirs. */
const gestureLife = 1000;

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
 * A row of the log: the start of the Timeline, a way to read the page before on purpose,
 * or one of the window's.
 * @param props - The row, and its Timeline.
 * @returns The row.
 */
const ShownRow = ({ row, timeline }: { readonly row: Shown; readonly timeline: TimelineId }) => {
  const askOlder = useAtomSet(older);

  switch (row._tag) {
    case "Start": {
      return <p className={styles.start}>The start of this Timeline</p>;
    }

    case "Held": {
      return (
        <p className={styles.start}>
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
    case "New": {
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
 * The rows of a window, virtualized, with the "new" divider where the core puts it.
 * @param props - The window, its Timeline, and its divider.
 * @returns The log.
 */
const Lines = ({
  divider,
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
  const size = useAtomValue(sizeShown);
  const cap = useAtomValue(windowCapOf);
  // Whether the page before can be read without asking, as scrolling near the top, or a
  // view that cannot be scrolled, reads it. Where it cannot, the view offers to read it on
  // purpose, at the top.
  const unasked = olderUnasked(window, cap);

  // With nothing earlier, the first row says so, inside the list, so it is anchored and
  // measured as every row is. The items `ui.activity` leaves out are not drawn, and are
  // counted all the same.
  const rows: readonly Shown[] = useMemo(() => {
    const shows = (item: TimelineItem) => showsItem(activity, kind, item.content);
    const drawn = rowsOf(window, divider, shows);

    if (!window.earlier) {
      return [start, ...drawn];
    }

    const held: Shown = { _tag: "Held", hidden: !window.items.some(shows), key: "held" };

    return unasked ? drawn : [held, ...drawn];
  }, [activity, divider, kind, unasked, window]);

  const scroller = useRef<HTMLDivElement>(null);
  const target = targetKey(window);
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
  // `ui.activity` is found among the rows around it.
  const laidOut = useRef<readonly LaidOut[]>([]);
  const shownActivity = useRef(activity);
  // What the core was last told: at the latest with the last item in view, or away. Nothing
  // yet, so the view says so once it has first laid out.
  const told = useRef<string | undefined>(undefined);
  // The scroller's box when the view last stood itself in it, so a scroll the browser makes
  // as the box changes, before the view has stood itself again, is told from the Owner's.
  const laidBox = useRef<Box | undefined>(undefined);
  // Whose a scroll is, kept in one place: where the view last put the log itself, which
  // the scroll event that follows reports, where the log last stood, and when the Owner
  // last pressed, touched, wheeled, or pressed a key in it.
  const placed = useRef<number | undefined>(undefined);
  const stood = useRef(0);
  const gestureAt = useRef<number | undefined>(undefined);

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
   * Whether a scroll event is the Owner's: not where the view last put the log, a move from
   * where it last stood, and within a second of the Owner's own input, or of the last move
   * that input made, as a wheel's or a drag's run of scrolls is. A scroll that does none of
   * that, or comes later, ends the gesture.
   * @param element - The scroller.
   * @returns Whether it is.
   */
  const scrolledByOwner = (element: HTMLElement): boolean => {
    const top = element.scrollTop;
    const now = performance.now();
    const own = top === placed.current;
    const moved = top !== stood.current;
    const live = gestureAt.current !== undefined && now - gestureAt.current <= gestureLife;
    const owned = !own && moved && live;

    placed.current = undefined;
    stood.current = top;
    gestureAt.current = owned ? now : undefined;

    return owned;
  };

  /**
   * Whether the view stays at the bottom as rows change: it was there, or the Owner jumped
   * to the latest, with nothing beyond the last row.
   * @returns Whether it does.
   */
  const pinned = () => (atBottom.current || window.following) && !window.later;

  // TanStack Virtual hands back new functions each render, which nothing here memoizes.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    // A line of text, as `--line-height` sets it, until a row is measured.
    estimateSize: () => Math.ceil(size * lineHeight),
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => scroller.current,
    overscan: 24,
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

  // A row measured at a new size moves the view by as much when it is before the row the
  // view holds still, or, at the bottom, wherever it is, so the rows wrapping again at a
  // new width or text size move nothing in view, however many change at once. The
  // virtualizer's own rule leaves a row alone while it thinks the Owner scrolls up, which
  // it does for a moment after any scroll, and so lost the place. The rule is a field of
  // the virtualizer's, not an option, so each render sets it afresh.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
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
   * Tells the core whether the Owner is at the latest, and the last item in view, when that
   * changed. Only this says the Owner has seen the latest: opening a Timeline never does.
   * A window read around a result says nothing of the latest until the Owner moved the
   * view there themselves, so a jump near the latest, or to a Timeline that fits the view,
   * marks nothing read.
   * @param element - The scroller.
   * @param owned - Whether the Owner moved the view, by the wheel, a touch, a press, or a key.
   */
  const tell = (element: HTMLDivElement, owned = false) => {
    const atLatest =
      element.scrollHeight - element.scrollTop - element.clientHeight <= nearBottom &&
      !window.later;

    if (atLatest && window.anchor !== undefined && !owned) {
      return;
    }

    const seen = atLatest ? lastInView(element) : undefined;
    let now = "away";

    if (atLatest) {
      now = seen === undefined ? "latest" : `latest ${seen.at} ${seen.sequence} ${seen.n}`;
    }

    if (now !== told.current) {
      told.current = now;
      tellFollowing({ following: atLatest, owned, seen, timeline });
    }
  };

  /**
   * Where a row the view was anchored to stands now, and how far below the top of the view
   * it should: its own place at its offset, or, when it is no longer drawn, as when
   * `ui.activity` hides it, the nearest row before it that still is, at the same offset,
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
   * the log, and takes where it stands then as no move of the Owner's, so the scroll the
   * browser reports of it says nothing.
   * @param element - The scroller.
   */
  const restandIn = (element: HTMLDivElement) => {
    placed.current = undefined;
    stand(element, true);
    stood.current = element.scrollTop;
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

    if (target !== undefined) {
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
   * Reads the page before without asking while what is drawn cannot be scrolled to reach
   * it: no item drawn, or less than fills the view, as when `ui.activity` hides a whole
   * page. Only in a view that can be seen, in the page and with a height.
   * @param element - The scroller.
   */
  const fill = (element: HTMLDivElement) => {
    const drawsNoItem = !rows.some((row) => row._tag === "Item");

    if (visible(element) && (drawsNoItem || total < element.clientHeight)) {
      readOlder();
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
    restandIn(element);
    tell(element);
    fill(element);
  };

  // The latest way back, for the Pane's move, and the latest stand, for a change of the
  // scroller's size, each of which happens between renders.
  const back = useRef(shownAgain);
  const restand = useRef(resized);

  back.current = shownAgain;
  restand.current = resized;

  // A change of the scroller's size alone, the rows' sizes aside, which the virtualizer
  // answers, may leave the view short of the bottom or of filling it.
  useLayoutEffect(() => {
    const element = scroller.current;

    const observer =
      element === null || typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            restand.current(element);
          });

    if (element !== null) {
      observer?.observe(element);
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
  // again by `ui.activity`, put the row that was in view back where it was. A row above the
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

  return (
    // Keys, a press, a touch, and the wheel only say the Owner moved the log themselves.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      aria-label={label}
      className={styles.scroller}
      onScroll={(event) => {
        const element = event.currentTarget;

        // The browser moved the log as its box changed, before the view stood itself in
        // it again: it does so now, where it stood, and the Owner moved nothing.
        if (reboxed(element)) {
          restandIn(element);
          tell(element);

          return;
        }

        remember(element);
        tell(element, scrolledByOwner(element));

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
      onPointerDown={moved}
      onTouchMove={moved}
      onWheel={moved}
      ref={scroller}
      role="log"
      // The log scrolls by keyboard, as any page does.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
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
    </div>
  );
};

/**
 * A Pane's open Timeline, or what stands in for it.
 * @param props - The Pane.
 * @returns The view.
 */
export const TimelineView = ({ pane }: { readonly pane: string }) => {
  const shown = useAtomValue(paneTimeline(pane));

  switch (shown._tag) {
    case "Closed": {
      return (
        <p className={styles.placeholder}>
          {
            "Choose a Timeline, or add a Network with /network add <id> <host>[/port] [plain] <nick>. /set opens the options."
          }
        </p>
      );
    }

    case "Vanished": {
      return <p className={styles.placeholder}>The Daemon has no such Timeline.</p>;
    }

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
