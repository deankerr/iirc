import { decodeBytes } from "./decode.ts";
import type { FallbackEncoding } from "./decode.ts";

/** A single unit of the IRC protocol, parsed from text. */
export interface Line {
  readonly tags: ReadonlyMap<string, string>;
  readonly source: string | undefined;
  readonly command: string;
  readonly params: readonly string[];
}

/** Why some text could not be parsed into a {@link Line}. */
export type UnparseableReason = "Empty" | "NoCommand";

/** The result of parsing text, which always keeps that text. */
export type Parsed =
  | { readonly _tag: "Line"; readonly text: string; readonly line: Line }
  | { readonly _tag: "Unparseable"; readonly text: string; readonly reason: UnparseableReason };

const tagEscapes = new Map([
  [":", ";"],
  ["\\", "\\"],
  ["n", "\n"],
  ["r", "\r"],
  ["s", " "],
]);

const unescapeTagValue = (value: string) => {
  let unescaped = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);

    if (char === "\\") {
      index += 1;
      const escaped = value.charAt(index);
      unescaped += tagEscapes.get(escaped) ?? escaped;
    } else {
      unescaped += char;
    }
  }

  return unescaped;
};

const parseTags = (text: string) => {
  const tags = new Map<string, string>();

  for (const tag of text.split(";")) {
    const separator = tag.indexOf("=");
    const key = separator === -1 ? tag : tag.slice(0, separator);

    if (key !== "") {
      tags.set(key, separator === -1 ? "" : unescapeTagValue(tag.slice(separator + 1)));
    }
  }

  return tags;
};

const untilInvalid = (text: string) => {
  const end = text.search(/[\0\r\n]/u);

  return end === -1 ? text : text.slice(0, end);
};

/**
 * Upper-cases ASCII letters only. `toUpperCase` is locale-free but maps non-ASCII, and
 * commands, like CTCP commands, are ASCII.
 * @param text - The text to change.
 * @returns The text with `a` to `z` made `A` to `Z`, and nothing else touched.
 */
export const upperCaseAscii = (text: string) =>
  text.replaceAll(/[a-z]/gu, (letter) => letter.toUpperCase());

// Reads space-separated tokens from text, treating runs of spaces as one.
const tokenReader = (text: string) => {
  let position = 0;

  const skipSpaces = () => {
    while (text.charAt(position) === " ") {
      position += 1;
    }
  };

  return {
    done: () => {
      skipSpaces();

      return position >= text.length;
    },
    peek: () => {
      skipSpaces();

      return text.charAt(position);
    },
    rest: () => {
      const rest = text.slice(position + 1);
      position = text.length;

      return rest;
    },
    token: () => {
      skipSpaces();
      const end = text.indexOf(" ", position);
      const token = text.slice(position, end === -1 ? text.length : end);
      position += token.length;

      return token;
    },
  };
};

/**
 * Parses the text of one Line, without ever throwing.
 * @param text - The Line's text, without its line ending.
 * @returns The parsed Line, or the reason there isn't one.
 */
export const parseLine = (text: string): Parsed => {
  const reader = tokenReader(untilInvalid(text));

  if (reader.done()) {
    return { _tag: "Unparseable", reason: "Empty", text };
  }

  const tags = reader.peek() === "@" ? parseTags(reader.token().slice(1)) : new Map();
  const source = reader.peek() === ":" ? reader.token().slice(1) : undefined;

  if (reader.done()) {
    return { _tag: "Unparseable", reason: "NoCommand", text };
  }

  const command = upperCaseAscii(reader.token());
  const params: string[] = [];

  while (!reader.done()) {
    params.push(reader.peek() === ":" ? reader.rest() : reader.token());
  }

  return { _tag: "Line", line: { command, params, source, tags }, text };
};

/**
 * Parses one frame of bytes, decoded as {@link decodeBytes} reads them: as UTF-8, else in
 * the fallback encoding, else as ISO-8859-1, so it never fails (MSG-4).
 * @param frame - The frame's bytes, without its line ending.
 * @param fallback - The Connection's fallback encoding, if it has one.
 * @returns The parsed Line, or the reason there isn't one.
 */
export const parseFrame = (frame: Uint8Array, fallback?: FallbackEncoding) =>
  parseLine(decodeBytes(frame, fallback).text);

// One character per byte, as ISO-8859-1. Not WHATWG's "latin1", which is windows-1252 and
// maps 0x80 to 0x9f elsewhere, so its text would not map back to the same bytes.
const byteText = (frame: Uint8Array) =>
  Array.from(frame, (byte) => String.fromCodePoint(byte)).join("");

/**
 * Finds a `PING` frame's token as the bytes that arrived, which text cannot promise,
 * because a token that is not UTF-8 would be re-encoded. It runs {@link parseLine} over
 * one character per byte, so it reads the frame exactly as {@link parseFrame} does.
 * @param frame - The frame's bytes, without its line ending.
 * @returns The bytes of the first parameter, or `undefined` if there is none.
 */
export const pingToken = (frame: Uint8Array): Uint8Array | undefined => {
  const parsed = parseLine(byteText(frame));
  const token = parsed._tag === "Line" ? parsed.line.params[0] : undefined;

  return token === undefined
    ? undefined
    : Uint8Array.from({ length: token.length }, (_unused, index) => token.codePointAt(index) ?? 0);
};
