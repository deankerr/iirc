import { Effect, Option, Schema } from "effect";
import { decodeHTML, decodeHTMLAttribute } from "entities/decode";

/**
 * A player a page names, as an address kept as data: nothing here fetches it, or says it may
 * play. Its size is the one the page gave beside it, or null.
 */
export interface PlayerCandidate {
  readonly link: string;
  readonly size: { readonly width: number; readonly height: number } | null;
}

/**
 * A video file a page names, as an address kept as data: nothing here fetches it. The type is
 * the page's own, parsed down to its essence.
 */
interface PageVideo {
  readonly link: string;
  readonly type: string;
}

/**
 * What a page says of itself. The image is an address kept as data: nothing here fetches it.
 * The oEmbed address is the one the page itself names, for the Daemon to fetch and then fill
 * the gaps with {@link fillFromOembed}. The players are the ones it names, in the order they
 * are tried, and are present only when it names one. The video is the file it names with a
 * `video/*` type, which is not a player, and is present only when it names one.
 */
export interface PageRead {
  readonly title?: string;
  readonly description?: string;
  readonly site?: string;
  readonly image?: string;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly oembed?: string;
  readonly players?: readonly PlayerCandidate[];
  readonly video?: PageVideo;
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

// A tolerant walk over the head, keeping `<meta>`, `<base>`, `<link>` and `<title>` only.
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
    } else if (name === "meta" || name === "base" || name === "link") {
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

const httpAddress = (value: string | undefined, base: string): string | undefined => {
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
  readonly oembedHref: string | undefined;
}

const OEMBED_TYPE = "application/json+oembed";

const isOembedLink = (attrs: ReadonlyMap<string, string>): boolean =>
  (attrs.get("rel") ?? "")
    .toLowerCase()
    .split(/[ \t\n\r\f]+/u)
    .includes("alternate") && (attrs.get("type") ?? "").trim().toLowerCase() === OEMBED_TYPE;

// The first value of each `<meta>` key, the `<title>` text, the `<base href>` and the first
// oEmbed `<link href>`, entities decoded.
const gather = (text: string): Gathered => {
  const meta = new Map<string, string>();
  let titleText: string | undefined;
  let baseHref: string | undefined;
  let oembedHref: string | undefined;

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
    } else if (name === "link" && oembedHref === undefined && href !== undefined) {
      if (isOembedLink(attrs)) {
        oembedHref = decodeHTMLAttribute(href);
      }
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

  return { baseHref, meta, oembedHref, titleText };
};

interface Draft {
  title?: string;
  description?: string;
  site?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  oembed?: string;
  players?: readonly PlayerCandidate[];
  video?: PageVideo;
}

// A size is one whole number of CSS pixels, in plain decimal digits and more than zero.
const dimension = (value: string | undefined): number | undefined => {
  const digits = tidy(value);

  if (digits === undefined || !/^\d+$/u.test(digits)) {
    return undefined;
  }

  const number = Number(digits);

  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

// The players a page names, each beside the size its own tags give, in the order they are
// tried and without repeating an address.
const playersOf = (meta: ReadonlyMap<string, string>, base: string): PlayerCandidate[] => {
  const named = [
    ["og:video:secure_url", "og:video"],
    ["og:video:url", "og:video"],
    ["og:video", "og:video"],
    ["twitter:player", "twitter:player"],
  ] as const;

  const found = new Map<string, PlayerCandidate>();

  for (const [key, sized] of named) {
    const link = httpAddress(firstOf(meta, [key]), base);

    if (link !== undefined && !found.has(link)) {
      const width = dimension(meta.get(`${sized}:width`));
      const height = dimension(meta.get(`${sized}:height`));

      found.set(link, {
        link,
        size: width === undefined || height === undefined ? null : { height, width },
      });
    }
  }

  return [...found.values()];
};

const VIDEO_TYPE = /^video\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

// The video file a page names: its first address, with the essence of the type it gives it.
// `text/html`, as YouTube says of its player, a missing type, or one that is not a plain
// `video/*` is a player in a frame at most, never a file.
const videoOf = (meta: ReadonlyMap<string, string>, base: string): PageVideo | undefined => {
  const type = (firstOf(meta, ["og:video:type"])?.split(";")[0] ?? "").trim().toLowerCase();

  if (!VIDEO_TYPE.test(type)) {
    return undefined;
  }

  for (const key of ["og:video:secure_url", "og:video:url", "og:video"]) {
    const link = httpAddress(firstOf(meta, [key]), base);

    if (link !== undefined) {
      return { link, type };
    }
  }

  return undefined;
};

/**
 * A page's head and its Content-Type in, what it says of itself out.
 *
 * @param input - the page's head as bytes, its Content-Type, and the address it was read from.
 * @returns what the page says of itself, which may be nothing: whether that is enough to show
 * is decided once an oEmbed address it names has filled its gaps.
 */
export const readPage = (input: {
  readonly head: Uint8Array;
  readonly contentType: string | undefined;
  readonly link: string;
}): PageRead => {
  const { meta, titleText, baseHref, oembedHref } = gather(
    decodeHead(input.head, input.contentType)
  );

  const base = absolute(baseHref, input.link) ?? input.link;

  const title = cut(firstOf(meta, ["og:title", "twitter:title"]) ?? titleText, TITLE_LIMIT);

  const description = cut(
    firstOf(meta, ["og:description", "twitter:description", "description"]),
    DESCRIPTION_LIMIT
  );

  const site = firstOf(meta, ["og:site_name"]);

  const image = httpAddress(
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
  const players = playersOf(meta, base);
  const video = videoOf(meta, base);

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

  const oembed = httpAddress(oembedHref, base);

  if (oembed !== undefined) {
    page.oembed = oembed;
  }

  if (players.length > 0) {
    page.players = players;
  }

  if (video !== undefined) {
    page.video = video;
  }

  return page;
};

// A field of the wrong type is dropped on its own, so it never discards the rest.
const lenient = <S extends Schema.Constraint>(field: S) =>
  Schema.optional(
    Schema.UndefinedOr(field).pipe(Schema.catchDecoding(() => Effect.succeedSome(undefined)))
  );

// Providers sometimes send a size as a numeric string.
const Size = Schema.Union([Schema.Finite, Schema.FiniteFromString]).check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);

// Only these fields are read. `html` is not among them, whatever the answer's `type`.
const Oembed = Schema.Struct({
  author_name: lenient(Schema.String),
  thumbnail_height: lenient(Size),
  thumbnail_url: lenient(Schema.String),
  thumbnail_width: lenient(Size),
  title: lenient(Schema.String),
});

/** What an oEmbed answer says, of the fields read, each as the provider sent it or absent. */
export type OembedAnswer = typeof Oembed.Type;

const decodeOembed = Schema.decodeUnknownOption(Schema.fromJsonString(Oembed));

/**
 * An oEmbed answer's JSON text in, its fields out.
 *
 * @param json - the answer's body, decoded as text.
 * @returns the fields it carries, each dropped on its own when malformed, or undefined when
 * the text is not a JSON object.
 */
export const readOembed = (json: string): OembedAnswer | undefined =>
  Option.getOrUndefined(decodeOembed(json));

/**
 * What an oEmbed answer adds to a page's own reading: only what the page left empty. The
 * title, the author as the site, and the thumbnail as the image with its size. Text in JSON
 * is not HTML, so nothing is decoded. The answer's `html` is never read, whatever its
 * `type`, and the description is never filled.
 *
 * @param page - What the page said of itself.
 * @param answer - What the oEmbed answer said.
 * @param oembedLink - The address the answer came from, which a thumbnail is resolved against.
 * @returns The page with its gaps filled.
 */
export const fillFromOembed = (
  page: PageRead,
  answer: OembedAnswer,
  oembedLink: string
): PageRead => {
  const filled: Draft = { ...page };

  if (page.title === undefined) {
    const title = cut(tidy(answer.title), TITLE_LIMIT);

    if (title !== undefined) {
      filled.title = title;
    }
  }

  if (page.site === undefined) {
    const site = tidy(answer.author_name);

    if (site !== undefined) {
      filled.site = site;
    }
  }

  if (page.image === undefined) {
    const image = httpAddress(tidy(answer.thumbnail_url), oembedLink);

    if (image !== undefined) {
      filled.image = image;

      if (answer.thumbnail_width !== undefined) {
        filled.imageWidth = answer.thumbnail_width;
      }

      if (answer.thumbnail_height !== undefined) {
        filled.imageHeight = answer.thumbnail_height;
      }
    }
  }

  return filled;
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
