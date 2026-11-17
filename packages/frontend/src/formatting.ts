/**
 * The formatting of a draft. A draft's text holds IRC's formatting codes, as it is sent,
 * kept, and recalled, while what the Owner sees and edits is its plain text, with no code
 * in it, so a caret never stands beside a code it cannot see. An edit of the plain text,
 * and a style put over some of it, are merged back into the codes here.
 *
 * Each line of a draft is sent as a Message of its own, and formatting does not carry from
 * one Message to the next, so a draft is read line by line, each from no style, and written
 * line by line: a style that goes on over a line break is written again on the next line.
 * What is written is always as the writer writes it, so no code is left where nothing
 * follows it.
 *
 * @packageDocumentation
 */
import { formatSpans, parseFormatting, plainStyle, stripFormatting } from "@iirc/protocol/format";
import type { Colour, Span, Style } from "@iirc/protocol/format";

/** A style that is on or off. */
export type Flag = "bold" | "italic" | "underline" | "strikethrough" | "monospace" | "reverse";

/** What can be put over some text: a flag turned over, or a foreground colour, none for the default. */
export type Format =
  | { readonly _tag: "Toggle"; readonly flag: Flag }
  | { readonly _tag: "Colour"; readonly colour: Colour | undefined };

/**
 * A style the Owner chose at a caret, with nothing selected, for what is typed there next,
 * at `at` in the plain text.
 */
export interface Pending {
  readonly at: number;
  readonly style: Style;
}

/** A draft as read: its plain text, and the style over each of its UTF-16 units. */
interface Styled {
  readonly plain: string;
  readonly styles: readonly Style[];
}

const breaks = /(?<lineBreak>[\r\n])/u;

const isBreak = (character: string | undefined) => character === "\n" || character === "\r";

/**
 * Whether text holds a formatting code: stripping takes every code out, so it is left as it
 * was only when it holds none.
 * @param text - The text.
 * @returns Whether it does.
 */
const anyCode = (text: string) => stripFormatting(text) !== text;

/**
 * Some lines read, each from `from`, each break taking the style before it.
 * @param text - The text.
 * @param from - The style each line starts in.
 * @returns It, styled.
 */
const readFrom = (text: string, from: Style): Styled => {
  const styles: Style[] = [];
  let plain = "";

  for (const part of text.split(breaks)) {
    if (isBreak(part)) {
      styles.push(styles.at(-1) ?? from);
      plain += part;
    } else {
      // Written in `from` first, so the line's codes change it, as they would after it.
      const spans = parseFormatting(formatSpans([{ style: from, text: "x" }]) + part);

      const all = spans.flatMap((span) =>
        Array.from({ length: span.text.length }, () => span.style)
      );

      styles.push(...all.slice(1));
      plain += spans
        .map((span) => span.text)
        .join("")
        .slice(1);
    }
  }

  return { plain, styles };
};

const read = (text: string): Styled => readFrom(text, plainStyle);

/**
 * A draft written: each line as the writer writes it, and the breaks as they were.
 * @param styled - The draft as read.
 * @returns Its text.
 */
const write = ({ plain, styles }: Styled): string => {
  let written = "";
  let line: Span[] = [];

  // By UTF-16 unit, as a textarea counts, so the style of each unit is its own.
  for (let index = 0; index < plain.length; index += 1) {
    const character = plain.charAt(index);
    const style = styles[index] ?? plainStyle;
    const last = line.at(-1);

    if (isBreak(character)) {
      written += formatSpans(line) + character;
      line = [];
    } else if (last?.style === style) {
      line[line.length - 1] = { style, text: last.text + character };
    } else {
      line.push({ style, text: character });
    }
  }

  return written + formatSpans(line);
};

/**
 * A draft's plain text, as the Owner sees and edits it: every formatting code left out.
 * @param text - The draft's text.
 * @returns Its plain text.
 */
export const plainOf = (text: string): string => stripFormatting(text);

/**
 * Whether a draft holds any formatting code.
 * @param text - The draft's text.
 * @returns Whether it does.
 */
export const hasFormatting = (text: string): boolean => anyCode(text);

/**
 * A draft's lines, each with its own codes, as each is sent, and as a view draws it.
 * @param text - The draft's text.
 * @returns Its lines.
 */
export const linesIn = (text: string): readonly string[] => text.split(/\r\n|\r|\n/u);

/**
 * The style text put in at `at` takes: the character's before it, but at the start of a
 * line, the character's after it on that line, and on a line of its own, the line break's
 * before it, which goes on in the style of the line before.
 * @param styled - The draft as read.
 * @param at - Where text goes in.
 * @param after - Where the text after what is replaced begins.
 * @returns The style.
 */
const inherited = ({ plain, styles }: Styled, at: number, after: number): Style => {
  const before = at > 0 ? styles[at - 1] : undefined;

  if (before !== undefined && !isBreak(plain[at - 1])) {
    return before;
  }

  return plain[after] !== undefined && !isBreak(plain[after])
    ? (styles[after] ?? plainStyle)
    : (before ?? plainStyle);
};

/**
 * The style in force at a caret, which text typed there takes.
 * @param text - The draft's text.
 * @param at - The caret, in the plain text.
 * @returns The style.
 */
export const styleAt = (text: string, at: number): Style => inherited(read(text), at, at);

const sameColour = (left: Colour | undefined, right: Colour | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : left._tag === right._tag &&
      (left._tag === "Palette"
        ? right._tag === "Palette" && left.index === right.index
        : right._tag === "Hex" && left.hex === right.hex);

const flags: readonly Flag[] = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "monospace",
  "reverse",
];

const sameStyle = (left: Style, right: Style) =>
  flags.every((flag) => left[flag] === right[flag]) &&
  sameColour(left.foreground, right.foreground) &&
  sameColour(left.background, right.background);

/** Where an edit was: where it begins, and how much went and came. */
interface Region {
  readonly start: number;
  readonly removed: number;
  readonly inserted: number;
}

/**
 * Where the text changed. Where it could have changed in several places, as typing a
 * letter beside the same letter, it is placed where the hint says, as near as it can be.
 * @param before - The plain text before.
 * @param after - The text after.
 * @param hint - Where the change began, if known.
 * @returns Where it was.
 */
const regionOf = (before: string, after: string, hint: number | undefined): Region => {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  let suffix = 0;

  while (prefix < shortest && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  while (suffix < shortest && before.at(-1 - suffix) === after.at(-1 - suffix)) {
    suffix += 1;
  }

  if (prefix + suffix < shortest) {
    return {
      inserted: after.length - prefix - suffix,
      removed: before.length - prefix - suffix,
      start: prefix,
    };
  }

  // Only an insertion or only a deletion, which could begin anywhere from `lowest` to
  // `prefix`.
  const grown = after.length - before.length;
  const lowest = shortest - suffix;

  return {
    inserted: Math.max(grown, 0),
    removed: Math.max(-grown, 0),
    start: Math.min(Math.max(hint ?? prefix, lowest), prefix),
  };
};

/**
 * The style of what an edit put in: the style pending where it went, or the style of the
 * first character it was typed over, as an input method's composition replaces what it
 * wrote, or else the style in force where it went.
 * @param styled - The draft as read.
 * @param region - Where the edit was.
 * @param pending - The style pending, if any.
 * @returns The style.
 */
const styleOfPut = (
  styled: Styled,
  { inserted, removed, start }: Region,
  pending: Pending | undefined
) => {
  const over = removed > 0 && !isBreak(styled.plain[start]) ? styled.styles[start] : undefined;

  if (pending !== undefined && pending.at === start && inserted > 0) {
    return pending.style;
  }

  return over ?? inherited(styled, start, start + removed);
};

/** What places an edit: the caret after it, if known, and the style pending, if any. */
export interface Hint {
  readonly caret?: number;
  readonly pending: Pending | undefined;
}

/**
 * A draft once its plain text was edited to `value`. What was removed goes, and what was
 * put in takes the style pending where it went, or of what it was typed over, or else the
 * style in force there. A code in what was put in, as from a paste, is read as formatting from that
 * style. Text left as it was leaves the draft as it was.
 * @param text - The draft's text.
 * @param value - Its plain text, edited.
 * @param hint - Where the caret is after it, and the style pending.
 * @returns The draft's text after.
 */
export const merged = (text: string, value: string, { caret, pending }: Hint): string => {
  const before = read(text);

  if (value === before.plain) {
    return text;
  }

  const grown = Math.max(value.length - before.plain.length, 0);

  const { inserted, removed, start } = regionOf(
    before.plain,
    value,
    caret === undefined ? pending?.at : caret - grown
  );

  const after = start + removed;

  const style = styleOfPut(before, { inserted, removed, start }, pending);

  const put = value.slice(start, start + inserted);

  const typed = anyCode(put)
    ? readFrom(put, style)
    : { plain: put, styles: Array.from({ length: put.length }, () => style) };

  return write({
    plain: before.plain.slice(0, start) + typed.plain + before.plain.slice(after),
    styles: [...before.styles.slice(0, start), ...typed.styles, ...before.styles.slice(after)],
  });
};

/**
 * A style with a format put over it, a flag turned on or off as asked.
 * @param style - The style.
 * @param format - The format.
 * @param on - Whether a flag is turned on.
 * @returns The style after.
 */
const putOver = (style: Style, format: Format, on: boolean): Style =>
  format._tag === "Toggle"
    ? { ...style, [format.flag]: on }
    : { ...style, foreground: format.colour };

/**
 * A draft once a format was put over a range of its plain text. A flag is turned off where
 * every character of the range has it, and on otherwise, as a word processor does.
 * @param text - The draft's text.
 * @param start - Where the range begins, in the plain text.
 * @param end - Where it ends.
 * @param format - What is put over it.
 * @returns The draft's text after.
 */
export const formattedIn = (text: string, start: number, end: number, format: Format): string => {
  const styled = read(text);
  const from = Math.max(Math.min(start, end, styled.plain.length), 0);
  const to = Math.min(Math.max(start, end), styled.plain.length);
  const inRange = styled.styles.slice(from, to);

  const on =
    format._tag === "Toggle" &&
    !inRange.every((style, index) => isBreak(styled.plain[from + index]) || style[format.flag]);

  return write({
    plain: styled.plain,
    styles: [
      ...styled.styles.slice(0, from),
      ...inRange.map((style) => putOver(style, format, on)),
      ...styled.styles.slice(to),
    ],
  });
};

/**
 * The style pending at a caret once a format was put over it, with nothing selected: over
 * the style pending there, or the one in force. A style that comes back to the one in
 * force is pending no longer.
 * @param text - The draft's text.
 * @param pending - The style pending now, at this caret or another.
 * @param at - The caret, in the plain text.
 * @param format - What is put over it.
 * @returns The style pending after, or none.
 */
export const pendingAfter = (
  text: string,
  pending: Pending | undefined,
  at: number,
  format: Format
): Pending | undefined => {
  const inForce = styleAt(text, at);
  const from = pending?.at === at ? pending.style : inForce;
  const style = putOver(from, format, format._tag === "Toggle" && !from[format.flag]);

  return sameStyle(style, inForce) ? undefined : { at, style };
};

/** The sixteen colours every IRC client offers, by their number, as mIRC names them. */
export const colourNames: readonly string[] = [
  "white",
  "black",
  "blue",
  "green",
  "red",
  "brown",
  "purple",
  "orange",
  "yellow",
  "light green",
  "cyan",
  "light cyan",
  "light blue",
  "pink",
  "grey",
  "light grey",
];

/** The colours a Frontend offers, in order: the default, then the sixteen. */
export const colourChoices: readonly (Colour | undefined)[] = [
  undefined,
  ...colourNames.map((_, index): Colour => ({ _tag: "Palette", index })),
];

/**
 * Plain text in a colour, as a view draws a choice of it.
 * @param colour - The colour, none for the default.
 * @returns The style.
 */
export const colouredStyle = (colour: Colour | undefined): Style => ({
  ...plainStyle,
  foreground: colour,
});

/**
 * A colour's name: one of the sixteen's, or its number or digits.
 * @param colour - The colour, none for the default.
 * @returns Its name.
 */
export const colourName = (colour: Colour | undefined): string => {
  if (colour === undefined) {
    return "default colour";
  }

  return colour._tag === "Palette"
    ? (colourNames[colour.index] ?? `colour ${colour.index}`)
    : `#${colour.hex}`;
};

const flagNames: Readonly<Record<Flag, string>> = {
  bold: "bold",
  italic: "italic",
  monospace: "fixed pitch",
  reverse: "reversed",
  strikethrough: "strikethrough",
  underline: "underline",
};

/**
 * What a style pending changes from the style in force at its caret, in words, for a view
 * to show before anything is typed: each flag turned on, or `not` it, and the colour.
 * @param text - The draft's text.
 * @param pending - The style pending, if any.
 * @returns The words, none with nothing pending.
 */
export const pendingWords = (text: string, pending: Pending | undefined): readonly string[] => {
  if (pending === undefined) {
    return [];
  }

  const inForce = styleAt(text, pending.at);

  const changed = flags.flatMap((flag) =>
    pending.style[flag] === inForce[flag]
      ? []
      : [pending.style[flag] ? flagNames[flag] : `not ${flagNames[flag]}`]
  );

  return sameColour(pending.style.foreground, inForce.foreground)
    ? changed
    : [...changed, colourName(pending.style.foreground)];
};
