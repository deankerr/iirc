/**
 * The options view, as the core folds it, apart from what changes it and from the Timelines,
 * so what the Timelines' atoms derive from the shared options can read it without depending
 * on the options' atoms, which read the Timelines'.
 *
 * @packageDocumentation
 */
import { initialOptions } from "@iirc/frontend/options";
import { Atom } from "effect/reactivity";

/** The options view, as the core folds it. */
export const optionsState = Atom.make(initialOptions).pipe(Atom.keepAlive);
