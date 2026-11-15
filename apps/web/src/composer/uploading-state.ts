/**
 * The files pending in the composers, as the core folds them, apart from what sends them,
 * so every change of a draft can carry their anchors along without depending on the
 * sending.
 *
 * @packageDocumentation
 */
import type { Composers, Place } from "@iirc/frontend/composer";
import { followed, initialUploading } from "@iirc/frontend/uploading";
import type { Typing } from "@iirc/frontend/uploading";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

/** Every file pending, as the core folds them. */
export const uploadingState = Atom.make(initialUploading).pipe(Atom.keepAlive);

/**
 * Where the composer's caret goes once a link was put in its draft, and how many times one
 * was, so the composer moves it each time this changes, and never as it mounts.
 */
export const caretAsked = Atom.make({ asked: 0, caret: 0 }).pipe(Atom.keepAlive);

/**
 * Carries the anchors of the files pending along as the composers change, however they
 * change: typed into, recalled, sent, or carried to a Timeline.
 * @param registry - The registry.
 * @param before - The composers before.
 * @param after - The composers after.
 * @param typing - Where the Owner's selection was in the draft they typed in, if they did.
 */
export const anchorsFollow = (
  registry: AtomRegistry.AtomRegistry,
  before: Composers,
  after: Composers,
  typing?: Typing & { readonly place: Place }
) => {
  registry.set(uploadingState, followed(registry.get(uploadingState), before, after, typing));
};
