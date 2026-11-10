/**
 * The keymap, as data: each binding names a chord, a command in the registry by its id,
 * the text it is given as arguments, and when it applies. A key pressed resolves to the
 * intents its command gives, or to nothing, so a key no binding takes is never swallowed.
 * Bindings are written as text, `mod+k` and `!editing && !palette`, and parsed: a binding
 * that does not parse, or names no command, is dropped, so a keymap holds only bindings
 * that can fire.
 *
 * @packageDocumentation
 */
import { commandWithId, runIn } from "./commands.ts";
import type { CommandContext, Intent, Parsed } from "./commands.ts";

/** Which modifier `mod` is: Cmd on a Mac, Ctrl everywhere else. The runtime says which. */
export type Platform = "Mac" | "Other";

declare const keyName: unique symbol;

/**
 * A key's name as a chord writes it, in lower case: a named key such as `arrowdown`,
 * `enter`, `space`, or `plus`, or one printable character other than `+`. Only `keyNamed`
 * and `chordOf` make one.
 */
export type KeyName = string & { readonly [keyName]: true };

/**
 * A chord: a key with the modifiers held. `mod` is Cmd on a Mac and Ctrl elsewhere, and
 * `ctrl` and `meta` are those keys on every platform, so a chord can name either.
 */
export interface Chord {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: KeyName;
}

/** A key pressed, as the browser reports it, as plain data. */
export interface KeyEvent {
  /** `KeyboardEvent.key`. */
  readonly key: string;
  /** `KeyboardEvent.code`, the physical key. */
  readonly code: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /**
   * `getModifierState("AltGraph")`: AltGr is held, which some platforms also report as
   * Ctrl and Alt.
   */
  readonly altGraph: boolean;
}

/** What a binding's `when` may test besides its command's own conditions. */
export type ContextKey = "editing" | "palette";

/** One test of a `when`: a context key, or its negation. */
export interface Clause {
  readonly key: ContextKey;
  readonly is: boolean;
}

/** A binding's `when`: every clause must hold. None always holds. */
export type When = readonly Clause[];

/** A key bound to a command, with its arguments, when it applies. */
export interface Binding {
  readonly keys: Chord;
  /** The command's id, such as `timeline.next`. */
  readonly command: string;
  /** The text after the command's name. */
  readonly args: string;
  readonly when: When;
}

/** Bindings, later ones winning over earlier ones for the same chord. */
export type Keymap = readonly Binding[];

/** A binding as text, as a keymap is written. */
export interface BindingText {
  readonly keys: string;
  readonly command: string;
  readonly args?: string;
  readonly when?: string;
}

/**
 * Where a key was pressed.
 *
 * - `command`: the context the bound command is judged in.
 * - `editing`: focus is in a field that takes text, such as the composer.
 * - `palette`: the command palette is open.
 */
export interface KeyContext {
  readonly command: CommandContext;
  readonly editing: boolean;
  readonly palette: boolean;
  readonly platform: Platform;
}

const parsed = <A>(value: A): Parsed<A> => ({ _tag: "Parsed", value });

const invalid = <A>(message: string): Parsed<A> => ({ _tag: "Invalid", message });

/** Named keys, by the name a chord writes, and the `KeyboardEvent.key` each stands for. */
const named: ReadonlyMap<string, string> = new Map([
  ["arrowdown", "ArrowDown"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
  ["arrowup", "ArrowUp"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["end", "End"],
  ["enter", "Enter"],
  ["escape", "Escape"],
  ["home", "Home"],
  ["pagedown", "PageDown"],
  ["pageup", "PageUp"],
  ["plus", "+"],
  ["space", " "],
  ["tab", "Tab"],
  ...Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `F${index + 1}`] as const),
]);

/** What each named key is written as, by its `KeyboardEvent.key`. */
const nameOfKey: ReadonlyMap<string, string> = new Map(
  [...named].map(([name, key]) => [key, name] as const)
);

/** Other names a chord may use for a key, read as the name each stands for. */
const keyAliases: ReadonlyMap<string, string> = new Map([
  ["down", "arrowdown"],
  ["esc", "escape"],
  ["left", "arrowleft"],
  ["return", "enter"],
  ["right", "arrowright"],
  ["up", "arrowup"],
]);

/**
 * ASCII letters in lower case, and nothing else changed, so no locale is read.
 * @param text - The text.
 * @returns It, folded.
 */
const lower = (text: string) => text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

const upper = (text: string) => text.replaceAll(/[a-z]/gu, (letter) => letter.toUpperCase());

/**
 * Whether text is a key's name: a named key, or one printable character, not a control, not
 * whitespace, and not `+`, which joins a chord.
 * @param text - The text, folded.
 * @returns Whether it is.
 */
const isKeyName = (text: string): text is KeyName => named.has(text) || /^[^\p{C}\s+]$/u.test(text);

/**
 * A key's name, from the text a chord writes for it.
 * @param text - The name, in any ASCII case.
 * @returns The name, or none when no key has it.
 */
export const keyNamed = (text: string): KeyName | undefined => {
  const folded = lower(text);
  const name = keyAliases.get(folded) ?? folded;

  return isKeyName(name) ? name : undefined;
};

/** Modifiers by the names a chord may write, and which each sets. */
const modifiers: ReadonlyMap<string, "mod" | "ctrl" | "meta" | "alt" | "shift"> = new Map([
  ["alt", "alt"],
  ["cmd", "meta"],
  ["command", "meta"],
  ["control", "ctrl"],
  ["ctrl", "ctrl"],
  ["meta", "meta"],
  ["mod", "mod"],
  ["opt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
]);

/**
 * A chord, from its text, such as `mod+shift+p` or `alt+arrowup`: modifiers, each once, then
 * one key, joined by `+`, in any ASCII case. The key `+` is written `plus`.
 * @param text - The text.
 * @returns The chord, or why it is not one.
 */
export const parseChord = (text: string): Parsed<Chord> => {
  const parts = text.trim().split("+");
  const last = parts.at(-1) ?? "";
  const key = keyNamed(last.trim());

  if (key === undefined) {
    return invalid(`"${text}" does not end in a key, such as k, arrowup, or plus.`);
  }

  const held = { alt: false, ctrl: false, meta: false, mod: false, shift: false };

  for (const part of parts.slice(0, -1)) {
    const modifier = modifiers.get(lower(part.trim()));

    if (modifier === undefined) {
      return invalid(`"${part}" in "${text}" is not a modifier: mod, ctrl, meta, alt, or shift.`);
    }

    if (held[modifier]) {
      return invalid(`"${text}" holds ${modifier} twice.`);
    }

    held[modifier] = true;
  }

  return parsed({ ...held, key });
};

/**
 * A chord as text, in the order a chord is written: `mod`, `ctrl`, `meta`, `alt`, `shift`,
 * then the key. It parses back to the same chord.
 * @param chord - The chord.
 * @returns Its text.
 */
export const formatChord = (chord: Chord): string =>
  [
    chord.mod ? "mod" : undefined,
    chord.ctrl ? "ctrl" : undefined,
    chord.meta ? "meta" : undefined,
    chord.alt ? "alt" : undefined,
    chord.shift ? "shift" : undefined,
    chord.key,
  ]
    .filter((part) => part !== undefined)
    .join("+");

/** How a named key is shown to the Owner. */
const shownKeys: ReadonlyMap<string, string> = new Map([
  ["arrowdown", "↓"],
  ["arrowleft", "←"],
  ["arrowright", "→"],
  ["arrowup", "↑"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["end", "End"],
  ["enter", "Enter"],
  ["escape", "Esc"],
  ["home", "Home"],
  ["pagedown", "PageDown"],
  ["pageup", "PageUp"],
  ["plus", "+"],
  ["space", "Space"],
  ["tab", "Tab"],
]);

/**
 * A chord as the Owner reads it on their platform: `Ctrl+Shift+P` elsewhere, and `⇧⌘P` on a
 * Mac, in the order macOS shows modifiers.
 * @param chord - The chord.
 * @param platform - The platform.
 * @returns Its text.
 */
export const showChord = (chord: Chord, platform: Platform): string => {
  const key = shownKeys.get(chord.key) ?? upper(chord.key);
  const ctrl = chord.ctrl || (chord.mod && platform === "Other");
  const meta = chord.meta || (chord.mod && platform === "Mac");

  if (platform === "Mac") {
    return [
      ctrl ? "⌃" : "",
      chord.alt ? "⌥" : "",
      chord.shift ? "⇧" : "",
      meta ? "⌘" : "",
      key,
    ].join("");
  }

  return [
    ctrl ? "Ctrl" : undefined,
    meta ? "Meta" : undefined,
    chord.alt ? "Alt" : undefined,
    chord.shift ? "Shift" : undefined,
    key,
  ]
    .filter((part) => part !== undefined)
    .join("+");
};

/** One printable character, as a layout types it. */
const printable = /^[^\p{C}\s]$/u;

/** A printable ASCII character. */
const ascii = /^[!-~]$/u;

/**
 * The key a key event names. With no modifier, or Shift alone, it is the character the
 * layout typed, so an AZERTY `é` is `é`, not the `2` its physical key is on QWERTY. The
 * physical key, a letter or digit, names it only where the layout's character says less:
 * a dead key, or a key with no character; with Alt, as Option and AltGr are, a character
 * other than the physical key's; and with Ctrl or Cmd, a character outside ASCII.
 * @param event - The event.
 * @returns The key's name, or none, as for a lone modifier or a key an input method holds.
 */
const keyOfEvent = (event: KeyEvent): KeyName | undefined => {
  // An input method holds the key, so it is the input method's, not a chord.
  if (event.key === "Process") {
    return undefined;
  }

  const namedKey = nameOfKey.get(event.key);

  if (namedKey !== undefined) {
    return keyNamed(namedKey);
  }

  const physical = /^(?:Key(?<letter>[A-Z])|Digit(?<digit>\d))$/u.exec(event.code)?.groups;
  const fromCode = physical?.letter ?? physical?.digit;
  const typed = printable.test(event.key) ? keyNamed(event.key) : undefined;

  if (typed === undefined) {
    return fromCode === undefined ? undefined : keyNamed(fromCode);
  }

  if (!event.ctrl && !event.meta && !event.alt) {
    return typed;
  }

  if (fromCode === undefined) {
    return typed;
  }

  if (event.alt) {
    return lower(event.key) === lower(fromCode) ? typed : keyNamed(fromCode);
  }

  return ascii.test(event.key) ? typed : keyNamed(fromCode);
};

/**
 * Whether a key is typed as text with AltGr, such as `@` on a German layout, as the browser
 * says AltGraph is held, though it may report Ctrl and Alt too. A Ctrl+Alt chord the
 * browser does not call AltGraph is a chord.
 * @param event - The event.
 * @returns Whether it is.
 */
const altGraph = (event: KeyEvent) =>
  event.altGraph && !nameOfKey.has(event.key) && printable.test(event.key);

/**
 * The chord a key event is, on a platform: `mod` for Cmd on a Mac and Ctrl elsewhere, so it
 * matches a binding written either way.
 * @param event - The event.
 * @param platform - The platform.
 * @returns The chord, or none when the key names no key a chord can.
 */
export const chordOf = (event: KeyEvent, platform: Platform): Chord | undefined => {
  const key = keyOfEvent(event);

  if (key === undefined) {
    return undefined;
  }

  const mac = platform === "Mac";

  return {
    alt: event.alt,
    ctrl: mac ? event.ctrl : false,
    key,
    meta: mac ? false : event.meta,
    mod: mac ? event.meta : event.ctrl,
    shift: event.shift,
  };
};

/**
 * Whether a binding's chord is the one pressed: `ctrl` written for Ctrl on a platform where
 * that is `mod` is the same key, as is `meta` where Cmd is.
 * @param bound - The binding's chord.
 * @param pressed - The chord pressed, as `chordOf` gives it.
 * @param platform - The platform.
 * @returns Whether they are the same keys.
 */
const sameKeys = (bound: Chord, pressed: Chord, platform: Platform) => {
  const mac = platform === "Mac";
  const mod = bound.mod || (mac ? bound.meta : bound.ctrl);
  const other = mac ? bound.ctrl : bound.meta;

  return (
    bound.key === pressed.key &&
    bound.alt === pressed.alt &&
    bound.shift === pressed.shift &&
    mod === pressed.mod &&
    other === (mac ? pressed.ctrl : pressed.meta)
  );
};

const contextKeys: ReadonlySet<string> = new Set<ContextKey>(["editing", "palette"]);

const isContextKey = (text: string): text is ContextKey => contextKeys.has(text);

/**
 * A `when`, from its text: context keys, each perhaps negated with `!`, joined by `&&`, such
 * as `!editing && !palette`. Empty text always holds.
 * @param text - The text.
 * @returns The `when`, or why it is not one.
 */
export const parseWhen = (text: string): Parsed<When> => {
  if (text.trim() === "") {
    return parsed([]);
  }

  const clauses: Clause[] = [];

  for (const part of text.split("&&")) {
    const trimmed = part.trim();
    const negated = trimmed.startsWith("!");
    const key = (negated ? trimmed.slice(1) : trimmed).trim();

    if (!isContextKey(key)) {
      return invalid(`"${key}" in "${text}" is not a context key: editing or palette.`);
    }

    clauses.push({ is: !negated, key });
  }

  return parsed(clauses);
};

/**
 * A binding, from its text: a chord, a command the registry has, and a `when`.
 * @param text - The binding as text.
 * @returns The binding, or why it is not one.
 */
export const parseBinding = (text: BindingText): Parsed<Binding> => {
  const keys = parseChord(text.keys);
  const when = parseWhen(text.when ?? "");

  if (keys._tag === "Invalid") {
    return keys;
  }

  if (when._tag === "Invalid") {
    return when;
  }

  if (commandWithId(text.command) === undefined) {
    return invalid(`No command has the id "${text.command}".`);
  }

  return parsed({
    args: text.args ?? "",
    command: text.command,
    keys: keys.value,
    when: when.value,
  });
};

/**
 * A keymap, from bindings as text. A binding that does not parse is dropped, so the keymap
 * holds only bindings that can fire.
 * @param texts - The bindings, as text.
 * @returns The keymap.
 */
export const keymapOf = (texts: readonly BindingText[]): Keymap =>
  texts.flatMap((text) => {
    const binding = parseBinding(text);

    return binding._tag === "Parsed" ? [binding.value] : [];
  });

/**
 * The bindings the Frontend starts with. Opening the palette and moving between Timelines
 * work while typing in the composer, as an IRC client's do, and Alt+A jumps to what calls
 * for the Owner most, as WeeChat's does. Focusing the composer is `i`,
 * outside a field: a letter outside a field has no browser default, where Ctrl+L and Cmd+L
 * go to the address bar, and inside one it is typed.
 */
export const defaultBindings: readonly BindingText[] = [
  { command: "palette.open", keys: "mod+k", when: "!palette" },
  { command: "palette.open", keys: "mod+shift+p", when: "!palette" },
  { command: "timeline.next", keys: "alt+arrowdown", when: "!palette" },
  { command: "timeline.previous", keys: "alt+arrowup", when: "!palette" },
  { command: "timeline.unread", keys: "alt+a", when: "!palette" },
  { command: "composer.focus", keys: "i", when: "!editing && !palette" },
  { args: "", command: "options.set", keys: "mod+,", when: "!palette" },
];

/** The keymap the Frontend starts with. */
export const defaultKeymap: Keymap = keymapOf(defaultBindings);

/**
 * Whether a `when` holds where a key was pressed.
 * @param when - The `when`.
 * @param context - Where the key was pressed.
 * @returns Whether every clause holds.
 */
const holds = (when: When, context: KeyContext) =>
  when.every((clause) => context[clause.key] === clause.is);

/**
 * What a key pressed does: the intents of the last binding of its chord whose `when` holds,
 * and whose command can run here and gives intents for its arguments. None when no binding
 * takes it, so the runtime lets the key through.
 * @param keymap - The keymap.
 * @param context - Where the key was pressed.
 * @param event - The key.
 * @returns The intents, or none.
 */
export const resolve = (
  keymap: Keymap,
  context: KeyContext,
  event: KeyEvent
): readonly Intent[] | undefined => {
  const pressed = chordOf(event, context.platform);

  // AltGr in a field types a character, such as `@`, so it is no chord there.
  if (pressed === undefined || (context.editing && altGraph(event))) {
    return undefined;
  }

  for (const binding of keymap.toReversed()) {
    const command = commandWithId(binding.command);

    if (
      command !== undefined &&
      sameKeys(binding.keys, pressed, context.platform) &&
      holds(binding.when, context)
    ) {
      const intents = runIn(command, binding.args, context.command);

      if (intents._tag === "Parsed") {
        return intents.value;
      }
    }
  }

  return undefined;
};

/**
 * The chords bound to a command with no arguments, for a list to show beside it.
 * @param keymap - The keymap.
 * @param command - The command's id.
 * @returns Its chords, in the keymap's order.
 */
export const chordsFor = (keymap: Keymap, command: string): readonly Chord[] =>
  keymap
    .filter((binding) => binding.command === command && binding.args === "")
    .map((binding) => binding.keys);
