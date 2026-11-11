/**
 * The head and members of each Channel the Panes show, as the core folds them, and whether
 * the members show on this device, apart from what reads them, so the one changes stream
 * can fold its events in without depending on the reads.
 *
 * @packageDocumentation
 */
import { initialChannels, reduceChannels } from "@iirc/frontend/channel";
import type { Channels, ChannelsEvent } from "@iirc/frontend/channel";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { readChoice, writeChoice } from "../page/device.ts";
import { compact, drawerShown, drawerState } from "../page/drawer.ts";

/** The head and members of each Channel the Panes show, as last read. */
export const channelState = Atom.make<Channels>(initialChannels).pipe(Atom.keepAlive);

/**
 * Folds one event into the Channels' state.
 * @param registry - The registry.
 * @param event - What happened.
 */
export const channelHappened = (registry: AtomRegistry.AtomRegistry, event: ChannelsEvent) => {
  registry.set(channelState, reduceChannels(registry.get(channelState), event));
};

/** Where this device keeps whether the members show. */
const membersKey = "iirc.members";

/**
 * Whether each Channel's members show beside it, on this device, as it last chose:
 * hidden until it chooses otherwise.
 */
export const membersShown = Atom.make(readChoice(membersKey) === "on").pipe(Atom.keepAlive);

/**
 * Whether the members show now: as a column beside each Channel, as this device chose, or,
 * on a compact screen, as a sheet over the focused Pane while it is open, which is never
 * kept, so a phone opens on its Timeline.
 */
export const membersVisible = Atom.make((get) =>
  get(compact) ? get(drawerShown) === "Members" : get(membersShown)
);

/**
 * Shows or hides the members: the sheet on a compact screen, or the column elsewhere,
 * keeping that choice on this device as best it can.
 * @param registry - The registry.
 * @param shown - Whether to show them, or none to turn them over.
 */
export const showMembers = (registry: AtomRegistry.AtomRegistry, shown: boolean | undefined) => {
  const now = shown ?? !registry.get(membersVisible);

  if (registry.get(compact)) {
    registry.set(drawerState, now ? "Members" : "None");

    return;
  }

  registry.set(membersShown, now);
  writeChoice(membersKey, now ? "on" : undefined);
};
