/**
 * Frames a byte stream into Lines as the Transport port says. A Line ends at CR or at LF,
 * and empty Lines are skipped, so CRLF, a bare LF, and a bare CR all end a Line: a CRLF
 * ends the Line and then an empty one, even when it is split across reads. A Line longer
 * than the limit is cut to it, and the rest of it, up to its ending, is dropped. An
 * unfinished Line when the stream ends is dropped, which here means it is never given.
 *
 * Ported on purpose from the transcript spike's framer, which pushed byte by byte. This
 * one copies runs between line endings, and holds at most `limit` bytes of an unfinished
 * Line however the bytes arrive, so a hostile Ircd cannot grow it.
 *
 * @packageDocumentation
 */

const lf = 0x0a;
const cr = 0x0d;

/** A framer for one Connection, fed each read as it arrives. */
export interface Framer {
  /** Takes one read and gives every Line it finished, without line endings. */
  readonly push: (chunk: Uint8Array) => readonly Uint8Array[];
}

/**
 * Where the next line ending is in a read, or its length if there is none.
 * @param chunk - The read.
 * @param from - Where to start looking.
 * @returns The index of the next CR or LF, or the read's length.
 */
const nextEnding = (chunk: Uint8Array, from: number) => {
  for (let index = from; index < chunk.length; index += 1) {
    const byte = chunk[index];

    if (byte === cr || byte === lf) {
      return index;
    }
  }

  return chunk.length;
};

/**
 * Makes a framer that gives at most `limit` bytes of any one Line.
 * @param limit - The most bytes of one Line to give.
 * @returns A fresh framer with nothing pending.
 */
export const makeFramer = (limit: number): Framer => {
  const pending = new Uint8Array(limit);
  let length = 0;

  return {
    push: (chunk) => {
      const lines: Uint8Array[] = [];
      let start = 0;

      while (start < chunk.length) {
        const end = nextEnding(chunk, start);
        // Whatever does not fit is past the limit, and is dropped.
        const kept = Math.min(end - start, pending.length - length);

        pending.set(chunk.subarray(start, start + kept), length);
        length += kept;

        if (end === chunk.length) {
          break;
        }

        if (length > 0) {
          lines.push(pending.slice(0, length));
        }

        length = 0;
        start = end + 1;
      }

      return lines;
    },
  };
};
