/**
 * What the browser's Back does while something lies over the page. Each overlay that Escape
 * closes takes one entry in the history as it opens, with the same URL, so Back closes the
 * topmost overlay and nothing else. One closed any other way gives its entry back, so with
 * nothing open no entry of an overlay is left, and Back leaves the page.
 *
 * The history is kept to the overlays open, never the other way round: an entry of an
 * overlay with nothing open for it, as a reload or Forward leaves, is gone back over at once.
 *
 * @packageDocumentation
 */
import { Option, Schema } from "effect";
import { useEffect, useLayoutEffect, useRef } from "react";

/** An overlay open now, by what closes it. */
interface Overlay {
  readonly close: () => void;
}

/** What an overlay's entry holds: how many overlays' entries lie at and under it. */
const Entry = Schema.Struct({ iircOverlays: Schema.Int });

/** A history entry's state, as an overlay's entry, or none for an entry of the page's own. */
const parseEntry = Schema.decodeUnknownOption(Entry);

/**
 * How many overlays' entries lie at and under a history entry: none under the page's own.
 * @param entry - The entry, as an overlay's, if it is one.
 * @returns The count.
 */
const depthOf = (entry: Option.Option<typeof Entry.Type>) =>
  Option.match(entry, { onNone: () => 0, onSome: (one) => Math.max(0, one.iircOverlays) });

/** The overlays open, the topmost last. */
const open: Overlay[] = [];

/** How many overlays' entries lie at and under the history's current entry, once started. */
let at: number | undefined;

/** Whether the history is moving back over entries no overlay holds now. */
let moving = false;

/** Whether the history is to be put in step with the overlays open, once this task is done. */
let settling = false;

/**
 * Puts the history in step with the overlays open: back over each entry none holds, or an
 * entry pushed for each that has none. Nothing is done while the history moves.
 */
const settle = () => {
  settling = false;

  if (at === undefined || moving) {
    return;
  }

  if (at > open.length) {
    // Set first, as a browser may tell of the move before `go` returns.
    moving = true;
    history.go(open.length - at);

    return;
  }

  while (at < open.length) {
    at += 1;
    history.pushState({ iircOverlays: at }, "");
  }
};

/**
 * Settles the history once what this task opens and closes is done, so an overlay that closes
 * and opens again in one go, as React's strict mode has it, leaves it as it was.
 */
const settleSoon = () => {
  if (!settling) {
    settling = true;
    queueMicrotask(settle);
  }
};

/**
 * Takes the history's arrival at an entry. Where it moved back over entries no overlay held,
 * that is all; otherwise it is the Owner's Back, which closes each overlay above the entry,
 * the topmost first.
 * @param event - The arrival.
 */
const popped = (event: PopStateEvent) => {
  const depth = depthOf(parseEntry(event.state));
  const asked = !moving;

  moving = false;
  at = depth;

  if (asked) {
    for (const overlay of open.splice(depth).toReversed()) {
      overlay.close();
    }
  }

  settle();
};

/**
 * Starts keeping the history in step with the overlays open, from the entry the page is on,
 * which a reload may leave as an overlay's. It is called as the page starts, and as an
 * overlay first opens, and only the first call does anything.
 */
export const watchBack = () => {
  if (at !== undefined) {
    return;
  }

  at = depthOf(parseEntry(history.state));
  window.addEventListener("popstate", popped);
  settleSoon();
};

/**
 * Gives an open overlay an entry in the history, which Back closes it by.
 * @param close - What closes it.
 * @returns What gives its entry back, as it closes any other way.
 */
const opened = (close: () => void) => {
  const overlay: Overlay = { close };

  watchBack();
  open.push(overlay);
  settleSoon();

  return () => {
    const index = open.indexOf(overlay);

    if (index !== -1) {
      open.splice(index, 1);
      settleSoon();
    }
  };
};

/**
 * Lets Back close an overlay while it is open, the topmost first, as Escape does.
 * @param isOpen - Whether it is open.
 * @param close - What closes it.
 */
export const useBackCloses = (isOpen: boolean, close: () => void) => {
  const latest = useRef(close);

  useLayoutEffect(() => {
    latest.current = close;
  });

  useEffect(
    () =>
      isOpen
        ? opened(() => {
            latest.current();
          })
        : undefined,
    [isOpen]
  );
};
