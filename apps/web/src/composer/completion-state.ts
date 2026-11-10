/**
 * Where Tab completion stands, as the core folds it, apart from what asks the Daemon, so
 * everything that replaces a draft other than completion can let it go without depending
 * on the composer's runtime.
 *
 * @packageDocumentation
 */
import { cancelled, initialCompletion } from "@iirc/frontend/completion";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

/** Where completion stands, as the core folds it. */
export const completionState = Atom.make(initialCompletion).pipe(Atom.keepAlive);

/**
 * Lets go of what was being completed: the draft was changed or replaced other than by
 * completion, by typing, recalling, sending, the palette, or another Timeline opening, so
 * an answer still on its way puts nothing in.
 * @param registry - The registry.
 */
export const cancelCompletion = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(completionState, cancelled(registry.get(completionState)));
};
