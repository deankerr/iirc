/**
 * Text a Network sent, made safe to put beside other text: every control shown as a
 * symbol, and every bidirectional embedding, override, or isolate it opens closed at its
 * end. Rendering and Previews both draw by it.
 *
 * @packageDocumentation
 */

// The bidirectional formatting characters: embeddings and overrides, their pop, isolates,
// their pop, and the marks.
export const embeddings = new Set([0x20_2a, 0x20_2b, 0x20_2d, 0x20_2e]);
export const popEmbedding = 0x20_2c;
export const isolates = new Set([0x20_66, 0x20_67, 0x20_68]);
export const popIsolate = 0x20_69;

/**
 * A control character as a symbol a reader can see: C0 controls and DEL as their Control
 * Pictures, C1 controls and lone surrogates as the replacement character, and the line and
 * paragraph separators as the newline symbol. Anything else is itself.
 * @param character - One code point, as a string.
 * @returns What to show for it.
 */
const visible = (character: string): string => {
  const code = character.codePointAt(0) ?? 0;

  if (code < 0x20) {
    return String.fromCodePoint(0x24_00 + code);
  }

  if (code === 0x7f) {
    return "\u2421";
  }

  if ((code >= 0x80 && code <= 0x9f) || (code >= 0xd8_00 && code <= 0xdf_ff)) {
    return "\uFFFD";
  }

  // A line or paragraph separator would start a new line, or a new bidirectional paragraph.
  if (code === 0x20_28 || code === 0x20_29) {
    return "\u2424";
  }

  return character;
};

/**
 * Text made safe to put beside other text: every control character shown as a symbol, and
 * every bidirectional embedding, override, or isolate it opens closed at its end, so it
 * cannot reorder what follows it. A view also isolates each run, and this holds without.
 * @param text - Text a Network sent, with no formatting codes left.
 * @returns The text to show.
 */
export const contained = (text: string): string => {
  const open: number[] = [];
  // How many isolates are open, so a pop with none skips the search, and each search
  // drops what it passes over: the work is linear however the text nests.
  let isolating = 0;
  let shown = "";

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (embeddings.has(code) || isolates.has(code)) {
      open.push(code);
      isolating += isolates.has(code) ? 1 : 0;
    } else if (code === popEmbedding) {
      if (open.length > 0 && embeddings.has(open.at(-1) ?? 0)) {
        open.pop();
      }
    } else if (code === popIsolate && isolating > 0) {
      open.length = open.findLastIndex((opened) => isolates.has(opened));
      isolating -= 1;
    }

    shown += visible(character);
  }

  return (
    shown +
    open
      .toReversed()
      .map((code) => String.fromCodePoint(isolates.has(code) ? popIsolate : popEmbedding))
      .join("")
  );
};
