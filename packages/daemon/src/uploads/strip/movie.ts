/**
 * The boxes that make a movie in an ISO base media file: `moov`, a fragment's `moof`, and
 * `mfra`, walked by a keep-list of what each may hold. A box on it is kept whole, or walked
 * into if it holds boxes the keep-list names, and any other, such as `udta`, `meta`, `uuid`,
 * XMP, or one of a type nobody here has heard of, is retyped `free` and zeroed where it is.
 *
 * A track is kept by the handler type its `hdlr` names, the picture, sound, text, and
 * timecode, and any other, a phone's timed-metadata track of locations among them, is dropped
 * whole: its `trak` is retyped and zeroed, its samples are zeroed where its sample table says
 * they lie, and nothing kept names it afterwards.
 *
 * @packageDocumentation
 */
import { Unreadable, bad, overfull, readBoxes, retype, typeOf, typesOf } from "./boxes.ts";
import type { Box, Patch, Sink } from "./boxes.ts";
import { ascii, be, concat, readBe } from "./bytes.ts";
import { insideOne } from "./items.ts";
import type { Range } from "./items.ts";
import { droppedSamples, readTrack } from "./tracks.ts";

/** What a box of one type may hold: the boxes kept whole, and the boxes walked into. */
export interface Holds {
  readonly leaves: ReadonlySet<number>;
  readonly into: ReadonlyMap<number, Holds>;
}

const holds = (leaves: string, into: Readonly<Record<string, Holds>> = {}): Holds => ({
  into: new Map(Object.entries(into).map(([name, inside]) => [typeOf(name), inside])),
  leaves: typesOf(leaves),
});

// Sample tables are kept whole, `stsd` and the rest: what they hold is how samples are found
// and decoded. Only a kept track's are walked, since a dropped track is dropped whole.
const sampleTable = holds(
  "stsd stts ctts cslg stss stps stsc stsz stz2 stco co64 sdtp sbgp sgpd subs saiz saio padb stdp stsh"
);

const mediaInformation = holds("vmhd smhd hmhd nmhd gmhd hdlr", {
  dinf: holds("dref"),
  stbl: sampleTable,
});

const media = holds("mdhd hdlr elng", { minf: mediaInformation });

const track = holds("tkhd tref tapt load trgr", { edts: holds("elst"), mdia: media });

/** What each box that is walked into may hold, by its type. */
export const movieParts: ReadonlyMap<number, Holds> = new Map([
  [typeOf("moov"), holds("mvhd iods", { mvex: holds("mehd trex leva trep"), trak: track })],
  [typeOf("moof"), holds("mfhd", { traf: holds("tfhd tfdt trun sbgp sgpd subs saiz saio") })],
  [typeOf("mfra"), holds("tfra mfro")],
]);

/** What a walk of one box needs to know of the file and its other boxes. */
export interface Movie {
  /** The payloads of the file's `mdat` boxes, in order. */
  readonly mdats: readonly Range[];
  /** The ids of the tracks dropped, from every `moov`. */
  readonly dropped: ReadonlySet<number>;
}

const types = {
  leva: typeOf("leva"),
  tfhd: typeOf("tfhd"),
  traf: typeOf("traf"),
  trak: typeOf("trak"),
  tref: typeOf("tref"),
  trun: typeOf("trun"),
};

// The boxes that name one track by the id after their version and flags, and go with it.
const namingOne = typesOf("trex trep tfra");

const free = ascii("free");

/**
 * The ids of the tracks a `moov` drops.
 * @param bytes - The `moov`, header and all.
 * @param header - How long its header is.
 * @returns The ids, of the dropped tracks whose `tkhd` says one.
 */
export const droppedTracks = (bytes: Uint8Array, header: number): ReadonlySet<number> => {
  const boxes = readBoxes(bytes, header, bytes.length);
  const dropped = new Set<number>();

  if (!(boxes instanceof Unreadable)) {
    for (const box of boxes) {
      if (box.type === types.trak) {
        const { id, kept } = readTrack(bytes, box);

        if (!kept && id !== undefined) {
          dropped.add(id);
        }
      }
    }
  }

  return dropped;
};

// Zeroes the samples of a dropped track where they lie, a run for each chunk and runs that
// touch joined, and retypes its `trak`.
const dropTrack = (bytes: Uint8Array, sink: Sink, trak: Box, movie: Movie): Unreadable | null => {
  // A track that cannot be named cannot be told apart in a fragment or a reference.
  if (readTrack(bytes, trak).id === undefined) {
    return bad("a dropped track's tkhd names no track");
  }

  const runs = droppedSamples(bytes, trak);

  if (runs instanceof Unreadable) {
    return runs;
  }

  const starts = movie.mdats.map(({ start }) => start);
  const joined: Range[] = [];

  for (const run of runs
    .filter(({ end, start }) => end > start)
    .toSorted((a, b) => a.start - b.start)) {
    const last = joined.at(-1);

    if (last !== undefined && run.start <= last.end) {
      joined[joined.length - 1] = { end: Math.max(last.end, run.end), start: last.start };
    } else {
      joined.push(run);
    }
  }

  for (const run of joined) {
    if (!insideOne(movie.mdats, starts, run)) {
      return bad("a dropped track's samples are not in an mdat");
    }

    sink.patches.push({ at: run.start, zeros: run.end - run.start });

    const failure = overfull(sink);

    if (failure !== null) {
      return failure;
    }
  }

  retype(sink, trak);

  return overfull(sink);
};

const cannotRemove = () => bad("a kept track's reference to a dropped track cannot be removed");

// Takes the dropped tracks out of a kept track's `tref`. A reference that names only dropped
// tracks is retyped, and one that names others too is rewritten without them, followed by a
// `free` box of what that frees, which must be enough to be one.
const dropReferences = (
  bytes: Uint8Array,
  sink: Sink,
  tref: Box,
  movie: Movie
): Unreadable | null => {
  const references = readBoxes(bytes, tref.start + tref.header, tref.end);

  if (references instanceof Unreadable) {
    return references;
  }

  for (const reference of references) {
    const from = reference.start + reference.header;
    const length = reference.end - from;

    if (length % 4 !== 0) {
      return cannotRemove();
    }

    const ids = Array.from({ length: length / 4 }, (_, n) => readBe(bytes, from + n * 4, 4));
    const kept = ids.filter((id) => !movie.dropped.has(id));

    if (kept.length === 0) {
      retype(sink, reference);
    } else if (kept.length < ids.length) {
      const freed = (ids.length - kept.length) * 4;

      if (freed < 8) {
        return cannotRemove();
      }

      const size = reference.header + kept.length * 4;
      const type = bytes.subarray(reference.start + 4, reference.start + 8);

      sink.patches.push({
        at: sink.base + reference.start,
        bytes: concat([
          reference.header === 16
            ? concat([be(1, 4), type, be(size, 8)])
            : concat([be(size, 4), type]),
          ...kept.map((id) => be(id, 4)),
          be(freed, 4),
          free,
          new Uint8Array(freed - 8),
        ]),
      });
    }
  }

  return overfull(sink);
};

// The id a box that names one track names, or why it cannot be read.
const namedTrack = (bytes: Uint8Array, box: Box, at: number): number | Unreadable =>
  box.start + box.header + at + 4 <= box.end
    ? readBe(bytes, box.start + box.header + at, 4)
    : bad("a box that names a track is cut short");

// What a fragment of a dropped track becomes: retyped when it holds no run of samples, and
// refused when it does, since zeroing a fragment's samples is not done.
const dropFragment = (bytes: Uint8Array, sink: Sink, traf: Box): Unreadable | null => {
  const children = readBoxes(bytes, traf.start + traf.header, traf.end);

  if (children instanceof Unreadable) {
    return children;
  }

  if (children.some((child) => child.type === types.trun)) {
    return bad("a fragment holds a run of a dropped track");
  }

  retype(sink, traf);

  return overfull(sink);
};

// What is done with a box, when what it is decides more than its type: a track and what
// names one.
const special = (
  bytes: Uint8Array,
  sink: Sink,
  box: Box,
  movie: Movie
): "walk" | Unreadable | null => {
  if (box.type === types.trak) {
    return readTrack(bytes, box).kept ? "walk" : dropTrack(bytes, sink, box, movie);
  }

  if (movie.dropped.size === 0) {
    return "walk";
  }

  if (box.type === types.tref) {
    return dropReferences(bytes, sink, box, movie);
  }

  if (box.type === types.leva) {
    return bad("a level assignment of a movie that drops a track");
  }

  if (namingOne.has(box.type)) {
    const id = namedTrack(bytes, box, 4);

    if (id instanceof Unreadable) {
      return id;
    }

    if (movie.dropped.has(id)) {
      retype(sink, box);

      return overfull(sink);
    }

    return "walk";
  }

  if (box.type === types.traf) {
    const tfhd = readBoxes(bytes, box.start + box.header, box.end);

    if (tfhd instanceof Unreadable) {
      return tfhd;
    }

    const header = tfhd.find((child) => child.type === types.tfhd);
    const id = header === undefined ? bad("a fragment with no tfhd") : namedTrack(bytes, header, 4);

    if (id instanceof Unreadable) {
      return id;
    }

    return movie.dropped.has(id) ? dropFragment(bytes, sink, box) : "walk";
  }

  return "walk";
};

const walkInto = (
  bytes: Uint8Array,
  sink: Sink,
  inside: Holds,
  from: number,
  to: number,
  movie: Movie
): Unreadable | null => {
  const boxes = readBoxes(bytes, from, to);

  if (boxes instanceof Unreadable) {
    return boxes;
  }

  for (const box of boxes) {
    const further = inside.into.get(box.type);
    const kept = further !== undefined || inside.leaves.has(box.type);
    const done = kept ? special(bytes, sink, box, movie) : "walk";

    if (done !== "walk") {
      if (done !== null) {
        return done;
      }
    } else if (further !== undefined) {
      const failure = walkInto(bytes, sink, further, box.start + box.header, box.end, movie);

      if (failure !== null) {
        return failure;
      }
    } else if (!kept) {
      retype(sink, box);

      const failure = overfull(sink);

      if (failure !== null) {
        return failure;
      }
    }
  }

  return null;
};

/**
 * Walks one box of a movie, whole in memory, retyping and zeroing what its keep-list does not
 * name, however deep, and dropping the tracks that are not kept with their samples.
 * @param bytes - The box, header and all.
 * @param base - Where it begins in the file, which the patches are given in.
 * @param header - How long its header is.
 * @param inside - What the box may hold.
 * @param movie - Where the file's `mdat` boxes are, and which tracks are dropped.
 * @returns The patches, or why it could not be walked.
 */
export const walkMovie = (
  bytes: Uint8Array,
  base: number,
  header: number,
  inside: Holds,
  movie: Movie
): readonly Patch[] | Unreadable => {
  const sink: Sink = { base, patches: [] };
  const failure = walkInto(bytes, sink, inside, header, bytes.length, movie);

  return failure ?? sink.patches;
};
