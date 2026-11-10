/**
 * The page's one place for what the browser says about it: whether it is shown and holds
 * the focus, which feeds the core, and its title, which shows what is unread. It is called
 * once, as the page starts, and lasts as long as the page.
 *
 * @packageDocumentation
 */
import type { AtomRegistry } from "effect/reactivity";

import { documentTitle } from "../reading/atoms.ts";
import { pageNow, pageState } from "./atoms.ts";

/**
 * Keeps whether the Owner can see the page, from the document's visibility and the window's
 * focus, and writes the page's title as what is unread changes.
 * @param registry - The registry.
 */
export const watchPage = (registry: AtomRegistry.AtomRegistry) => {
  const seen = () => {
    registry.set(pageState, pageNow());
  };

  document.addEventListener("visibilitychange", seen);
  window.addEventListener("focus", seen);
  window.addEventListener("blur", seen);
  seen();

  registry.subscribe(
    documentTitle,
    (title) => {
      document.title = title;
    },
    { immediate: true }
  );
};
