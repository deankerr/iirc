/**
 * Random bearer tokens, API keys and sign-ins alike: 256 random bits, given out
 * once, and kept only as their SHA-256, which a presented token is compared against in
 * constant time.
 *
 * @packageDocumentation
 */
// `node:crypto` for `timingSafeEqual`, which `effect/crypto` does not offer.
import { timingSafeEqual } from "node:crypto";

import { Effect, Option, Redacted, Schema } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

/** A SHA-256 as 64 lower-case hex digits, as the Daemon's files store a token. */
export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const encoder = new TextEncoder();

const sha256Of = (token: string) =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;

    return yield* digest.digest(Digest.sha256, encoder.encode(token));
  });

/**
 * Makes a token: 256 bits from `SecureRandom`, written as the prefix and base64url.
 * @param prefix - What says what the token is, such as `iirc_`.
 * @returns The token, `Redacted`, and its SHA-256 as hex, which is all that is kept.
 */
export const makeToken = (prefix: string) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const bytes = yield* random.randomBytes(32);
    const token = `${prefix}${Buffer.from(bytes).toString("base64url")}`;
    const sha256 = Buffer.from(yield* sha256Of(token)).toString("hex");

    return { sha256, token: Redacted.make(token) };
  });

/**
 * Compares two SHA-256 digests in time that does not depend on where they differ.
 * @param left - One digest.
 * @param right - The other.
 * @returns Whether they are equal.
 */
const equalDigests = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

/**
 * The stored entry a presented token is, if any. Every stored hash is compared, so the
 * time taken says nothing of which matched, or how much of one.
 * @param stored - What is kept, each with its token's SHA-256 as hex.
 * @param presented - The token presented.
 * @returns The entry it matches.
 */
export const matching = <A extends { readonly sha256: string }>(
  stored: readonly A[],
  presented: Redacted.Redacted
) =>
  Effect.map(sha256Of(Redacted.value(presented)), (hash) => {
    let found: A | undefined;

    for (const entry of stored) {
      if (equalDigests(hash, new Uint8Array(Buffer.from(entry.sha256, "hex")))) {
        found = entry;
      }
    }

    return Option.fromNullishOr(found);
  });
