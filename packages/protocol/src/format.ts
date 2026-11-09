/** A colour a Network asked for. */
export type Colour =
  | { readonly _tag: "Palette"; readonly index: number }
  | { readonly _tag: "Hex"; readonly hex: string };

/**
 * The formatting in force over some text. A colour of `undefined` is the Frontend's
 * default, which is also what colour `99` means.
 */
export interface Style {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly monospace: boolean;
  readonly reverse: boolean;
  /** A `Palette` colour is `0` to `98`, and a `Hex` one is six lower-case digits. */
  readonly foreground: Colour | undefined;
  readonly background: Colour | undefined;
}

/** Some text and the {@link Style} in force over it. The text holds no formatting code. */
export interface Span {
  readonly text: string;
  readonly style: Style;
}

/** The style before any code: nothing on, and default colours. */
export const plainStyle: Style = {
  background: undefined,
  bold: false,
  foreground: undefined,
  italic: false,
  monospace: false,
  reverse: false,
  strikethrough: false,
  underline: false,
};

type Toggle = "bold" | "italic" | "underline" | "strikethrough" | "monospace" | "reverse";

// A colour code that sets nothing, or sets only the foreground, leaves `background` as
// `undefined`, which means unchanged. `{ colour: undefined }` sets it to the default.
type Token =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Toggle"; readonly style: Toggle }
  | { readonly _tag: "Reset" }
  | {
      readonly _tag: "Colours";
      readonly foreground: Colour | undefined;
      readonly background: { readonly colour: Colour | undefined } | undefined;
    };

const colourCode = 0x03;
const hexCode = 0x04;

const simpleCodes = new Map<number, Token>([
  [0x02, { _tag: "Toggle", style: "bold" }],
  [0x1d, { _tag: "Toggle", style: "italic" }],
  [0x1f, { _tag: "Toggle", style: "underline" }],
  [0x1e, { _tag: "Toggle", style: "strikethrough" }],
  [0x11, { _tag: "Toggle", style: "monospace" }],
  [0x16, { _tag: "Toggle", style: "reverse" }],
  [0x0f, { _tag: "Reset" }],
]);

interface Read {
  readonly colour: Colour | undefined;
  readonly end: number;
}

type ColourReader = (text: string, at: number) => Read | undefined;

const digitAt = (text: string, at: number) => {
  const code = text.codePointAt(at) ?? 0;

  return code >= 0x30 && code <= 0x39 ? code - 0x30 : undefined;
};

const paletteColour = (first: number, second: number | undefined, at: number): Read => {
  const index = second === undefined ? first : first * 10 + second;

  return {
    colour: index === 99 ? undefined : { _tag: "Palette", index },
    end: second === undefined ? at + 1 : at + 2,
  };
};

// One or two digits, always two when there are two. `99` is the default colour.
const readPalette: ColourReader = (text, at) => {
  const first = digitAt(text, at);

  return first === undefined ? undefined : paletteColour(first, digitAt(text, at + 1), at);
};

const readHex: ColourReader = (text, at) => {
  const digits = text.slice(at, at + 6);

  return /^[\da-f]{6}$/iu.test(digits)
    ? { colour: { _tag: "Hex", hex: digits.toLowerCase() }, end: at + 6 }
    : undefined;
};

// `at` is just after the code. With no colour to read, the code resets both colours and
// takes nothing else, so a comma after it stays text.
const readColours = (text: string, at: number, read: ColourReader) => {
  const foreground = read(text, at);

  if (foreground === undefined) {
    return {
      end: at,
      token: { _tag: "Colours", background: { colour: undefined }, foreground: undefined },
    } as const;
  }

  // A comma not followed by a colour is text, so the background is left as it was.
  const background =
    text.charAt(foreground.end) === "," ? read(text, foreground.end + 1) : undefined;

  return {
    end: background?.end ?? foreground.end,
    token: {
      _tag: "Colours",
      background: background === undefined ? undefined : { colour: background.colour },
      foreground: foreground.colour,
    },
  } as const;
};

const tokenize = (text: string): readonly Token[] => {
  const tokens: Token[] = [];
  let textStart = 0;
  let index = 0;

  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    const simple = simpleCodes.get(code);

    const coloured =
      code === colourCode || code === hexCode
        ? readColours(text, index + 1, code === colourCode ? readPalette : readHex)
        : undefined;

    const token = simple ?? coloured?.token;

    if (token === undefined) {
      index += 1;
    } else {
      if (index > textStart) {
        tokens.push({ _tag: "Text", text: text.slice(textStart, index) });
      }

      tokens.push(token);
      index = coloured?.end ?? index + 1;
      textStart = index;
    }
  }

  if (text.length > textStart) {
    tokens.push({ _tag: "Text", text: text.slice(textStart) });
  }

  return tokens;
};

const sameColour = (left: Colour | undefined, right: Colour | undefined) => {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left._tag === "Palette"
    ? right._tag === "Palette" && left.index === right.index
    : right._tag === "Hex" && left.hex === right.hex;
};

const sameStyle = (left: Style, right: Style) =>
  left.bold === right.bold &&
  left.italic === right.italic &&
  left.underline === right.underline &&
  left.strikethrough === right.strikethrough &&
  left.monospace === right.monospace &&
  left.reverse === right.reverse &&
  sameColour(left.foreground, right.foreground) &&
  sameColour(left.background, right.background);

const apply = (style: Style, token: Token): Style => {
  switch (token._tag) {
    case "Text": {
      return style;
    }

    case "Toggle": {
      return { ...style, [token.style]: !style[token.style] };
    }

    case "Reset": {
      return plainStyle;
    }

    case "Colours": {
      return {
        ...style,
        background: token.background === undefined ? style.background : token.background.colour,
        foreground: token.foreground,
      };
    }

    default: {
      return style;
    }
  }
};

/**
 * Reads the mIRC formatting codes in some text, without ever throwing. Any string
 * is valid. The result is data for a Frontend to draw, and is never markup.
 *
 * Codes that change nothing leave one Span, so the same style never appears twice in a
 * row, and no Span is empty. Reverse is a flag and does not swap the colours.
 * @param text - The text of a Message, a topic, or anything else a Network sends.
 * @returns The runs of text in order, each with the style in force over it.
 */
export const parseFormatting = (text: string): readonly Span[] => {
  const spans: Span[] = [];
  let style = plainStyle;

  for (const token of tokenize(text)) {
    if (token._tag === "Text") {
      const last = spans.at(-1);

      if (last !== undefined && sameStyle(last.style, style)) {
        spans[spans.length - 1] = { style, text: last.text + token.text };
      } else {
        spans.push({ style, text: token.text });
      }
    } else {
      style = apply(style, token);
    }
  }

  return spans;
};

/**
 * Removes every formatting code, keeping the text. Highlights and search run on this
 *. It reads the codes exactly as {@link parseFormatting} does.
 * @param text - The text to strip.
 * @returns The text a reader would see, which no longer holds a formatting code.
 */
export const stripFormatting = (text: string): string =>
  tokenize(text)
    .map((token) => (token._tag === "Text" ? token.text : ""))
    .join("");
