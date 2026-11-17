import { Schema } from "effect";
import { Yaml } from "effect/encoding";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatSpans, parseFormatting, plainStyle, stripFormatting } from "./format.ts";
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

const styled = (text: string, style: Partial<Style> = {}): Span => ({
  style: { ...plainStyle, ...style },
  text,
});

const palette = (index: number): Colour => ({ _tag: "Palette", index });

const hex = (digits: string): Colour => ({ _tag: "Hex", hex: digits });

describe(formatSpans, () => {
  it("writes nothing for no spans, and bare text for the plain style", () => {
    expect(formatSpans([])).toBe("");
    expect(formatSpans([styled("hello")])).toBe("hello");
  });

  it("writes only what changes, and no reset at the end", () => {
    expect(formatSpans([styled("a", { bold: true }), styled("b")])).toBe("\u0002a\u0002b");
    expect(
      formatSpans([styled("a", { bold: true }), styled("b", { bold: true, italic: true })])
    ).toBe("\u0002a\u001Db");
  });

  it("writes a palette colour as two digits, so a digit after it is text", () => {
    expect(formatSpans([styled("5", { foreground: palette(4) })])).toBe("\u0003045");
    expect(formatSpans([styled("a", { background: palette(5), foreground: palette(4) })])).toBe(
      "\u000304,05a"
    );
  });

  it("writes the default colour so that a digit after it is text", () => {
    const spans = [styled("a", { foreground: palette(4) }), styled("7")];

    expect(formatSpans(spans)).toBe("\u000304a\u0003997");
    expect(parseFormatting(formatSpans(spans))).toStrictEqual(spans);
  });

  it("keeps a comma after a colour as text", () => {
    const spans = [
      styled(",5", { foreground: palette(4) }),
      styled(",ff0000", { foreground: hex("00ff00") }),
    ];

    expect(parseFormatting(formatSpans(spans))).toStrictEqual(spans);
  });

  it("strips the codes in a span's text, so they cannot change what follows", () => {
    const spans = [styled("a\u0002b\u000304,05c\u000F"), styled("d", { italic: true })];

    expect(parseFormatting(formatSpans(spans))).toStrictEqual([
      styled("abc"),
      styled("d", { italic: true }),
    ]);
  });

  it("never throws, on colours that do not exist", () => {
    const spans = [
      styled("a", { background: hex("xyz"), foreground: palette(120) }),
      styled("b", { background: palette(1.5), foreground: palette(-1) }),
    ];

    expect(parseFormatting(formatSpans(spans))).toStrictEqual([styled("ab")]);
  });
});

const normalised = (spans: readonly Span[]): Span[] => {
  const out: Span[] = [];

  for (const span of spans) {
    const last = out.at(-1);

    if (span.text === "") {
      continue;
    }

    if (last !== undefined && sameStyle(last.style, span.style)) {
      out[out.length - 1] = { style: last.style, text: last.text + span.text };
    } else {
      out.push({ style: { ...span.style }, text: span.text });
    }
  }

  return out;
};

describe("formatSpans, on random spans", () => {
  const colours = fc.oneof(
    fc.constant(undefined),
    fc.constantFrom<Colour>(
      { _tag: "Palette", index: 0 },
      { _tag: "Palette", index: 4 },
      { _tag: "Palette", index: 98 },
      { _tag: "Hex", hex: "ff0000" },
      { _tag: "Hex", hex: "00ff00" }
    ),
    fc.integer({ max: 98, min: 0 }).map((index): Colour => ({ _tag: "Palette", index })),
    fc
      .array(fc.constantFrom(..."0123456789abcdef".split("")), { maxLength: 6, minLength: 6 })
      .map((digits): Colour => ({ _tag: "Hex", hex: digits.join("") }))
  );

  const styles = fc.record({
    background: colours,
    bold: fc.boolean(),
    foreground: colours,
    italic: fc.boolean(),
    monospace: fc.boolean(),
    reverse: fc.boolean(),
    strikethrough: fc.boolean(),
    underline: fc.boolean(),
  });

  const plainPieces = [
    ..."0123456789,".split(""),
    "99",
    "a",
    "f",
    "abc",
    "ff0000",
    " ",
    "é",
    "\u{1F600}",
  ];

  const texts = fc.array(fc.constantFrom(...plainPieces), { maxLength: 6 }).map((p) => p.join(""));

  const codeTexts = fc
    .array(fc.constantFrom(...plainPieces, ...codes), { maxLength: 8 })
    .map((p) => p.join(""));

  const spansOf = (text: fc.Arbitrary<string>) =>
    fc.array(fc.record({ style: styles, text }), { maxLength: 8 });

  it("is read back as the same spans, and strips to their text", () => {
    fc.assert(
      fc.property(spansOf(texts), (spans) => {
        const text = formatSpans(spans);

        expect(parseFormatting(text)).toStrictEqual(normalised(spans));
        expect(stripFormatting(text)).toBe(joined(spans));
      }),
      { numRuns: 5000 }
    );
  });

  it("holds when the text itself holds codes, which are stripped first", () => {
    fc.assert(
      fc.property(spansOf(codeTexts), (spans) => {
        const clean = spans.map((span) => ({ ...span, text: stripFormatting(span.text) }));
        const text = formatSpans(spans);

        expect(parseFormatting(text)).toStrictEqual(normalised(clean));
        expect(stripFormatting(text)).toBe(joined(clean));
      }),
      { numRuns: 5000 }
    );
  });

  it("never ends in a code", () => {
    fc.assert(
      fc.property(spansOf(texts), (spans) => {
        const text = formatSpans(spans);

        expect(text === "" || !codes.includes(text.at(-1) ?? "")).toBeTruthy();
      }),
      { numRuns: 2000 }
    );
  });
});
