/**
 * What a key pressed does on the page, by the keymap, carried out. Every key goes through
 * here: the document's one listener, and a widget that keeps its keys from the document,
 * such as an option's editor, which asks first so a bound key still works inside it.
 *
 * @packageDocumentation
 */
import { contextOf } from "@iirc/frontend/composer";
import { resolve, typesInComposer } from "@iirc/frontend/keymap";
import type { KeyContext, KeyEvent } from "@iirc/frontend/keymap";
import type { AtomRegistry } from "effect/reactivity";

import { channelState } from "../channel/state.ts";
import { perform } from "../composer/atoms.ts";
import { composerInput } from "../composer/input.ts";
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
 * What a modal dialog, a popover, or a menu looks like once it is open: React Aria draws
 * each only while it is.
 */
const overlays = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-trigger]';

/**
 * Whether something over the page keeps its keys: a modal dialog, a popover, or a menu is
 * open, or focus is in a form, as the password prompt is.
 * @param target - Where the key was pressed.
 * @returns Whether it does.
 */
const covered = (target: EventTarget | null) =>
  document.querySelector(overlays) !== null ||
  (target instanceof Element && target.closest("form") !== null);

const keyOf = (event: KeyboardEvent): KeyEvent => ({
  alt: event.altKey,
  altGraph: event.getModifierState("AltGraph"),
  code: event.code,
  ctrl: event.ctrlKey,
  key: event.key,
  meta: event.metaKey,
  shift: event.shiftKey,
});

/**
 * Where a key was pressed, for the keymap.
 * @param registry - The registry.
 * @param event - The key, as the DOM gave it.
 * @returns Where it was.
 */
const contextOfKey = (registry: AtomRegistry.AtomRegistry, event: KeyboardEvent): KeyContext => ({
  command: contextOf(registry.get(timelinesState), registry.get(channelState)),
  composer: composerInput(document) !== undefined,
  covered: covered(event.target),
  editing: editing(event.target),
  palette: registry.get(paletteState).open,
  platform,
});

/**
 * Gives a key that types to the composer, which takes the focus at once, its caret at the end
 * of its draft, so the character the key makes lands in it. It does not prevent the key's
 * default, which the browser then does to the composer, and it stops the key there, so a
 * widget's own handling of it, such as a list's typeahead, never takes the focus back. A key
 * the keymap binds, one in a field that takes text or under something that keeps its keys,
 * one an input method is composing, and one with no composer to write to, are left alone.
 * @param registry - The registry.
 * @param event - The key, as the DOM gave it.
 * @returns Whether the composer took it.
 */
export const typedInComposer = (
  registry: AtomRegistry.AtomRegistry,
  event: KeyboardEvent
): boolean => {
  const input = composerInput(document);

  if (
    input === undefined ||
    event.isComposing ||
    event.defaultPrevented ||
    !typesInComposer(registry.get(keymapState), contextOfKey(registry, event), keyOf(event))
  ) {
    return false;
  }

  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  event.stopPropagation();

  return true;
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

  const intents = resolve(registry.get(keymapState), contextOfKey(registry, event), keyOf(event));

  if (intents === undefined) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  registry.set(perform, intents);

  return true;
};
