/**
 * What a key pressed does on the page, by the keymap, carried out. Every key goes through
 * here: the document's one listener, and a widget that keeps its keys from the document,
 * such as an option's editor, which asks first so a bound key still works inside it.
 *
 * @packageDocumentation
 */
import { contextOf } from "@iirc/frontend/composer";
import { resolve } from "@iirc/frontend/keymap";
import type { AtomRegistry } from "effect/reactivity";

import { perform } from "../composer/atoms.ts";
import { timelinesState } from "../timelines/atoms.ts";
import { keymapState, paletteState, platform } from "./state.ts";

/** Inputs whose type takes no text, so a key pressed there is not typing. */
const notText: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * Whether a key pressed on an element is typed into a field.
 * @param target - Where the key was pressed.
 * @returns Whether it takes text.
 */
const editing = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target instanceof HTMLInputElement) {
    return !notText.has(target.type);
  }

  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
};

/**
 * Carries out what the keymap binds a key to, if anything, and prevents its default and
 * stops it then. A key an input method is composing, or one already handled, is left alone.
 * @param registry - The registry.
 * @param event - The key, as the DOM gave it.
 * @returns Whether the keymap took it.
 */
export const pressed = (registry: AtomRegistry.AtomRegistry, event: KeyboardEvent): boolean => {
  if (event.isComposing || event.defaultPrevented) {
    return false;
  }

  const intents = resolve(
    registry.get(keymapState),
    {
      command: contextOf(registry.get(timelinesState)),
      editing: editing(event.target),
      palette: registry.get(paletteState).open,
      platform,
    },
    {
      alt: event.altKey,
      altGraph: event.getModifierState("AltGraph"),
      code: event.code,
      ctrl: event.ctrlKey,
      key: event.key,
      meta: event.metaKey,
      shift: event.shiftKey,
    }
  );

  if (intents === undefined) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  registry.set(perform, intents);

  return true;
};
