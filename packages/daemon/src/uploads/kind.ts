/** How many leading bytes the detector reads. */
export const headLength = 4096;

/** The broad sort of a file, which is what a file with no name is called. */
export type Family = "image" | "video" | "audio" | "text" | "file";

/** What bytes are, and how to serve them. */
export interface Kind {
  /** The exact Content-Type to serve. */
  readonly type: string;
  /** The canonical extension, lower case, without a dot. */
  readonly extension: string;
  /** Every extension that already names this kind, the canonical one first. */
  readonly extensions: readonly string[];
  readonly family: Family;
  /** Whether it is shown in place, rather than downloaded as an attachment. */
  readonly inline: boolean;
}

const kind = (
  type: string,
  family: Family,
  inline: boolean,
  extensions: readonly [string, ...string[]]
): Kind => ({ extension: extensions[0], extensions, family, inline, type });

const png = kind("image/png", "image", true, ["png", "apng"]);
const jpeg = kind("image/jpeg", "image", true, ["jpg", "jpeg", "jpe"]);
const gif = kind("image/gif", "image", true, ["gif"]);
const webp = kind("image/webp", "image", true, ["webp"]);
const avif = kind("image/avif", "image", true, ["avif"]);
const heic = kind("image/heic", "image", false, ["heic", "heif"]);
const svg = kind("image/svg+xml", "image", false, ["svg"]);
const mp4 = kind("video/mp4", "video", true, ["mp4", "m4v"]);
const mov = kind("video/quicktime", "video", true, ["mov", "qt"]);
const webm = kind("video/webm", "video", true, ["webm"]);
const matroska = kind("video/x-matroska", "video", false, ["mkv"]);
const mp3 = kind("audio/mpeg", "audio", true, ["mp3"]);
const ogg = kind("audio/ogg", "audio", true, ["ogg", "oga", "opus"]);
const flac = kind("audio/flac", "audio", true, ["flac"]);
const wav = kind("audio/wav", "audio", true, ["wav"]);
const m4a = kind("audio/mp4", "audio", true, ["m4a"]);
const pdf = kind("application/pdf", "file", false, ["pdf"]);
const html = kind("text/html; charset=utf-8", "text", false, ["html", "htm"]);
const xml = kind("application/xml", "file", false, ["xml"]);

const text = kind("text/plain; charset=utf-8", "text", true, [
  "txt",
  "text",
  "log",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "diff",
  "patch",
  "js",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "py",
  "rs",
  "go",
  "c",
  "h",
  "cpp",
  "java",
  "sh",
  "sql",
]);

const unknown = kind("application/octet-stream", "file", false, ["bin"]);

/** Every kind that can be detected, which is how a name's extension is recognised. */
export const knownKinds: readonly Kind[] = [
  png,
  jpeg,
  gif,
  webp,
  avif,
  heic,
  svg,
  mp4,
  mov,
  webm,
  matroska,
  mp3,
  ogg,
  flac,
  wav,
  m4a,
  pdf,
  html,
  xml,
  text,
];

/** The kind of bytes that are none of the others: no extension names it. */
const unknownKind: Kind = { ...unknown, extensions: [] };

/**
 * The Kind a type was read as, so a name can be made safe again for bytes read before.
 * @param type - The type a record holds.
 * @returns Its Kind, or the Kind of bytes that are none of the others for a type no Kind has.
 */
export const kindOfType = (type: string): Kind =>
  knownKinds.find((kind) => kind.type === type) ?? unknownKind;

const ascii = (head: Uint8Array, at: number, expected: string): boolean => {
  if (head.length < at + expected.length) {
    return false;
  }

  for (let i = 0; i < expected.length; i += 1) {
    if (head[at + i] !== expected.codePointAt(i)) {
      return false;
    }
  }

  return true;
};

const isMpegFrame = (head: Uint8Array): boolean => {
  const [b0, b1, b2] = head;

  if (b0 !== 0xff || b1 === undefined || b2 === undefined) {
    return false;
  }

  const version = Math.floor(b1 / 8) % 4;
  const layer = Math.floor(b1 / 2) % 4;
  const bitrate = Math.floor(b2 / 16);
  const rate = Math.floor(b2 / 4) % 4;

  return (
    b1 >= 0xe0 && version !== 1 && layer !== 0 && bitrate !== 15 && bitrate !== 0 && rate !== 3
  );
};

const brandsOf = (head: Uint8Array) => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const declared = view.getUint32(0);
  const end = Math.min(declared < 16 ? head.length : declared, head.length);
  const brandAt = (at: number) => String.fromCodePoint(...head.subarray(at, at + 4));
  const major = brandAt(8);
  const all = new Set([major]);

  for (let at = 16; at + 4 <= end; at += 4) {
    all.add(brandAt(at));
  }

  return { all, major };
};

// The brands, major or compatible, of an ISO base media file that plays as MP4: the ISO
// and MPEG-4 families, AVC, DASH segments, iTunes and Adobe video, and 3GPP, which is
// MP4's profile. Any other brand, such as JPEG 2000's `jp2 `, is not shown as video.
const mp4Brands = [
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "mp41",
  "mp42",
  "mp71",
  "avc1",
  "dash",
  "M4V ",
  "M4VH",
  "M4VP",
  "mmp4",
  "msnv",
  "f4v ",
  "3gp4",
  "3gp5",
  "3gp6",
  "3g2a",
];

const isoBaseMedia = (head: Uint8Array): Kind => {
  const { all, major } = brandsOf(head);
  const has = (...brands: readonly string[]) => brands.some((brand) => all.has(brand));

  if (has("avif", "avis")) {
    return avif;
  }

  if (has("heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1")) {
    return heic;
  }

  if (major === "qt  ") {
    return mov;
  }

  if (major === "M4A ") {
    return m4a;
  }

  return has(...mp4Brands) ? mp4 : unknownKind;
};

const ebml = (head: Uint8Array): Kind => {
  const near = String.fromCodePoint(...head.subarray(0, 64));

  return near.includes("webm") ? webm : matroska;
};

const isAllowedControl = (code: number): boolean =>
  code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;

// Valid UTF-8, where a sequence cut off by the end of the head is allowed, and no control
// character a person would not type. Returns the decoded text, or undefined if it is not text.
const readText = (head: Uint8Array): string | undefined => {
  let decoded: string;

  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(head, {
      stream: true,
    });
  } catch {
    return undefined;
  }

  for (let i = 0; i < decoded.length; i += 1) {
    const code = decoded.codePointAt(i) ?? 0;

    if (code < 0x20 ? !isAllowedControl(code) : code === 0x7f) {
      return undefined;
    }
  }

  return decoded;
};

const markupKind = (source: string): Kind => {
  const lower = source.toLowerCase();

  if (/<svg[\s>/]/u.test(lower)) {
    return svg;
  }

  if (lower.startsWith("<?xml")) {
    return xml;
  }

  return html;
};

const textKind = (head: Uint8Array): Kind => {
  const decoded = readText(head);

  if (decoded === undefined) {
    return unknownKind;
  }

  const body = decoded.replace(/^\uFEFF/u, "").trimStart();

  return body.startsWith("<") ? markupKind(body) : text;
};

const imageOrContainer = (head: Uint8Array): Kind | undefined => {
  if (head[0] === 0x89 && ascii(head, 1, "PNG\r\n\u001A\n")) {
    return png;
  }

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return jpeg;
  }

  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) {
    return gif;
  }

  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) {
    return webp;
  }

  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE")) {
    return wav;
  }

  if (ascii(head, 4, "ftyp") && head.length >= 12) {
    return isoBaseMedia(head);
  }

  return undefined;
};

const streamOrDocument = (head: Uint8Array): Kind | undefined => {
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return ebml(head);
  }

  if (ascii(head, 0, "ID3") || isMpegFrame(head)) {
    return mp3;
  }

  if (ascii(head, 0, "OggS")) {
    return ogg;
  }

  if (ascii(head, 0, "fLaC")) {
    return flac;
  }

  if (ascii(head, 0, "%PDF-")) {
    return pdf;
  }

  return undefined;
};

/**
 * What the leading bytes of a file are, decided by their structure and never by a name.
 * @param head - Up to `headLength` leading bytes, which may be fewer, or none.
 * @returns The Kind to serve it as.
 */
export const detectKind = (head: Uint8Array): Kind =>
  head.length === 0
    ? unknownKind
    : (imageOrContainer(head) ?? streamOrDocument(head) ?? textKind(head));
