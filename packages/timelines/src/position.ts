/**
 * Where an item stands in a Timeline: `(at, sequence, n)`. Positions are totally ordered,
 * and each is written as a cursor whose text sorts the same way, so a cursor can go in a
 * URL and a store can order by it.
 *
 * @packageDocumentation
 */
import { Instant } from "@iirc/client";

/**
 * An item's place: `at`, the time of its News, then `sequence`, the Journal sequence of
 * the step that made it, then `n`, the News's index in that step. A position never
 * changes once given.
 */
export interface Position {
  readonly at: Instant;
  readonly sequence: number;
  readonly n: number;
}

/**
 * Orders two positions.
 * @param left - One position.
 * @param right - The other.
 * @returns Below zero when `left` comes first, zero when they are the same, above when it comes after.
 */
export const comparePositions = (left: Position, right: Position): number => {
  if (left.at !== right.at) {
    return left.at < right.at ? -1 : 1;
  }

  if (left.sequence !== right.sequence) {
    return left.sequence < right.sequence ? -1 : 1;
  }

  if (left.n === right.n) {
    return 0;
  }

  return left.n < right.n ? -1 : 1;
};

// An instant may be before the epoch, as a `time` tag can say, so it is offset to be
// positive. The sum passes 2^53, so it is worked out exactly with BigInt.
const offset = 2n ** 53n;

const atDigits = 14;
const sequenceDigits = 14;
const indexDigits = 8;

const hex = (value: bigint, digits: number): string => value.toString(16).padStart(digits, "0");

const cursorPattern = /^(?<at>[0-9a-f]{14})-(?<sequence>[0-9a-f]{14})-(?<n>[0-9a-f]{8})$/u;

/**
 * A position as a cursor: fixed-width lower-case hex, so two cursors compare as text
 * exactly as their positions compare, and each is safe in a URL path.
 * @param position - The position.
 * @returns Its cursor.
 */
export const cursorOf = (position: Position): string =>
  `${hex(BigInt(position.at) + offset, atDigits)}-${hex(BigInt(position.sequence), sequenceDigits)}-${hex(BigInt(position.n), indexDigits)}`;

const safe = (value: bigint): number | undefined =>
  value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : undefined;

/**
 * Reads a cursor back as its position.
 * @param cursor - Text that may be a cursor.
 * @returns The position, or `undefined` when it is not one {@link cursorOf} could give.
 */
export const parseCursor = (cursor: string): Position | undefined => {
  const groups = cursorPattern.exec(cursor)?.groups;

  if (groups?.at === undefined || groups.sequence === undefined || groups.n === undefined) {
    return undefined;
  }

  const at = safe(BigInt(`0x${groups.at}`) - offset);
  const sequence = safe(BigInt(`0x${groups.sequence}`));
  const n = Number.parseInt(groups.n, 16);

  return at === undefined || sequence === undefined || sequence < 1
    ? undefined
    : { at: Instant.make(at), n, sequence };
};
