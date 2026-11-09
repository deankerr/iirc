import { Redacted, Schema } from "effect";
import { Base64 } from "effect/encoding";

import { fallbackDecoder, utf8Lossy, utf8OrElse } from "./decode.ts";

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
 * A WHATWG encoding label that this runtime can read with, such as `latin1` or
 * `Shift_JIS`. UTF-16, `x-user-defined`, and `replacement` are refused, because none of
 * them reads a Line's spaces and colons as themselves.
 */
export const FallbackEncoding = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((label: string) => fallbackDecoder(label) !== undefined, {
      expected: "a WHATWG encoding label this runtime can read with",
    })
  )
);

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

/** The most bytes client-only tags may take, with the leading `@` and the space after. */
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
  const end = lineEnd(bytes);
  const text = decoderFor(encoding);
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

  const tags = hasTags ? parseTags(utf8Lossy(wordAt(bytes, first + 1, end))) : new Map();
  const source = hasSource ? text(wordAt(bytes, sourceStart + 1, end)) : undefined;
  const command = upperCaseAscii(text(wordAt(bytes, commandStart, end)));
  const params: string[] = [];

  for (const start of words.slice(commandAt + 1)) {
    if (bytes[start] === colon) {
      params.push(text(bytes.subarray(start + 1, end)));
      break;
    }

    params.push(text(wordAt(bytes, start, end)));
  }

  return {
    _tag: "Line",
    line: { command, params, source: source === "" ? undefined : source, tags },
  };
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
const lineBreaking = /[\0\r\n]/u;
const escapedInTags = /[; \\\r\n]/gu;

const tagEscape: ReadonlyMap<string, string> = new Map([
  ["\n", "\\n"],
  ["\r", "\\r"],
  [" ", "\\s"],
  [";", "\\:"],
  ["\\", "\\\\"],
]);

const isMiddle = (param: string) => param !== "" && !param.includes(" ") && !param.startsWith(":");

/**
 * Whether a text survives being encoded as UTF-8: it has no lone surrogate.
 * @param text - The text.
 * @returns Whether it does.
 */
const isWellFormed = (text: string) => text.isWellFormed();

const lineBytes = (line: { readonly command: string; readonly params: readonly string[] }) =>
  utf8.encode([line.command, ...line.params].join(" ")).length + (line.params.length > 0 ? 1 : 0);

const tagText = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags)
    .map(([key, value]) =>
      value === ""
        ? key
        : `${key}=${value.replaceAll(escapedInTags, (char) => tagEscape.get(char) ?? char)}`
    )
    .join(";");

const tagBytes = (tags: Readonly<Record<string, string>>) =>
  Object.keys(tags).length === 0 ? 0 : utf8.encode(tagText(tags)).length + 2;

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
  /** Tags over {@link maxTagBytes} bytes. */
  | "TagsTooLong"
  /** A Target, Channel, or nick that would name something else, such as a list. */
  | "InvalidTarget"
  /** A Message with nothing in it, which an Ircd refuses. */
  | "EmptyText";

/** A Line that cannot be sent safely, and why. */
export interface Rejected {
  readonly _tag: "Rejected";
  readonly reason: RejectedReason;
}

const rejected = (reason: RejectedReason): Rejected => ({ _tag: "Rejected", reason });

/**
 * Whether a builder's result is {@link Rejected}.
 * @param result - What a builder or {@link fillSecret} returned.
 * @returns Whether it is a rejection.
 */
export const isRejected = (
  result: OutboundLine | readonly OutboundLine[] | Rejected
): result is Rejected => "_tag" in result && result._tag === "Rejected";

interface Unchecked {
  readonly command: string;
  readonly params: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
}

const isSafeParam = (param: string) => !lineBreaking.test(param) && isWellFormed(param);

const isSafeTag = ([key, value]: readonly [string, string]) =>
  isSendableTag(key) && !value.includes("\0") && isWellFormed(value);

/**
 * Says why a Line cannot be sent safely, or `undefined` if it can.
 * @param line - The Line to check.
 * @returns The first problem found, or `undefined`.
 */
const problem = (line: Unchecked): RejectedReason | undefined => {
  if (!command.test(line.command)) {
    return "InvalidCommand";
  }

  if (line.params.length > 15) {
    return "TooManyParameters";
  }

  if (!line.params.every(isSafeParam) || !line.params.slice(0, -1).every(isMiddle)) {
    return "InvalidParameter";
  }

  if (lineBytes(line) > maxLineBytes) {
    return "TooLong";
  }

  if (!Object.entries(line.tags).every(isSafeTag)) {
    return "InvalidTag";
  }

  return tagBytes(line.tags) > maxTagBytes ? "TagsTooLong" : undefined;
};

const explanations: Readonly<Record<RejectedReason, string>> = {
  EmptyText: "a Message must say something",
  InvalidCommand: "a command must be upper-case letters, or three digits",
  InvalidParameter:
    "no parameter may hold NUL, CR, LF, or a lone surrogate, and only the last may be empty, hold a space, or start with a colon",
  InvalidTag:
    "a tag we send must be client-only, or label, batch, or draft/multiline-concat, and its value may not hold NUL or a lone surrogate",
  InvalidTarget: "a Target must name one thing",
  TagsTooLong: `tags take at most ${maxTagBytes} bytes`,
  TooLong: `a Line takes at most ${maxLineBytes} bytes`,
  TooManyParameters: "a Line has at most 15 parameters",
};

/**
 * A Line that is safe to send: it cannot inject a second Line, it fits, and it encodes
 * to UTF-8 and parses back the same. The only way to get one is from this module's
 * builders, or by decoding a recorded one, which checks it again. The tags are ones a
 * Feature added: client-only tags, or `label`, `batch`, and `draft/multiline-concat`.
 * The last parameter is written as a trailing parameter when it needs to be.
 */
export const OutboundLine = Schema.Struct({
  command: Schema.String,
  params: Schema.Array(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (line) => {
        const reason = problem(line);

        return reason === undefined ? true : explanations[reason];
      },
      { expected: "a Line that is safe to send" }
    )
  ),
  Schema.brand("OutboundLine")
);

/** The decoded form of {@link OutboundLine}. */
export type OutboundLine = typeof OutboundLine.Type;

const checked = (line: Unchecked): OutboundLine | Rejected => {
  const reason = problem(line);

  return reason === undefined
    ? OutboundLine.make(
        { command: line.command, params: [...line.params], tags: { ...line.tags } },
        { disableChecks: true }
      )
    : rejected(reason);
};

/**
 * Builds a Line that is safe to send, or says why it cannot be.
 * @param command - The command, such as `PRIVMSG`, which is upper-cased.
 * @param params - The parameters, where only the last may be empty, hold a space, or
 * start with a colon.
 * @param tags - Tags to send, which must be client-only, or `label`, `batch`, or
 * `draft/multiline-concat`.
 * @returns The Line, or why it cannot be sent.
 */
export const outbound = (
  command: string,
  params: readonly string[],
  tags: Readonly<Record<string, string>> = {}
): OutboundLine | Rejected => checked({ command: upperCaseAscii(command), params, tags });

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

const needsTrailing = (param: string) => !isMiddle(param);

/**
 * The text of a Line, without its line ending: tags escaped, and the last parameter
 * written as a trailing parameter when it must be.
 * @param line - The Line.
 * @returns Its text.
 */
const lineText = (line: OutboundLine) => {
  const tags = Object.keys(line.tags).length === 0 ? "" : `@${tagText(line.tags)} `;
  const last = line.params.at(-1);

  const params =
    last === undefined
      ? []
      : [...line.params.slice(0, -1), needsTrailing(last) ? `:${last}` : last];

  return `${tags}${[line.command, ...params].join(" ")}`;
};

/**
 * Encodes a Line for the wire, as UTF-8.
 * @param line - The Line.
 * @returns Its bytes, with CRLF.
 */
export const encode = (line: OutboundLine): Uint8Array => utf8.encode(`${lineText(line)}\r\n`);

// Builders

/**
 * Whether a parameter names one thing: a word with no comma, which would make it a list.
 * @param name - The parameter.
 * @returns Whether it does.
 */
const isOne = (name: string) => isMiddle(name) && !name.includes(",") && isSafeParam(name);

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
 * `PONG`, the answer to a `PING`.
 * @param token - The `PING`'s token, as it was parsed.
 * @returns The Line, or why it cannot be sent.
 */
export const pong = (token: string): OutboundLine | Rejected => outbound("PONG", [token]);

/**
 * `NAMES` of one Channel.
 * @param channel - The Channel.
 * @returns The Line, or why it cannot be sent.
 */
export const names = (channel: string): OutboundLine | Rejected =>
  toOne(channel, () => outbound("NAMES", [channel]));

/**
 * `MODE` of one Target, to read its modes, or with arguments to change them.
 * @param target - A Channel, or Self.
 * @param args - The mode string and its parameters, if any.
 * @returns The Line, or why it cannot be sent.
 */
export const mode = (target: string, args: readonly string[] = []): OutboundLine | Rejected =>
  toOne(target, () => outbound("MODE", [target, ...args]));

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

/** The name of a Credential. The value is held by the Vault and never by a Line. */
export const CredentialName = Schema.String.pipe(Schema.brand("CredentialName"));

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

  if (parts.some((part) => part.includes("\0") || !isWellFormed(part))) {
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
