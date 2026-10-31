/** The most bytes a frame may hold: 8191 of tags, 512 of message, and a space. */
export const maxFrameBytes = 8704;

const lineFeed = 0x0a;
const carriageReturn = 0x0d;

const withoutCarriageReturn = (frame: Uint8Array) =>
  frame.at(-1) === carriageReturn ? frame.subarray(0, -1) : frame;

/** The complete frames found so far, and the bytes still waiting for a line ending. */
export interface Framed {
  readonly frames: readonly Uint8Array[];
  readonly pending: Uint8Array;
}

/**
 * Splits a byte stream into frames. An over-long frame is cut at
 * {@link maxFrameBytes}, so a peer that never ends a line cannot grow the buffer.
 * @param pending - The bytes left over from the previous call.
 * @param chunk - The bytes that just arrived.
 * @returns The frames completed by `chunk`, and the bytes left over.
 */
export const takeFrames = (pending: Uint8Array, chunk: Uint8Array): Framed => {
  const buffer = new Uint8Array(pending.length + chunk.length);
  buffer.set(pending);
  buffer.set(chunk, pending.length);

  const frames: Uint8Array[] = [];
  let start = 0;
  let end = buffer.indexOf(lineFeed);

  while (end !== -1) {
    frames.push(withoutCarriageReturn(buffer.subarray(start, end)));
    start = end + 1;
    end = buffer.indexOf(lineFeed, start);
  }

  while (buffer.length - start > maxFrameBytes) {
    frames.push(buffer.subarray(start, start + maxFrameBytes));
    start += maxFrameBytes;
  }

  return { frames, pending: buffer.slice(start) };
};
