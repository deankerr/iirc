/**
 * Each Pane's Lookup card, as the core folds it, apart from what asks the Daemon and from
 * what the view shows, so the one changes stream can fold its refused acts in without
 * depending on either.
 *
 * @packageDocumentation
 */
import { initialLookups, reduceLookups } from "@iirc/frontend/lookup";
import type { Lookups, LookupsEvent } from "@iirc/frontend/lookup";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

/** Each Pane's card, as the core folds it. */
export const lookupsState = Atom.make<Lookups>(initialLookups).pipe(Atom.keepAlive);

/**
 * Folds one event into the Lookups.
 * @param registry - The registry.
 * @param event - What happened.
 */
export const lookupsHappened = (registry: AtomRegistry.AtomRegistry, event: LookupsEvent) => {
  registry.set(lookupsState, reduceLookups(registry.get(lookupsState), event));
};
