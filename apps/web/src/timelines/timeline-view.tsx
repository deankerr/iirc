/**
 * The open Timeline, as a log anchored to the bottom like a chat: it opens on the latest,
 * stays at the bottom while live items arrive there, keeps what is in view still when
 * older items are added above, and asks for older items as the Owner nears the top. Away
 * from the latest, it tells the core so, which then leaves new items to be read when the
 * Owner scrolls back down.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId } from "@iirc/api";
import { rowsOf } from "@iirc/frontend/timelines";
import type { Row, Window } from "@iirc/frontend/timelines";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useMemo, useRef } from "react";

import { following, newer, older, openTimeline } from "./atoms.ts";
import { Line } from "./line.tsx";

import styles from "./timeline-view.module.css";

/** How near the top, in pixels, the Owner must scroll for older items to be asked for. */
const nearTop = 240;

/** How near the bottom counts as at it, in pixels. */
const nearBottom = 8;

/** A row as the view shows it: one of the window's, or the start of the Timeline. */
type Shown = Row | { readonly _tag: "Start"; readonly key: string };

const start: Shown = { _tag: "Start", key: "start" };

/** A row in view, and how far below the top of the view it starts. */
interface Anchor {
  readonly key: string;
  readonly offset: number;
}

/**
 * The rows of a window, virtualized.
 * @param props - The window and its Timeline.
 * @returns The log.
 */
const Lines = ({
  label,
  timeline,
  window,
}: {
  readonly label: string;
  readonly timeline: TimelineId;
  readonly window: Window;
}) => {
  // With nothing earlier, the first row says so, inside the list, so it is anchored and
  // measured as every row is.
  const rows: readonly Shown[] = useMemo(
    () => (window.earlier ? rowsOf(window) : [start, ...rowsOf(window)]),
    [window]
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
  // What the core was last told: whether the Owner is at the latest.
  const told = useRef(true);

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

    // Pinned only with nothing more beyond the last row.
    if (atBottom.current && !window.later) {
      element.scrollTop = element.scrollHeight;

      return;
    }

    const held = anchor.current;

    if (shifted && held !== undefined) {
      const index = rows.findIndex((row) => row.key === held.key);
      const start = virtualizer.measurementsCache[index]?.start;

      if (start !== undefined) {
        element.scrollTop = start - held.offset;
      }
    }
  }, [rows, total, virtualizer, window.later]);

  return (
    <div
      aria-label={label}
      className={styles.scroller}
      onScroll={(event) => {
        const element = event.currentTarget;

        remember(element);

        const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < nearTop;
        const atLatest = atBottom.current && !window.later;

        if (atLatest !== told.current) {
          told.current = atLatest;
          tellFollowing({ following: atLatest, timeline });
        }

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
 * The open Timeline, or what stands in for it.
 * @returns The view.
 */
export const TimelineView = () => {
  const shown = useAtomValue(openTimeline);

  switch (shown._tag) {
    case "Closed": {
      return <p className={styles.placeholder}>Choose a Timeline.</p>;
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
          <h2 className={styles.title}>
            <bdi>{label}</bdi>
          </h2>
          <Lines
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
