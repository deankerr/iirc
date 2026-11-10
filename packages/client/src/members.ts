/**
 * A Channel's members, and a `NAMES` listing as it is read. Every change copies only the
 * one Channel's members it touches, and a `353` copies none: its part waits in the
 * listing, and the parts are folded in every so often, so reading a listing costs about
 * what it lists.
 *
 * @packageDocumentation
 */
import type { Listing, Member } from "./state.ts";

/** The most members kept for one Channel, so a hostile Ircd cannot grow the State without bound. */
const maxMembers = 100_000;

/** The most parts a listing holds before they are folded into its members. */
const maxParts = 128;

/**
 * Members with one more, or one changed. A Channel already at its bound takes no one new.
 * @param members - The members.
 * @param folded - The member's folded nick.
 * @param member - The member.
 * @returns The members after.
 */
export const withMember = (
  members: ReadonlyMap<string, Member>,
  folded: string,
  member: Member
): ReadonlyMap<string, Member> =>
  members.size >= maxMembers && !members.has(folded)
    ? members
    : new Map(members).set(folded, member);

/**
 * Members without one.
 * @param members - The members.
 * @param folded - The member's folded nick.
 * @returns The members after, or the same members if they did not hold it.
 */
export const withoutMember = (
  members: ReadonlyMap<string, Member>,
  folded: string
): ReadonlyMap<string, Member> => {
  if (!members.has(folded)) {
    return members;
  }

  const next = new Map(members);
  next.delete(folded);

  return next;
};

/**
 * Every member a listing holds so far, its parts folded in order, as if each had been
 * added on its own.
 * @param listing - The listing.
 * @returns Its members.
 */
export const listedMembers = (listing: Listing): ReadonlyMap<string, Member> => {
  if (listing.parts.length === 0) {
    return listing.members;
  }

  const members = new Map(listing.members);

  for (const part of listing.parts) {
    for (const [folded, member] of part) {
      if (members.size < maxMembers || members.has(folded)) {
        members.set(folded, member);
      }
    }
  }

  return members;
};

/**
 * A listing with one more part. Past {@link maxParts} parts, they are folded into its
 * members, so a listing that never ends stays bounded.
 * @param listing - The listing so far, or `undefined` when this part begins it.
 * @param part - The members this `353` lists, keyed by folded nick.
 * @returns The listing after.
 */
export const listMore = (
  listing: Listing | undefined,
  part: readonly (readonly [string, Member])[]
): Listing => {
  const was = listing ?? { members: new Map(), parts: [] };

  if (part.length === 0) {
    return was;
  }

  const parts = [...was.parts, part];

  return parts.length < maxParts
    ? { members: was.members, parts }
    : { members: listedMembers({ members: was.members, parts }), parts: [] };
};

/**
 * A listing with its members changed, as a `JOIN`, `PART`, or `MODE` changes them while it
 * is pending, its parts folded in first.
 * @param listing - The listing.
 * @param change - What to change.
 * @returns The listing after.
 */
export const changeListing = (
  listing: Listing,
  change: (members: ReadonlyMap<string, Member>) => ReadonlyMap<string, Member>
): Listing => ({ members: change(listedMembers(listing)), parts: [] });

/**
 * Whether a listing holds a member, without folding its parts.
 * @param listing - The listing.
 * @param folded - The member's folded nick.
 * @returns Whether it does.
 */
export const inListing = (listing: Listing, folded: string): boolean => {
  if (listing.members.has(folded)) {
    return true;
  }

  // A member a part lists is held unless the listing was at its bound when it came.
  let { size } = listing.members;
  const added = new Set<string>();

  for (const part of listing.parts) {
    for (const [key] of part) {
      if (!added.has(key) && !listing.members.has(key) && size < maxMembers) {
        added.add(key);
        size += 1;
      }
    }
  }

  return added.has(folded);
};

/**
 * A listing without one member, folding its parts only when it holds them.
 * @param listing - The listing.
 * @param folded - The member's folded nick.
 * @returns The listing after.
 */
export const withoutListed = (listing: Listing, folded: string): Listing =>
  inListing(listing, folded)
    ? changeListing(listing, (members) => withoutMember(members, folded))
    : listing;
