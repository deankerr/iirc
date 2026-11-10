/**
 * Each Network's `CHANTYPES`, as `known` said it during a Session, which Tab completion
 * reads to tell a Channel's name from a nick. It is read once a Session, and forgotten on
 * a reset of the changes stream, apart from what reads it, so the stream can forget it
 * without depending on the composer's runtime.
 *
 * @packageDocumentation
 */
import type { NetworkId } from "@iirc/api";
import type { Chantypes } from "@iirc/frontend/completion";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

/** Each Network's `CHANTYPES`, with the Session it was read during. */
export const chantypesState = Atom.make<ReadonlyMap<NetworkId, Chantypes>>(new Map()).pipe(
  Atom.keepAlive
);

/**
 * Forgets every Network's `CHANTYPES`, as on a reset, after which each is read again.
 * @param registry - The registry.
 */
export const forgetChantypes = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(chantypesState, new Map());
};
