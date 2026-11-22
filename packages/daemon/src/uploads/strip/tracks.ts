/**
 * The tracks of a movie: which are kept, by the handler type their `hdlr` names, and where
 * the samples of one that is dropped lie, read from its sample table, so that they can be
 * zeroed where they are.
 *
 * @packageDocumentation
 */
import { Unreadable, bad, readBoxes, typeOf, typesOf } from "./boxes.ts";
import type { Box } from "./boxes.ts";
import { readBe } from "./bytes.ts";
import type { Range } from "./items.ts";

// The picture, the sound, the text, and the timecode a player needs. Anything else, timed
// metadata such as a phone's location among it, is dropped with its samples.
const keptHandlers = typesOf("vide pict auxv soun sbtl subt text clcp tmcd");

const types = {
  co64: typeOf("co64"),
  hdlr: typeOf("hdlr"),
  mdia: typeOf("mdia"),
  minf: typeOf("minf"),
  stbl: typeOf("stbl"),
  stco: typeOf("stco"),
  stsc: typeOf("stsc"),
  stsz: typeOf("stsz"),
  stz2: typeOf("stz2"),
  tkhd: typeOf("tkhd"),
};

// The one child of a type in a box, or none when it has none or more than one.
const only = (bytes: Uint8Array, parent: Box, type: number): Box | undefined => {
  const children = readBoxes(bytes, parent.start + parent.header, parent.end);

  if (children instanceof Unreadable) {
    return undefined;
  }

  const found = children.filter((child) => child.type === type);

  return found.length === 1 ? found[0] : undefined;
};

const missing = () => bad("a dropped track's sample table is missing");

const disagrees = () => bad("a dropped track's sample table disagrees with itself");

// The one box of either of two types that mean the same thing, such as `stco` and `co64`.
const oneOf = (bytes: Uint8Array, parent: Box, a: number, b: number): Box | Unreadable => {
  const children = readBoxes(bytes, parent.start + parent.header, parent.end);

  if (children instanceof Unreadable) {
    return children;
  }

  const found = children.filter((child) => child.type === a || child.type === b);

  if (found.length > 1) {
    return disagrees();
  }

  return found[0] ?? missing();
};

/** A track as the walker decides it: its id, if `tkhd` says one, and whether it is kept. */
export interface Track {
  readonly id: number | undefined;
  readonly kept: boolean;
}

/**
 * Reads a `trak`'s id and decides whether it is kept, by the handler type of its `mdia`'s
 * `hdlr`. One with no `mdia` or `hdlr` that can be read is dropped.
 * @param bytes - The bytes the `trak` is in.
 * @param trak - The `trak`.
 * @returns The track.
 */
export const readTrack = (bytes: Uint8Array, trak: Box): Track => {
  const tkhd = only(bytes, trak, types.tkhd);
  const mdia = only(bytes, trak, types.mdia);
  const hdlr = mdia === undefined ? undefined : only(bytes, mdia, types.hdlr);
  let id: number | undefined;

  if (tkhd !== undefined) {
    const p = tkhd.start + tkhd.header;
    const at = p + ((bytes[p] ?? 0) === 1 ? 20 : 12);

    id = at + 4 <= tkhd.end ? readBe(bytes, at, 4) : undefined;
  }

  // The handler type follows the version, the flags, and QuickTime's component type.
  const at = hdlr === undefined ? 0 : hdlr.start + hdlr.header + 8;
  const kept = hdlr !== undefined && at + 4 <= hdlr.end && keptHandlers.has(readBe(bytes, at, 4));

  return { id, kept };
};

// A full box's entries after its version, flags, and the fields before its count, checked to
// be inside it.
const table = (
  bytes: Uint8Array,
  found: Box,
  before: number,
  width: (count: number) => number
): { readonly at: number; readonly count: number } | Unreadable => {
  const countAt = found.start + found.header + 4 + before;

  if (countAt + 4 > found.end) {
    return disagrees();
  }

  const count = readBe(bytes, countAt, 4);

  return countAt + 4 + width(count) > found.end ? disagrees() : { at: countAt + 4, count };
};

const chunkOffsets = (bytes: Uint8Array, stbl: Box): readonly number[] | Unreadable => {
  const found = oneOf(bytes, stbl, types.stco, types.co64);

  if (found instanceof Unreadable) {
    return found;
  }

  const width = found.type === types.stco ? 4 : 8;
  const read = table(bytes, found, 0, (count) => count * width);

  return read instanceof Unreadable
    ? read
    : Array.from({ length: read.count }, (_, n) => readBe(bytes, read.at + n * width, width));
};

/** How big each sample is: one size for every sample, or each its own. */
type Sizes =
  | { readonly count: number; readonly each: number }
  | { readonly count: number; readonly at: (n: number) => number };

const sampleSizes = (bytes: Uint8Array, stbl: Box): Sizes | Unreadable => {
  const found = oneOf(bytes, stbl, types.stsz, types.stz2);

  if (found instanceof Unreadable) {
    return found;
  }

  if (found.type === types.stsz) {
    const p = found.start + found.header;
    const each = p + 8 <= found.end ? readBe(bytes, p + 4, 4) : 0;
    const read = table(bytes, found, 4, (count) => (each === 0 ? count * 4 : 0));

    if (read instanceof Unreadable) {
      return read;
    }

    return each === 0
      ? { at: (n) => readBe(bytes, read.at + n * 4, 4), count: read.count }
      : { count: read.count, each };
  }

  const stz2 = found;

  const field =
    stz2.start + stz2.header + 7 < stz2.end ? (bytes[stz2.start + stz2.header + 7] ?? 0) : 0;

  if (field !== 4 && field !== 8 && field !== 16) {
    return disagrees();
  }

  const read = table(bytes, stz2, 4, (count) => Math.ceil((count * field) / 8));

  if (read instanceof Unreadable) {
    return read;
  }

  return {
    at: (n) => {
      if (field !== 4) {
        return readBe(bytes, read.at + (n * field) / 8, field / 8);
      }

      const byte = bytes[read.at + Math.floor(n / 2)] ?? 0;

      return n % 2 === 0 ? Math.floor(byte / 16) : byte % 16;
    },
    count: read.count,
  };
};

// The chunks of the sample table, as how many samples each holds, from `stsc`.
const samplesPerChunk = (
  bytes: Uint8Array,
  stbl: Box,
  chunks: number
): readonly number[] | Unreadable => {
  const stsc = only(bytes, stbl, types.stsc);

  if (stsc === undefined) {
    return missing();
  }

  const read = table(bytes, stsc, 0, (count) => count * 12);

  if (read instanceof Unreadable) {
    return read;
  }

  const counts: number[] = [];

  for (let n = 0; n < read.count; n += 1) {
    const first = readBe(bytes, read.at + n * 12, 4);
    const next = n + 1 < read.count ? readBe(bytes, read.at + (n + 1) * 12, 4) : chunks + 1;
    const samples = readBe(bytes, read.at + n * 12 + 4, 4);

    if (first !== counts.length + 1 || next <= first || next > chunks + 1) {
      return disagrees();
    }

    for (let chunk = first; chunk < next; chunk += 1) {
      counts.push(samples);
    }
  }

  return counts.length === chunks ? counts : disagrees();
};

/**
 * Where the samples of a dropped track lie in the file, a run for each chunk, from its sample
 * table, which must be whole and agree with itself.
 * @param bytes - The bytes the `trak` is in.
 * @param trak - The `trak`.
 * @returns The runs, which may touch or be empty, or why they cannot be found.
 */
export const droppedSamples = (bytes: Uint8Array, trak: Box): readonly Range[] | Unreadable => {
  const mdia = only(bytes, trak, types.mdia);
  const minf = mdia === undefined ? undefined : only(bytes, mdia, types.minf);
  const stbl = minf === undefined ? undefined : only(bytes, minf, types.stbl);

  if (stbl === undefined) {
    return missing();
  }

  const offsets = chunkOffsets(bytes, stbl);
  const sizes = sampleSizes(bytes, stbl);

  if (offsets instanceof Unreadable) {
    return offsets;
  }

  if (sizes instanceof Unreadable) {
    return sizes;
  }

  const counts = samplesPerChunk(bytes, stbl, offsets.length);

  if (counts instanceof Unreadable) {
    return counts;
  }

  const runs: Range[] = [];
  let sample = 0;

  for (const [chunk, start] of offsets.entries()) {
    const samples = counts[chunk] ?? 0;

    if (sample + samples > sizes.count) {
      return disagrees();
    }

    let length = 0;

    if ("each" in sizes) {
      length = samples * sizes.each;
    } else {
      for (let n = sample; n < sample + samples; n += 1) {
        length += sizes.at(n);
      }
    }

    sample += samples;
    runs.push({ end: start + length, start });
  }

  return sample === sizes.count ? runs : disagrees();
};
