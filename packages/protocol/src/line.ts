import { Schema } from "effect";

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
 * How an Ircd's bytes become text. `Utf8Only` is what `UTF8ONLY` promises. Otherwise
 * bytes that are not UTF-8 are read in a fallback encoding, named by its WHATWG label.
 */
export const Encoding = Schema.TaggedUnion({
  Utf8Only: {},
  Utf8OrElse: { fallback: Schema.String },
});

/** The decoded form of {@link Encoding}. */
export type Encoding = typeof Encoding.Type;

/** The most bytes a Line may take, without its tags and line ending. */
export const maxLineBytes = 510;

/** The most bytes client-only tags may take, with the leading `@` and the space after. */
export const maxTagBytes = 4094;

const utf8 = new TextEncoder();
const command = /^(?:[A-Za-z]+|\d{3})$/u;
const clientTag = /^\+(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9-]+$/u;
const lineBreaking = /[\0\r\n]/u;
const tagEscapes = /[; \\\r\n]/gu;

const isMiddle = (param: string) => param !== "" && !param.includes(" ") && !param.startsWith(":");

const lineBytes = (line: { readonly command: string; readonly params: readonly string[] }) =>
  utf8.encode([line.command, ...line.params].join(" ")).length + (line.params.length > 0 ? 1 : 0);

const tagBytes = (tags: Readonly<Record<string, string>>) => {
  const entries = Object.entries(tags);

  if (entries.length === 0) {
    return 0;
  }

  const text = entries
    .map(([key, value]) => (value === "" ? key : `${key}=${value.replaceAll(tagEscapes, "\\_")}`))
    .join(";");

  return utf8.encode(text).length + 2;
};

/**
 * Says why a Line cannot be sent safely, or `true` if it can.
 * @param line - The Line to check.
 * @returns The first problem found, or `true`.
 */
const unsafe = (line: {
  readonly command: string;
  readonly params: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
}) => {
  const middle = line.params.slice(0, -1);
  const tags = Object.entries(line.tags);

  if (!command.test(line.command)) {
    return "a command must be letters, or three digits";
  }

  if (line.params.length > 15) {
    return "a Line has at most 15 parameters";
  }

  if (line.params.some((param) => lineBreaking.test(param))) {
    return "no parameter may hold NUL, CR, or LF";
  }

  if (!middle.every(isMiddle)) {
    return "only the last parameter may be empty, hold a space, or start with a colon";
  }

  if (lineBytes(line) > maxLineBytes) {
    return `a Line takes at most ${maxLineBytes} bytes`;
  }

  if (!tags.every(([key, value]) => clientTag.test(key) && !value.includes("\0"))) {
    return "a tag we send must be a client-only tag, and its value may not hold NUL";
  }

  if (tagBytes(line.tags) > maxTagBytes) {
    return `tags take at most ${maxTagBytes} bytes`;
  }

  return true;
};

/**
 * A Line that is safe to send: it cannot inject a second Line, and it fits. The only
 * way to get one is from this module's builders, or by decoding a recorded one, which
 * checks it again. The tags are client-only tags that a Feature added. The last
 * parameter is written as a trailing parameter when it needs to be.
 */
export const OutboundLine = Schema.Struct({
  command: Schema.String,
  params: Schema.Array(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
}).pipe(
  Schema.check(Schema.makeFilter(unsafe, { expected: "a Line that is safe to send" })),
  Schema.brand("OutboundLine")
);

/** The decoded form of {@link OutboundLine}. */
export type OutboundLine = typeof OutboundLine.Type;

/** The name of a Credential. The value is held by the Vault and never by a Line. */
export const CredentialName = Schema.String.pipe(Schema.brand("CredentialName"));

/** The decoded form of {@link CredentialName}. */
export type CredentialName = typeof CredentialName.Type;

/**
 * A Line that carries a Credential, written with the Credential's name in place of its
 * value. It is a closed list, so this module knows every place a Credential can go,
 * and is the only code that fills one in.
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
