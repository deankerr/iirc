import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { KeyScope } from "@iirc/api";

import type { Key } from "./configuration.ts";

// A random 256-bit key needs no slow hash to resist guessing, only SHA-256 so that the Log
// never holds it (AUTH-2).
const keyBytes = 32;

/**
 * Makes a new API key: `iirc_` and 32 random bytes in base64url (AUTH-2).
 * @returns The key, which is shown once and never stored.
 */
export const newKey = (): string => `iirc_${randomBytes(keyBytes).toString("base64url")}`;

/**
 * The SHA-256 of a key, which is all the Log keeps of it (AUTH-2).
 * @param key - The key.
 * @returns Its hash, in lowercase hex.
 */
export const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

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
): { readonly name: string; readonly scope: KeyScope } | undefined => {
  const hash = Buffer.from(hashKey(presented), "hex");
  let found: { readonly name: string; readonly scope: KeyScope } | undefined;

  for (const [name, key] of keys) {
    const matches = timingSafeEqual(hash, Buffer.from(key.hash, "hex"));

    found = matches && found === undefined ? { name, scope: key.scope } : found;
  }

  return found;
};

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
