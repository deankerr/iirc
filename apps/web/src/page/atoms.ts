/**
 * Whether the Owner can see the page: shown, and holding the focus, and whether its screen
 * is compact, showing one Pane at a time. The core decides from it whether marking read is
 * due and whether a notification is called for, the Panes shown follow it, and the one
 * place that listens for it, `watchPage`, keeps it.
 *
 * @packageDocumentation
 */
import type { Page } from "@iirc/frontend/activity";
import { Atom } from "effect/reactivity";

/**
 * The widest screen that is compact, as a phone's is, showing one Pane at a time. The
 * shell's styles lay the page out for it at the same width.
 */
export const compactQuery = "(max-width: 640px)";

/**
 * Whether the screen is compact now, as the browser says, which only a page in a browser
 * asks.
 * @returns Whether it is.
 */
const compactNow = (): boolean => window.matchMedia(compactQuery).matches;

/**
 * The page as the browser says it is now, or unseen outside a browser, as in a test, which
 * sets it.
 * @returns The page.
 */
export const pageNow = (): Page =>
  typeof document === "undefined"
    ? { compact: false, focused: false, visible: false }
    : {
        compact: compactNow(),
        focused: document.hasFocus(),
        visible: document.visibilityState === "visible",
      };

/** Whether the Owner can see the page, as `watchPage` keeps it. */
export const pageState = Atom.make<Page>(pageNow()).pipe(Atom.keepAlive);
