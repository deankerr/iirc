import { Array as Arr, pipe } from "effect";
import type { Redacted } from "effect";

import type { NewEntry } from "./entry.ts";

/** Every Credential the Daemon holds, by name (CRED-1, CRED-3). */
export type Secrets = ReadonlyMap<string, Redacted.Redacted>;

/** What each value a sensitive Line was built from becomes in the Log (LOG-6). */
export const redactedText = "<redacted>";

/**
 * What the Log records for a Line built from Credentials, in place of its bytes: the same
 * Line with each value built into it as {@link redactedText}, and whose values those were,
 * in the order they stand (LOG-6). Only where a Line is built knows where its values went,
 * so nothing else ever looks for them ([ADR 0008](../../../docs/adr/0008-credentials-are-held-not-hunted.md)).
 */
export interface Sensitive {
  readonly bytes: Uint8Array;
  readonly names: readonly string[];
}

// Long enough for an Ircd's whole `ERROR` and any defect worth reading, and short enough
// for a `closing`, `closed` or Dropped Entry.
const longestReason = 1024;

// A reason is cut by UTF-16 unit, and a high surrogate left alone at the cut goes too, so
// no pair is split.
const boundedText = (text: string) => {
  if (text.length <= longestReason) {
    return text;
  }

  const cut = text.slice(0, longestReason - 1);
  const last = cut.codePointAt(cut.length - 1) ?? 0;

  return `${last >= 0xd8_00 && last <= 0xdb_ff ? cut.slice(0, -1) : cut}…`;
};

const boundedReason = (entry: NewEntry): NewEntry => {
  if (entry._tag === "Connection" && entry.phase === "closing") {
    return { ...entry, reason: boundedText(entry.reason) };
  }

  if (entry._tag === "Connection" && entry.phase === "closed" && entry.reason !== undefined) {
    return { ...entry, reason: boundedText(entry.reason) };
  }

  return entry._tag === "Dropped" ? { ...entry, reason: boundedText(entry.reason) } : entry;
};

/**
 * Bounds the reason a `closing`, a `closed`, or a Dropped Entry gives. Every other field,
 * and every other Entry, passes through as it is.
 * @param entries - What is about to be recorded.
 * @returns The same Entries, with every reason bounded.
 */
export const boundReasons = (
  entries: Arr.NonEmptyReadonlyArray<NewEntry>
): Arr.NonEmptyReadonlyArray<NewEntry> => pipe(entries, Arr.map(boundedReason));
