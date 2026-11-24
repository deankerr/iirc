/**
 * The items of a HEIC or AVIF image: which of them `iinf` says are images, where `iloc` says
 * the data of each lies, and where the data of the others is to be zeroed, checked so that
 * zeroing it can touch nothing that is kept.
 *
 * @packageDocumentation
 */
import { Unreadable, bad, readBoxes, typeOf, typesOf } from "./boxes.ts";
import type { Box } from "./boxes.ts";
import { readBe } from "./bytes.ts";

/** A run of the file, from where it begins to where it ends. */
export interface Range {
  readonly start: number;
  readonly end: number;
}

// Images, and what makes one from others: a grid, an overlay, an identity, or a gain map.
// Everything else, Exif, XMP in a `mime` item, a `uri ` item, or a type unknown, is dropped.
// A `jpeg` item is dropped too, since a JPEG's data carries APP segments of its own, EXIF and
// XMP among them, which are not walked here.
const kept = typesOf("hvc1 hvt1 av01 grid iovl iden j2k1 unci tmap mski avc1 vvc1");

const infe = typeOf("infe");

const u16 = (bytes: Uint8Array, at: number) => readBe(bytes, at, 2);

const u32 = (bytes: Uint8Array, at: number) => readBe(bytes, at, 4);

/** The items `iinf` lists: the ids of all, of the ones kept, and the `infe` boxes of those. */
export interface Items {
  readonly listed: ReadonlySet<number>;
  readonly kept: ReadonlySet<number>;
  readonly infos: readonly Box[];
}

// How much of an `infe` of a version there must be for it to hold an id and, from version 2, a type.
const infeLength = (version: number): number => {
  if (version < 2) {
    return 8;
  }

  return version === 2 ? 12 : 14;
};

/**
 * Reads `iinf`, keeping the items whose type is on the keep-list. An item of an `infe` that
 * names no type, which is every one of version 0 or 1, is dropped.
 * @param bytes - The `meta` box.
 * @param iinf - The `iinf` box in it.
 * @returns The items, or why `iinf` could not be read.
 */
export const readItems = (bytes: Uint8Array, iinf: Box): Items | Unreadable => {
  const at = iinf.start + iinf.header;
  const version = bytes[at] ?? 0;

  if (at + 4 > iinf.end || version > 1) {
    return bad("truncated iinf box or unknown version");
  }

  const infos = readBoxes(bytes, at + (version === 0 ? 6 : 8), iinf.end);

  if (infos instanceof Unreadable) {
    return infos;
  }

  const seen = new Set<number>();
  const ids = new Set<number>();
  const keeping: Box[] = [];

  for (const info of infos) {
    if (info.type === infe) {
      const q = info.start + info.header;
      const infoVersion = bytes[q] ?? 0;

      if (infoVersion > 3 || info.end - q < infeLength(infoVersion)) {
        return bad("truncated infe box or unknown version");
      }

      const id = infoVersion === 3 ? u32(bytes, q + 4) : u16(bytes, q + 4);

      if (seen.has(id)) {
        return bad("two items share an ID");
      }

      seen.add(id);

      if (infoVersion >= 2 && kept.has(u32(bytes, q + (infoVersion === 3 ? 10 : 8)))) {
        ids.add(id);
        keeping.push(info);
      }
    }
  }

  return { infos: keeping, kept: ids, listed: seen };
};

/** An extent of an item's data: where it begins, its entry's base put in, and how long it is. */
interface Extent {
  readonly offset: number;
  readonly length: number;
}

/** An item's entry in `iloc`. */
export interface Entry {
  readonly id: number;
  /** Where the entry is in `meta`, so that it can be copied. */
  readonly span: Range;
  /** 0 for the file, 1 for `idat`, 2 for other items. */
  readonly method: number;
  readonly dataReference: number;
  readonly extents: readonly Extent[];
}

/** What `iloc` holds, and where its count is, since it is the one number in it that changes. */
export interface Locations {
  readonly countAt: number;
  readonly countWidth: number;
  readonly entries: readonly Entry[];
}

/** How wide the numbers of an `iloc` are. */
interface Widths {
  readonly id: number;
  readonly version: number;
  readonly offset: number;
  readonly length: number;
  readonly base: number;
  readonly index: number;
}

const readEntry = (
  bytes: Uint8Array,
  start: number,
  end: number,
  widths: Widths
): Entry | Unreadable => {
  const methodWidth = widths.version === 0 ? 0 : 2;
  let at = start;

  if (at + widths.id + methodWidth + 2 + widths.base + 2 > end) {
    return bad("truncated iloc entry");
  }

  const id = readBe(bytes, at, widths.id);

  at += widths.id;

  const method = widths.version === 0 ? 0 : u16(bytes, at) % 16;

  at += methodWidth;

  const dataReference = u16(bytes, at);
  const base = readBe(bytes, at + 2, widths.base);
  const count = u16(bytes, at + 2 + widths.base);
  const extentWidth = widths.index + widths.offset + widths.length;
  const extents: Extent[] = [];

  at += 4 + widths.base;

  if (at + count * extentWidth > end) {
    return bad("truncated iloc entry");
  }

  for (let e = 0; e < count; e += 1) {
    const offset = base + readBe(bytes, at + widths.index, widths.offset);
    const length = readBe(bytes, at + widths.index + widths.offset, widths.length);

    if (offset + length > Number.MAX_SAFE_INTEGER) {
      return bad("iloc extent is too large");
    }

    extents.push({ length, offset });
    at += extentWidth;
  }

  return { dataReference, extents, id, method, span: { end: at, start } };
};

/**
 * Reads `iloc`, versions 0, 1 and 2, with any widths of offset, length, base offset and index.
 * @param bytes - The `meta` box.
 * @param iloc - The `iloc` box in it.
 * @returns Its entries, or why it could not be read.
 */
export const readLocations = (bytes: Uint8Array, iloc: Box): Locations | Unreadable => {
  const p = iloc.start + iloc.header;
  const version = bytes[p] ?? 0;

  if (p + 8 > iloc.end || version > 2) {
    return bad("truncated iloc box or unknown version");
  }

  const widths: Widths = {
    base: Math.floor((bytes[p + 5] ?? 0) / 16),
    id: version < 2 ? 2 : 4,
    index: version === 0 ? 0 : (bytes[p + 5] ?? 0) % 16,
    length: (bytes[p + 4] ?? 0) % 16,
    offset: Math.floor((bytes[p + 4] ?? 0) / 16),
    version,
  };

  if ([widths.base, widths.index, widths.length, widths.offset].some((width) => width > 8)) {
    return bad("iloc number wider than 8 bytes");
  }

  const countAt = p + 6;

  if (countAt + widths.id > iloc.end) {
    return bad("truncated iloc box");
  }

  const count = readBe(bytes, countAt, widths.id);
  const entries: Entry[] = [];
  let at = countAt + widths.id;

  // Each entry is checked to be inside the box before it is read, so that a count that lies
  // costs no more than the bytes there are.
  for (let n = 0; n < count; n += 1) {
    const entry = readEntry(bytes, at, iloc.end, widths);

    if (entry instanceof Unreadable) {
      return entry;
    }

    entries.push(entry);
    at = entry.span.end;
  }

  // The entries are all there is, to the end of the box, whatever the count says: a count
  // below them would leave items unlocated, so their data could not be found to be zeroed.
  if (at !== iloc.end) {
    return bad("iloc has more entries than its count");
  }

  const located = new Set(entries.map(({ id }) => id));

  if (located.size !== entries.length) {
    return bad("iloc lists an item twice");
  }

  return { countAt, countWidth: widths.id, entries };
};

/** Runs of a file by where they begin, for asking whether another runs into one. */
interface Occupied {
  readonly starts: readonly number[];
  /** `reach[i]` is the furthest end of runs `0` through `i`. */
  readonly reach: readonly number[];
}

const occupy = (ranges: readonly Range[]): Occupied => {
  const sorted = ranges.toSorted((a, b) => a.start - b.start);
  let furthest = 0;

  return {
    reach: sorted.map(({ end }) => {
      furthest = Math.max(furthest, end);

      return furthest;
    }),
    starts: sorted.map(({ start }) => start),
  };
};

// How many of some numbers in order are below a limit, or at it when `orEqual`.
const countBelow = (numbers: readonly number[], limit: number, orEqual: boolean): number => {
  let low = 0;
  let high = numbers.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = numbers[middle] ?? 0;

    if (orEqual ? value <= limit : value < limit) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

const runsInto = (occupied: Occupied, range: Range): boolean => {
  const before = countBelow(occupied.starts, range.end, false);

  return before > 0 && (occupied.reach[before - 1] ?? 0) > range.start;
};

/**
 * Whether a run lies whole inside one of some that are in order and apart.
 * @param inside - The runs, in order and apart.
 * @param starts - Where each of them begins.
 * @param range - The run.
 * @returns Whether it does.
 */
export const insideOne = (
  inside: readonly Range[],
  starts: readonly number[],
  range: Range
): boolean => {
  const before = countBelow(starts, range.start, true);

  return before > 0 && range.end <= (inside[before - 1]?.end ?? 0);
};

/** What of the data of dropped items is to be zeroed: in the file, and in `idat`. */
export interface Zeroing {
  readonly file: readonly Range[];
  readonly idat: readonly Range[];
}

/** Where things are, for checking that zeroing a dropped item's data touches nothing else. */
export interface Where {
  readonly fileSize: number;
  readonly meta: Range;
  readonly mdats: readonly Range[];
  /** The payload of `idat`, if `meta` has one. */
  readonly idat: Range | undefined;
}

// The extents of the kept items, in the file and in idat. An extent of no length is the whole
// of what it points into, so it is taken to be, which only makes a check stricter.
const keptRuns = (entries: readonly Entry[], keptIds: ReadonlySet<number>, where: Where) => {
  const idatSize = where.idat === undefined ? 0 : where.idat.end - where.idat.start;
  const file: Range[] = [];
  const idat: Range[] = [];

  for (const { extents, id, method } of entries) {
    if (keptIds.has(id) && method <= 1) {
      const limit = method === 1 ? idatSize : where.fileSize;

      for (const { length, offset } of extents) {
        (method === 1 ? idat : file).push({
          end: length === 0 ? limit : offset + length,
          start: offset,
        });
      }
    }
  }

  return { file: occupy(file), idat: occupy(idat) };
};

// The extents of the dropped items, or why one cannot be zeroed. Method 2 is made of other
// items' extents, and has nothing of its own.
const droppedRuns = (
  entries: readonly Entry[],
  keptIds: ReadonlySet<number>
): Zeroing | Unreadable => {
  const file: Range[] = [];
  const idat: Range[] = [];

  for (const { dataReference, extents, id, method } of entries) {
    if (!keptIds.has(id)) {
      if (dataReference !== 0) {
        return bad("removed item's data is in another file");
      }

      if (method > 2) {
        return bad("removed item's data is in an unknown location");
      }

      for (const { length, offset } of method === 2 ? [] : extents) {
        if (length === 0) {
          return bad("removed item has an empty extent");
        }

        (method === 1 ? idat : file).push({ end: offset + length, start: offset });
      }
    }
  }

  return { file, idat };
};

/**
 * Where the data of the dropped items is, checked to be a place it can be zeroed: that its
 * extents are not empty, are inside the file, are not in `meta`, are not in the data of an
 * item that is kept, and are in an `mdat`, or in `idat` for an item kept there.
 * @param entries - The entries of `iloc`.
 * @param keptIds - The ids of the items kept.
 * @param where - Where `meta`, `idat` and the `mdat` boxes are.
 * @returns The runs to zero, or why one cannot be.
 */
export const zeroing = (
  entries: readonly Entry[],
  keptIds: ReadonlySet<number>,
  where: Where
): Zeroing | Unreadable => {
  const dropped = droppedRuns(entries, keptIds);

  if (dropped instanceof Unreadable) {
    return dropped;
  }

  const keeping = keptRuns(entries, keptIds, where);
  const mdatStarts = where.mdats.map(({ start }) => start);
  const idatSize = where.idat === undefined ? 0 : where.idat.end - where.idat.start;

  for (const range of dropped.file) {
    if (range.end > where.fileSize) {
      return bad("removed item's data runs past the end of the file");
    }

    if (range.start < where.meta.end && range.end > where.meta.start) {
      return bad("removed item's data is in meta");
    }

    if (!insideOne(where.mdats, mdatStarts, range)) {
      return bad("removed item's data is not in an mdat box");
    }

    if (runsInto(keeping.file, range)) {
      return bad("removed item's data overlaps a kept item's");
    }
  }

  for (const range of dropped.idat) {
    if (range.end > idatSize) {
      return bad("removed item's data runs past its idat box");
    }

    if (runsInto(keeping.idat, range)) {
      return bad("removed item's data overlaps a kept item's");
    }
  }

  return dropped;
};
