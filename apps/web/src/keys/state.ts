/**
 * The keymap the page holds and which key is `Mod`, as atoms, apart from what carries out
 * what a key asks for, so a button can show a command's keys without depending on the
 * composer's runtime.
 *
 * @packageDocumentation
 */
import { defaultKeymap } from "@iirc/frontend/keymap";
import type { Keymap, Platform } from "@iirc/frontend/keymap";
import { Atom } from "effect/reactivity";

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
