/**
 * ISO base media boxes: reading a box's header and bounds, and the same-length edits a
 * stripper makes of a file, as patches over it rather than as new bytes.
 *
 * Every box is checked against what holds it before a stripper trusts it, and one that lies,
 * by being smaller than its header or running past its container, makes the file
 * `Unreadable`, never something kept as it came.
 *
 * @packageDocumentation
 */
import { ascii, concat, readBe } from "./bytes.ts";

/** Why a file could not be walked, which is how a walker fails: it never throws. */
export class Unreadable {
  readonly _tag = "Unreadable";
  readonly reason: string;

  /**
   * @param reason - What broke.
   */
  constructor(reason: string) {
    this.reason = reason;
  }
}

/**
 * Why the file could not be walked.
 * @param reason - What broke.
 * @returns An `Unreadable`.
 */
export const bad = (reason: string): Unreadable => new Unreadable(reason);

/**
 * A change of a file that leaves its length as it was: bytes written at a place, or a run of
 * zeros, which is never held as bytes so that a box of any size can be emptied.
 */
export type Patch =
  | { readonly at: number; readonly bytes: Uint8Array }
  | { readonly at: number; readonly zeros: number };

/**
 * Where a walk puts its patches, and what offset in the file its bytes begin at, since a box
 * is walked in memory apart from the file it lies in.
 */
export interface Sink {
  readonly patches: Patch[];
  readonly base: number;
}

/** The most patches a file may take, so that a file of nothing but tiny boxes cannot make a walk hold millions. */
export const maxPatches = 1_000_000;

/** A box in some bytes: where it begins, how long its header is, and where it ends. */
export interface Box {
  /** The box's type as the number its four bytes make. */
  readonly type: number;
  readonly start: number;
  /** 8, or 16 when its size is a 64-bit one. */
  readonly header: number;
  readonly end: number;
}

/**
 * A box type as the number its four bytes make, which is how a walk compares them, so that
 * reading one makes nothing for the collector to sweep.
 * @param name - The type's four ASCII letters.
 * @returns The number.
 */
export const typeOf = (name: string): number => readBe(ascii(name), 0, 4);

/**
 * A set of box types.
 * @param names - The types' names, separated by spaces.
 * @returns The set, of their numbers.
 */
export const typesOf = (names: string): ReadonlySet<number> =>
  new Set(names.split(" ").map(typeOf));

/**
 * Reads a box's header and checks its bounds. A size of 1 is followed by a 64-bit size, and a
 * size of 0 runs to `limit`.
 * @param bytes - The bytes the header is in, which hold at least its header.
 * @param at - Where the box begins in them.
 * @param limit - Where what holds the box ends, in the same offsets as `at`.
 * @returns The box, or why its header lies.
 */
export const readBox = (bytes: Uint8Array, at: number, limit: number): Box | Unreadable => {
  if (at + 8 > limit || at + 8 > bytes.length) {
    return bad("a box header is cut short");
  }

  const small = readBe(bytes, at, 4);
  const header = small === 1 ? 16 : 8;

  if (at + header > limit || at + header > bytes.length) {
    return bad("a box header is cut short");
  }

  let size = small;

  if (small === 0) {
    size = limit - at;
  } else if (small === 1) {
    size = readBe(bytes, at + 8, 8);
  }

  if (size < header) {
    return bad("a box is smaller than its header");
  }

  if (at + size > limit) {
    return bad("a box runs past what holds it");
  }

  return { end: at + size, header, start: at, type: readBe(bytes, at + 4, 4) };
};

/**
 * Whether every byte of a range is zero.
 * @param bytes - The bytes.
 * @param from - Where the range begins.
 * @param to - Where it ends.
 * @returns Whether it is all zeros.
 */
export const allZero = (bytes: Uint8Array, from: number, to: number): boolean => {
  for (let i = from; i < to; i += 1) {
    if (bytes[i] !== 0) {
      return false;
    }
  }

  return true;
};

/**
 * The boxes laid end to end in a range. What is left at the end, too little to be a box, must
 * be zeros, which is how a QuickTime atom list ends, and holds nothing.
 * @param bytes - The bytes.
 * @param from - Where the first box begins.
 * @param to - Where the range ends.
 * @returns The boxes in order, or why one lies.
 */
export const readBoxes = (
  bytes: Uint8Array,
  from: number,
  to: number
): readonly Box[] | Unreadable => {
  const boxes: Box[] = [];
  let at = from;

  while (to - at >= 8) {
    const box = readBox(bytes, at, to);

    if (box instanceof Unreadable) {
      return box;
    }

    boxes.push(box);

    if (boxes.length > maxPatches) {
      return bad("a box of too many boxes");
    }

    at = box.end;
  }

  return allZero(bytes, at, to) ? boxes : bad("a box header is cut short");
};

const free = ascii("free");

/**
 * Turns a box into a `free` box of the same size with its payload zeroed, so that every offset
 * after it is still right and nothing it held is left in the file. A box whose size is 64 bits
 * keeps its header's shape.
 * @param sink - Where the patches go.
 * @param box - The box, in the bytes the sink's base is the offset of.
 */
export const retype = (sink: Sink, box: Box) => {
  const at = sink.base + box.start;
  const payload = box.end - box.start - box.header;

  if (box.header === 8 && payload <= 64) {
    sink.patches.push({ at: at + 4, bytes: concat([free, new Uint8Array(payload)]) });
  } else {
    sink.patches.push({ at: at + 4, bytes: free });

    if (payload > 0) {
      sink.patches.push({ at: at + box.header, zeros: payload });
    }
  }
};

/**
 * Whether a walk holds more patches than it will.
 * @param sink - Where the patches go.
 * @returns A failure if it does.
 */
export const overfull = (sink: Sink): Unreadable | null =>
  sink.patches.length > maxPatches ? bad("a file of too many parts") : null;
