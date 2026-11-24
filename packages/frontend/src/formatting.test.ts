import { formatSpans, parseFormatting, stripFormatting } from "@iirc/protocol/format";
import type { Colour } from "@iirc/protocol/format";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { linesOf } from "./composer.ts";
import {
  flagOn,
  formattedIn,
  hasFormatting,
  linesIn,
  merged,
  pendingAfter,
  pendingWords,
  plainOf,
  styleAt,
} from "./formatting.ts";
import type { Format } from "./formatting.ts";

/**
 * A style with some flags on, and its colours.
 * @param on - The flags on, and the colours.
 * @returns The style.
 */
const styleOf = (on: {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly foreground?: Colour;
  readonly background?: Colour;
}) => ({
  background: on.background,
  bold: on.bold ?? false,
  foreground: on.foreground,
  italic: on.italic ?? false,
  monospace: false,
  reverse: false,
  strikethrough: false,
  underline: false,
});

const bold: Format = { _tag: "Toggle", flag: "bold" };
const italic: Format = { _tag: "Toggle", flag: "italic" };
const red: Format = { _tag: "Colour", colour: { _tag: "Palette", index: 4 } };
const uncoloured: Format = { _tag: "Colour", colour: undefined };
const blue: Format = { _tag: "Colour", colour: { _tag: "Palette", index: 2 } };
const onRed: Format = { _tag: "Background", colour: { _tag: "Palette", index: 4 } };
const unbacked: Format = { _tag: "Background", colour: undefined };

/**
 * Whether a draft's text is written as the writer writes it: each line read and written
 * again comes back the same, so no code stands where nothing follows it or changes nothing.
 * @param text - The draft's text.
 * @returns Whether it is.
 */
const normalised = (text: string) =>
  linesIn(text).every((line) => formatSpans(parseFormatting(line)) === line);

describe("a draft's plain text", () => {
  it("is what a reader sees, every code left out", () => {
    expect([
      plainOf("a \u0002b\u0002 \u000304c"),
      hasFormatting("a b"),
      hasFormatting("\u0002a"),
    ]).toStrictEqual(["a b c", false, true]);
  });
});

describe("formatting a range", () => {
  it("turns a flag off where every character of the range has it, and on where any lacks it", () => {
    expect([
      formattedIn("a \u0002b\u0002 c", 2, 3, bold),
      formattedIn("a \u0002b\u0002 c", 0, 3, bold),
    ]).toStrictEqual(["a b c", "\u0002a b\u0002 c"]);
  });

  it("keeps the other flags of the range", () => {
    expect(formattedIn("\u001Dabc", 1, 2, bold)).toBe("\u001Da\u0002b\u0002c");
  });

  it("colours a selection, and takes the colour back to the default", () => {
    const coloured = formattedIn("a b c", 2, 3, red);

    expect([coloured, formattedIn(coloured, 0, 5, uncoloured)]).toStrictEqual([
      "a \u000304b\u000399 c",
      "a b c",
    ]);
  });

  it("gives a selection a background over the default color, which reads back as that background and the default color", () => {
    const backed = formattedIn("a b c", 2, 3, onRed);

    expect([parseFormatting(backed), formattedIn(backed, 0, 5, unbacked)]).toStrictEqual([
      [
        { style: styleOf({}), text: "a " },
        { style: styleOf({ background: { _tag: "Palette", index: 4 } }), text: "b" },
        { style: styleOf({}), text: " c" },
      ],
      "a b c",
    ]);
  });

  it("keeps a run's colour under a background, and its background under a colour", () => {
    const backed = formattedIn(formattedIn("abc", 0, 3, blue), 1, 2, onRed);

    expect([
      parseFormatting(backed),
      parseFormatting(formattedIn(backed, 0, 3, red)),
    ]).toStrictEqual([
      [
        { style: styleOf({ foreground: { _tag: "Palette", index: 2 } }), text: "a" },
        {
          style: styleOf({
            background: { _tag: "Palette", index: 4 },
            foreground: { _tag: "Palette", index: 2 },
          }),
          text: "b",
        },
        { style: styleOf({ foreground: { _tag: "Palette", index: 2 } }), text: "c" },
      ],
      [
        { style: styleOf({ foreground: { _tag: "Palette", index: 4 } }), text: "a" },
        {
          style: styleOf({
            background: { _tag: "Palette", index: 4 },
            foreground: { _tag: "Palette", index: 4 },
          }),
          text: "b",
        },
        { style: styleOf({ foreground: { _tag: "Palette", index: 4 } }), text: "c" },
      ],
    ]);
  });

  it("takes only the background away with the default background", () => {
    expect(formattedIn("\u000302,04abc", 0, 3, unbacked)).toBe("\u000302abc");
  });

  it("writes a background across a line break again at the start of the next line", () => {
    const text = formattedIn("ab\ncd", 1, 4, onRed);

    const backed = { _tag: "Palette", index: 4 } as const;

    expect({
      lines: linesOf(text).map((line) =>
        parseFormatting(line).map((span) => [span.text, span.style.background])
      ),
      normal: normalised(text),
    }).toStrictEqual({
      lines: [
        [
          ["a", undefined],
          ["b", backed],
        ],
        [
          ["c", backed],
          ["d", undefined],
        ],
      ],
      normal: true,
    });
  });

  it("writes a style across a line break again at the start of the next line, so each message carries it", () => {
    const text = formattedIn("ab\ncd", 1, 4, bold);

    expect([text, linesOf(text).map((line) => parseFormatting(line))]).toStrictEqual([
      "a\u0002b\n\u0002c\u0002d",
      [
        [
          { style: styleOf({}), text: "a" },
          { style: styleOf({ bold: true }), text: "b" },
        ],
        [
          { style: styleOf({ bold: true }), text: "c" },
          { style: styleOf({}), text: "d" },
        ],
      ],
    ]);
  });
});

describe("an edit merged into a draft", () => {
  it("takes the style of the character before what was typed", () => {
    expect(merged("\u0002hi", "hi!", { caret: 3, pending: undefined })).toBe("\u0002hi!");
  });

  it("takes the style of the character after at the very start", () => {
    expect(merged("\u0002hi", "!hi", { caret: 1, pending: undefined })).toBe("\u0002!hi");
  });

  it("takes the style of the line it starts, not the line before", () => {
    expect(merged("\u0002a\nb", "a\n!b", { caret: 3, pending: undefined })).toBe("\u0002a\n!b");
  });

  it("goes on in the style of the line before on a line of its own", () => {
    expect(merged("\u0002a", "a\nb", { caret: 3, pending: undefined })).toBe("\u0002a\n\u0002b");
  });

  it("leaves no code behind once the last character of a run is deleted", () => {
    expect([
      merged("a \u0002b\u0002 c", "a  c", { caret: 2, pending: undefined }),
      merged("x\u0002y", "x", { caret: 1, pending: undefined }),
    ]).toStrictEqual(["a  c", "x"]);
  });

  it("leaves no code behind once a deletion crosses where a style changes", () => {
    expect(merged("\u0002ab\u0002cd", "acd", { caret: 1, pending: undefined })).toBe(
      "\u0002a\u0002cd"
    );
  });

  it("is placed by the caret where the text alone could place it in several ways", () => {
    expect([
      merged("\u0002a\u0002a", "aaa", { caret: 2, pending: undefined }),
      merged("\u0002a\u0002a", "a", { caret: 0, pending: undefined }),
    ]).toStrictEqual(["\u0002aa\u0002a", "a"]);
  });

  it("takes the style of what it was typed over", () => {
    expect(merged("a \u0002bc\u0002 d", "a X d", { caret: 3, pending: undefined })).toBe(
      "a \u0002X\u0002 d"
    );
  });

  it("keeps a style pending through an input method's composition, which replaces what it wrote", () => {
    const pending = pendingAfter("hello", undefined, 5, bold);
    const composing = merged("hello", "hellok", { caret: 6, pending });

    expect(merged(composing, "hello\u304B", { caret: 6, pending: undefined })).toBe(
      "hello\u0002\u304B"
    );
  });

  it("reads a paste's codes as formatting, starting from the style where it lands", () => {
    expect([
      merged("ab", "a\u0002X\u0002b", { caret: 4, pending: undefined }),
      merged("\u0002ab", "a\u0002X\u0002b", { caret: 4, pending: undefined }),
    ]).toStrictEqual(["a\u0002X\u0002b", "\u0002a\u0002X\u0002b"]);
  });

  it("keeps the formatting around a completion", () => {
    expect(merged("\u0002hey ni\u0002 there", "hey nick: there", { pending: undefined })).toBe(
      "\u0002hey nick:\u0002 there"
    );
  });

  it("is always written plainly: its plain text is the value, and no code is stray", () => {
    const styled = fc.constantFrom<Format>(bold, italic, red, uncoloured, onRed, unbacked);
    const text = fc.string({ maxLength: 12, unit: fc.constantFrom("a", "b", " ", "\n") });

    fc.assert(
      fc.property(
        text,
        fc.nat(12),
        fc.nat(12),
        styled,
        fc.nat(12),
        fc.nat(12),
        text,
        (plain, from, to, format, cut, length, typed) => {
          const low = Math.min(from, to, plain.length);
          const high = Math.min(Math.max(from, to), plain.length);
          const formatted = formattedIn(plain, low, high, format);
          const at = Math.min(cut, plain.length);

          const value =
            plain.slice(0, at) + typed + plain.slice(Math.min(at + length, plain.length));

          const after = merged(formatted, value, { caret: at + typed.length, pending: undefined });

          expect([normalised(formatted), normalised(after), stripFormatting(after)]).toStrictEqual([
            true,
            true,
            value,
          ]);
        }
      )
    );
  });
});

describe("the style pending at a caret", () => {
  it("holds a background for what is typed there next", () => {
    const pending = pendingAfter("hello", undefined, 5, onRed);

    expect(parseFormatting(merged("hello", "hello!", { caret: 6, pending }))).toStrictEqual([
      { style: styleOf({}), text: "hello" },
      { style: styleOf({ background: { _tag: "Palette", index: 4 } }), text: "!" },
    ]);
  });

  it("is typed at that caret once, and then goes", () => {
    const pending = pendingAfter("hello", undefined, 5, bold);

    expect([pending, merged("hello", "hello!", { caret: 6, pending })]).toStrictEqual([
      { at: 5, style: styleOf({ bold: true }) },
      "hello\u0002!",
    ]);
  });

  it("is typed where the text alone could place it in several ways", () => {
    const pending = pendingAfter("hello", undefined, 3, bold);

    expect(merged("hello", "helllo", { pending })).toBe("hel\u0002l\u0002lo");
  });

  it("is not typed elsewhere, after the caret moved", () => {
    const pending = pendingAfter("hello", undefined, 5, bold);

    expect(merged("hello", "h!ello", { caret: 2, pending })).toBe("h!ello");
  });

  it("is let go of once toggled back to the style in force there", () => {
    const pending = pendingAfter("hello", undefined, 5, bold);

    expect([
      pendingAfter("hello", pending, 5, bold),
      pendingAfter("hello", pending, 5, italic),
    ]).toStrictEqual([undefined, { at: 5, style: styleOf({ bold: true, italic: true }) }]);
  });

  it("turns off a style the text goes on in", () => {
    const pending = pendingAfter("\u0002hi", undefined, 2, bold);

    expect([
      styleAt("\u0002hi", 2),
      merged("\u0002hi", "hi!", { caret: 3, pending }),
    ]).toStrictEqual([styleOf({ bold: true }), "\u0002hi\u0002!"]);
  });
});

/**
 * What is pending, in words, once formats are put at offset 2, one by one.
 * @param text - The draft's text.
 * @param formats - The formats, in order.
 * @returns The words.
 */
const words = (text: string, formats: readonly Format[]) => {
  let pending: ReturnType<typeof pendingAfter>;

  for (const format of formats) {
    pending = pendingAfter(text, pending, 2, format);
  }

  return pendingWords(text, pending);
};

describe("a style pending, in words", () => {
  it("names what it changes from the style in force", () => {
    expect([
      words("hi", [italic, red]),
      words("\u0002hi", [bold]),
      words("\u000304hi", [uncoloured]),
      words("hi", []),
      words("hi", [onRed]),
      words("\u000302,04hi", [unbacked]),
    ]).toStrictEqual([
      ["italic", "red"],
      ["not bold"],
      ["default color"],
      [],
      ["red background"],
      ["default background"],
    ]);
  });
});

describe("whether a flag is on where a format would go", () => {
  it.each([
    ["the whole selection has it", "a \u0002bc\u0002 d", 2, 4, true],
    ["only some of the selection has it", "a \u0002b\u0002c d", 2, 4, false],
    ["none of the selection has it", "a bc d", 2, 4, false],
    ["at a caret in it", "a \u0002bc\u0002 d", 3, 3, true],
    ["at a caret outside it", "a \u0002bc\u0002 d", 1, 1, false],
  ])("%s", (_, text, start, end, on) => {
    expect(flagOn(text, undefined, start, end, "bold")).toBe(on);
  });

  it("is what is pending at a caret, over what is in force there", () => {
    const pending = pendingAfter("hello", undefined, 5, bold);

    expect({
      elsewhere: flagOn("hello", pending, 2, 2, "bold"),
      here: flagOn("hello", pending, 5, 5, "bold"),
    }).toStrictEqual({ elsewhere: false, here: true });
  });
});
