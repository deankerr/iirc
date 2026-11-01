/** The most bytes a frame may hold: 8191 of tags, 512 of message, and a space. */
export const maxFrameBytes = 8704;

const lineFeed = 0x0a;
const carriageReturn = 0x0d;

const withoutCarriageReturn = (frame: Uint8Array) =>
  frame.at(-1) === carriageReturn ? frame.subarray(0, -1) : frame;

/** The complete frames found so far, and the bytes still waiting for a line ending. */
export interface Framed {
  /** Which of `frames`, by index, are pieces of a frame over the limit. */
  readonly cut: ReadonlySet<number>;
  /** Whether `pending` continues a frame that was cut, so it is a piece too. */
  readonly cutting: boolean;
  readonly frames: readonly Uint8Array[];
  readonly pending: Uint8Array;
}

/**
 * Splits a byte stream into frames. A frame over {@link maxFrameBytes} is cut into
 * pieces at that limit, so a peer that never ends a line cannot grow the buffer, and
 * every piece is marked, including the last, which is not a Line on its own.
 * @param pending - The bytes left over from the previous call.
 * @param chunk - The bytes that just arrived.
 * @param cutting - The `cutting` the previous call returned.
 * @returns The frames completed by `chunk`, and the bytes left over.
 */
export const takeFrames = (pending: Uint8Array, chunk: Uint8Array, cutting = false): Framed => {
  const buffer = new Uint8Array(pending.length + chunk.length);
  buffer.set(pending);
  buffer.set(chunk, pending.length);

  const frames: Uint8Array[] = [];
  const cut = new Set<number>();
  let continuing = cutting;
  let start = 0;

  const cutUntilWithin = (end: number) => {
    while (end - start > maxFrameBytes) {
      cut.add(frames.length);
      frames.push(buffer.subarray(start, start + maxFrameBytes));
      start += maxFrameBytes;
      continuing = true;
    }
  };

  let lineEnd = buffer.indexOf(lineFeed);

  while (lineEnd !== -1) {
    const end = start + withoutCarriageReturn(buffer.subarray(start, lineEnd)).length;

    cutUntilWithin(end);

    if (continuing) {
      cut.add(frames.length);
    }

    frames.push(buffer.subarray(start, end));
    continuing = false;
    start = lineEnd + 1;
    lineEnd = buffer.indexOf(lineFeed, start);
  }

  // A trailing carriage return may be half a line ending, so it doesn't count yet.
  cutUntilWithin(start + withoutCarriageReturn(buffer.subarray(start)).length);

  return { cut, cutting: continuing, frames, pending: buffer.slice(start) };
};
