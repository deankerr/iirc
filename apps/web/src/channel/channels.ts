/**
 * The head and members of each Channel the Panes show, as the core folds them, apart from
 * what reads them and from what the view shows, so the one changes stream can fold its
 * events in without depending on either.
 *
 * @packageDocumentation
 */
import { initialChannels, reduceChannels } from "@iirc/frontend/channel";
import type { Channels, ChannelsEvent } from "@iirc/frontend/channel";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

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
