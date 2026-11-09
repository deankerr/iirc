import { Schema } from "effect";
import { Yaml } from "effect/encoding";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseFormatting, plainStyle, stripFormatting } from "./format.ts";
import type { Colour, Span, Style } from "./format.ts";
import formatting from "./testdata/formatting.yaml?raw";

const VectorColour = Schema.Union([
  Schema.Struct({ palette: Schema.Finite }),
  Schema.Struct({ hex: Schema.String }),
]);

const Vectors = Schema.Struct({
  tests: Schema.Array(
    Schema.Struct({
      input: Schema.String,
      name: Schema.String,
      plain: Schema.String,
      spans: Schema.Array(
        Schema.Struct({
          bg: Schema.optional(VectorColour),
          bold: Schema.optional(Schema.Boolean),
          fg: Schema.optional(VectorColour),
          italic: Schema.optional(Schema.Boolean),
          monospace: Schema.optional(Schema.Boolean),
          reverse: Schema.optional(Schema.Boolean),
          strikethrough: Schema.optional(Schema.Boolean),
          text: Schema.String,
          underline: Schema.optional(Schema.Boolean),
        })
      ),
    })
  ),
});

const { tests: vectors } = Schema.decodeUnknownSync(Vectors)(Yaml.parse(formatting));

type VectorColourValue = typeof VectorColour.Type;

const colourOf = (colour: VectorColourValue | undefined): Colour | undefined => {
  if (colour === undefined) {
    return undefined;
  }

  return "palette" in colour
    ? { _tag: "Palette", index: colour.palette }
    : { _tag: "Hex", hex: colour.hex };
};

const expectedSpans = (spans: (typeof vectors)[number]["spans"]): Span[] =>
  spans.map((span) => ({
    style: {
      background: colourOf(span.bg),
      bold: span.bold ?? false,
      foreground: colourOf(span.fg),
      italic: span.italic ?? false,
      monospace: span.monospace ?? false,
      reverse: span.reverse ?? false,
      strikethrough: span.strikethrough ?? false,
      underline: span.underline ?? false,
    },
    text: span.text,
  }));

describe("formatting vectors", () => {
  it.each(vectors)("parses $name", ({ input, plain, spans }) => {
    expect(parseFormatting(input)).toStrictEqual(expectedSpans(spans));
    expect(stripFormatting(input)).toBe(plain);
  });
});

const codes = [
  "\u0002",
  "\u001D",
  "\u001F",
  "\u001E",
  "\u0011",
  "\u0016",
  "\u000F",
  "\u0003",
  "\u0004",
];

const alphabet = [
  ...codes,
  ...codes,
  ..."0123456789,".split(""),
  ..."abcdefABCDEF xyz".split(""),
  "99",
  "\u{1F600}",
  "\uD800",
  "\0",
];

const hasCode = (text: string) => codes.some((code) => text.includes(code));
const sameStyle = (left: Style, right: Style) => JSON.stringify(left) === JSON.stringify(right);

const colourIsValid = (colour: Colour | undefined) => {
  if (colour === undefined) {
    return true;
  }

  return colour._tag === "Palette"
    ? colour.index >= 0 && colour.index <= 98
    : /^[\da-f]{6}$/u.test(colour.hex);
};

const joined = (spans: readonly Span[]) => spans.map((span) => span.text).join("");

describe("formatting, on text with no code", () => {
  it("is one span in the plain style", () => {
    const [span, ...rest] = parseFormatting("hello");

    expect(span).toStrictEqual({ style: plainStyle, text: "hello" });
    expect(rest).toStrictEqual([]);
  });
});

describe("formatting, on random text", () => {
  const samples = fc
    .array(fc.constantFrom(...alphabet), { maxLength: 40 })
    .map((pieces) => pieces.join(""));

  it("never throws, and strips to exactly the text of the spans, which hold no code", () => {
    expect(() => {
      fc.assert(
        fc.property(samples, (sample) => {
          const stripped = stripFormatting(sample);

          return (
            joined(parseFormatting(sample)) === stripped &&
            !hasCode(stripped) &&
            stripFormatting(stripped) === stripped
          );
        }),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });

  it("makes no empty span, and never the same style twice in a row", () => {
    expect(() => {
      fc.assert(
        fc.property(samples, (sample) =>
          parseFormatting(sample).every(
            (span, index, spans) =>
              span.text !== "" &&
              (index === 0 || !sameStyle(span.style, spans[index - 1]?.style ?? plainStyle))
          )
        ),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });

  it("only ever makes colours that exist", () => {
    expect(() => {
      fc.assert(
        fc.property(samples, (sample) =>
          parseFormatting(sample).every(
            ({ style }) => colourIsValid(style.foreground) && colourIsValid(style.background)
          )
        ),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });
});

describe("formatting, on long text", () => {
  it("reads a hundred thousand codes without trouble", () => {
    const text = "\u0002a\u000304,12b".repeat(50_000);

    expect(stripFormatting(text)).toBe("ab".repeat(50_000));
    expect(joined(parseFormatting(text))).toBe("ab".repeat(50_000));
  });
});
