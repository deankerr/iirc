/**
 * The palette's state and the keymap, as atoms, apart from what carries out a choice, so
 * the composer's runtime can open the palette without depending on it.
 *
 * @packageDocumentation
 */
import { defaultKeymap } from "@iirc/frontend/keymap";
import type { Keymap, Platform } from "@iirc/frontend/keymap";
import { initialPalette, reducePalette } from "@iirc/frontend/palette";
import type { PaletteEvent, Scope } from "@iirc/frontend/palette";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { runtime } from "../app/runtime.ts";
import { refresh } from "../options/atoms.ts";

/** Whether the palette is open, its query, and what was chosen recently, as the core folds it. */
export const paletteState = Atom.make(initialPalette).pipe(Atom.keepAlive);

/** The key of the palette's entry that is highlighted, as its rows say, which previews a theme. */
export const paletteHighlight = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

/**
 * The keymap the page holds. It is the core's default until options under `ui` can
 * override it.
 */
export const keymapState = Atom.make<Keymap>(defaultKeymap).pipe(Atom.keepAlive);

/**
 * Which modifier is `Mod`: Cmd on Apple's platforms, Ctrl elsewhere, read once from the
 * browser.
 */
export const platform: Platform =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent)
    ? "Mac"
    : "Other";

/**
 * Folds one event into the palette.
 * @param registry - The registry.
 * @param event - What happened.
 */
export const paletteHappened = (registry: AtomRegistry.AtomRegistry, event: PaletteEvent) => {
  registry.set(paletteState, reducePalette(registry.get(paletteState), event));
};

/**
 * Opens the palette, empty, listing everything or the themes alone, and reads the options
 * it lists, as opening the options view does, so it lists every option of every Network as
 * configured now.
 */
export const openPalette = runtime
  .fn((scope: Scope, get) =>
    Effect.gen(function* () {
      get.registry.set(paletteHighlight, undefined);
      paletteHappened(get.registry, { _tag: "Opened", scope });
      yield* refresh(get.registry);
    })
  )
  .pipe(Atom.keepAlive);
