import { Redacted, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";

import { binaryString, fallbackDecoder, utf8Lossy, utf8OrElse } from "./decode.ts";

/**
 * One Line received from an Ircd, after parsing. Anything that parses is a Line, so a
 * hostile Ircd can send one with any command and any parameters, and readers decide
 * from its structure alone.
 */
export interface Line {
  readonly tags: ReadonlyMap<string, string>;
  readonly source: string | undefined;
  readonly command: string;
  readonly params: readonly string[];
}

/** Why some bytes could not be parsed into a {@link Line}. */
export type UnparseableReason = "Empty" | "NoCommand";

/** The result of parsing one Line's bytes, which never fails by throwing. */
export type Parsed =
  | { readonly _tag: "Line"; readonly line: Line }
  | { readonly _tag: "Unparseable"; readonly reason: UnparseableReason };

/**
 * The encodings a fallback may be: every WHATWG encoding by its canonical name, except
 * UTF-8 itself and those that cannot be a fallback. UTF-16 reads every space and colon as
 * half a character, `replacement` reads everything as one U+FFFD, Bun's `x-user-defined`
 * drops bytes above 0x7f, and ISO-2022-JP is all 7-bit bytes, so its text always reads as
 * UTF-8 first and the fallback would never be tried. It is a fixed list, not whatever this
 * runtime knows, so a recorded Configuration means the same everywhere, and a runtime
 * without one of these decoders is refused by {@link missingDecoders}. Runtimes still
 * decode some bytes differently, so replay is exact only on the pinned Bun. ISO-8859-1, which WHATWG reads as `windows-1252`, is `windows-1252`.
 */
export const fallbackEncodings = [
  "ibm866",
  "iso-8859-2",
  "iso-8859-3",
  "iso-8859-4",
  "iso-8859-5",
  "iso-8859-6",
  "iso-8859-7",
  "iso-8859-8",
  "iso-8859-8-i",
  "iso-8859-10",
  "iso-8859-13",
  "iso-8859-14",
  "iso-8859-15",
  "iso-8859-16",
  "koi8-r",
  "koi8-u",
  "macintosh",
  "windows-874",
  "windows-1250",
  "windows-1251",
  "windows-1252",
  "windows-1253",
  "windows-1254",
  "windows-1255",
  "windows-1256",
  "windows-1257",
  "windows-1258",
  "x-mac-cyrillic",
  "gbk",
  "gb18030",
  "big5",
  "euc-jp",
  "shift_jis",
  "euc-kr",
] as const;

/** An encoding to read bytes that are not UTF-8 with, by its canonical WHATWG name. */
export const FallbackEncoding = Schema.Literals(fallbackEncodings);

/** The decoded form of {@link FallbackEncoding}. */
export type FallbackEncoding = typeof FallbackEncoding.Type;

/**
 * The fallback encodings this runtime cannot decode. A runtime that misses any would read
 * the same bytes as different text, so whatever processes or replays a Journal checks
 * this is empty before it starts, and refuses to run otherwise.
 * @returns The missing encodings, empty on a runtime that has them all.
 */
export const missingDecoders = (): readonly FallbackEncoding[] =>
  fallbackEncodings.filter((name) => fallbackDecoder(name)?.encoding !== name);

/**
 * How an Ircd's bytes become text. `Utf8Only` is what `UTF8ONLY` promises. Otherwise
 * bytes that are not UTF-8 are read in a fallback encoding, named by its WHATWG label.
 */
export const Encoding = Schema.TaggedUnion({
  Utf8Only: {},
  Utf8OrElse: { fallback: FallbackEncoding },
});

/** The decoded form of {@link Encoding}. */
export type Encoding = typeof Encoding.Type;

/** The most bytes a Line may take, without its tags and line ending. */
export const maxLineBytes = 510;

/**
 * The most bytes of tag data a client may send: the bytes between the leading `@` and
 * the space after the tags, which are not counted.
 */
export const maxTagBytes = 4094;

// Parsing

const space = 0x20;
const colon = 0x3a;
const at = 0x40;

/**
 * Where a Line's bytes end: at the first NUL, CR, or LF. None may appear in a Line, and
 * an Ircd that ends a Line with a bare CR has sent everything after it as another.
 * @param bytes - The Line's bytes.
 * @returns The index it ends at.
 */
const lineEnd = (bytes: Uint8Array) => {
  const end = bytes.findIndex((byte) => byte === 0x00 || byte === 0x0d || byte === 0x0a);

  return end === -1 ? bytes.length : end;
};

const tagEscapes: ReadonlyMap<string, string> = new Map([
  [":", ";"],
  ["\\", "\\"],
  ["n", "\n"],
  ["r", "\r"],
  ["s", " "],
]);

// A lone `\` at the end is dropped, and so is one before a character with no escape.
const unescapeTagValue = (value: string) =>
  value.includes("\\")
    ? value.replaceAll(/\\(?<escaped>.?)/gsu, (_match, escaped: string) =>
        escaped === "" ? "" : (tagEscapes.get(escaped) ?? escaped)
      )
    : value;

// Tags are UTF-8 by their spec. A key is an opaque name that is never refused, and the
// last of a repeated key wins.
const parseTags = (text: string): ReadonlyMap<string, string> => {
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

/**
 * Upper-cases ASCII letters only, as commands are compared.
 * @param text - The text to change.
 * @returns The text with `a` to `z` made `A` to `Z`, and nothing else touched.
 */
export const upperCaseAscii = (text: string): string =>
  text.replaceAll(/[a-z]+/gu, (letters) => letters.toUpperCase());

const decoderFor = (encoding: Encoding) =>
  encoding._tag === "Utf8Only"
    ? utf8Lossy
    : (bytes: Uint8Array) => utf8OrElse(bytes, fallbackDecoder(encoding.fallback));

/**
 * Where each word starts: each byte that is not a space and follows a space or the
 * start. Runs of spaces count as one, as RFC 1459 allows.
 * @param bytes - The Line's bytes.
 * @param end - Where the Line ends.
 * @returns The index of each word's first byte, in order.
 */
const wordsOf = (bytes: Uint8Array, end: number): readonly number[] => {
  const starts: number[] = [];

  for (let index = 0; index < end; index += 1) {
    if (bytes[index] !== space && (index === 0 || bytes[index - 1] === space)) {
      starts.push(index);
    }
  }

  return starts;
};

/**
 * The word that starts at an index, up to the next space or the end.
 * @param bytes - The Line's bytes.
 * @param start - Where the word starts.
 * @param end - Where the Line ends.
 * @returns The word's bytes.
 */
const wordAt = (bytes: Uint8Array, start: number, end: number) => {
  const stop = bytes.subarray(start, end).indexOf(space);

  return bytes.subarray(start, stop === -1 ? end : start + stop);
};

type Span = readonly [start: number, end: number];

/** Where a Line's parts lie in its bytes, or why it has none. */
type Layout =
  | { readonly _tag: "Unparseable"; readonly reason: UnparseableReason }
  | {
      readonly _tag: "Layout";
      readonly tags: Span | undefined;
      readonly source: Span | undefined;
      readonly command: Span;
      readonly params: readonly Span[];
    };

const wordSpan = (bytes: Uint8Array, start: number, end: number): Span => [
  start,
  start + wordAt(bytes, start, end).length,
];

/**
 * Finds a Line's parts in its bytes. `parse` and `rawParams` both read this, so they
 * always agree on where each parameter starts and ends.
 * @param bytes - The Line's bytes.
 * @returns Where each part lies, without the `@` or `:` that marks it.
 */
const layoutOf = (bytes: Uint8Array): Layout => {
  const end = lineEnd(bytes);
  const words = wordsOf(bytes, end);
  const [first] = words;

  if (first === undefined) {
    return { _tag: "Unparseable", reason: "Empty" };
  }

  const hasTags = bytes[first] === at;
  const tagsEnd = hasTags ? 1 : 0;
  const sourceStart = words[tagsEnd];
  const hasSource = sourceStart !== undefined && bytes[sourceStart] === colon;
  const commandAt = tagsEnd + (hasSource ? 1 : 0);
  const commandStart = words[commandAt];

  if (commandStart === undefined) {
    return { _tag: "Unparseable", reason: "NoCommand" };
  }

  const params: Span[] = [];

  for (const start of words.slice(commandAt + 1)) {
    if (bytes[start] === colon) {
      params.push([start + 1, end]);
      break;
    }

    params.push(wordSpan(bytes, start, end));
  }

  return {
    _tag: "Layout",
    command: wordSpan(bytes, commandStart, end),
    params,
    source: hasSource ? wordSpan(bytes, sourceStart + 1, end) : undefined,
    tags: hasTags ? wordSpan(bytes, first + 1, end) : undefined,
  };
};

const partOf = (bytes: Uint8Array, [start, end]: Span) => bytes.subarray(start, end);

/**
 * Parses one Line's bytes, without its line ending, and never throws. It reads the
 * grammar at the byte level, then decodes each part on its own, so one part in another
 * encoding leaves the rest readable. It accepts what any Ircd might send: runs of spaces
 * between parts, spaces before the first, a source or none, tags or none, a trailing
 * parameter with or without its colon, and any number of parameters. A command is
 * upper-cased. Tags are UTF-8, and the rest is read as `encoding` says.
 * @param bytes - The Line's bytes, as the Transport framed them.
 * @param encoding - How bytes that are not UTF-8 become text.
 * @returns The Line, or why there is none.
 */
export const parse = (bytes: Uint8Array, encoding: Encoding): Parsed => {
  const layout = layoutOf(bytes);

  if (layout._tag === "Unparseable") {
    return layout;
  }

  const text = decoderFor(encoding);
  const source = layout.source === undefined ? "" : text(partOf(bytes, layout.source));

  return {
    _tag: "Line",
    line: {
      command: upperCaseAscii(text(partOf(bytes, layout.command))),
      params: layout.params.map((span) => text(partOf(bytes, span))),
      source: source === "" ? undefined : source,
      tags:
        layout.tags === undefined ? new Map() : parseTags(utf8Lossy(partOf(bytes, layout.tags))),
    },
  };
};

/**
 * A Line's parameters as the bytes that arrived, split exactly as {@link parse} splits
 * them, for what must be echoed byte for byte, such as a `PING`'s token. Text cannot
 * promise that: a token that is not UTF-8 is decoded, and would be re-encoded as UTF-8.
 * Each is a {@link RawParam}, whose bytes are a string, so nothing done to `bytes` later
 * changes it, and a Client can keep one in its State.
 * @param bytes - The Line's bytes, as the Transport framed them.
 * @returns Each parameter's bytes, or none if the Line does not parse.
 */
export const rawParams = (bytes: Uint8Array): readonly RawParam[] => {
  const layout = layoutOf(bytes);

  return layout._tag === "Unparseable"
    ? []
    : layout.params.map((span) => ({ bytes: binaryString(partOf(bytes, span)) }));
};

/** A source's parts: `nick!user@host`, where a server's name is all nick. */
export interface Source {
  readonly nick: string;
  readonly user: string | undefined;
  readonly host: string | undefined;
}

/**
 * Splits a source into its parts. The nick runs to the first `!` or `@`, the user from a
 * `!` to the `@` after it, and the host from the first `@` on.
 * @param source - A Line's source.
 * @returns Its parts. A server's name, which has neither, is all nick.
 */
export const parseSource = (source: string): Source => {
  const atSign = source.indexOf("@");
  const beforeHost = atSign === -1 ? source : source.slice(0, atSign);
  const bang = beforeHost.indexOf("!");

  return {
    host: atSign === -1 ? undefined : source.slice(atSign + 1),
    nick: bang === -1 ? beforeHost : beforeHost.slice(0, bang),
    user: bang === -1 ? undefined : beforeHost.slice(bang + 1),
  };
};

// Sending

const utf8 = new TextEncoder();
const command = /^(?:[A-Z]+|\d{3})$/u;
const clientTag = /^\+(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9-]+$/u;

/**
 * The tags without `+` that a client may send: `label` for `labeled-response`, and
 * `batch` and `draft/multiline-concat` for `draft/multiline`.
 */
const sentTags: ReadonlySet<string> = new Set(["batch", "draft/multiline-concat", "label"]);

const isSendableTag = (key: string) => clientTag.test(key) || sentTags.has(key);
const escapedInTags = /[; \\\r\n]/gu;

const tagEscape: ReadonlyMap<string, string> = new Map([
  ["\n", "\\n"],
  ["\r", "\\r"],
  [" ", "\\s"],
  [";", "\\:"],
  ["\\", "\\\\"],
]);

const isBinary = (text: string) => {
  for (let index = 0; index < text.length; index += 1) {
    if ((text.codePointAt(index) ?? 0) > 0xff) {
      return false;
    }
  }

  return true;
};

/** Bytes held as a string with one code unit per byte, from 0 to 255. */
const BinaryString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isBinary, { expected: "a string of one code unit per byte, 0 to 255" })
  )
);

/**
 * A parameter given as bytes, sent exactly as they are, such as a `PING`'s token echoed
 * in a `PONG`. The bytes are a binary string, one code unit per byte, so they cannot be
 * changed once checked, and are recorded as they are.
 */
export const RawParam = Schema.Struct({ bytes: BinaryString });

/** The decoded form of {@link RawParam}. */
export type RawParam = typeof RawParam.Type;

/** A parameter to send: text, sent as UTF-8, or bytes, sent as they are. */
export const Param = Schema.Union([Schema.String, RawParam]);

/** The decoded form of {@link Param}. */
export type Param = typeof Param.Type;

const isText = Schema.is(Schema.String);

const breaksLines = (bytes: Uint8Array) =>
  bytes.some((byte) => byte === 0x00 || byte === 0x0d || byte === 0x0a);

// What only the last parameter may be: empty, holding a space, or starting with a colon.
const needsTrailing = (bytes: Uint8Array) =>
  bytes.length === 0 || bytes[0] === colon || bytes.includes(space);

const escapeTag = ([key, value]: readonly [string, string]) =>
  value === ""
    ? key
    : `${key}=${value.replaceAll(escapedInTags, (char) => tagEscape.get(char) ?? char)}`;

/** Why a Line cannot be sent safely. */
export type RejectedReason =
  /** The command is not letters, or three digits. */
  | "InvalidCommand"
  /** A parameter holds NUL, CR, LF, or a lone surrogate, or a middle one is not a word. */
  | "InvalidParameter"
  /** More than 15 parameters. */
  | "TooManyParameters"
  /** More than {@link maxLineBytes} bytes, without tags and line ending. */
  | "TooLong"
  /** A tag we may not send, or a value that holds NUL or a lone surrogate. */
  | "InvalidTag"
  /** More than {@link maxTagBytes} bytes of tag data. */
  | "TagsTooLong"
  /** A Target, Channel, or nick that would name something else, such as a list. */
  | "InvalidTarget"
  /** A Message with nothing in it, which an Ircd refuses. */
  | "EmptyText"
  /** Text that does not read as a Line a client may send: no command, or a source, which only an Ircd gives. */
  | "Unparseable";

/** A Line that cannot be sent safely, and why. */
export interface Rejected {
  readonly _tag: "Rejected";
  readonly reason: RejectedReason;
}

const rejected = (reason: RejectedReason): Rejected => ({ _tag: "Rejected", reason });

/**
 * Whether a result is {@link Rejected}.
 * @param result - What a builder, {@link encode}, or {@link fillSecret} returned.
 * @returns Whether it is a rejection.
 */
export const isRejected = (
  result: OutboundLine | readonly OutboundLine[] | Uint8Array | Rejected
): result is Rejected => "_tag" in result && result._tag === "Rejected";

/** A Line before it is checked, whatever its fields hold. */
interface Unchecked {
  readonly command: unknown;
  readonly params: unknown;
  readonly tags: unknown;
}

/** One parameter, read once: the plain value to keep, and the bytes it encodes to. */
interface ReadParam {
  readonly param: Param;
  readonly bytes: Uint8Array;
}

/**
 * A Line read once into plain data, every invariant checked on it. Checking and
 * encoding both work from this, so what was checked is what is written.
 */
interface Snapshot {
  readonly _tag: "Snapshot";
  readonly command: string;
  readonly params: readonly ReadParam[];
  readonly tags: readonly (readonly [string, string])[];
}

// The shapes a Line's fields are read into: plain strings, arrays, and objects, made
// fresh by decoding, so each field is read once and a getter cannot change what was
// checked. A boxed `String` is not a string here.
const readCommand = Schema.decodeUnknownResult(Schema.String);

const readParams = Schema.decodeUnknownResult(
  Schema.Array(Schema.Union([Schema.String, Schema.Struct({ bytes: Schema.String })]))
);

const readTags = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.String));

// Text must survive UTF-8, and bytes must be one code unit per byte.
const readParam = (param: Param): ReadParam | undefined => {
  if (isText(param)) {
    return param.isWellFormed() ? { bytes: utf8.encode(param), param } : undefined;
  }

  return isBinary(param.bytes)
    ? {
        bytes: Uint8Array.from(param.bytes, (char) => char.codePointAt(0) ?? 0),
        param: { bytes: param.bytes },
      }
    : undefined;
};

const isSafeTag = ([key, value]: readonly [string, string]) =>
  isSendableTag(key) && !value.includes("\0") && value.isWellFormed();

const separator = Uint8Array.of(space);
const trailing = Uint8Array.of(space, colon);

/**
 * The bytes of a Line's command and parameters, exactly as {@link encode} writes them,
 * with the colon only when the last parameter needs it.
 * @param line - The Line, read.
 * @returns The pieces, in order.
 */
const lineParts = (line: Pick<Snapshot, "command" | "params">) => {
  const parts: Uint8Array[] = [utf8.encode(line.command)];

  for (const [index, { bytes }] of line.params.entries()) {
    const isLast = index === line.params.length - 1;

    parts.push(isLast && needsTrailing(bytes) ? trailing : separator, bytes);
  }

  return parts;
};

const lengthOf = (parts: readonly Uint8Array[]) =>
  parts.reduce((total, part) => total + part.length, 0);

/**
 * Reads a Line once into plain data and checks every invariant on what it read: the
 * command, each parameter, which may hold a space or a colon, the limits, and the tags.
 * It never throws: a field that cannot be read is a parameter that cannot be sent.
 * @param line - The Line, however it was made.
 * @returns What was read, or why it cannot be sent.
 */
const snapshotOf = (line: Unchecked): Snapshot | Rejected => {
  try {
    const verb = readCommand(line.command);

    if (Result.isFailure(verb) || !command.test(verb.success)) {
      return rejected("InvalidCommand");
    }

    const values = readParams(line.params);

    if (Result.isFailure(values)) {
      return rejected("InvalidParameter");
    }

    if (values.success.length > 15) {
      return rejected("TooManyParameters");
    }

    const params = values.success.map(readParam);
    const read = params.flatMap((param) => (param === undefined ? [] : [param]));
    const middle = read.slice(0, -1);

    if (
      read.length !== params.length ||
      read.some(({ bytes }) => breaksLines(bytes)) ||
      middle.some(({ bytes }) => needsTrailing(bytes))
    ) {
      return rejected("InvalidParameter");
    }

    if (lengthOf(lineParts({ command: verb.success, params: read })) > maxLineBytes) {
      return rejected("TooLong");
    }

    const tagged = readTags(line.tags);
    const tags = Result.isFailure(tagged) ? [] : Object.entries(tagged.success);

    if (Result.isFailure(tagged) || !tags.every(isSafeTag)) {
      return rejected("InvalidTag");
    }

    return utf8.encode(tags.map(escapeTag).join(";")).length > maxTagBytes
      ? rejected("TagsTooLong")
      : { _tag: "Snapshot", command: verb.success, params: read, tags };
  } catch {
    // Only a getter that throws gets here, and what cannot be read cannot be sent.
    return rejected("InvalidParameter");
  }
};

const explanations: Readonly<Record<RejectedReason, string>> = {
  EmptyText: "a Message must say something",
  InvalidCommand: "a command must be upper-case letters, or three digits",
  InvalidParameter:
    "no parameter may hold NUL, CR, LF, or a lone surrogate, and only the last may be empty, hold a space, or start with a colon",
  InvalidTag:
    "a tag we send must be client-only, or label, batch, or draft/multiline-concat, and its value may not hold NUL or a lone surrogate",
  InvalidTarget: "a Target must name one thing",
  TagsTooLong: `tag data takes at most ${maxTagBytes} bytes`,
  TooLong: `a Line takes at most ${maxLineBytes} bytes`,
  TooManyParameters: "a Line has at most 15 parameters",
  Unparseable: "text must read as a Line with a command and no source",
};

/**
 * A Line that is safe to send: it cannot inject a second Line, it fits, and it parses
 * back the same. Get one from this module's builders, or by decoding a recorded one,
 * which checks it again. A parameter is text, sent as UTF-8, or a {@link RawParam},
 * sent as its bytes. The tags are ones a Feature added: client-only tags, or `label`,
 * `batch`, and `draft/multiline-concat`, and their values are escaped when encoded.
 * The last parameter is written as a trailing parameter when it must be. {@link encode}
 * checks it all again, so a value that only looks like one is never sent.
 */
export const OutboundLine = Schema.Struct({
  command: Schema.String,
  params: Schema.Array(Param),
  tags: Schema.Record(Schema.String, Schema.String),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (line) => {
        const snapshot = snapshotOf(line);

        return snapshot._tag === "Rejected" ? explanations[snapshot.reason] : true;
      },
      { expected: "a Line that is safe to send" }
    )
  ),
  Schema.brand("OutboundLine")
);

/** The decoded form of {@link OutboundLine}. */
export type OutboundLine = typeof OutboundLine.Type;

// What is kept is what was read and checked, as fresh plain data.
const checked = (line: Unchecked): OutboundLine | Rejected => {
  const snapshot = snapshotOf(line);

  return snapshot._tag === "Rejected"
    ? snapshot
    : OutboundLine.make(
        {
          command: snapshot.command,
          params: snapshot.params.map(({ param }) => param),
          tags: Object.fromEntries(snapshot.tags),
        },
        { disableChecks: true }
      );
};

/**
 * Builds a Line that is safe to send, or says why it cannot be. It never throws,
 * whatever it is given.
 * @param command - The command, such as `PRIVMSG`, which is upper-cased.
 * @param params - The parameters, as text or bytes, where only the last may be empty,
 * hold a space, or start with a colon.
 * @param tags - Tags to send, which must be client-only, or `label`, `batch`, or
 * `draft/multiline-concat`.
 * @returns The Line, or why it cannot be sent.
 */
export const outbound = (
  command: string,
  params: readonly Param[],
  tags: Readonly<Record<string, string>> = {}
): OutboundLine | Rejected =>
  checked({ command: isText(command) ? upperCaseAscii(command) : command, params, tags });

/**
 * Adds tags to a Line, as `labeled-response` adds `label`. A tag already there is
 * replaced.
 * @param line - The Line.
 * @param tags - The tags to add.
 * @returns The Line with them, or why it cannot be sent, such as tags too long.
 */
export const withTags = (
  line: OutboundLine,
  tags: Readonly<Record<string, string>>
): OutboundLine | Rejected => checked({ ...line, tags: { ...line.tags, ...tags } });

const lineEnding = Uint8Array.of(0x0d, 0x0a);

/**
 * Encodes a Line for the wire: tags escaped, text as UTF-8, bytes as they are, and the
 * last parameter written as a trailing parameter when it must be. This is the one guard
 * on what leaves: it reads the Line once, checks every invariant on what it read, and
 * writes from that, so however a value typed as an `OutboundLine` was made, no unsafe
 * byte is written. A `Rejected` here means code upstream built a Line it should not have.
 * @param line - The Line.
 * @returns Its bytes, with CRLF, or why it cannot be sent.
 */
export const encode = (line: OutboundLine): Uint8Array | Rejected => {
  const snapshot = snapshotOf(line);

  if (snapshot._tag === "Rejected") {
    return snapshot;
  }

  const parts = [
    ...(snapshot.tags.length > 0
      ? [utf8.encode(`@${snapshot.tags.map(escapeTag).join(";")} `)]
      : []),
    ...lineParts(snapshot),
    lineEnding,
  ];

  const encoded = new Uint8Array(lengthOf(parts));
  let offset = 0;

  for (const part of parts) {
    encoded.set(part, offset);
    offset += part.length;
  }

  return encoded;
};

// Builders

/**
 * Whether a parameter names one thing: a word with no comma, which would make it a list.
 * @param name - The parameter.
 * @returns Whether it does.
 */
const isOne = (name: string) => {
  const read = Result.isSuccess(readCommand(name)) ? readParam(name) : undefined;

  return (
    read !== undefined &&
    !breaksLines(read.bytes) &&
    !needsTrailing(read.bytes) &&
    !name.includes(",")
  );
};

const toOne = (name: string, build: () => OutboundLine | Rejected): OutboundLine | Rejected =>
  isOne(name) ? build() : rejected("InvalidTarget");

/**
 * Whether a name can be one Channel to join. `JOIN 0` leaves every Channel, so `0` is not.
 * @param name - The name.
 * @returns Whether it can.
 */
const isChannel = (name: string) => isOne(name) && name !== "0";

const said = (command: "NOTICE" | "PRIVMSG") => (target: string, text: string) =>
  toOne(target, () => (text === "" ? rejected("EmptyText") : outbound(command, [target, text])));

/**
 * `PRIVMSG` to one Target. A CTCP `ACTION` is a `PRIVMSG` whose text comes from
 * `ctcpText` in `@iirc/protocol/ctcp`.
 * @param target - A Channel or User, one only.
 * @param text - What to say, which may not be empty.
 * @returns The Line, or why it cannot be sent.
 */
export const privmsg: (target: string, text: string) => OutboundLine | Rejected = said("PRIVMSG");

/**
 * `NOTICE` to one Target, which nothing may answer automatically.
 * @param target - A Channel or User, one only.
 * @param text - What to say, which may not be empty.
 * @returns The Line, or why it cannot be sent.
 */
export const notice: (target: string, text: string) => OutboundLine | Rejected = said("NOTICE");

/**
 * `TAGMSG` to one Target, which carries only tags, as for a reaction or typing.
 * @param target - A Channel or User, one only.
 * @param tags - The client-only tags to send.
 * @returns The Line, or why it cannot be sent.
 */
export const tagmsg = (
  target: string,
  tags: Readonly<Record<string, string>>
): OutboundLine | Rejected => toOne(target, () => outbound("TAGMSG", [target], tags));

/**
 * `JOIN` of Channels with no key. A Channel with a key goes through the
 * `JoinWithKey` {@link SecretLine}, and which Channels share a Line is the caller's
 * choice.
 * @param channels - The Channels, one or more. `0` is refused, because it leaves them all.
 * @returns The Line, or why it cannot be sent, such as too many Channels to fit.
 */
export const join = (channels: readonly string[]): OutboundLine | Rejected =>
  channels.length > 0 && channels.every(isChannel)
    ? outbound("JOIN", [channels.join(",")])
    : rejected("InvalidTarget");

/**
 * `PART` from one Channel.
 * @param channel - The Channel.
 * @param reason - What to say on the way out, if anything.
 * @returns The Line, or why it cannot be sent.
 */
export const part = (channel: string, reason?: string): OutboundLine | Rejected =>
  toOne(channel, () => outbound("PART", reason === undefined ? [channel] : [channel, reason]));

/**
 * `QUIT`.
 * @param reason - What to say on the way out, if anything.
 * @returns The Line, or why it cannot be sent.
 */
export const quit = (reason?: string): OutboundLine | Rejected =>
  outbound("QUIT", reason === undefined ? [] : [reason]);

// Anywhere in a nick, these mean something else: a comma ends it, `!` and `@` split a
// source, and `*` and `?` are masks. An Ircd refuses more, with `432`.
const notInNicks = /[,*?!@]/u;

/**
 * `NICK`.
 * @param name - The nick to ask for. It may not hold `,`, `*`, `?`, `!`, or `@`, and the
 * Ircd decides the rest.
 * @returns The Line, or why it cannot be sent.
 */
export const nick = (name: string): OutboundLine | Rejected =>
  isOne(name) && !notInNicks.test(name) ? outbound("NICK", [name]) : rejected("InvalidTarget");

/**
 * `USER`, in RFC 2812's form, with mode 0.
 * @param username - The username, a single word.
 * @param realname - The realname, which may hold spaces.
 * @returns The Line, or why it cannot be sent.
 */
export const user = (username: string, realname: string): OutboundLine | Rejected =>
  outbound("USER", [username, "0", "*", realname]);

/** The `CAP` subcommands a client sends. */
export type CapSubcommand = "END" | "LIST" | "LS" | "REQ";

/**
 * `CAP`, such as `CAP LS 302`, `CAP REQ :sasl multi-prefix`, or `CAP END`.
 * @param subcommand - What to ask.
 * @param argument - The version for `LS`, or the space-separated caps for `REQ`.
 * @returns The Line, or why it cannot be sent, such as a `REQ` too long to fit.
 */
export const cap = (subcommand: CapSubcommand, argument?: string): OutboundLine | Rejected =>
  outbound("CAP", argument === undefined ? [subcommand] : [subcommand, argument]);

/**
 * `AUTHENTICATE` with a mechanism, `*` to abort, or `+` for an empty response. A response
 * that carries a Credential comes only from {@link fillSecret}.
 * @param argument - The mechanism, `*`, or `+`.
 * @returns The Line, or why it cannot be sent.
 */
export const authenticate = (argument: string): OutboundLine | Rejected =>
  toOne(argument, () => outbound("AUTHENTICATE", [argument]));

/**
 * `PING`, which the Ircd answers with a `PONG` holding the same token.
 * @param token - Any text.
 * @returns The Line, or why it cannot be sent.
 */
export const ping = (token: string): OutboundLine | Rejected => outbound("PING", [token]);

/**
 * `PONG`, the answer to a `PING`. Give it the token from {@link rawParams}, so it echoes
 * a token that is not UTF-8 exactly, as an Ircd that compares bytes expects. Bytes are
 * read into a {@link RawParam} at once, so changing them later changes nothing.
 * @param token - The `PING`'s token: its raw parameter, its bytes, or its text.
 * @returns The Line, or why it cannot be sent.
 */
export const pong = (token: string | RawParam | Uint8Array): OutboundLine | Rejected =>
  outbound("PONG", [token instanceof Uint8Array ? { bytes: binaryString(token) } : token]);

/**
 * `NAMES` of one Channel.
 * @param channel - The Channel.
 * @returns The Line, or why it cannot be sent.
 */
export const names = (channel: string): OutboundLine | Rejected =>
  toOne(channel, () => outbound("NAMES", [channel]));

/**
 * Whether a parameter is one word: not empty, with no space, and not starting with a
 * colon, so it reads as one parameter wherever it stands.
 * @param word - The parameter.
 * @returns Whether it is.
 */
const isWord = (word: string) => {
  const read = Result.isSuccess(readCommand(word)) ? readParam(word) : undefined;

  return read !== undefined && !breaksLines(read.bytes) && !needsTrailing(read.bytes);
};

/**
 * `MODE` of one Target, to read its modes, or with arguments to change them.
 * @param target - A Channel, or Self.
 * @param args - The mode string and its parameters, if any, each one word.
 * @returns The Line, or why it cannot be sent.
 */
export const mode = (target: string, args: readonly string[] = []): OutboundLine | Rejected =>
  toOne(target, () =>
    args.every(isWord) ? outbound("MODE", [target, ...args]) : rejected("InvalidParameter")
  );

/**
 * `TOPIC` of one Channel, to set it. An empty topic clears it, and is sent as an empty
 * trailing parameter, since `TOPIC` with no topic asks for it instead.
 * @param channel - The Channel.
 * @param text - The topic, or `""` to clear it.
 * @returns The Line, or why it cannot be sent.
 */
export const topic = (channel: string, text: string): OutboundLine | Rejected =>
  toOne(channel, () => outbound("TOPIC", [channel, text]));

/**
 * `KICK` of one or more nicks from one Channel, as one list. How many nicks share a Line,
 * by `TARGMAX`, is the caller's to choose.
 * @param channel - The Channel.
 * @param nicks - The nicks, one or more.
 * @param reason - Why, if anything.
 * @returns The Line, or why it cannot be sent.
 */
export const kick = (
  channel: string,
  nicks: readonly string[],
  reason?: string
): OutboundLine | Rejected =>
  toOne(channel, () =>
    nicks.length > 0 && nicks.every((one) => isOne(one) && !notInNicks.test(one))
      ? outbound(
          "KICK",
          reason === undefined || reason === ""
            ? [channel, nicks.join(",")]
            : [channel, nicks.join(","), reason]
        )
      : rejected("InvalidTarget")
  );

/**
 * `INVITE` of one nick to one Channel.
 * @param name - The nick.
 * @param channel - The Channel.
 * @returns The Line, or why it cannot be sent.
 */
export const invite = (name: string, channel: string): OutboundLine | Rejected =>
  isOne(name) && !notInNicks.test(name)
    ? toOne(channel, () => outbound("INVITE", [name, channel]))
    : rejected("InvalidTarget");

/**
 * A Line written as text, as `/quote` takes it, read by {@link parse} and built again
 * with {@link outbound}, so it is sent as it reads: its tags, command, and parameters. A
 * source is refused, since only an Ircd gives one, and so is text with a CR, LF, or NUL,
 * which would end the Line there.
 * @param text - The Line, without its line ending.
 * @returns The Line, or why it cannot be sent.
 */
export const quote = (text: string): OutboundLine | Rejected => {
  if (!isText(text) || !text.isWellFormed() || /[\0\r\n]/u.test(text)) {
    return rejected("InvalidParameter");
  }

  const parsed = parse(utf8.encode(text), { _tag: "Utf8Only" });

  if (parsed._tag === "Unparseable" || parsed.line.source !== undefined) {
    return rejected("Unparseable");
  }

  const { line } = parsed;

  return outbound(line.command, line.params, Object.fromEntries(line.tags));
};

/**
 * `WHO` of a mask or a Channel.
 * @param mask - What to look up, one word.
 * @param fields - WHOX fields such as `%tcnuhra,1`, where the Ircd offers WHOX.
 * @returns The Line, or why it cannot be sent.
 */
export const who = (mask: string, fields?: string): OutboundLine | Rejected =>
  toOne(mask, () => outbound("WHO", fields === undefined ? [mask] : [mask, fields]));

/**
 * `AWAY`, with a reason to be away, or none to come back.
 * @param reason - Why, or `undefined` to come back.
 * @returns The Line, or why it cannot be sent.
 */
export const away = (reason?: string): OutboundLine | Rejected =>
  outbound("AWAY", reason === undefined || reason === "" ? [] : [reason]);

// Credentials

/**
 * The name of a Credential. The value is held by the Vault and never by a Line. Its
 * identifier marks every field it types as a Credential, so a Frontend that walks a
 * Schema shows such a field by name, and never asks for its value back.
 */
export const CredentialName = Schema.String.annotate({ identifier: "CredentialName" }).pipe(
  Schema.brand("CredentialName")
);

/** The decoded form of {@link CredentialName}. */
export type CredentialName = typeof CredentialName.Type;

/**
 * A Line that carries a Credential, written with the Credential's name in place of its
 * value. It is a closed list, so this module knows every place a Credential can go,
 * and is the only code that fills one in.
 *
 * SASL `SCRAM-SHA-256` would land here. Its replies depend on the Ircd's challenge, a
 * nonce, and keys derived from the Credential, so it needs either cases that take the
 * challenge or an exchange run on the Runtime's side. SASL `EXTERNAL` needs no case
 * here: its Credential is a client certificate, which `Dial` would name.
 */
export const SecretLine = Schema.TaggedUnion({
  /** The SASL PLAIN response, which may be split over several `AUTHENTICATE` Lines. */
  AuthenticatePlain: {
    authcid: Schema.String,
    authzid: Schema.String,
    credential: CredentialName,
  },
  /** `JOIN` with a Channel key. */
  JoinWithKey: { channel: Schema.String, credential: CredentialName },
  /** `PASS`, before registration. */
  Pass: { credential: CredentialName },
});

/** The decoded form of {@link SecretLine}. */
export type SecretLine = typeof SecretLine.Type;

/** The most bytes of SASL payload in one `AUTHENTICATE`. */
export const maxAuthenticateBytes = 400;

const chunks = (payload: string) =>
  Array.from({ length: Math.floor(payload.length / maxAuthenticateBytes) + 1 }, (_unused, index) =>
    payload.slice(index * maxAuthenticateBytes, (index + 1) * maxAuthenticateBytes)
  );

// The PLAIN response is `authzid NUL authcid NUL password`, so none may hold a NUL.
const plain = (
  { authcid, authzid }: { readonly authcid: string; readonly authzid: string },
  value: string
): readonly OutboundLine[] | Rejected => {
  const parts = [authzid, authcid, value];

  if (parts.some((part) => part.includes("\0") || !part.isWellFormed())) {
    return rejected("InvalidParameter");
  }

  // A payload that fills its last chunk exactly is ended by `+`, which is also the
  // whole of an empty one, so the last chunk is always short.
  const lines = chunks(Base64.encode(utf8.encode(parts.join("\0")))).map((chunk) =>
    outbound("AUTHENTICATE", [chunk === "" ? "+" : chunk])
  );

  const sendable = lines.flatMap((line) => (isRejected(line) ? [] : [line]));

  return sendable.length === lines.length ? sendable : rejected("TooLong");
};

/**
 * Fills a Credential's value into the Line that carries it. This is the only code that
 * puts a Credential into a Line. Its result is sent and never journaled. The SASL PLAIN
 * response is split into `AUTHENTICATE` Lines of {@link maxAuthenticateBytes} bytes of
 * payload, and ended by `AUTHENTICATE +` when the last is full.
 * @param line - Where the Credential goes, by name.
 * @param value - The Credential, from the Vault.
 * @returns The Lines to send, in order, or why they cannot be sent, such as a value
 * holding a line break or a NUL.
 */
export const fillSecret = (
  line: SecretLine,
  value: Redacted.Redacted
): readonly OutboundLine[] | Rejected => {
  const revealed = Redacted.value(value);

  switch (line._tag) {
    case "AuthenticatePlain": {
      return plain(line, revealed);
    }

    case "JoinWithKey": {
      if (!isChannel(line.channel) || !isOne(revealed)) {
        return rejected(isChannel(line.channel) ? "InvalidParameter" : "InvalidTarget");
      }

      const join = outbound("JOIN", [line.channel, revealed]);

      return isRejected(join) ? join : [join];
    }

    case "Pass": {
      const pass = outbound("PASS", [revealed]);

      return isRejected(pass) ? pass : [pass];
    }

    default: {
      return line satisfies never;
    }
  }
};
