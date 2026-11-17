/**
 * What Lines have shown of other Users, by folded nick. A Network can hold tens of
 * thousands, and a step that learns of one User must not copy them all, so they are kept
 * in a fixed number of buckets by a hash of the key: a change copies the bucket list and
 * the one bucket it touches, which is plain data, and the same on every runtime.
 *
 * @packageDocumentation
 */
import type { Seen } from "./state.ts";

/** Users by folded nick, in buckets by {@link bucketOf}. Empty buckets are not held. */
export type Users = ReadonlyMap<number, ReadonlyMap<string, Seen>>;

/** How many buckets the keys spread over. */
const buckets = 256;

/** No Users. */
export const noUsers: Users = new Map();

/**
 * The bucket a key falls in: a 32-bit string hash, the same on every runtime.
 * @param key - The folded nick.
 * @returns Its bucket.
 */
const bucketOf = (key: string): number => {
  let hash = 0;

  // Kept below 2 ** 32, so every step is exact in a double.
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + (key.codePointAt(index) ?? 0)) % 4_294_967_296;
  }

  return hash % buckets;
};

/**
 * One User.
 * @param users - The Users.
 * @param key - Their folded nick.
 * @returns What was seen of them, or `undefined`.
 */
export const userIn = (users: Users, key: string): Seen | undefined =>
  users.get(bucketOf(key))?.get(key);

/**
 * The Users with one more, or one changed, copying only the one bucket.
 * @param users - The Users.
 * @param key - Their folded nick.
 * @param seen - What was seen of them.
 * @returns The Users after.
 */
export const withUser = (users: Users, key: string, seen: Seen): Users => {
  const bucket = bucketOf(key);

  return new Map(users).set(bucket, new Map(users.get(bucket)).set(key, seen));
};

/**
 * The Users without some, copying only the buckets they were in.
 * @param users - The Users.
 * @param keys - The folded nicks.
 * @returns The Users after, or the same Users if they held none.
 */
export const withoutUsers = (users: Users, keys: Iterable<string>): Users => {
  let next: Map<number, ReadonlyMap<string, Seen>> | undefined;

  for (const key of keys) {
    const bucket = bucketOf(key);
    const held = (next ?? users).get(bucket);

    if (held?.has(key) === true) {
      next ??= new Map(users);

      const less = new Map(held);
      less.delete(key);

      if (less.size === 0) {
        next.delete(bucket);
      } else {
        next.set(bucket, less);
      }
    }
  }

  return next ?? users;
};

/**
 * Every User, bucket by bucket.
 * @param users - The Users.
 * @returns Each folded nick and what was seen of them.
 */
export const usersOf = (users: Users): readonly (readonly [string, Seen])[] =>
  [...users.values()].flatMap((bucket) => [...bucket]);

/**
 * Users from entries, where the last of any that share a key is kept.
 * @param entries - Each folded nick and what was seen of them.
 * @returns The Users.
 */
export const usersFrom = (entries: Iterable<readonly [string, Seen]>): Users => {
  const next = new Map<number, Map<string, Seen>>();

  for (const [key, seen] of entries) {
    const bucket = bucketOf(key);
    const held = next.get(bucket) ?? new Map<string, Seen>();

    next.set(bucket, held.set(key, seen));
  }

  return next;
};

/**
 * Every User changed alike.
 * @param users - The Users.
 * @param change - What to change.
 * @returns The Users after.
 */
export const mapUsers = (users: Users, change: (seen: Seen) => Seen): Users =>
  new Map(
    [...users].map(([bucket, held]) => [
      bucket,
      new Map([...held].map(([key, seen]) => [key, change(seen)])),
    ])
  );
