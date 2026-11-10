/**
 * The open Channel's head and members as the core folds them, and whether the members
 * show on this device, apart from what reads them, so the one changes stream can fold its
 * events in without depending on the reads.
 *
 * @packageDocumentation
 */
import { initialChannel, reduceChannel } from "@iirc/frontend/channel";
import type { Channel, ChannelEvent } from "@iirc/frontend/channel";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { readChoice, writeChoice } from "../page/device.ts";

/** The open Channel's head and members, as last read. */
export const channelState = Atom.make<Channel>(initialChannel).pipe(Atom.keepAlive);

/**
 * Folds one event into the Channel's state.
 * @param registry - The registry.
 * @param event - What happened.
 */
export const channelHappened = (registry: AtomRegistry.AtomRegistry, event: ChannelEvent) => {
  registry.set(channelState, reduceChannel(registry.get(channelState), event));
};

/** Where this device keeps whether the members show. */
const membersKey = "iirc.members";

/**
 * Whether the open Channel's members show beside it, on this device, as it last chose:
 * hidden until it chooses otherwise.
 */
export const membersShown = Atom.make(readChoice(membersKey) === "on").pipe(Atom.keepAlive);

/**
 * Shows or hides the members, and keeps the choice on this device as best it can.
 * @param registry - The registry.
 * @param shown - Whether to show them, or none to turn them over.
 */
export const showMembers = (registry: AtomRegistry.AtomRegistry, shown: boolean | undefined) => {
  const now = shown ?? !registry.get(membersShown);

  registry.set(membersShown, now);
  writeChoice(membersKey, now ? "on" : undefined);
};
