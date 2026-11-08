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

/**
 * A Line that is safe to send: it cannot inject a second Line, and it fits. The only
 * way to get one is from this module's builders, or by decoding a recorded one, which
 * checks it again. The tags are client-only tags that a Feature added.
 */
export const OutboundLine = Schema.Struct({
  command: Schema.String,
  params: Schema.Array(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
}).pipe(Schema.brand("OutboundLine"));

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
