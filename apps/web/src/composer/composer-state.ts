/**
 * The composers' state as the core folds it, and what it says is drawn in place of the
 * theme or font in effect, apart from what carries out the composer's commands, so the
 * theme can follow what the Composer's list highlights without depending on the runtime.
 *
 * @packageDocumentation
 */
import { previewOf } from "@iirc/frontend/completion";
import type { Preview } from "@iirc/frontend/completion";
import { draftOf, initialComposers, placeIn } from "@iirc/frontend/composer";
import type { Composers } from "@iirc/frontend/composer";
import { Atom } from "effect/reactivity";

import { timelinesState } from "../timelines/atoms.ts";
import { completionState } from "./completion-state.ts";

/** Every Timeline's composer, as the core folds it. */
export const composerState = Atom.make<Composers>(initialComposers).pipe(Atom.keepAlive);

/** The keys of the commands run from a composer, newest first, which its list puts first. */
export const ranState = Atom.make<readonly string[]>([]).pipe(Atom.keepAlive);

/**
 * The theme or font the composer under the main view's list highlights, which is drawn in
 * place of the one in effect while it does, and none once it moves on, the list closes, or
 * the draft is sent or changed.
 */
export const composerPreview = Atom.make((get): Preview | undefined => {
  const place = placeIn(get(timelinesState));

  return previewOf(get(completionState), place, draftOf(get(composerState), place).text);
});
