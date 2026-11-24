import { describe, expect, it } from "vitest";

import { firstHighlight, formatRows, keyInList, listedFlags } from "./format-list.ts";
import type { Highlight } from "./format-list.ts";
import { colourChoices } from "./formatting.ts";
import type { Format } from "./formatting.ts";
import type { KeyEvent } from "./keymap.ts";

const press = (key: string, held: Partial<KeyEvent> = {}): KeyEvent => ({
  alt: false,
  altGraph: false,
  code: "",
  ctrl: false,
  key,
  meta: false,
  shift: false,
  ...held,
});

const formats = 0;
const colours = 1;
const backgrounds = 2;

const at = (row: number, column: number): Highlight => ({ column, row });

const bold: Format = { _tag: "Toggle", flag: "bold" };
const red: Format = { _tag: "Colour", colour: { _tag: "Palette", index: 4 } };

describe("the formatting list", () => {
  it("holds the six formats by their letters, then the default and the sixteen colours, then the same as backgrounds", () => {
    expect({
      backgrounds: formatRows[backgrounds],
      colours: formatRows[colours]?.length,
      first: formatRows[colours]?.[0],
      letters: listedFlags.map(({ letter }) => letter).join(""),
      rows: formatRows.length,
      toggles: formatRows[formats],
    }).toStrictEqual({
      backgrounds: colourChoices.map((colour) => ({ _tag: "Background", colour })),
      colours: 17,
      first: { _tag: "Colour", colour: undefined },
      letters: "BIUMRS",
      rows: 3,
      toggles: listedFlags.map(({ flag }) => ({ _tag: "Toggle", flag })),
    });
  });

  it("starts on the default color", () => {
    expect(firstHighlight).toStrictEqual(at(colours, 0));
  });
});

describe("a key while the formatting list is open", () => {
  it.each([
    ["a format's letter chooses it", at(colours, 3), press("b"), { _tag: "Chosen", format: bold }],
    [
      "its capital chooses it",
      at(colours, 3),
      press("S", { shift: true }),
      { _tag: "Chosen", format: { _tag: "Toggle", flag: "strikethrough" } },
    ],
    [
      "m is fixed pitch",
      at(formats, 0),
      press("m"),
      { _tag: "Chosen", format: { _tag: "Toggle", flag: "monospace" } },
    ],
    ["a letter no format has is the textarea's", at(colours, 0), press("x"), { _tag: "Passed" }],
    [
      "a letter with Mod is the keymap's",
      at(colours, 0),
      press("b", { ctrl: true }),
      { _tag: "Passed" },
    ],
    [
      "a letter with Meta is the keymap's",
      at(colours, 0),
      press("r", { meta: true }),
      { _tag: "Passed" },
    ],
    [
      "a letter with AltGr types another character",
      at(colours, 0),
      press("b", { altGraph: true }),
      { _tag: "Passed" },
    ],
    [
      "a letter with Alt is the keymap's",
      at(colours, 0),
      press("b", { alt: true }),
      { _tag: "Passed" },
    ],
    [
      "Enter chooses what is highlighted",
      at(colours, 5),
      press("Enter"),
      { _tag: "Chosen", format: red },
    ],
    [
      "Enter on a format chooses it",
      at(formats, 0),
      press("Enter"),
      { _tag: "Chosen", format: bold },
    ],
    ["Escape puts it away", at(colours, 2), press("Escape"), { _tag: "Dismissed" }],
    [
      "right moves along a row",
      at(colours, 0),
      press("ArrowRight"),
      { _tag: "Moved", highlight: at(colours, 1) },
    ],
    [
      "right past the end goes round to the start",
      at(colours, 16),
      press("ArrowRight"),
      { _tag: "Moved", highlight: at(colours, 0) },
    ],
    [
      "left past the start goes round to the end",
      at(formats, 0),
      press("ArrowLeft"),
      { _tag: "Moved", highlight: at(formats, 5) },
    ],
    [
      "up from the colours reaches the formats",
      at(colours, 2),
      press("ArrowUp"),
      { _tag: "Moved", highlight: at(formats, 2) },
    ],
    [
      "up from a colour past the formats' end reaches the last format",
      at(colours, 12),
      press("ArrowUp"),
      { _tag: "Moved", highlight: at(formats, 5) },
    ],
    [
      "up from the formats stays",
      at(formats, 1),
      press("ArrowUp"),
      { _tag: "Moved", highlight: at(formats, 1) },
    ],
    [
      "down from the formats reaches the colours",
      at(formats, 4),
      press("ArrowDown"),
      { _tag: "Moved", highlight: at(colours, 4) },
    ],
    [
      "down from the colours reaches the backgrounds",
      at(colours, 9),
      press("ArrowDown"),
      { _tag: "Moved", highlight: at(backgrounds, 9) },
    ],
    [
      "up from the backgrounds reaches the colours",
      at(backgrounds, 3),
      press("ArrowUp"),
      { _tag: "Moved", highlight: at(colours, 3) },
    ],
    [
      "down from the backgrounds stays",
      at(backgrounds, 9),
      press("ArrowDown"),
      { _tag: "Moved", highlight: at(backgrounds, 9) },
    ],
    [
      "right past the backgrounds' end goes round to the start",
      at(backgrounds, 16),
      press("ArrowRight"),
      { _tag: "Moved", highlight: at(backgrounds, 0) },
    ],
    [
      "Enter on a background chooses it",
      at(backgrounds, 5),
      press("Enter"),
      { _tag: "Chosen", format: { _tag: "Background", colour: { _tag: "Palette", index: 4 } } },
    ],
    [
      "an arrow with Alt is the keymap's",
      at(colours, 0),
      press("ArrowUp", { alt: true }),
      { _tag: "Passed" },
    ],
    ["any other key is the textarea's", at(colours, 0), press("Backspace"), { _tag: "Passed" }],
  ] as const)("%s", (_, highlight, event, expected) => {
    expect(keyInList(highlight, event)).toStrictEqual(expected);
  });
});
