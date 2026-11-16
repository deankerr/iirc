/**
 * The boxes that make a movie in an ISO base media file: `moov`, a fragment's `moof`, and
 * `mfra`, walked by a keep-list of what each may hold. A box on it is kept whole, or walked
 * into if it holds boxes the keep-list names, and any other, such as `udta`, `meta`, `uuid`,
 * XMP, or one of a type nobody here has heard of, is retyped `free` and zeroed where it is.
 *
 * @packageDocumentation
 */
import { Unreadable, overfull, readBoxes, retype, typeOf, typesOf } from "./boxes.ts";
import type { Patch, Sink } from "./boxes.ts";

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
// and decoded. A timed-metadata track's sample entries are in `stsd`, which is why a
// location carried by one is not caught.
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

const walkInto = (
  bytes: Uint8Array,
  sink: Sink,
  inside: Holds,
  from: number,
  to: number
): Unreadable | null => {
  const boxes = readBoxes(bytes, from, to);

  if (boxes instanceof Unreadable) {
    return boxes;
  }

  for (const box of boxes) {
    const further = inside.into.get(box.type);

    if (further !== undefined) {
      const failure = walkInto(bytes, sink, further, box.start + box.header, box.end);

      if (failure !== null) {
        return failure;
      }
    } else if (!inside.leaves.has(box.type)) {
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
 * name, however deep.
 * @param bytes - The box, header and all.
 * @param base - Where it begins in the file, which the patches are given in.
 * @param header - How long its header is.
 * @param inside - What the box may hold.
 * @returns The patches, or why it could not be walked.
 */
export const walkMovie = (
  bytes: Uint8Array,
  base: number,
  header: number,
  inside: Holds
): readonly Patch[] | Unreadable => {
  const sink: Sink = { base, patches: [] };
  const failure = walkInto(bytes, sink, inside, header, bytes.length);

  return failure ?? sink.patches;
};
