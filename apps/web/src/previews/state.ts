/**
 * What the core holds of Previews, and the modes it reads them under, apart from what
 * changes them, so the Timelines' atoms can fold in a window's held Previews without
 * depending on the Previews' atoms, which read the Timelines'.
 *
 * @packageDocumentation
 */
import { uiShown } from "@iirc/frontend/options";
import { initialPreviews, previewsModesOf } from "@iirc/frontend/previews";
import type { Previews } from "@iirc/frontend/previews";
import { Atom } from "effect/reactivity";

import { optionsState } from "../options/state.ts";

/** What the core holds of Previews. */
export const previewsState = Atom.make<Previews>(initialPreviews).pipe(Atom.keepAlive);

/** `ui.previews` and each Timeline's own choice over it, as they show with the changes on their way, once read. */
export const previewsModes = Atom.make((get) => previewsModesOf(uiShown(get(optionsState))));
