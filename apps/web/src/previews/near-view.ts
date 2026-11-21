/**
 * What a Timeline's Previews watch to know a row is near: its scroller, and a screen's
 * height beyond it, above and below. A Message is asked for, and an image starts loading,
 * once the row is within that margin.
 *
 * @packageDocumentation
 */
import { createContext, useContext } from "react";

/**
 * The scroller a Timeline's rows are in, once it is in the page. A row's box is clipped by
 * its scroller, so a margin around the page's viewport would reach nothing outside it:
 * the scroller itself is what a margin is measured around. Where there is none, as for a
 * Preview outside a Timeline, the page's viewport stands in.
 */
const ScrollerContext = createContext<Element | null>(null);

/** Gives the Timeline's scroller to the Previews drawn inside it. */
export const ScrollerProvider = ScrollerContext.Provider;

/**
 * The scroller the Previews around this one are in, if any.
 * @returns The scroller, or none.
 */
export const useScroller = (): Element | null => useContext(ScrollerContext);

/**
 * Tells once an element is within a screen's height of a view, above or below, and watches
 * no more. Where no browser observes, it never tells.
 * @param element - The element, or none yet.
 * @param root - The scroller it is in, or none for the page's viewport.
 * @param near - What to do once it is.
 * @returns How to stop watching.
 */
export const watchNear = (
  element: Element | null,
  root: Element | null,
  near: () => void
): (() => void) => {
  if (element === null || typeof IntersectionObserver === "undefined") {
    return () => {
      // Nothing was watched.
    };
  }

  // A percentage is of the root's own box, so a margin of 100% is its height.
  const observer = new IntersectionObserver(
    (entries, self) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        self.disconnect();
        near();
      }
    },
    { root, rootMargin: "100% 0px" }
  );

  observer.observe(element);

  return () => {
    observer.disconnect();
  };
};
