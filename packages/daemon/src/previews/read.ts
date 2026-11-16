import { decodeHTML, decodeHTMLAttribute } from "entities/decode";

/** What a page says of itself. */
export interface PageRead {
  readonly title?: string;
  readonly description?: string;
  readonly site?: string;
  readonly image?: string;
}

const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 500;
const PRESCAN_BYTES = 1024;

interface Tag {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
}

type Piece =
  | { readonly kind: "tag"; readonly tag: Tag }
  | { readonly kind: "title"; readonly text: string };

const isSpace = (ch: string): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";

const isNameStart = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z]/u.test(ch);

/** Reads attributes from `text` starting at `from`; returns them and the index after the tag. */
interface Attributes {
  readonly attrs: Map<string, string>;
  readonly end: number;
}

interface Value {
  readonly value: string;
  readonly end: number;
}

// An attribute's value, quoted or not, starting after its `=`.
const readValue = (text: string, from: number): Value => {
  let i = from;

  while (i < text.length && isSpace(text.charAt(i))) {
    i += 1;
  }

  const quote = text.charAt(i);

  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, i + 1);
    const stop = close === -1 ? text.length : close;

    return { end: stop + 1, value: text.slice(i + 1, stop) };
  }

  const start = i;

  while (i < text.length && !isSpace(text.charAt(i)) && text.charAt(i) !== ">") {
    i += 1;
  }

  return { end: i, value: text.slice(start, i) };
};

const readAttributes = (text: string, from: number): Attributes => {
  const attrs = new Map<string, string>();
  let i = from;

  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === ">") {
      return { attrs, end: i + 1 };
    }

    if (isSpace(ch) || ch === "/") {
      i += 1;
      continue;
    }

    const nameStart = i;

    while (i < text.length && !isSpace(text.charAt(i)) && !"=>/".includes(text.charAt(i))) {
      i += 1;
    }

    const name = text.slice(nameStart, i).toLowerCase();

    while (i < text.length && isSpace(text.charAt(i))) {
      i += 1;
    }

    let value = "";

    if (text.charAt(i) === "=") {
      ({ value, end: i } = readValue(text, i + 1));
    }

    if (name !== "" && !attrs.has(name)) {
      attrs.set(name, value);
    }
  }

  return { attrs, end: text.length };
};

const CLOSERS = {
  script: /<\/script/giu,
  style: /<\/style/giu,
  title: /<\/title/giu,
};

// Where the element named `name`, whose contents start at `from`, ends.
const elementEnd = (text: string, name: keyof typeof CLOSERS, from: number): number => {
  const closer = CLOSERS[name];
  closer.lastIndex = from;
  const found = closer.exec(text);

  return found === null ? text.length : found.index;
};

// A tolerant walk over the head, keeping `<meta>`, `<base>` and `<title>` only.
const scan = (text: string): Piece[] => {
  const pieces: Piece[] = [];
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf("<", i);

    if (lt === -1) {
      break;
    }

    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);

      if (close === -1) {
        break;
      }

      i = close + 3;
      continue;
    }

    if (!isNameStart(text.charAt(lt + 1))) {
      i = lt + 1;
      continue;
    }

    let nameEnd = lt + 1;

    while (
      nameEnd < text.length &&
      !isSpace(text.charAt(nameEnd)) &&
      !"/>".includes(text.charAt(nameEnd))
    ) {
      nameEnd += 1;
    }

    const name = text.slice(lt + 1, nameEnd).toLowerCase();
    const { attrs, end } = readAttributes(text, nameEnd);
    i = end;

    if (name === "body") {
      break;
    }

    if (name === "script" || name === "style" || name === "title") {
      const stop = elementEnd(text, name, i);

      if (name === "title") {
        pieces.push({ kind: "title", text: text.slice(i, stop) });
      }

      i = stop;
    } else if (name === "meta" || name === "base") {
      pieces.push({ kind: "tag", tag: { attrs, name } });
    }
  }

  return pieces;
};

// SAFETY: `TextDecoder` accepts any WHATWG label and throws on an unknown one, which the callers catch;
// its type only lists the labels as a union.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
const decoderFor = (label: string): TextDecoder => new TextDecoder(label as "utf-8");

const resolveLabel = (label: string | undefined): string | undefined => {
  if (label === undefined || label.trim() === "") {
    return undefined;
  }

  try {
    return decoderFor(label.trim()).encoding;
  } catch {
    return undefined;
  }
};

const bomCharset = (head: Uint8Array): string | undefined => {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return "utf-8";
  }

  if (head[0] === 0xff && head[1] === 0xfe) {
    return "utf-16le";
  }

  if (head[0] === 0xfe && head[1] === 0xff) {
    return "utf-16be";
  }

  return undefined;
};

const headerCharset = (contentType: string | undefined): string | undefined => {
  const match = /charset\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s;]+))/iu.exec(
    contentType ?? ""
  );

  return resolveLabel(match?.groups?.double ?? match?.groups?.single ?? match?.groups?.bare);
};

const metaCharset = (head: Uint8Array): string | undefined => {
  const text = new TextDecoder("latin1").decode(head.subarray(0, PRESCAN_BYTES));

  for (const piece of scan(text)) {
    if (piece.kind !== "tag" || piece.tag.name !== "meta") {
      continue;
    }

    const { attrs } = piece.tag;
    const direct = resolveLabel(attrs.get("charset"));

    const httpEquiv =
      attrs.get("http-equiv")?.toLowerCase() === "content-type"
        ? headerCharset(attrs.get("content"))
        : undefined;

    const found = direct ?? httpEquiv;

    if (found !== undefined) {
      // The HTML standard reads a meta-declared UTF-16 as UTF-8: the prescan could read it.
      return found.startsWith("utf-16") ? "utf-8" : found;
    }
  }

  return undefined;
};

const decodeHead = (head: Uint8Array, contentType: string | undefined): string => {
  const charset = bomCharset(head) ?? headerCharset(contentType) ?? metaCharset(head) ?? "utf-8";

  return decoderFor(charset).decode(head);
};

const tidy = (text: string | undefined): string | undefined => {
  const collapsed = text?.replaceAll(/\s+/gu, " ").trim();

  return collapsed === undefined || collapsed === "" ? undefined : collapsed;
};

const cut = (text: string | undefined, limit: number): string | undefined =>
  // oxlint-disable-next-line typescript/no-misused-spread -- the limits count code points, never half a surrogate pair.
  text === undefined ? undefined : [...text].slice(0, limit).join("");

const absolute = (value: string | undefined, base: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  try {
    return new URL(value, base).href;
  } catch {
    return undefined;
  }
};

const httpImage = (value: string | undefined, base: string): string | undefined => {
  const resolved = absolute(value, base);

  return resolved !== undefined && /^https?:\/\//iu.test(resolved) ? resolved : undefined;
};

const firstOf = (
  meta: ReadonlyMap<string, string>,
  keys: readonly string[]
): string | undefined => {
  for (const key of keys) {
    const value = tidy(meta.get(key));

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
};

interface Gathered {
  readonly meta: Map<string, string>;
  readonly titleText: string | undefined;
  readonly baseHref: string | undefined;
}

// The first value of each `<meta>` key, the `<title>` text and the `<base href>`, entities decoded.
const gather = (text: string): Gathered => {
  const meta = new Map<string, string>();
  let titleText: string | undefined;
  let baseHref: string | undefined;

  for (const piece of scan(text)) {
    if (piece.kind === "title") {
      titleText ??= tidy(decodeHTML(piece.text));
      continue;
    }

    const { name, attrs } = piece.tag;
    const href = attrs.get("href");
    const content = attrs.get("content");

    if (name === "base" && baseHref === undefined && href !== undefined) {
      baseHref = decodeHTMLAttribute(href);
    } else if (name === "meta" && content !== undefined) {
      const keys = [attrs.get("property"), attrs.get("name")].map((key) =>
        key?.trim().toLowerCase()
      );

      for (const key of new Set(keys)) {
        if (key !== undefined && tidy(meta.get(key)) === undefined) {
          meta.set(key, decodeHTMLAttribute(content));
        }
      }
    }
  }

  return { baseHref, meta, titleText };
};

interface Draft {
  title?: string;
  description?: string;
  site?: string;
  image?: string;
}

/**
 * A page's head and its Content-Type in, what it says of itself out.
 *
 * @param input - the page's head as bytes, its Content-Type, and the address it was read from.
 * @returns what the page says of itself, or undefined when there is nothing to show.
 */
export const readPage = (input: {
  readonly head: Uint8Array;
  readonly contentType: string | undefined;
  readonly link: string;
}): PageRead | undefined => {
  const { meta, titleText, baseHref } = gather(decodeHead(input.head, input.contentType));
  const base = absolute(baseHref, input.link) ?? input.link;

  const title = cut(firstOf(meta, ["og:title", "twitter:title"]) ?? titleText, TITLE_LIMIT);

  const description = cut(
    firstOf(meta, ["og:description", "twitter:description", "description"]),
    DESCRIPTION_LIMIT
  );

  if (title === undefined && description === undefined) {
    return undefined;
  }

  const site = firstOf(meta, ["og:site_name"]);

  const image = httpImage(
    firstOf(meta, [
      "og:image",
      "og:image:url",
      "og:image:secure_url",
      "twitter:image",
      "twitter:image:src",
    ]),
    base
  );

  const page: Draft = {};

  if (title !== undefined) {
    page.title = title;
  }

  if (description !== undefined) {
    page.description = description;
  }

  if (site !== undefined) {
    page.site = site;
  }

  if (image !== undefined) {
    page.image = image;
  }

  return page;
};

/**
 * The kind of a link whose answer is itself media, from its Content-Type alone.
 *
 * @param contentType - the answer's Content-Type, with or without parameters.
 * @returns the kind of media, or undefined when the answer is not media.
 */
export const readMedia = (contentType: string): "image" | "video" | "audio" | undefined => {
  const essence = (contentType.split(";")[0] ?? "").trim().toLowerCase();

  if (essence.startsWith("image/")) {
    return "image";
  }

  if (essence.startsWith("video/")) {
    return "video";
  }

  if (essence.startsWith("audio/")) {
    return "audio";
  }

  return undefined;
};
