/**
 * The list a draft's formatting is chosen from: a row of formats, each by its letter, above
 * a row of text colours and a row of backgrounds. A Frontend draws it and carries out what it decides, while the
 * field the Owner types in keeps the focus, so each key pressed while it is open is read
 * here: a format's letter chooses it, the arrows move the highlight, Enter chooses what is
 * highlighted, and Escape puts the list away. One choice is made each time it opens.
 *
 * @packageDocumentation
 */
import { colourChoices } from "./formatting.ts";
import type { Flag, Format } from "./formatting.ts";
import type { KeyEvent } from "./keymap.ts";

/** A format the list offers, the letter that chooses it, and its name in words. */
export interface ListedFlag {
  readonly flag: Flag;
  readonly letter: string;
  readonly name: string;
}

/** The formats, in the order the list offers them, each with its letter. */
export const listedFlags: readonly ListedFlag[] = [
  { flag: "bold", letter: "B", name: "bold" },
  { flag: "italic", letter: "I", name: "italic" },
  { flag: "underline", letter: "U", name: "underline" },
  { flag: "monospace", letter: "M", name: "monospace" },
  { flag: "reverse", letter: "R", name: "reverse colors" },
  { flag: "strikethrough", letter: "S", name: "strikethrough" },
];

/**
 * The list's rows, top to bottom: the formats, then the default and the sixteen colours for
 * the text, then the same for its background.
 */
export const formatRows: readonly (readonly Format[])[] = [
  listedFlags.map(({ flag }): Format => ({ _tag: "Toggle", flag })),
  colourChoices.map((colour): Format => ({ _tag: "Colour", colour })),
  colourChoices.map((colour): Format => ({ _tag: "Background", colour })),
];

/** Which item is highlighted: its row in `formatRows`, and its place along it. */
export interface Highlight {
  readonly row: number;
  readonly column: number;
}

/** Where the highlight starts: on the default colour, so the colours are a press away. */
export const firstHighlight: Highlight = { column: 0, row: 1 };

/**
 * What a key does while the list is open.
 *
 * - `Chosen`: put the format over the range the list was opened for, and put it away.
 * - `Moved`: the highlight moved, or stayed against an edge, and the key does nothing else.
 * - `Dismissed`: put it away, choosing nothing.
 * - `Passed`: the key is not the list's, and does what it does anywhere else.
 */
export type ListKey =
  | { readonly _tag: "Chosen"; readonly format: Format }
  | { readonly _tag: "Moved"; readonly highlight: Highlight }
  | { readonly _tag: "Dismissed" }
  | { readonly _tag: "Passed" };

const byLetter: ReadonlyMap<string, Flag> = new Map(
  listedFlags.flatMap(({ flag, letter }) => [
    [letter, flag],
    [letter.toLowerCase(), flag],
  ])
);

const along: ReadonlyMap<string, number> = new Map([
  ["ArrowLeft", -1],
  ["ArrowRight", 1],
]);

const across: ReadonlyMap<string, number> = new Map([
  ["ArrowDown", 1],
  ["ArrowUp", -1],
]);

const lengthOf = (row: number) => formatRows[row]?.length ?? 0;

/**
 * The highlight moved along its row, on past either end to the other, or across to the
 * row above or below, as near the same place as that row reaches, and no further than the
 * first or the last row.
 * @param highlight - Where it is.
 * @param key - The arrow.
 * @returns Where it goes, or none for a key that is not an arrow.
 */
const moved = ({ column, row }: Highlight, key: string): Highlight | undefined => {
  const by = along.get(key);

  if (by !== undefined) {
    const length = lengthOf(row);

    return { column: (((column + by) % length) + length) % length, row };
  }

  const to = across.get(key);

  if (to === undefined) {
    return undefined;
  }

  const next = Math.min(Math.max(row + to, 0), formatRows.length - 1);

  return { column: Math.min(column, lengthOf(next) - 1), row: next };
};

/**
 * What a key does while the list is open. A key held with Mod, Ctrl, Meta, Alt, or AltGr is
 * never the list's, so the keymap or the layout keeps it; Shift alone types a letter's
 * capital.
 * @param highlight - What is highlighted.
 * @param event - The key.
 * @returns What it does.
 */
export const keyInList = (highlight: Highlight, event: KeyEvent): ListKey => {
  if (event.alt || event.ctrl || event.meta || event.altGraph) {
    return { _tag: "Passed" };
  }

  const flag = byLetter.get(event.key);

  if (flag !== undefined) {
    return { _tag: "Chosen", format: { _tag: "Toggle", flag } };
  }

  const next = moved(highlight, event.key);

  if (next !== undefined) {
    return { _tag: "Moved", highlight: next };
  }

  const format = formatRows[highlight.row]?.[highlight.column];

  if (event.key === "Enter" && format !== undefined) {
    return { _tag: "Chosen", format };
  }

  return event.key === "Escape" ? { _tag: "Dismissed" } : { _tag: "Passed" };
};
