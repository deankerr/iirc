import { Array as Arr, pipe, Redacted } from "effect";

import type { NewEntry } from "./entry.ts";

/** Every Credential the Daemon holds, by name (CRED-1, CRED-3). */
export type Secrets = ReadonlyMap<string, Redacted.Redacted>;

/** What each removed value becomes in the Log (LOG-6). */
export const redactedText = "<redacted>";

/**
 * What the Log records for a Line built from Credentials, in place of its bytes: the same
 * Line with each value built into it as {@link redactedText}, and whose values those were
 * (LOG-6). Only where a Line is built knows where its values went.
 */
export interface Sensitive {
  readonly bytes: Uint8Array;
  readonly names: readonly string[];
}

interface Needle {
  readonly bytes: Uint8Array;
  readonly name: string;
}

interface Match {
  readonly end: number;
  readonly name: string;
  readonly start: number;
}

const encoder = new TextEncoder();
const placeholder = encoder.encode(redactedText);

// What may stand either side of a value: a space, `:`, or `,`, as well as either end. A
// Channel key such as `pizza` would otherwise redact the word in every Message.
const boundaries: ReadonlySet<number> = new Set([0x20, 0x3a, 0x2c]);

const isBoundary = (bytes: Uint8Array, index: number) =>
  index < 0 || index >= bytes.length || boundaries.has(bytes[index] ?? 0);

// Built once for each set of secrets a host is given, and not once a Line. Longer values
// go first, so that one holding another is taken whole. An empty value would match at
// every boundary, so it matches nothing.
const needlesFor = new WeakMap<Secrets, readonly Needle[]>();

const needlesOf = (secrets: Secrets): readonly Needle[] => {
  const held = needlesFor.get(secrets);

  if (held !== undefined) {
    return held;
  }

  const needles = [...secrets]
    .flatMap(([name, value]) => {
      const bytes = encoder.encode(Redacted.value(value));

      return bytes.length > 0 ? [{ bytes, name }] : [];
    })
    .toSorted((one, other) => other.bytes.length - one.bytes.length);

  needlesFor.set(secrets, needles);

  return needles;
};

const overlaps = (matches: readonly Match[], start: number, end: number) =>
  matches.some((match) => start < match.end && match.start < end);

const findMatches = (bytes: Uint8Array, needles: readonly Needle[]) => {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const matches: Match[] = [];

  for (const { bytes: needle, name } of needles) {
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      const end = at + needle.length;

      if (isBoundary(bytes, at - 1) && isBoundary(bytes, end) && !overlaps(matches, at, end)) {
        matches.push({ end, name, start: at });
      }
    }
  }

  return matches.toSorted((one, other) => one.start - other.start);
};

const replaced = (bytes: Uint8Array, matches: readonly Match[]) => {
  const parts: Uint8Array[] = [];
  let from = 0;

  for (const { end, start } of matches) {
    parts.push(bytes.subarray(from, start), placeholder);
    from = end;
  }

  parts.push(bytes.subarray(from));

  return new Uint8Array(Buffer.concat(parts));
};

// Where each placeholder already in a Line stands, which a Line built from Credentials has
// one of for each name it holds.
const placeholdersIn = (bytes: Uint8Array) => {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: number[] = [];

  for (
    let at = haystack.indexOf(placeholder);
    at !== -1;
    at = haystack.indexOf(placeholder, at + 1)
  ) {
    found.push(at);
  }

  return found;
};

// The names in the order their placeholders stand in the Line, one for each, so that the
// nth `<redacted>` is the nth name (LOG-6). Those a Line built from Credentials held stand
// where their placeholders do. If there are not as many placeholders as names, nothing says
// where they stand, so they go first.
const namesInOrder = (held: readonly string[], bytes: Uint8Array, found: readonly Match[]) => {
  const stands = placeholdersIn(bytes);

  const earlier =
    stands.length === held.length
      ? held.map((name, index) => ({ name, start: stands[index] ?? 0 }))
      : held.map((name) => ({ name, start: -1 }));

  return [...earlier, ...found]
    .toSorted((one, other) => one.start - other.start)
    .map(({ name }) => name);
};

const scrubbed = (needles: readonly Needle[], entry: NewEntry): NewEntry => {
  if (entry._tag !== "Line" && entry._tag !== "Dropped") {
    return entry;
  }

  const matches = findMatches(entry.bytes, needles);

  return matches.length === 0
    ? entry
    : {
        ...entry,
        bytes: replaced(entry.bytes, matches),
        redacted: namesInOrder(entry.redacted ?? [], entry.bytes, matches),
      };
};

/**
 * Replaces every value of `secrets` found as a whole word in a Line or Dropped Entry,
 * in either direction and whatever the command, with {@link redactedText}, and adds the
 * Credentials' names to the Entry's `redacted` (LOG-6). The names go in the order the
 * placeholders stand in the Line, one for each and a repeated Credential repeated, so that
 * the nth `<redacted>` is the nth name. A word is bounded by the Line's start or end, a
 * space, `:`, or `,`. Every other Entry passes through as it is.
 * @param secrets - Every Credential the Daemon holds.
 * @param entries - What is about to be recorded.
 * @returns The same Entries, scrubbed, and the very same array when there are no secrets.
 */
export const scrub = (
  secrets: Secrets,
  entries: Arr.NonEmptyReadonlyArray<NewEntry>
): Arr.NonEmptyReadonlyArray<NewEntry> => {
  if (secrets.size === 0) {
    return entries;
  }

  const needles = needlesOf(secrets);

  return pipe(
    entries,
    Arr.map((entry) => scrubbed(needles, entry))
  );
};
