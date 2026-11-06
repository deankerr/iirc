const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// A decoder can refuse bytes by throwing, which is turned into a value here and nowhere else.
type Attempt = { readonly _tag: "Read"; readonly text: string } | { readonly _tag: "Unreadable" };

const attempt = (decoder: TextDecoder, bytes: Uint8Array): Attempt => {
  try {
    return { _tag: "Read", text: decoder.decode(bytes) };
  } catch {
    return { _tag: "Unreadable" };
  }
};

class Encoding {
  /** The encoding's canonical WHATWG name, such as `shift_jis`, to store and to show. */
  readonly name: string;
  readonly #decoder: TextDecoder;

  constructor(decoder: TextDecoder) {
    this.name = decoder.encoding;
    this.#decoder = decoder;
  }

  /**
   * @param bytes - The bytes to read.
   * @returns The text, or that the bytes are not valid in this encoding.
   */
  read(bytes: Uint8Array) {
    return attempt(this.#decoder, bytes);
  }
}

/**
 * An encoding to try when bytes are not UTF-8: a WHATWG `TextDecoder` label that this
 * runtime knows, so it can always be used. The only way to get one is
 * {@link parseFallbackEncoding}.
 */
export type FallbackEncoding = Encoding;

/**
 * Turns a label into a {@link FallbackEncoding} (MSG-4). Any WHATWG `TextDecoder` label
 * will do, in any case and with spaces around it, such as `Shift_JIS` or `windows-1251`.
 * Labels are aliases, so `latin1` is `windows-1252`, which is not the Latin-1 that
 * {@link decodeBytes} falls back to last.
 * @param label - What the Owner configured.
 * @returns The encoding, or `undefined` if this runtime does not know the label, or
 * cannot be trusted with it (`x-user-defined` drops every byte above 0x7f in Bun).
 */
export const parseFallbackEncoding = (label: string): FallbackEncoding | undefined => {
  try {
    // Reflect, because Bun's types list a few labels, while any WHATWG label works and an
    // unknown one throws a RangeError, which is the answer wanted here.
    const decoder: unknown = Reflect.construct(TextDecoder, [
      label,
      { fatal: true, ignoreBOM: true },
    ]);

    return decoder instanceof TextDecoder && decoder.encoding !== "x-user-defined"
      ? new Encoding(decoder)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The text of some bytes, and the decoder that read them. */
export type Decoded =
  | { readonly _tag: "utf-8"; readonly text: string }
  | { readonly _tag: "Fallback"; readonly text: string; readonly encoding: string }
  | { readonly _tag: "Latin1"; readonly text: string };

// One character per byte, so the text maps back to the same bytes. Not WHATWG's
// "latin1", which is windows-1252 and maps 0x80 to 0x9f elsewhere.
const latin1 = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");

/**
 * Reads bytes from an Ircd as text (MSG-4): as UTF-8 if they are valid UTF-8, else through
 * the fallback encoding if they are valid in it, else as ISO-8859-1. Decoding never fails,
 * and the last step reads any bytes. A byte order mark is kept, as U+FEFF.
 * @param bytes - The bytes, such as a frame without its line ending.
 * @param fallback - The Network's configured encoding, if it has one.
 * @returns The text, and which decoder produced it.
 */
export const decodeBytes = (bytes: Uint8Array, fallback?: FallbackEncoding): Decoded => {
  const utf8 = attempt(strictUtf8, bytes);

  if (utf8._tag === "Read") {
    return { _tag: "utf-8", text: utf8.text };
  }

  const other = fallback?.read(bytes);

  return fallback !== undefined && other?._tag === "Read"
    ? { _tag: "Fallback", encoding: fallback.name, text: other.text }
    : { _tag: "Latin1", text: latin1(bytes) };
};
