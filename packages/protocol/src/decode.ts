/**
 * Bytes to text, for the parser. Internal: `parse` is the interface.
 *
 * @packageDocumentation
 */

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Encodings a fallback may not be. UTF-16 reads every space and colon as half a
 * character, so no Line would split. `x-user-defined` drops bytes above 0x7f in Bun, and
 * `replacement` reads everything as one U+FFFD.
 */
const refused: ReadonlySet<string> = new Set([
  "replacement",
  "utf-16be",
  "utf-16le",
  "x-user-defined",
]);

/** The most labels remembered. A label comes from Configuration, so few are ever seen. */
const rememberedLabels = 64;

const decoders = new Map<string, TextDecoder | undefined>();

const construct = (label: string): TextDecoder | undefined => {
  try {
    // Reflect, because Bun's types list a few labels, while any WHATWG label works and an
    // unknown one throws a RangeError, which is the answer wanted here.
    const decoder: unknown = Reflect.construct(TextDecoder, [
      label,
      { fatal: true, ignoreBOM: true },
    ]);

    return decoder instanceof TextDecoder && !refused.has(decoder.encoding) ? decoder : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The strict decoder for a WHATWG label, or `undefined` if this runtime does not know it
 * or it is refused. The same label always gives the same answer, so remembering it
 * changes nothing but speed.
 * @param label - A WHATWG encoding label, such as `latin1` or `Shift_JIS`.
 * @returns The decoder, which throws on bytes it cannot read.
 */
export const fallbackDecoder = (label: string): TextDecoder | undefined => {
  if (decoders.has(label)) {
    return decoders.get(label);
  }

  const decoder = construct(label);

  if (decoders.size < rememberedLabels) {
    decoders.set(label, decoder);
  }

  return decoder;
};

const attempt = (decoder: TextDecoder, bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * One character per byte, as ISO-8859-1, which reads any bytes. Not WHATWG's `latin1`,
 * which is windows-1252. It is also how a raw parameter holds its bytes.
 * @param bytes - The bytes.
 * @returns A string with one code unit per byte, of the same value.
 */
export const binaryString = (bytes: Uint8Array): string => {
  let text = "";

  for (const byte of bytes) {
    text += String.fromCodePoint(byte);
  }

  return text;
};

const isAscii = (bytes: Uint8Array) => bytes.every((byte) => byte < 0x80);

/**
 * Reads bytes as UTF-8, replacing what is not UTF-8 with U+FFFD. For what a Network
 * promises is UTF-8, such as tag values, and everything under `UTF8ONLY`.
 * @param bytes - The bytes.
 * @returns The text.
 */
export const utf8Lossy = (bytes: Uint8Array): string =>
  isAscii(bytes) ? binaryString(bytes) : lossyUtf8.decode(bytes);

/**
 * Reads bytes as UTF-8 if they are UTF-8, else in the fallback if they are valid in it,
 * else as ISO-8859-1, so it never fails.
 * @param bytes - The bytes.
 * @param fallback - The fallback's decoder, if its label is one this runtime knows.
 * @returns The text.
 */
export const utf8OrElse = (bytes: Uint8Array, fallback: TextDecoder | undefined): string => {
  if (isAscii(bytes)) {
    return binaryString(bytes);
  }

  return (
    attempt(strictUtf8, bytes) ??
    (fallback === undefined ? undefined : attempt(fallback, bytes)) ??
    binaryString(bytes)
  );
};
