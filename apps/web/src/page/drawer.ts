/**
 * What lies over the page on a compact screen: nothing, the sidebar, drawn in from the
 * side, or the members of the focused Pane's Channel, as a sheet. It is this device's view
 * alone, presentational, and never the core's: nothing the core decides depends on it but
 * whether the members are read, which it is told as it is told the members' toggle. A
 * screen that stops being compact ends whatever was asked, since the sidebar and the
 * members have room of their own there, so narrowing it again opens nothing.
 *
 * @packageDocumentation
 */
import type { Page } from "@iirc/frontend/activity";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { pageState } from "./atoms.ts";

/** What lies over the page on a compact screen. */
export type Drawer = "None" | "Sidebar" | "Members";

/** What was last asked to lie over the page, on a compact screen. */
export const drawerState = Atom.make<Drawer>("None").pipe(Atom.keepAlive);

/** Whether the screen is compact, as a phone's is: one Pane at a time, and drawers. */
export const compact = Atom.make((get) => get(pageState).compact);

/** What lies over the page now: what was asked, on a compact screen, and nothing elsewhere. */
export const drawerShown = Atom.make((get): Drawer => (get(compact) ? get(drawerState) : "None"));

/**
 * Takes the page as the browser says it is now, and ends what was asked to lie over it
 * when its screen is not compact, so no request outlives the compact screen it was made on.
 * The members' column, this device's choice on a wider screen, is kept.
 * @param registry - The registry.
 * @param page - The page.
 */
export const pageSeen = (registry: AtomRegistry.AtomRegistry, page: Page) => {
  registry.set(pageState, page);

  if (!page.compact) {
    registry.set(drawerState, "None");
  }
};
