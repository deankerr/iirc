/**
 * Where each Pane's Channel's members show: a column beside its Timeline, as this device
 * chose, where the Pane is wide enough to hold both; over its Timeline for a moment, where
 * it is narrow; or a sheet over the focused Pane on a compact screen. The Channels' state
 * itself is kept apart, and named here too for those that read it.
 *
 * @packageDocumentation
 */
import { shownPanes } from "@iirc/frontend/layout";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { pageState } from "../page/atoms.ts";
import { readChoice, writeChoice } from "../page/device.ts";
import { compact, drawerShown, drawerState } from "../page/drawer.ts";
import { focusedId, layoutState } from "../panes/atoms.ts";

export { channelHappened, channelState } from "./channels.ts";

/**
 * The narrowest a Pane is, in pixels, and still holds its members beside its Timeline:
 * about eighteen characters of members and sixty of Timeline, its times and nicks with
 * room to say something. A narrower Pane shows its members over its Timeline instead.
 */
const narrowBelow = 600;

/** Where this device keeps whether the members show. */
const membersKey = "iirc.members";

/**
 * Whether the members show beside each Channel wide enough to hold them, on this device,
 * as it last chose: hidden until it chooses otherwise.
 */
export const membersShown = Atom.make(readChoice(membersKey) === "on").pipe(Atom.keepAlive);

/** The Panes narrower than `narrowBelow`, by id, as the page measures them. */
const narrowPanes = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);

/** Whether a Pane is too narrow to hold its members beside its Timeline, by its id. */
export const paneNarrow = Atom.family((pane: string) =>
  Atom.make((get) => get(narrowPanes).has(pane))
);

/**
 * The narrow Pane whose members lie over its Timeline, if any. It is never kept, and
 * whatever the Owner does elsewhere ends it.
 */
const floatingMembers = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

/**
 * Whether a Pane's members show now, by its id: the sheet over the focused Pane on a
 * compact screen while it is open, over a narrow Pane's Timeline while it was asked for
 * there, and beside a wider one's as this device chose.
 */
export const membersOpen = Atom.family((pane: string) =>
  Atom.make((get) => {
    if (get(compact)) {
      return get(drawerShown) === "Members" && get(focusedId) === pane;
    }

    return get(paneNarrow(pane)) ? get(floatingMembers) === pane : get(membersShown);
  })
);

/** Whether any Pane shown shows its members, so they are read. */
export const membersVisible = Atom.make((get) =>
  shownPanes(get(layoutState), get(pageState).compact).some((pane) => get(membersOpen(pane.id)))
);

/**
 * Shows or hides a Pane's members: the sheet on a compact screen, over its Timeline in a
 * narrow Pane, or the column elsewhere, keeping that choice on this device as best it can.
 * @param registry - The registry.
 * @param shown - Whether to show them, or none to turn them over.
 * @param pane - The Pane's id: the focused Pane unless another is named.
 */
export const showMembers = (
  registry: AtomRegistry.AtomRegistry,
  shown: boolean | undefined,
  pane = registry.get(focusedId)
) => {
  const now = shown ?? !registry.get(membersOpen(pane));

  if (registry.get(compact)) {
    registry.set(drawerState, now ? "Members" : "None");

    return;
  }

  if (registry.get(paneNarrow(pane))) {
    registry.set(floatingMembers, now ? pane : undefined);

    return;
  }

  registry.set(membersShown, now);
  writeChoice(membersKey, now ? "on" : undefined);
};

/** Shows or hides a Pane's members, from its toggle. */
export const toggleMembers = Atom.fnSync(
  ({ pane, shown }: { readonly pane: string; readonly shown: boolean }, get) => {
    showMembers(get.registry, shown, pane);
  }
).pipe(Atom.keepAlive);

/**
 * Puts away members that lie over something, the sheet or those over a narrow Pane's
 * Timeline, as Escape, a press elsewhere, or choosing what to do with a member does. A
 * column beside a Timeline stays.
 */
export const membersDismissed = Atom.fnSync((_: undefined, get) => {
  if (get.registry.get(drawerState) === "Members") {
    get.registry.set(drawerState, "None");
  }

  get.registry.set(floatingMembers, undefined);
}).pipe(Atom.keepAlive);

/**
 * Takes how wide a Pane is now, or that it is gone. Members over a Pane that widens past
 * `narrowBelow`, or goes, are put away, so no request outlives the narrow Pane it was made
 * in.
 * @param registry - The registry.
 * @param pane - The Pane's id.
 * @param width - Its width in pixels, or none once it is gone.
 */
export const paneMeasured = (
  registry: AtomRegistry.AtomRegistry,
  pane: string,
  width: number | undefined
) => {
  const narrow = width !== undefined && width < narrowBelow;
  const held = registry.get(narrowPanes);

  if (held.has(pane) !== narrow) {
    const next = new Set(held);

    if (narrow) {
      next.add(pane);
    } else {
      next.delete(pane);
    }

    registry.set(narrowPanes, next);
  }

  if (!narrow && registry.get(floatingMembers) === pane) {
    registry.set(floatingMembers, undefined);
  }
};
