/** How many random bytes make an Upload's id: 80 bits. */
export const idBytes = 10;

/** How many characters an Upload's id has: five bits each. */
export const idLength = 16;

/** Crockford's base32, lower case: no `i`, `l`, `o` or `u`, so an id is hard to misread. */
const crockfordAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";

const bitsPerCharacter = 5;

/**
 * The text of an Upload's id, big-endian, five bits to a character.
 * @param bytes - Exactly `idBytes` bytes.
 * @returns `idLength` lower case Crockford base32 characters.
 */
export const encodeUploadId = (bytes: Uint8Array): string => {
  if (bytes.length !== idBytes) {
    throw new RangeError(`An Upload id is ${idBytes} bytes, not ${bytes.length}`);
  }

  let text = "";
  let buffer = 0;
  let held = 0;

  for (const byte of bytes) {
    buffer = buffer * 256 + byte;
    held += 8;

    while (held >= bitsPerCharacter) {
      held -= bitsPerCharacter;
      text += crockfordAlphabet[Math.floor(buffer / 2 ** held) % 32];
    }

    buffer %= 2 ** held;
  }

  return text;
};

/**
 * Whether text has the shape of an Upload's id.
 * @param text - Any text, such as a path segment.
 * @returns True when it is `idLength` characters of the alphabet.
 */
export const isUploadId = (text: string): boolean => /^[0-9a-hjkmnp-tv-z]{16}$/u.test(text);
