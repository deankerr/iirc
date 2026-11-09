/**
 * Frames a byte stream into Lines as the Transport port says. A Line ends at LF, with one
 * CR before it removed. Empty Lines are skipped. A Line longer than the limit is cut to it
 * and the rest of it dropped. An unfinished Line when the stream ends is dropped, which
 * here means it is simply never given.
 *
 * Ported on purpose from the transcript spike's framer, which pushed byte by byte. This
 * one copies runs between LFs, and holds at most `limit + 1` bytes of an unfinished Line
 * however the bytes arrive, so a hostile Ircd cannot grow it.
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
 * Makes a framer that gives at most `limit` bytes of any one Line.
 * @param limit - The most bytes of one Line to give.
 * @returns A fresh framer with nothing pending.
 */
export const makeFramer = (limit: number): Framer => {
  // One byte past the limit is kept, in case it is the CR of the Line's ending.
  const pending = new Uint8Array(limit + 1);
  let length = 0;
  let overlong = false;

  const finish = (lines: Uint8Array[]) => {
    const end = !overlong && length > 0 && pending[length - 1] === cr ? length - 1 : length;
    const kept = Math.min(end, limit);

    if (kept > 0) {
      lines.push(pending.slice(0, kept));
    }

    length = 0;
    overlong = false;
  };

  return {
    push: (chunk) => {
      const lines: Uint8Array[] = [];
      let start = 0;

      while (start < chunk.length) {
        const found = chunk.indexOf(lf, start);
        const end = found === -1 ? chunk.length : found;

        if (!overlong) {
          const room = pending.length - length;
          const run = end - start;

          pending.set(chunk.subarray(start, start + Math.min(run, room)), length);
          length += Math.min(run, room);
          overlong = run > room;
        }

        if (found === -1) {
          break;
        }

        finish(lines);
        start = found + 1;
      }

      return lines;
    },
  };
};
