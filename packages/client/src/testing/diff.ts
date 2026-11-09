/**
 * A line diff, so a transcript that did not play as written reads as IRC.
 *
 * @packageDocumentation
 */

const context = 3;

interface Edit {
  readonly kind: " " | "-" | "+";
  readonly line: string;
}

// The edits from `before` to `after`, by their longest common subsequence.
const edits = (before: readonly string[], after: readonly string[]): readonly Edit[] => {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const lengths = new Int32Array(rows * columns);

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      lengths[row * columns + column] =
        before[row] === after[column]
          ? (lengths[(row + 1) * columns + column + 1] ?? 0) + 1
          : Math.max(
              lengths[(row + 1) * columns + column] ?? 0,
              lengths[row * columns + column + 1] ?? 0
            );
    }
  }

  const out: Edit[] = [];
  let row = 0;
  let column = 0;

  while (row < before.length || column < after.length) {
    if (row < before.length && column < after.length && before[row] === after[column]) {
      out.push({ kind: " ", line: before[row] ?? "" });
      row += 1;
      column += 1;
    } else if (
      row < before.length &&
      (column === after.length ||
        (lengths[(row + 1) * columns + column] ?? 0) >= (lengths[row * columns + column + 1] ?? 0))
    ) {
      out.push({ kind: "-", line: before[row] ?? "" });
      row += 1;
    } else {
      out.push({ kind: "+", line: after[column] ?? "" });
      column += 1;
    }
  }

  return out;
};

/**
 * Writes the lines that differ between two texts, with three lines of context around
 * each change, and the expected text's line numbers.
 * @param expected - What was written, marked `-` where it differs.
 * @param actual - What happened, marked `+` where it differs.
 * @returns The diff, or an empty string when they are the same.
 */
export const diff = (expected: readonly string[], actual: readonly string[]): string => {
  const all = edits(expected, actual);
  const near = new Set<number>();

  for (const [index, edit] of all.entries()) {
    if (edit.kind !== " ") {
      for (let offset = -context; offset <= context; offset += 1) {
        near.add(index + offset);
      }
    }
  }

  const out: string[] = [];
  let line = 0;
  let previous = -2;

  for (const [index, edit] of all.entries()) {
    if (edit.kind !== "+") {
      line += 1;
    }

    if (near.has(index)) {
      if (index !== previous + 1) {
        out.push(`@@ line ${edit.kind === "+" ? line + 1 : line} @@`);
      }

      out.push(`${edit.kind} ${edit.line}`.trimEnd());
      previous = index;
    }
  }

  return out.join("\n");
};
