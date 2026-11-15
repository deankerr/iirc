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

const isSvg = (bytes: Uint8Array) => {
  const head = decoder
    .decode(bytes)
    .replace(/^﻿?\s*/u, "")
    .toLowerCase();

  return head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!doctype svg");
};

/** How many leading bytes are read before an image's type is decided. */
export const sniffed = 64;

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

const indexOf = (haystack: Uint8Array, needle: readonly number[]) => {
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    if (needle.every((byte, offset) => lower(haystack[at + offset] ?? 0) === byte)) {
      return at;
    }
  }

  return -1;
};

const codes = (text: string) => Array.from(text, (character) => character.codePointAt(0) ?? 0);

const headClose = codes("</head>");
const bodyOpen = codes("<body");
const kept = headClose.length - 1;

/**
 * Finds where a page's head ends: after `</head>`, or before `<body`, whichever comes first,
 * in any case, across chunks.
 * @returns A function that takes each chunk and gives where in it the page ends, or -1.
 */
export const headEnd = () => {
  let tail = new Uint8Array();

  return (chunk: Uint8Array) => {
    const prior = tail.length;
    const seen = new Uint8Array(prior + chunk.length);

    seen.set(tail);
    seen.set(chunk, prior);
    tail = seen.slice(Math.max(0, seen.length - kept));

    const close = indexOf(seen, headClose);
    const open = indexOf(seen, bodyOpen);

    const ends = [
      ...(close === -1 ? [] : [close + headClose.length]),
      ...(open === -1 ? [] : [open]),
    ];

    // A `<body` begun in the chunk before cannot be taken back, so the page ends at once.
    return ends.length === 0 ? -1 : Math.max(0, Math.min(...ends) - prior);
  };
};
