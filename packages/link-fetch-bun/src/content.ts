/**
 * What an answer may be for each purpose: its types, its leading bytes, and its bounds.
 *
 * @packageDocumentation
 */
import { limits } from "@iirc/link-fetch";
import type { Purpose } from "@iirc/link-fetch";
import { Bytes } from "effect";

/**
 * What each purpose asks for, and `media`, what a page that is likely media asks for: images,
 * video, and sound only, never HTML or any type at all, so a site that answers HTML to any
 * `Accept` that would take it answers the media.
 */
export const accept: Record<Purpose["kind"] | "media", string> = {
  image: "image/avif, image/webp, image/png, image/jpeg, image/gif, image/svg+xml;q=0.8",
  media:
    "image/avif, image/webp, image/png, image/jpeg, image/gif, image/svg+xml;q=0.8, video/*;q=0.8, audio/*;q=0.8",
  oembed: "application/json",
  page: "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1",
  stream: "video/*, audio/*",
};

/**
 * The media type alone, lower-cased: `text/html; charset=utf-8` is `text/html`.
 * @param header - A `Content-Type` or `Content-Encoding`, if any.
 * @returns The type, or empty.
 */
export const essence = (header: string | null) =>
  (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const pageTypes = new Set(["text/html", "application/xhtml+xml", "text/plain"]);

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
  page: (type) => (type === "text/plain" ? limits.text : limits.page),
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
 * What follows a DOCTYPE that starts a text. Its end is the first `>` outside quotes and
 * outside its internal subset, in brackets, where comments and processing instructions are
 * skipped whole, so no quoted or commented `]>` ends it.
 * @param text - The text, lower-cased, starting at `<!doctype`.
 * @returns The text after it, or nothing when it does not end in the text.
 */
const afterDoctype = (text: string): string | undefined => {
  let quote: string | undefined;
  let subset = false;

  for (let at = "<!doctype".length; at < text.length; at += 1) {
    const character = text[at];

    if (quote !== undefined) {
      quote = character === quote ? undefined : quote;
    } else if (subset && (text.startsWith("<!--", at) || text.startsWith("<?", at))) {
      const closing = text.startsWith("<!--", at) ? "-->" : "?>";
      const end = text.indexOf(closing, at + 2);

      if (end === -1) {
        return undefined;
      }

      at = end + closing.length - 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[" || character === "]") {
      subset = character === "[";
    } else if (character === ">" && !subset) {
      return text.slice(at + 1);
    }
  }

  return undefined;
};

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

  return afterDoctype(text);
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

const isLetter = (byte: number) => lower(byte) >= 0x61 && lower(byte) <= 0x7a;

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
  | { readonly in: "read on" }
  | { readonly in: "comment" }
  | { readonly in: "raw"; readonly close: readonly number[] }
  | { readonly in: "head end" }
  | {
      readonly in: "tag";
      readonly quote: number | undefined;
      /** What follows the tag's `>`: a raw text element's text, or else text. */
      readonly next?: { readonly in: "raw"; readonly close: readonly number[] };
    };

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

const quotes = new Set(codes(`"'`));

/**
 * Whether the byte after a `<` makes it a tag, a comment, a DOCTYPE, or a processing
 * instruction: a letter, `/`, `!`, or `?`.
 * @param byte - The byte.
 * @returns Whether it does.
 */
const startsTag = (byte: number) => isLetter(byte) || codes("/!?").includes(byte);

/**
 * Skips a tag to its `>`, honouring quoted attribute values.
 * @param bytes - The bytes.
 * @param from - Where to go on from, inside the tag.
 * @param quote - The quote open there, if any.
 * @returns Where the tag ends, after its `>`, or -1 and the quote still open at the end.
 */
const skipTag = (bytes: Uint8Array, from: number, quote: number | undefined) => {
  let open = quote;

  for (let at = from; at < bytes.length; at += 1) {
    const byte = bytes[at] ?? -1;

    if (open !== undefined) {
      open = byte === open ? undefined : open;
    } else if (quotes.has(byte)) {
      open = byte;
    } else if (byte === greaterThan) {
      return { end: at + 1, quote: undefined };
    }
  }

  return { end: -1, quote: open };
};

/** Where the scanner is, and where it goes on from. */
interface Step {
  readonly mode: Mode;
  readonly at: number;
}

/**
 * What a `<` in text begins, other than a body, and where to go on from.
 * @param bytes - The bytes.
 * @param open - Where the `<` is.
 * @returns The mode after it, and where to go on from.
 */
const opened = (bytes: Uint8Array, open: number): Step => {
  const raw = rawText.find((each) => isTag(bytes, open, each.open));

  if (isTag(bytes, open, headClose)) {
    return { at: open + headClose.length, mode: { in: "head end" } };
  }

  if (holds(bytes, open, commentOpen)) {
    return { at: open + commentOpen.length, mode: { in: "comment" } };
  }

  if (raw !== undefined) {
    // Its opening tag is finished first, so its attributes never open or close it.
    return {
      at: open + raw.open.length,
      mode: { in: "tag", next: { close: raw.close, in: "raw" }, quote: undefined },
    };
  }

  // Any other tag is skipped whole, so what its quoted attributes hold is never a tag. A `<`
  // that starts no tag, as in `a < b`, is text.
  return {
    at: open + 1,
    mode: startsTag(bytes[open + 1] ?? -1) ? { in: "tag", quote: undefined } : { in: "text" },
  };
};

// What a tag's attribute value starts with when it names an Open Graph or Twitter card tag,
// before the letter its name goes on with, as `og:title` does. A prefix declaration, as in
// `<html prefix="og: https://ogp.me/ns#">`, has a space there, and names no tag.
const cardTags = ["og:", "twitter:"].flatMap((prefix) =>
  ['"', "'", "="].map((before) => codes(`${before}${prefix}`))
);

// The longest of them, and the letter after it.
const cardTagLength = Math.max(...cardTags.map((each) => each.length)) + 1;

/**
 * Whether bytes of a tag name a card tag: one of {@link cardTags} and then a letter.
 * @param bytes - The bytes.
 * @returns Whether they do.
 */
const namesCardTag = (bytes: Uint8Array) =>
  cardTags.some((tag) => {
    let at = find(bytes, 0, tag);

    while (at !== -1) {
      if (isLetter(bytes[at + tag.length] ?? -1)) {
        return true;
      }

      at = find(bytes, at + 1, tag);
    }

    return false;
  });

/** What of a page may be given now, and whether the page has ended. */
interface Fed {
  readonly give: Uint8Array;
  readonly done: boolean;
}

/**
 * Finds where a page's head ends: after the `>` of its `</head`, or before its `<body`,
 * whichever comes first, in any case, across chunks. Comments and the text of raw text
 * elements, such as a script, are skipped, so a `<body>` in a string ends nothing. It is no
 * HTML tokenizer: it looks only for what ends a head.
 *
 * The page ends there only when a tag in its head has an attribute whose value starts `og:`
 * or `twitter:` and then a letter, as a card tag's name does. Otherwise its tags may be later
 * in the page, so the page reads on to its end, and nothing more is looked for. A prefix
 * declaration, `og:` and then a space, is no card tag.
 *
 * Bytes it cannot yet decide, such as a `<bo` at the end of a chunk, are held back until the
 * next chunk decides them, so the page is the same however the network split it.
 * @returns `feed`, which takes each chunk and gives what of the page may be given now, and
 * whether the page ended, and `flush`, which gives what is held back once the body ends.
 */
export const headEnd = () => {
  let mode: Mode = { in: "text" };
  let carry = new Uint8Array();
  let named = false;
  // The end of the tag bytes seen so far, so a value split across chunks is still seen.
  let tail = new Uint8Array();

  // Looks for a card tag in bytes of a tag, after the end of those before them.
  const notice = (bytes: Uint8Array) => {
    if (named) {
      return;
    }

    const seen = Bytes.concat([tail, bytes]);

    named = namesCardTag(seen);
    tail = seen.slice(Math.max(seen.length - cardTagLength + 1, 0));
  };

  const flush = () => {
    const held = carry;

    carry = new Uint8Array();

    return held;
  };

  const feed = (chunk: Uint8Array): Fed => {
    const bytes = Bytes.concat([carry, chunk]);

    carry = new Uint8Array();

    const ended = (at: number): Fed => ({ done: true, give: bytes.subarray(0, at) });
    const goOn: Fed = { done: false, give: bytes };

    // Holds back what this chunk cannot decide, to look at again with the next.
    const later = (from: number): Fed => {
      const held = Math.max(from, 0);

      carry = bytes.slice(held);

      return { done: false, give: bytes.subarray(0, held) };
    };

    // A head that named no card tag ends nothing.
    const headEnded = (at: number): Fed => {
      if (named) {
        return ended(at);
      }

      mode = { in: "read on" };

      return goOn;
    };

    let at = 0;

    for (;;) {
      if (mode.in === "read on") {
        return goOn;
      }

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

        // The closing tag is finished to its `>` before text goes on.
        if (boundaries.has(bytes[end + length] ?? -1)) {
          mode = { in: "tag", quote: undefined };
        }

        at = end + length;
      } else if (mode.in === "tag") {
        const skipped = skipTag(bytes, at, mode.quote);

        notice(bytes.subarray(at, skipped.end === -1 ? bytes.length : skipped.end));

        if (skipped.end === -1) {
          mode = { ...mode, quote: skipped.quote };

          return goOn;
        }

        mode = mode.next ?? { in: "text" };
        at = skipped.end;
      } else if (mode.in === "head end") {
        const end = bytes.indexOf(greaterThan, at);

        return end === -1 ? goOn : headEnded(end + 1);
      } else {
        const open = bytes.indexOf(lessThan, at);

        if (open === -1) {
          return goOn;
        }

        if (undecided(bytes, open)) {
          return later(open);
        }

        if (isTag(bytes, open, bodyOpen)) {
          return headEnded(open);
        }

        ({ at, mode } = opened(bytes, open));
      }
    }
  };

  return { feed, flush };
};
