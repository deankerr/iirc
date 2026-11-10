/**
 * Whether the Owner can see the page: shown, and holding the focus. The core decides from
 * it whether marking read is due and whether a notification is called for, and the one
 * place that listens for it, `watchPage`, keeps it.
 *
 * @packageDocumentation
 */
import type { Page } from "@iirc/frontend/activity";
import { Atom } from "effect/reactivity";

/**
 * The page as the browser says it is now, or unseen outside a browser, as in a test, which
 * sets it.
 * @returns The page.
 */
export const pageNow = (): Page =>
  typeof document === "undefined"
    ? { focused: false, visible: false }
    : { focused: document.hasFocus(), visible: document.visibilityState === "visible" };

/** Whether the Owner can see the page, as `watchPage` keeps it. */
export const pageState = Atom.make<Page>(pageNow()).pipe(Atom.keepAlive);
