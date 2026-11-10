/**
 * The Panes, as atoms derived from the core's layout, which the Timelines' state holds:
 * the tree, which Panes show on this screen, and each Pane's number among them. A change
 * to the Panes is a command the core folds, never a write here.
 *
 * @packageDocumentation
 */
import { focusedPane, panesOf } from "@iirc/frontend/layout";
import { Atom } from "effect/reactivity";

import { pageState } from "../page/atoms.ts";
import { paned, timelinesState } from "../timelines/atoms.ts";

/** The event a Pane's content hears when its node moved into another Panel. */
export const movedEvent = "iirc-pane-moved";

/** The layout: the tree of Panes and the one with the focus. */
export const layoutState = Atom.make((get) => get(timelinesState).layout);

/**
 * Whether one Pane shows alone: the layout is zoomed, or the screen is compact, as a
 * phone's is, where the layout is kept as it was and only the focused Pane shows.
 */
export const alone = Atom.make((get) => get(layoutState).zoomed || get(pageState).compact);

/** The focused Pane's id. */
export const focusedId = Atom.make((get) => focusedPane(get(layoutState)).id);

/**
 * Every Pane's id, in reading order, with its number, from 1, as its header and the composer
 * show it while there are several.
 */
const paneNumbers = Atom.make((get) =>
  panesOf(get(layoutState).root).map((pane, index) => ({ id: pane.id, number: index + 1 }))
);

/**
 * A Pane's number among several, or none while it is the only one.
 * @param pane - The Pane's id.
 * @returns The atom.
 */
export const paneNumber = Atom.family((pane: string) =>
  Atom.make((get) => {
    const numbers = get(paneNumbers);

    return numbers.length < 2 ? undefined : numbers.find((one) => one.id === pane)?.number;
  })
);

/** Focuses a Pane, as a click or focus moving into it does, unless it has the focus already. */
export const focusPane = Atom.fnSync((pane: string, get) => {
  if (focusedPane(get.registry.get(timelinesState).layout).id !== pane) {
    get.registry.set(paned, { _tag: "Focus", pane });
  }
}).pipe(Atom.keepAlive);

/**
 * Takes the ratios the Owner gave a Split by dragging its divider, or pressing an arrow key
 * on it, as percentages.
 */
export const resize = Atom.fnSync(
  ({ ratios, split }: { readonly split: string; readonly ratios: readonly number[] }, get) => {
    get.registry.set(paned, { _tag: "Resize", ratios, split });
  }
).pipe(Atom.keepAlive);
