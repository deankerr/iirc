/**
 * A Pane's open Timeline, as a log anchored to the bottom like a chat: it opens on the latest,
 * stays at the bottom while live items arrive there, keeps what is in view still when
 * older items are added above, and asks for older items as the Owner nears the top. Away
 * from the latest, it tells the core so, which then leaves new items to be read when the
 * Owner scrolls back down.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId, TimelineItem } from "@iirc/api";
import { rowsOf } from "@iirc/frontend/timelines";
import type { Divider, Row, Window } from "@iirc/frontend/timelines";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useMemo, useRef } from "react";

import { TimelineHeader } from "../channel/timeline-header.tsx";
import { movedEvent, paneNumber } from "../panes/atoms.ts";
import { following, newer, older, paneTimeline } from "./atoms.ts";
import { Line } from "./line.tsx";

import styles from "./timeline-view.module.css";

/** How near the top, in pixels, the Owner must scroll for older items to be asked for. */
const nearTop = 240;

/** How near the bottom counts as at it, in pixels. */
const nearBottom = 8;

/** A row as the view shows it: one of the window's, or the start of the Timeline. */
type Shown = Row | { readonly _tag: "Start"; readonly key: string };

const start: Shown = { _tag: "Start", key: "start" };

/** Where an item stands. */
type Position = TimelineItem["position"];

/** A row in view, and how far below the top of the view it starts. */
interface Anchor {
  readonly key: string;
  readonly offset: number;
}

/**
 * The rows of a window, virtualized, with the "new" divider where the core puts it.
 * @param props - The window, its Timeline, and its divider.
 * @returns The log.
 */
const Lines = ({
  divider,
  label,
  timeline,
  window,
}: {
  readonly divider: Divider | undefined;
  readonly label: string;
  readonly timeline: TimelineId;
  readonly window: Window;
}) => {
  // With nothing earlier, the first row says so, inside the list, so it is anchored and
  // measured as every row is.
  const rows: readonly Shown[] = useMemo(
    () => (window.earlier ? rowsOf(window, divider) : [start, ...rowsOf(window, divider)]),
    [divider, window]
  );

  const scroller = useRef<HTMLDivElement>(null);
  const askOlder = useAtomSet(older);
  const askNewer = useAtomSet(newer);
  const tellFollowing = useAtomSet(following);

  // Where the view stands, kept as the Owner scrolls, to restore after rows change. These
  // are the DOM's, not state: nothing renders from them.
  const atBottom = useRef(true);
  const anchor = useRef<Anchor | undefined>(undefined);
  const firstKey = useRef<string | undefined>(undefined);
  // What the core was last told: at the latest with the last item in view, or away. Nothing
  // yet, so the view says so once it has first laid out.
  const told = useRef<string | undefined>(undefined);

  // TanStack Virtual hands back new functions each render, which nothing here memoizes.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 20,
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => scroller.current,
    overscan: 24,
  });

  const items = virtualizer.getVirtualItems();
  const total = virtualizer.getTotalSize();

  const remember = (element: HTMLDivElement) => {
    atBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= nearBottom;

    const top = items.find((item) => item.end > element.scrollTop);

    anchor.current =
      top === undefined
        ? undefined
        : { key: String(top.key), offset: top.start - element.scrollTop };
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
   * @param element - The scroller.
   */
  const tell = (element: HTMLDivElement) => {
    const atLatest =
      element.scrollHeight - element.scrollTop - element.clientHeight <= nearBottom &&
      !window.later;

    const seen = atLatest ? lastInView(element) : undefined;
    let now = "away";

    if (atLatest) {
      now = seen === undefined ? "latest" : `latest ${seen.at} ${seen.sequence} ${seen.n}`;
    }

    if (now !== told.current) {
      told.current = now;
      tellFollowing({ following: atLatest, seen, timeline });
    }
  };

  /**
   * Puts the view back where it stood: at the bottom with nothing beyond, or the row that
   * was in view where it was.
   * @param element - The scroller.
   * @param shifted - Whether rows were added above or dropped, moving every row.
   */
  const standBack = (element: HTMLDivElement, shifted: boolean) => {
    const held = anchor.current;

    // Pinned only with nothing more beyond the last row.
    if (atBottom.current && !window.later) {
      element.scrollTop = element.scrollHeight;
    } else if (shifted && held !== undefined) {
      const index = rows.findIndex((row) => row.key === held.key);
      const start = virtualizer.measurementsCache[index]?.start;

      if (start !== undefined) {
        element.scrollTop = start - held.offset;
      }
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
  };

  // The latest way back, for the Pane's move, which happens between renders.
  const back = useRef(shownAgain);

  back.current = shownAgain;

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

  // After rows change: at the bottom, stay there; with rows added above, put the row that
  // was in view back where it was. A row above the view that changes height is kept still
  // by the virtualizer itself.
  useLayoutEffect(() => {
    const element = scroller.current;
    const first = rows[0]?.key;
    // Rows added above, or the oldest dropped past the cap, move every row.
    const shifted = firstKey.current !== undefined && first !== firstKey.current;

    firstKey.current = first;

    if (element === null) {
      return;
    }

    standBack(element, shifted);

    // Laid out: what is in view now is what the Owner can see.
    tell(element);
  });

  return (
    <div
      aria-label={label}
      className={styles.scroller}
      onScroll={(event) => {
        const element = event.currentTarget;

        remember(element);
        tell(element);

        const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < nearTop;

        if (element.scrollTop < nearTop && window.earlier && !window.reading) {
          askOlder(timeline);
        } else if (nearEnd && window.later && !window.reading) {
          askNewer(timeline);
        }
      }}
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
              className={styles.row}
              data-index={item.index}
              key={item.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row._tag === "Start" ? (
                <p className={styles.start}>The start of this Timeline</p>
              ) : (
                <Line row={row} />
              )}
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
  const number = useAtomValue(paneNumber(pane));

  switch (shown._tag) {
    case "Closed": {
      return (
        <p className={styles.placeholder}>
          {
            "Choose a Timeline, or add a Network with /network add <id> <host>[/port] [-tls] <nick>. /set opens the options."
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
          <TimelineHeader name={label} number={number} pane={pane} />
          <Lines
            divider={shown.divider}
            key={shown.timeline}
            label={label}
            timeline={shown.timeline}
            window={shown.window}
          />
        </section>
      );
    }

    default: {
      return shown satisfies never;
    }
  }
};
