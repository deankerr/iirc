/**
 * Whether an element has come near the view: within a screen's height of its scroller, above
 * or below. A Message is asked for, and media starts loading, once it is near. Where no
 * browser observes, nothing ever is.
 *
 * @packageDocumentation
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * The scroller a Timeline's rows are in, once it is in the page. A row's box is clipped by
 * its scroller, so a margin around the page's viewport would reach nothing outside it:
 * the scroller itself is what a margin is measured around. Where there is none, as for a
 * Preview outside a Timeline, the page's viewport stands in.
 */
const ScrollerContext = createContext<Element | null>(null);

/** Gives the Timeline's scroller to the Previews drawn inside it. */
export const PreviewScrollerProvider = ScrollerContext.Provider;

/**
 * Tells once an element is within a screen's height of a view, above or below, and watches
 * no more. Where no browser observes, it never tells.
 * @param element - The element, or none yet.
 * @param root - The scroller it is in, or none for the page's viewport.
 * @param near - What to do once it is.
 * @returns How to stop watching.
 */
const watchNear = (
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

/**
 * Whether an element has come near the view, once: from then on it stays so, wherever it
 * scrolls. Given `onNear`, it is called once the element is near, and again each time
 * `onNear` itself changes while it is, so a caller that memoizes it on what it tells is told
 * anew when that changes.
 * @param target - The element, or a ref to it, or none to watch nothing yet.
 * @param onNear - What to call once it is near, if anything.
 * @returns Whether it is.
 */
export const useNearView = (
  target: Element | RefObject<Element | null> | null,
  onNear?: () => void
): boolean => {
  const [near, setNear] = useState(false);
  const scroller = useContext(ScrollerContext);

  useEffect(() => {
    const element = target === null || target instanceof Element ? target : target.current;

    return watchNear(near ? null : element, scroller, () => {
      setNear(true);
    });
  }, [near, scroller, target]);

  useEffect(() => {
    if (near) {
      onNear?.();
    }
  }, [near, onNear]);

  return near;
};
