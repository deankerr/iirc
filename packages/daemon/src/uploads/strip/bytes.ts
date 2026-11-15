/**
 * Reading and writing the fixed-width numbers and flags image formats are made of. A read
 * past the end reads zeros, so a caller checks its bounds before it trusts one.
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
 * A number as little-endian bytes.
 * @param value - The number.
 * @param width - How many bytes.
 * @returns The bytes.
 */
export const le = (value: number, width: number): Uint8Array =>
  Uint8Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** i) % 256);

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
