/**
 * SASL `SCRAM-SHA-256` (RFC 5802 and RFC 7677, with no channel binding), as the Runtime's
 * exchange for a Connection works it out: the client-first message with a nonce from
 * Effect's `Random`, the client-final message with the proof derived from the Credential,
 * and the check of the Ircd's server-final message. What one round leaves for the next is
 * an {@link Exchange}, which the Runtime holds with the Connection and never journals or
 * logs. The hashing runs on WebCrypto through Effect's crypto modules, which is arithmetic,
 * not the world.
 *
 * @packageDocumentation
 */
import { authenticateResponse, isRejected } from "@iirc/protocol/line";
import type { OutboundLine } from "@iirc/protocol/line";
import { Effect, Layer, Random, Redacted } from "effect";
import { Digest, Kdf, Mac, SecureRandom } from "effect/crypto";
import { Base64 } from "effect/encoding";

/**
 * The most PBKDF2 iterations a server-first message may ask for: OWASP's recommendation
 * for PBKDF2-HMAC-SHA256, so a well-run Network is under it, and an Ircd that asks for
 * more is refused before anything is derived, rather than making the Daemon spin.
 */
export const maxIterations = 600_000;

/** The bytes of a nonce, whose base64 is 20 characters, as RFC 7677's is. */
const nonceBytes = 15;

/** What one round of the exchange leaves for the next. Never journaled or logged. */
export type Exchange =
  /** The client-first message is sent: its bare part, and the nonce in it. */
  | { readonly _tag: "First"; readonly bare: string; readonly nonce: string }
  /** The client-final message is sent: the server signature the Ircd must prove. */
  | { readonly _tag: "Final"; readonly serverSignature: Uint8Array };

/**
 * A round's answer: the Lines to send and what the next round needs, or why there is none.
 * `Unsendable` is the Owner's own value or account that cannot go in the message, and
 * `Unanswerable` the Ircd's challenge.
 */
export type Answer<E extends Exchange> =
  | {
      readonly _tag: "Answered";
      readonly exchange: E;
      readonly lines: readonly OutboundLine[];
    }
  | { readonly _tag: "Unanswerable" }
  | { readonly _tag: "Unsendable" };

const unanswerable = { _tag: "Unanswerable" } as const;
const unsendable = { _tag: "Unsendable" } as const;

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const crypto = Layer.mergeAll(
  Kdf.layerWebCrypto,
  Digest.layerWebCrypto,
  Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
);

// The text of a base64 message from the Ircd, or nothing if it is not base64 of UTF-8.
const fromBase64 = (text: string): string | undefined => {
  const bytes = Base64.decode(text);

  if (bytes._tag === "Failure") {
    return undefined;
  }

  try {
    return strictUtf8.decode(bytes.success);
  } catch {
    return undefined;
  }
};

const answered = <E extends Exchange>(exchange: E, message: string): Answer<E> => {
  const lines = authenticateResponse(utf8.encode(message));

  return isRejected(lines) ? unsendable : { _tag: "Answered", exchange, lines };
};

// A username in a SCRAM message, with `=` and `,` escaped, as RFC 5802 says.
const saslname = (name: string): string => name.replaceAll("=", "=3D").replaceAll(",", "=2C");

// The code points RFC 4013 maps to a space (table C.1.2), and those it maps to nothing
// (table B.1).
const nonAsciiSpaces: ReadonlySet<number> = new Set([
  0xa0, 0x16_80, 0x20_00, 0x20_01, 0x20_02, 0x20_03, 0x20_04, 0x20_05, 0x20_06, 0x20_07, 0x20_08,
  0x20_09, 0x20_0a, 0x20_0b, 0x20_2f, 0x20_5f, 0x30_00,
]);

const mappedToNothing: ReadonlySet<number> = new Set([
  0xad, 0x03_4f, 0x18_06, 0x18_0b, 0x18_0c, 0x18_0d, 0x20_0b, 0x20_0c, 0x20_0d, 0x20_60, 0xfe_00,
  0xfe_01, 0xfe_02, 0xfe_03, 0xfe_04, 0xfe_05, 0xfe_06, 0xfe_07, 0xfe_08, 0xfe_09, 0xfe_0a, 0xfe_0b,
  0xfe_0c, 0xfe_0d, 0xfe_0e, 0xfe_0f, 0xfe_ff,
]);

// The control characters RFC 4013 prohibits (tables C.2.1 and C.2.2, in part).
const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);

const mapped = (char: string): string => {
  const code = char.codePointAt(0) ?? 0;

  if (mappedToNothing.has(code)) {
    return "";
  }

  return nonAsciiSpaces.has(code) ? " " : char;
};

/**
 * A password as SASLprep (RFC 4013) gives it: characters mapped to a space or to nothing as
 * it says, then NFKC.
 * @param password - The password as the Owner gave it.
 * @returns The prepared password, or nothing when it holds a control character, which
 * SASLprep prohibits, or is not well-formed.
 */
const saslprep = (password: string): string | undefined => {
  if (!password.isWellFormed()) {
    return undefined;
  }

  const prepared = Array.from(password, mapped).join("").normalize("NFKC");

  return Array.from(prepared, (char) => char.codePointAt(0) ?? 0).some(isControl)
    ? undefined
    : prepared;
};

/**
 * The client-first message for an account, with a fresh nonce.
 * @param authcid - The account.
 * @returns Its Lines and the exchange, or `Unsendable` for an account that cannot be named.
 */
export const clientFirst = (authcid: string): Effect.Effect<Answer<Exchange & { _tag: "First" }>> =>
  Effect.gen(function* () {
    if (authcid === "" || authcid.includes("\0") || !authcid.isWellFormed()) {
      return unsendable;
    }

    const bytes = yield* Effect.all(
      Array.from({ length: nonceBytes }, () => Random.nextIntBetween(0, 255))
    );

    const nonce = Base64.encode(Uint8Array.from(bytes));
    const bare = `n=${saslname(authcid)},r=${nonce}`;

    return answered({ _tag: "First", bare, nonce }, `n,,${bare}`);
  });

/** A server-first message, parsed. */
interface ServerFirst {
  readonly nonce: string;
  readonly salt: Uint8Array;
  readonly iterations: number;
}

const iterationCount = /^[1-9]\d{0,9}$/u;
const printable = /^[!-+--~]+$/u;

// `r=…,s=…,i=…`, in that order, perhaps with extensions after, which RFC 5802 lets a
// client ignore. A mandatory extension, `m=`, comes first, and is one this client lacks.
const parseServerFirst = (message: string): ServerFirst | undefined => {
  const [nonce, salt, iterations] = message.split(",");

  if (
    nonce?.startsWith("r=") !== true ||
    salt?.startsWith("s=") !== true ||
    iterations?.startsWith("i=") !== true
  ) {
    return undefined;
  }

  const count = iterations.slice(2);
  const saltBytes = Base64.decode(salt.slice(2));

  if (
    !printable.test(nonce.slice(2)) ||
    !iterationCount.test(count) ||
    saltBytes._tag === "Failure" ||
    saltBytes.success.length === 0
  ) {
    return undefined;
  }

  return { iterations: Number(count), nonce: nonce.slice(2), salt: saltBytes.success };
};

// The proof is the client key XOR the client signature, as RFC 5802 defines it.
const xor = (left: Uint8Array, right: Uint8Array): Uint8Array =>
  // oxlint-disable-next-line eslint/no-bitwise -- SCRAM's proof is defined as an XOR of bytes.
  left.map((byte, index) => byte ^ (right[index] ?? 0));

const hmac = (key: Uint8Array, data: string) =>
  Effect.gen(function* () {
    const mac = yield* Mac.Mac;

    return yield* mac.sign(yield* Mac.key(Mac.hmacSha256, key), utf8.encode(data));
  });

/**
 * The client-final message, answering the Ircd's server-first message with the proof that
 * Self holds the password. The iteration count is checked before anything is derived.
 * @param exchange - What the client-first message left.
 * @param password - The Credential.
 * @param serverFirst - The server-first message, in base64 as it came.
 * @returns Its Lines and the server signature to check, or why there are none.
 */
export const clientFinal = (
  exchange: Exchange & { _tag: "First" },
  password: Redacted.Redacted,
  serverFirst: string
): Effect.Effect<Answer<Exchange & { _tag: "Final" }>> =>
  Effect.gen(function* () {
    const message = fromBase64(serverFirst);
    const parsed = message === undefined ? undefined : parseServerFirst(message);

    // The Ircd's nonce must extend ours, or this answers a challenge made for someone else.
    if (
      message === undefined ||
      parsed === undefined ||
      parsed.nonce.length <= exchange.nonce.length ||
      !parsed.nonce.startsWith(exchange.nonce) ||
      parsed.iterations > maxIterations
    ) {
      return unanswerable;
    }

    const prepared = saslprep(Redacted.value(password));

    if (prepared === undefined) {
      return unsendable;
    }

    const kdf = yield* Kdf.Kdf;
    const digest = yield* Digest.Digest;

    const salted = yield* kdf.derive(
      Kdf.pbkdf2({ hash: Digest.sha256, iterations: parsed.iterations }),
      utf8.encode(prepared),
      { length: 32, salt: parsed.salt }
    );

    const withoutProof = `c=biws,r=${parsed.nonce}`;
    const authMessage = `${exchange.bare},${message},${withoutProof}`;
    const clientKey = yield* hmac(salted, "Client Key");
    const storedKey = yield* digest.digest(Digest.sha256, clientKey);
    const clientSignature = yield* hmac(storedKey, authMessage);
    const serverKey = yield* hmac(salted, "Server Key");
    const serverSignature = yield* hmac(serverKey, authMessage);
    const proof = Base64.encode(xor(clientKey, clientSignature));

    return answered({ _tag: "Final", serverSignature }, `${withoutProof},p=${proof}`);
  }).pipe(
    Effect.provide(crypto),
    Effect.catchTag("CryptoError", () => Effect.succeed(unsendable))
  );

/**
 * Whether the Ircd's server-final message proves it held the password's keys: its
 * signature is the one the exchange worked out, compared in constant time. An error, a
 * message that does not parse, or no exchange past the client-final message is not.
 * @param exchange - What the client-final message left, if anything.
 * @param serverFinal - The server-final message, in base64 as it came.
 * @returns Whether it is verified.
 */
export const verify = (exchange: Exchange | undefined, serverFinal: string): boolean => {
  const message = fromBase64(serverFinal);
  const [verifier] = message?.split(",") ?? [];

  if (exchange?._tag !== "Final" || verifier?.startsWith("v=") !== true) {
    return false;
  }

  const signature = Base64.decode(verifier.slice(2));

  return (
    signature._tag === "Success" && Mac.timingSafeEqual(signature.success, exchange.serverSignature)
  );
};
