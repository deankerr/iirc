/**
 * Reading and writing the fixed-width numbers and flags image formats are made of. A read
 * past the end reads zeros, so a caller checks its bounds before it trusts one.
 *
 * What a walker keeps is written, as the walk reaches it, into one buffer allocated once, so
 * that what a walk holds beyond that buffer never depends on how many parts the image has.
 *
 * @packageDocumentation
 */

/**
 * Whether bytes hold ASCII text at an offset.
 * @param bytes - The bytes.
 * @param at - Where the text would begin.
 * @param expected - The text.
 * @returns Whether it is there, whole.
 */
export const asciiAt = (bytes: Uint8Array, at: number, expected: string): boolean => {
  if (at < 0 || at + expected.length > bytes.length) {
    return false;
  }

  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[at + i] !== expected.codePointAt(i)) {
      return false;
    }
  }

  return true;
};

/**
 * The bytes of ASCII text.
 * @param text - The text.
 * @returns Its bytes.
 */
export const ascii = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.codePointAt(0) ?? 0);

/**
 * A big-endian number.
 * @param bytes - The bytes.
 * @param at - Where it begins.
 * @param width - How many bytes it has.
 * @returns The number.
 */
export const readBe = (bytes: Uint8Array, at: number, width: number): number => {
  let value = 0;

  for (let i = 0; i < width; i += 1) {
    value = value * 256 + (bytes[at + i] ?? 0);
  }

  return value;
};

/**
 * A little-endian number.
 * @param bytes - The bytes.
 * @param at - Where it begins.
 * @param width - How many bytes it has.
 * @returns The number.
 */
export const readLe = (bytes: Uint8Array, at: number, width: number): number => {
  let value = 0;

  for (let i = width - 1; i >= 0; i -= 1) {
    value = value * 256 + (bytes[at + i] ?? 0);
  }

  return value;
};

/**
 * A number as big-endian bytes.
 * @param value - The number.
 * @param width - How many bytes.
 * @returns The bytes.
 */
export const be = (value: number, width: number): Uint8Array =>
  Uint8Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** (width - 1 - i)) % 256);

/**
 * Whether a flag is set in a byte.
 * @param byte - The byte.
 * @param flag - The flag, a power of two.
 * @returns Whether it is set.
 */
export const hasFlag = (byte: number, flag: number): boolean => Math.floor(byte / flag) % 2 === 1;

/**
 * Parts, end to end.
 * @param parts - The parts.
 * @returns One array of them all.
 */
export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;

  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }

  return whole;
};

/**
 * A buffer of a capacity fixed when it is made, written from its start. A walker gives it
 * the capacity its output can never exceed, so a write past it is a defect in that bound,
 * and throws rather than drops bytes.
 */
export interface Writer {
  readonly bytes: Uint8Array;
  /** How much is written. A walker may set it back to give up what it wrote since. */
  length: number;
}

/**
 * A writer with nothing written.
 * @param capacity - The most that will be written.
 * @returns The writer.
 */
export const makeWriter = (capacity: number): Writer => ({
  bytes: new Uint8Array(capacity),
  length: 0,
});

const room = (writer: Writer, at: number, size: number) => {
  if (at < 0 || at + size > writer.bytes.length) {
    throw new RangeError("a stripped image outgrew the bound its walker computed");
  }
};

/**
 * Overwrites a number already written, least significant byte first.
 * @param writer - The writer.
 * @param at - Where it begins.
 * @param value - The number.
 * @param width - How many bytes.
 */
export const patchLe = (writer: Writer, at: number, value: number, width: number) => {
  room(writer, at, width);

  for (let i = 0; i < width; i += 1) {
    writer.bytes[at + i] = Math.floor(value / 256 ** i) % 256;
  }
};

/**
 * Copies bytes onto the end.
 * @param writer - The writer.
 * @param part - The bytes.
 */
export const put = (writer: Writer, part: Uint8Array) => {
  room(writer, writer.length, part.length);
  writer.bytes.set(part, writer.length);
  writer.length += part.length;
};

/**
 * Copies a range of bytes onto the end. A short range is copied byte by byte, so that the
 * many small parts an image may be made of make no view each for the collector to sweep.
 * @param writer - The writer.
 * @param bytes - The bytes to copy from.
 * @param from - Where the range begins.
 * @param to - Where it ends.
 */
export const copy = (writer: Writer, bytes: Uint8Array, from: number, to: number) => {
  const size = to - from;

  if (size > 32) {
    put(writer, bytes.subarray(from, to));

    return;
  }

  room(writer, writer.length, size);

  for (let i = 0; i < size; i += 1) {
    writer.bytes[writer.length + i] = bytes[from + i] ?? 0;
  }

  writer.length += size;
};

/**
 * Writes ASCII text onto the end.
 * @param writer - The writer.
 * @param text - The text.
 */
export const putAscii = (writer: Writer, text: string) => {
  room(writer, writer.length, text.length);

  for (let i = 0; i < text.length; i += 1) {
    writer.bytes[writer.length + i] = text.codePointAt(i) ?? 0;
  }

  writer.length += text.length;
};

/**
 * Writes a number onto the end, least significant byte first.
 * @param writer - The writer.
 * @param value - The number.
 * @param width - How many bytes.
 */
export const putLe = (writer: Writer, value: number, width: number) => {
  room(writer, writer.length, width);
  patchLe(writer, writer.length, value, width);
  writer.length += width;
};

/**
 * Leaves room at the end, to be patched once what goes there is known.
 * @param writer - The writer.
 * @param size - How many bytes.
 * @returns Where the room begins.
 */
export const reserve = (writer: Writer, size: number): number => {
  room(writer, writer.length, size);

  const at = writer.length;

  writer.bytes.fill(0, at, at + size);
  writer.length += size;

  return at;
};

/**
 * Overwrites bytes already written.
 * @param writer - The writer.
 * @param at - Where they begin.
 * @param part - The bytes.
 */
export const patch = (writer: Writer, at: number, part: Uint8Array) => {
  room(writer, at, part.length);
  writer.bytes.set(part, at);
};

/**
 * Closes a gap by moving what follows it down.
 * @param writer - The writer.
 * @param gapAt - Where the gap begins.
 * @param gapSize - How wide it is.
 */
export const closeGap = (writer: Writer, gapAt: number, gapSize: number) => {
  writer.bytes.copyWithin(gapAt, gapAt + gapSize, writer.length);
  writer.length -= gapSize;
};

/**
 * What a walk wrote.
 * @param writer - The writer.
 * @returns A view of the bytes written, which holds the whole buffer the writer was made with.
 */
export const written = (writer: Writer): Uint8Array => writer.bytes.subarray(0, writer.length);
