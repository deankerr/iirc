/**
 * The sidebar as this device holds it: whether it is hidden, on a screen that is not
 * compact, and how wide it is, each kept in `localStorage` as this device's own choice. On
 * a compact screen the sidebar is a drawer instead, which `/sidebar` opens and closes.
 *
 * @packageDocumentation
 */
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { readChoice, writeChoice } from "./device.ts";
import { compact, drawerState } from "./drawer.ts";

/** Where this device keeps whether the sidebar is hidden. */
const hiddenKey = "iirc.sidebar";

/** Where this device keeps how wide the sidebar is. */
const widthKey = "iirc.sidebar-width";

/** The narrowest the sidebar is drawn, in CSS pixels: a name and its counts still fit. */
export const narrowest = 140;

/** The widest the sidebar is drawn, in CSS pixels. The shell also keeps it under half the window. */
export const widest = 480;

/** How wide the sidebar is until this device chooses, in CSS pixels. */
export const defaultWidth = 200;

/**
 * A width, held within the sidebar's bounds and to whole pixels.
 * @param width - The width asked for.
 * @returns The width drawn.
 */
const bounded = (width: number): number => Math.min(widest, Math.max(narrowest, Math.round(width)));

/**
 * A width this device kept, read back: whole pixels within the bounds, or none for
 * anything else, so text kept by another version or edited by hand starts as new.
 * @param text - The text kept.
 * @returns The width, or none.
 */
const widthKept = (text: string | undefined): number | undefined => {
  if (text === undefined || !/^\d{1,4}$/u.test(text)) {
    return undefined;
  }

  const width = Number(text);

  return width === bounded(width) ? width : undefined;
};

/** Whether this device hid the sidebar, on a screen that is not compact. */
const sidebarHidden = Atom.make(readChoice(hiddenKey) === "hidden").pipe(Atom.keepAlive);

/** How wide the sidebar is on this device, in CSS pixels, as it is dragged. */
export const sidebarWidth = Atom.make(widthKept(readChoice(widthKey)) ?? defaultWidth).pipe(
  Atom.keepAlive
);

/** Whether the sidebar has a column of its own beside the Panes now. */
export const sidebarBeside = Atom.make((get) => !get(compact) && !get(sidebarHidden));

/**
 * Shows or hides the sidebar: the drawer on a compact screen, which is never kept, or the
 * column elsewhere, keeping that choice on this device as best it can.
 * @param registry - The registry.
 * @param shown - Whether to show it, or none to turn it over.
 */
export const showSidebar = (registry: AtomRegistry.AtomRegistry, shown: boolean | undefined) => {
  if (registry.get(compact)) {
    const now = shown ?? registry.get(drawerState) !== "Sidebar";

    registry.set(drawerState, now ? "Sidebar" : "None");

    return;
  }

  const hidden = !(shown ?? registry.get(sidebarHidden));

  registry.set(sidebarHidden, hidden);
  writeChoice(hiddenKey, hidden ? "hidden" : undefined);
};

/**
 * Sets how wide the sidebar is, within its bounds, and keeps it on this device when asked,
 * as a drag ends or a key moves it, not at every step of a drag.
 * @param registry - The registry.
 * @param width - The width asked for.
 * @param keep - Whether to keep it.
 */
export const resizeSidebar = (
  registry: AtomRegistry.AtomRegistry,
  width: number,
  keep: boolean
) => {
  const drawn = bounded(width);

  registry.set(sidebarWidth, drawn);

  if (keep) {
    writeChoice(widthKey, drawn === defaultWidth ? undefined : String(drawn));
  }
};
