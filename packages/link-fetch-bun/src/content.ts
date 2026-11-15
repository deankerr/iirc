/**
 * What an answer may be for each purpose: its types, its leading bytes, and its bounds.
 *
 * @packageDocumentation
 */
import { limits } from "@iirc/link-fetch";
import type { Purpose } from "@iirc/link-fetch";

/** What each purpose asks for. */
export const accept: Record<Purpose["kind"], string> = {
  image: "image/avif, image/webp, image/png, image/jpeg, image/gif, image/svg+xml;q=0.8",
  oembed: "application/json",
  page: "text/html, application/xhtml+xml;q=0.9",
  stream: "video/*, audio/*",
};

/**
 * The media type alone, lower-cased: `text/html; charset=utf-8` is `text/html`.
 * @param header - A `Content-Type` or `Content-Encoding`, if any.
 * @returns The type, or empty.
 */
export const essence = (header: string | null) =>
  (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const pageTypes = new Set(["text/html", "application/xhtml+xml"]);

// `image/jpg` is not registered, but servers send it often enough that refusing it would only
// lose Previews.
const imageTypes = new Map([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
  ["image/avif", "image/avif"],
  ["image/svg+xml", "image/svg+xml"],
]);

const svg = "image/svg+xml";

const takes: Record<Purpose["kind"], (type: string) => string | undefined> = {
  image: (type) => imageTypes.get(type),
  oembed: (type) => (type === "application/json" || type.endsWith("+json") ? type : undefined),
  page: (type) => (pageTypes.has(type) ? type : undefined),
  stream: (type) => (type.startsWith("video/") || type.startsWith("audio/") ? type : undefined),
};

/**
 * The type an answer's declared type stands for under a purpose, before any byte is read.
 * @param purpose - What the link is fetched for.
 * @param type - The type the answer declared.
 * @returns The type, or nothing when the purpose does not take it.
 */
export const declared = (purpose: Purpose, type: string) => takes[purpose.kind](type);

const caps: Record<Purpose["kind"], (type: string) => number> = {
  image: (type) => (type === svg ? limits.svg : limits.raster),
  oembed: () => limits.oembed,
  page: () => limits.page,
  stream: () => limits.stream,
};

/**
 * The most a body may give, decompressed.
 * @param purpose - What the link is fetched for.
 * @param type - Its type.
 * @returns The bound, in bytes.
 */
export const capOf = (purpose: Purpose, type: string) => caps[purpose.kind](type);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCodePoint(...bytes.subarray(start, end));

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  prefix.every((byte, index) => bytes[index] === byte);

/**
 * Whether an ISO BMFF file is AVIF. It starts with its `ftyp` box: the box's size, `ftyp`,
 * the major brand, a version, and then the compatible brands, to the end of the box.
 * @param bytes - Its first bytes.
 * @returns Whether any brand is AVIF.
 */
const isAvif = (bytes: Uint8Array) => {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") {
    return false;
  }

  const size = Math.min(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0), bytes.length);
  const brands = [ascii(bytes, 8, 12)];

  for (let at = 16; at + 4 <= size; at += 4) {
    brands.push(ascii(bytes, at, at + 4));
  }

  return brands.some((brand) => brand === "avif" || brand === "avis");
};

const decoder = new TextDecoder();

const whitespace = /^[\t\n\f\r ]*/u;

/**
 * What follows a prolog item that starts a text: an XML declaration, a comment, or a DOCTYPE,
 * which may hold an internal subset in brackets.
 * @param text - The text, lower-cased, starting at an item.
 * @returns The text after the item, or nothing when it is not one or does not end in the text.
 */
const afterProlog = (text: string): string | undefined => {
  const past = (opening: string, closing: string) => {
    const at = text.indexOf(closing, opening.length);

    return at === -1 ? undefined : text.slice(at + closing.length);
  };

  if (text.startsWith("<?xml")) {
    return past("<?xml", "?>");
  }

  if (text.startsWith("<!--")) {
    return past("<!--", "-->");
  }

  if (!text.startsWith("<!doctype")) {
    return undefined;
  }

  const bracket = text.indexOf("[");
  const end = text.indexOf(">");

  return bracket !== -1 && bracket < end ? past("<!doctype", "]>") : past("<!doctype", ">");
};

/**
 * Whether bytes begin an SVG: after an optional BOM, whitespace, an XML declaration, comments,
 * and a DOCTYPE, the root element must be `<svg` and the end of its name, all within the bytes.
 * @param bytes - The first bytes.
 * @returns Whether they do.
 */
const isSvg = (bytes: Uint8Array) => {
  let text: string | undefined = decoder.decode(bytes).replace(/^﻿/u, "").toLowerCase();

  while (text !== undefined) {
    text = text.replace(whitespace, "");

    if (/^<svg[\t\n\f\r />]/u.test(text)) {
      return true;
    }

    text = afterProlog(text);
  }

  return false;
};

/**
 * How many leading bytes are read before an image's type is decided: enough for an SVG's
 * prolog, of which a raster image's magic number needs far less.
 */
export const sniffed = 1024;

/**
 * The image type an image's leading bytes show.
 * @param bytes - Its first bytes, at least {@link sniffed} of them unless it is shorter.
 * @returns The type, or nothing when they are of none of the types taken.
 */
export const sniff = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return "image/gif";
  }

  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }

  if (isAvif(bytes)) {
    return "image/avif";
  }

  return isSvg(bytes) ? svg : undefined;
};

const lower = (byte: number) => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);

const codes = (text: string) => Array.from(text, (character) => character.codePointAt(0) ?? 0);

const boundaries = new Set(codes("\t\n\f\r />"));

const lessThan = 0x3c;
const greaterThan = 0x3e;

// Elements whose content is text, in which a `<body>` or `</head>` is no tag. A title and a
// textarea are escapable raw text in HTML, which reads the same way here.
const rawText = ["script", "style", "title", "textarea", "noscript"].map((name) => ({
  close: codes(`</${name}`),
  open: codes(`<${name}`),
}));

const commentOpen = codes("<!--");
const commentClose = codes("-->");
const headClose = codes("</head");
const bodyOpen = codes("<body");

type Mode =
  | { readonly in: "text" }
  | { readonly in: "comment" }
  | { readonly in: "raw"; readonly close: readonly number[] }
  | { readonly in: "head end" };

/**
 * Whether bytes hold a pattern at a place, in any case.
 * @param bytes - The bytes.
 * @param at - Where.
 * @param pattern - The pattern, lower-case.
 * @returns Whether they do.
 */
const holds = (bytes: Uint8Array, at: number, pattern: readonly number[]) =>
  pattern.every((byte, offset) => lower(bytes[at + offset] ?? -1) === byte);

/**
 * Whether bytes hold a tag's name at a place, and then the end of the name.
 * @param bytes - The bytes.
 * @param at - Where.
 * @param name - `<` or `</` and the name, lower-case.
 * @returns Whether they do.
 */
const isTag = (bytes: Uint8Array, at: number, name: readonly number[]) =>
  holds(bytes, at, name) && boundaries.has(bytes[at + name.length] ?? -1);

// What a `<` may begin that the scanner acts on, each with the bytes needed to tell it.
const wanted = [
  ...[bodyOpen, headClose, ...rawText.map((each) => each.open)].map((name) => ({
    name,
    needs: name.length + 1,
  })),
  { name: commentOpen, needs: commentOpen.length },
];

/**
 * Whether the bytes after a `<` are too few to tell what it begins, so the next chunk must.
 * @param bytes - The bytes.
 * @param at - Where the `<` is.
 * @returns Whether they are.
 */
const undecided = (bytes: Uint8Array, at: number) => {
  const left = bytes.length - at;

  return wanted.some(({ name, needs }) => left < needs && holds(bytes, at, name.slice(0, left)));
};

const find = (bytes: Uint8Array, from: number, pattern: readonly number[]) => {
  for (let at = from; at + pattern.length <= bytes.length; at += 1) {
    if (holds(bytes, at, pattern)) {
      return at;
    }
  }

  return -1;
};

/**
 * Finds where a page's head ends: after the `>` of its `</head`, or before its `<body`,
 * whichever comes first, in any case, across chunks. Comments and the text of raw text
 * elements, such as a script, are skipped, so a `<body>` in a string ends nothing. It is no
 * HTML tokenizer: it looks only for what ends a head, and carries at most a few bytes from one
 * chunk to the next.
 * @returns A function that takes each chunk and gives where in it the page ends, or -1.
 */
export const headEnd = () => {
  let mode: Mode = { in: "text" };
  let carry = new Uint8Array();

  return (chunk: Uint8Array) => {
    const offset = carry.length;
    const bytes = new Uint8Array(offset + chunk.length);

    bytes.set(carry);
    bytes.set(chunk, offset);
    carry = new Uint8Array();

    // The carried bytes were given with the chunk before, so a page that ends in them ends
    // at the start of this one.
    const ended = (at: number) => Math.max(0, at - offset);

    // Looks again, with the next chunk, from a place this one cannot decide.
    const later = (from: number) => {
      carry = bytes.slice(Math.max(from, 0));

      return -1;
    };

    let at = 0;

    for (;;) {
      if (mode.in === "comment") {
        const end = find(bytes, at, commentClose);

        if (end === -1) {
          return later(bytes.length - commentClose.length + 1);
        }

        mode = { in: "text" };
        at = end + commentClose.length;
      } else if (mode.in === "raw") {
        const { length } = mode.close;
        const end = find(bytes, at, mode.close);

        if (end === -1 || end + length >= bytes.length) {
          return later(end === -1 ? bytes.length - length : end);
        }

        if (boundaries.has(bytes[end + length] ?? -1)) {
          mode = { in: "text" };
        }

        at = end + length;
      } else if (mode.in === "head end") {
        const end = bytes.indexOf(greaterThan, at);

        return end === -1 ? -1 : ended(end + 1);
      } else {
        const open = bytes.indexOf(lessThan, at);

        if (open === -1) {
          return -1;
        }

        if (undecided(bytes, open)) {
          return later(open);
        }

        if (isTag(bytes, open, bodyOpen)) {
          return ended(open);
        }

        const raw = rawText.find((each) => isTag(bytes, open, each.open));

        if (isTag(bytes, open, headClose)) {
          mode = { in: "head end" };
          at = open + headClose.length;
        } else if (holds(bytes, open, commentOpen)) {
          mode = { in: "comment" };
          at = open + commentOpen.length;
        } else if (raw === undefined) {
          at = open + 1;
        } else {
          mode = { close: raw.close, in: "raw" };
          at = open + raw.open.length;
        }
      }
    }
  };
};
