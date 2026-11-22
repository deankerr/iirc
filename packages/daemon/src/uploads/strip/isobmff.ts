/**
 * HEIC, AVIF, MP4 and MOV, which are all boxes in the ISO base media file format, walked from
 * the top by a keep-list of our own. The result is not new bytes but patches over the file,
 * every one the same length as what it covers, so that a video is never read whole: only the
 * header of each top-level box is read, and the boxes that are walked into, `moov`, `moof`,
 * and an image's `meta`, which are small.
 *
 * The walk is pure given what it reads through: no other I/O, no clock, no randomness, and it
 * never throws. A box that is on no keep-list is retyped `free` and zeroed where it is.
 *
 * @packageDocumentation
 */
import { Effect } from "effect";

import {
  Unreadable,
  allZero,
  bad,
  maxPatches,
  overfull,
  readBox,
  retype,
  typeOf,
  typesOf,
} from "./boxes.ts";
import type { Box, Patch, Sink } from "./boxes.ts";
import { walkMeta } from "./heif.ts";
import type { Range } from "./heif.ts";
import { droppedTracks, movieParts, walkMovie } from "./movie.ts";

/** How a file's bytes are read: `length` of them from `at`, which the walk has checked to be inside the file. */
export type Reader = (at: number, length: number) => Effect.Effect<Uint8Array>;

/** What a walk gives: the patches that strip the file, or why it could not be walked. */
export type Planned = { readonly _tag: "Planned"; readonly patches: readonly Patch[] } | Unreadable;

/** Which of the two layouts a file has: a movie's, or an image's with items. */
export type Layout = "movie" | "image";

// The most a box walked into may be, which no movie or photo's metadata comes near.
const maxWalked = 256 * 1024 * 1024;

const keptAlways = typesOf("ftyp mdat");

const keptInMovies = typesOf("wide sidx ssix styp");

const walkedInMovies = typesOf("moov moof mfra");

const walkedInImages = typesOf("moov moof meta");

const mdat = typeOf("mdat");

const meta = typeOf("meta");

const moov = typeOf("moov");

/** What the first pass over the top-level boxes found. */
interface Scan {
  /** The boxes to be read whole and walked into. */
  readonly walked: readonly Box[];
  /** The payloads of the `mdat` boxes. */
  readonly mdats: readonly Range[];
}

// Walks the top-level boxes by their headers alone: what is kept is passed over, what is
// walked into is noted, and anything else is retyped and zeroed where it is.
const scanTop = (
  layout: Layout,
  read: Reader,
  size: number,
  sink: Sink
): Effect.Effect<Scan | Unreadable> =>
  Effect.gen(function* () {
    const keeps = layout === "movie" ? new Set([...keptAlways, ...keptInMovies]) : keptAlways;
    const walkIn = layout === "movie" ? walkedInMovies : walkedInImages;
    const walked: Box[] = [];
    const mdats: Range[] = [];
    let at = 0;
    let count = 0;

    while (at < size) {
      count += 1;

      if (count > maxPatches) {
        return bad("a file of too many boxes");
      }

      const want = Math.min(16, size - at);
      const head = yield* read(at, want);

      if (head.length !== want) {
        return bad("the file could not be read");
      }

      if (want < 8) {
        // What is left is too little to be a box, which is only allowed to be zeros.
        return allZero(head, 0, want) ? { mdats, walked } : bad("a box header is cut short");
      }

      const found = readBox(head, 0, size - at);

      if (found instanceof Unreadable) {
        return found;
      }

      const box: Box = { ...found, end: at + found.end, start: at };

      if (keeps.has(box.type)) {
        if (box.type === mdat) {
          mdats.push({ end: box.end, start: box.start + box.header });
        }
      } else if (walkIn.has(box.type)) {
        walked.push(box);
      } else {
        retype(sink, box);
      }

      const failure = overfull(sink);

      if (failure !== null) {
        return failure;
      }

      at = box.end;
    }

    return { mdats, walked };
  });

// Reads a box whole.
const readWhole = (box: Box, read: Reader): Effect.Effect<Uint8Array | Unreadable> =>
  Effect.gen(function* () {
    const length = box.end - box.start;

    if (length > maxWalked) {
      return bad("a box too large to walk");
    }

    const bytes = yield* read(box.start, length);

    return bytes.length === length ? bytes : bad("the file could not be read");
  });

// Walks a box read whole.
const walkBox = (
  box: Box,
  bytes: Uint8Array,
  file: {
    readonly size: number;
    readonly mdats: readonly Range[];
    readonly dropped: ReadonlySet<number>;
  }
): readonly Patch[] | Unreadable => {
  if (box.type === meta) {
    return walkMeta(bytes, box.start, box.header, file);
  }

  const inside = movieParts.get(box.type);

  return inside === undefined
    ? bad("a box that is not walked")
    : walkMovie(bytes, box.start, box.header, inside, file);
};

/**
 * Walks a file from the top.
 * @param layout - Whether it is a movie or an image.
 * @param read - How its bytes are read.
 * @param size - How long it is.
 * @returns What to patch, or why it could not be walked.
 */
export const plan = (layout: Layout, read: Reader, size: number): Effect.Effect<Planned> =>
  Effect.gen(function* () {
    const patches: Patch[] = [];
    const scan = yield* scanTop(layout, read, size, { base: 0, patches });

    if (scan instanceof Unreadable) {
      return scan;
    }

    if (scan.walked.filter((box) => box.type === meta).length > 1) {
      return bad("more than one meta at the top of an image");
    }

    // Without a `moov`, which tracks the media holds is unknown, so none of it can be kept.
    if (
      layout === "movie" &&
      scan.mdats.length > 0 &&
      !scan.walked.some((box) => box.type === moov)
    ) {
      return bad("a movie with media and no moov");
    }

    // Every `moov` is read before anything is walked, since which tracks it drops decides
    // what is done with a fragment, wherever it lies.
    const wholes = new Map<Box, Uint8Array>();
    const dropped = new Set<number>();

    for (const box of scan.walked) {
      if (box.type === moov) {
        const bytes = yield* readWhole(box, read);

        if (bytes instanceof Unreadable) {
          return bytes;
        }

        wholes.set(box, bytes);

        for (const id of droppedTracks(bytes, box.header)) {
          dropped.add(id);
        }
      }
    }

    for (const box of scan.walked) {
      const bytes = wholes.get(box) ?? (yield* readWhole(box, read));

      if (bytes instanceof Unreadable) {
        return bytes;
      }

      const result = walkBox(box, bytes, { dropped, mdats: scan.mdats, size });

      if (result instanceof Unreadable) {
        return result;
      }

      for (const patch of result) {
        patches.push(patch);
      }

      if (patches.length > maxPatches) {
        return bad("a file of too many parts");
      }
    }

    return { _tag: "Planned", patches };
  });
