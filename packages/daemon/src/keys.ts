import type { KeyScope } from "@iirc/api";
import { Effect, Layer, Result } from "effect";
import { Digest, Mac, SecureRandom } from "effect/crypto";
import { Base64Url, Hex } from "effect/encoding";

import type { Key } from "./configuration.ts";

// A random 256-bit key needs no slow hash to resist guessing, only SHA-256 so that the Log
// never holds it (AUTH-2).
const keyBytes = 32;

/** What keys are made and checked with: WebCrypto's random bytes and SHA-256. */
export const keyCrypto: Layer.Layer<Digest.Digest | SecureRandom.SecureRandom> = Layer.mergeAll(
  Digest.layerWebCrypto,
  SecureRandom.layerWebCrypto
);

const encoder = new TextEncoder();

const digestOf = (key: string) =>
  Digest.Digest.use((digest) => digest.digest(Digest.sha256, encoder.encode(key)));

/**
 * Makes a new API key: `iirc_` and 32 random bytes in base64url (AUTH-2).
 * @returns The key, which is shown once and never stored.
 */
export const newKey: Effect.Effect<string, never, SecureRandom.SecureRandom> =
  SecureRandom.SecureRandom.use((random) => random.randomBytes(keyBytes)).pipe(
    Effect.map((bytes) => `iirc_${Base64Url.encode(bytes)}`)
  );

/**
 * The SHA-256 of a key's UTF-8, which is all the Log keeps of it (AUTH-2).
 * @param key - The key.
 * @returns Its hash, in lowercase hex.
 */
export const hashKey = (key: string): Effect.Effect<string, never, Digest.Digest> =>
  Effect.map(digestOf(key), Hex.encode);

// A stored hash that is not hex matches nothing: no hash has length 0.
const noHash = new Uint8Array(0);

/**
 * Finds whose key was presented (AUTH-2). Hashing first gives every comparison the same
 * length, and each stored hash is compared in constant time, every one of them every time,
 * so how long this takes says nothing about how close a guess came, or to which key.
 * @param keys - The keys held now, by name.
 * @param presented - What came with a request.
 * @returns The key's name and scope, or nothing if no key matches.
 */
export const findKey = (
  keys: ReadonlyMap<string, Key>,
  presented: string
): Effect.Effect<
  { readonly name: string; readonly scope: KeyScope } | undefined,
  never,
  Digest.Digest
> =>
  Effect.map(digestOf(presented), (hash) => {
    let found: { readonly name: string; readonly scope: KeyScope } | undefined;

    for (const [name, key] of keys) {
      const stored = Result.getOrElse(Hex.decode(key.hash), () => noHash);
      // An XOR over every byte, with no early exit. Node's is native, but what is compared
      // here is the SHA-256 of what was presented, which a guesser cannot steer byte by
      // byte, so this needs no more.
      const matches = Mac.timingSafeEqual(hash, stored);

      found = matches && found === undefined ? { name, scope: key.scope } : found;
    }

    return found;
  });

const reach: Readonly<Record<KeyScope, number>> = { admin: 2, chat: 1, read: 0 };

/**
 * Whether a key's scope reaches what an operation needs, each scope adding to the last
 * (AUTH-3).
 * @param scope - The key's scope.
 * @param needed - The operation's.
 * @returns Whether the key may do it.
 */
export const reaches = (scope: KeyScope, needed: KeyScope): boolean =>
  reach[scope] >= reach[needed];
