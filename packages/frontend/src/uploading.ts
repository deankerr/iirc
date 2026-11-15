/**
 * Uploading from the composer: the files the Owner pasted, dropped, picked, or photographed,
 * each pending until the Daemon answers, and where its link goes in the draft. Each has an
 * anchor, the place in the draft where the caret was when it was added, which follows the
 * draft as it is edited, so the link goes in where the Owner meant it whatever they type
 * meanwhile. The link is only text in the draft, said when the Owner sends it.
 *
 * The runtime names each file with a key, since the core makes no randomness, sends it,
 * and folds back what became of it.
 *
 * @packageDocumentation
 */
import type { OwnerOptionName, UploadsStatus } from "@iirc/api";

import { draftOf, reduceComposers } from "./composer.ts";
import type { Composers, Place } from "./composer.ts";
import { sizeText } from "./uploads.ts";

/** A file the Owner added, as the runtime names and reads it. */
export interface AddedFile {
  /** The runtime's name for it, unique among those pending. */
  readonly key: string;
  readonly name: string;
  /** Its size, in bytes. */
  readonly size: number;
  /** Its type as the browser guessed it, which only decides whether a preview is drawn. */
  readonly type: string;
}

/**
 * Why a file was not kept, or might not have been.
 *
 * - `OverLimit`: it is larger than `maxSize`, refused before it was sent when `before`, or
 *   by the Daemon as it read it.
 * - `StoreUnavailable`: the store that keeps Uploads could not be reached.
 * - `JournalFailed`: the Daemon could not write its Journal.
 * - `NoAnswer`: the Daemon did not answer, `sent` once the file was being sent, so whether
 *   it was kept is unknown, or before, as whether Uploads were on was asked.
 * - `Unexpected`: the Daemon answered in a way the Frontend could not read.
 */
export type UploadFailure =
  | { readonly _tag: "OverLimit"; readonly maxSize: number; readonly before: boolean }
  | { readonly _tag: "StoreUnavailable" }
  | { readonly _tag: "JournalFailed" }
  | { readonly _tag: "NoAnswer"; readonly sent: boolean }
  | { readonly _tag: "Unexpected" };

/** A file pending in a composer: being sent, or failed and shown until dismissed. */
export interface Pending extends AddedFile {
  readonly place: Place;
  /** Where its link goes in the draft. */
  readonly anchor: number;
  /** How many of its bytes were sent, of how many, as the browser last said, if it has. */
  readonly progress: { readonly loaded: number; readonly total: number } | undefined;
  readonly failure: UploadFailure | undefined;
}

/**
 * Every file pending, in the order added, and the note each composer shows while Uploads
 * are off, naming the options not set.
 */
export interface Uploading {
  readonly pending: readonly Pending[];
  readonly notes: ReadonlyMap<Place, readonly OwnerOptionName[]>;
}

/** Nothing pending, and no note. */
export const initialUploading: Uploading = { notes: new Map(), pending: [] };

/**
 * Whether Uploads were on as files were added, as the Daemon said, or that it did not say.
 */
export type Readiness = UploadsStatus | { readonly _tag: "NoAnswer" };

/**
 * What happened.
 *
 * - `Added`: files were added to a composer with its caret at `anchor`, while Uploads
 *   stood as `readiness` says.
 * - `Progressed`: the browser sent more of a file.
 * - `Failed`: a file was not kept, or might not have been.
 * - `Off`: the Daemon said Uploads are off as a file was sent, so it was not kept.
 * - `Dropped`: a file was cancelled, or its failure dismissed.
 * - `NoteDismissed`: the note under a composer was dismissed.
 */
export type UploadingEvent =
  | {
      readonly _tag: "Added";
      readonly place: Place;
      readonly anchor: number;
      readonly files: readonly AddedFile[];
      readonly readiness: Readiness;
    }
  | {
      readonly _tag: "Progressed";
      readonly key: string;
      readonly loaded: number;
      readonly total: number;
    }
  | { readonly _tag: "Failed"; readonly key: string; readonly failure: UploadFailure }
  | { readonly _tag: "Off"; readonly key: string; readonly missing: readonly OwnerOptionName[] }
  | { readonly _tag: "Dropped"; readonly key: string }
  | { readonly _tag: "NoteDismissed"; readonly place: Place };

/**
 * The files pending under a composer, in the order added.
 * @param state - What is pending.
 * @param place - The composer's place.
 * @returns Its files.
 */
export const pendingIn = (state: Uploading, place: Place): readonly Pending[] =>
  state.pending.filter((one) => one.place === place);

/**
 * The files of a state that are to be sent: being sent, and not yet failed.
 * @param state - What is pending.
 * @returns Their keys.
 */
export const sending = (state: Uploading): ReadonlySet<string> =>
  new Set(state.pending.filter((one) => one.failure === undefined).map((one) => one.key));

/**
 * The note under a composer while Uploads are off, naming the options not set, or none.
 * @param state - What is pending.
 * @param place - The composer's place.
 * @returns The options not set, or none.
 */
export const noteIn = (state: Uploading, place: Place): readonly OwnerOptionName[] | undefined =>
  state.notes.get(place);

const withNote = (
  state: Uploading,
  place: Place,
  missing: readonly OwnerOptionName[] | undefined
): Uploading => {
  const notes = new Map(state.notes);

  if (missing === undefined) {
    notes.delete(place);
  } else {
    notes.set(place, missing);
  }

  return { ...state, notes };
};

const without = (state: Uploading, key: string): Uploading => ({
  ...state,
  pending: state.pending.filter((one) => one.key !== key),
});

const changed = (state: Uploading, key: string, change: (one: Pending) => Pending): Uploading => ({
  ...state,
  pending: state.pending.map((one) => (one.key === key ? change(one) : one)),
});

/**
 * The files added, each pending: one larger than `maxSize` failed already, never to be
 * sent, and the rest being sent.
 * @param place - The composer's place.
 * @param anchor - Where the caret was.
 * @param files - The files.
 * @param maxSize - The largest an Upload may be.
 * @returns Them, pending.
 */
const addedOn = (
  place: Place,
  anchor: number,
  files: readonly AddedFile[],
  maxSize: number
): readonly Pending[] =>
  files.map((file) => ({
    ...file,
    anchor,
    failure: file.size > maxSize ? { _tag: "OverLimit", before: true, maxSize } : undefined,
    place,
    progress: undefined,
  }));

/**
 * Folds one event into what is pending. Files added while Uploads are off are not pending:
 * the composer notes it instead, naming the options to set, and the note goes once files
 * are added there while they are on.
 * @param state - What is pending.
 * @param event - What happened.
 * @returns What is pending now.
 */
export const reduceUploading = (state: Uploading, event: UploadingEvent): Uploading => {
  switch (event._tag) {
    case "Added": {
      const { anchor, files, place, readiness } = event;

      if (files.length === 0) {
        return state;
      }

      switch (readiness._tag) {
        case "Off": {
          return withNote(state, place, readiness.missing);
        }

        case "NoAnswer": {
          return {
            ...state,
            pending: [
              ...state.pending,
              ...addedOn(place, anchor, files, Number.POSITIVE_INFINITY).map((one) => ({
                ...one,
                failure: { _tag: "NoAnswer", sent: false } as const,
              })),
            ],
          };
        }

        case "On": {
          return withNote(
            {
              ...state,
              pending: [...state.pending, ...addedOn(place, anchor, files, readiness.maxSize)],
            },
            place,
            undefined
          );
        }

        default: {
          return readiness satisfies never;
        }
      }
    }

    case "Progressed": {
      const { key, loaded, total } = event;

      return changed(state, key, (one) =>
        one.failure === undefined ? { ...one, progress: { loaded, total } } : one
      );
    }

    case "Failed": {
      return changed(state, event.key, (one) => ({ ...one, failure: event.failure }));
    }

    case "Off": {
      const place = state.pending.find((one) => one.key === event.key)?.place;

      return place === undefined
        ? state
        : withNote(without(state, event.key), place, event.missing);
    }

    case "Dropped": {
      return without(state, event.key);
    }

    case "NoteDismissed": {
      return withNote(state, event.place, undefined);
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Where an anchor is once the text it is in was edited from `before` to `after`. The edit is
 * found as the text between their common start and common end. An anchor before the edit,
 * or exactly where text was typed, stays, so text typed at the anchor goes after the link:
 * paste a screenshot, then type a caption, and the link leads. One after the edit moves
 * with the text after it. One the edit replaced goes to the end of what replaced it.
 * @param anchor - Where it was.
 * @param before - The text before.
 * @param after - The text after.
 * @returns Where it is, within the text after.
 */
export const anchorAfter = (anchor: number, before: string, after: string): number => {
  if (before === after) {
    return Math.min(Math.max(anchor, 0), after.length);
  }

  const shortest = Math.min(before.length, after.length);
  let start = 0;

  while (start < shortest && before[start] === after[start]) {
    start += 1;
  }

  let end = 0;

  while (
    end < shortest - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  const beforeEnd = before.length - end;
  const afterEnd = after.length - end;

  let moved = afterEnd;

  if (anchor <= start) {
    moved = anchor;
  } else if (anchor >= beforeEnd) {
    moved = anchor + after.length - before.length;
  }

  return Math.min(Math.max(moved, 0), after.length);
};

/**
 * What is pending once the composers changed, as the Owner typed, recalled, or sent: each
 * anchor follows its draft's text. A draft that came to show its Timeline takes its files
 * with it.
 * @param state - What is pending.
 * @param before - The composers before.
 * @param after - The composers after.
 * @returns What is pending now.
 */
export const followed = (state: Uploading, before: Composers, after: Composers): Uploading => {
  if (state.pending.length === 0 || before === after) {
    return state;
  }

  return {
    ...state,
    pending: state.pending.map((one) => {
      const place = after.carried.get(one.place) ?? one.place;
      const was = draftOf(before, one.place).text;
      const now = draftOf(after, place).text;

      return was === now && place === one.place
        ? one
        : { ...one, anchor: anchorAfter(one.anchor, was, now), place };
    }),
  };
};

/** A link put into a draft: the text after, and where and how much was put in. */
export interface Insertion {
  readonly text: string;
  /** Where it went in. */
  readonly at: number;
  /** How much went in: the link and a space either side it needs. */
  readonly length: number;
}

const spaced = (character: string | undefined) => character !== undefined && !/\s/u.test(character);

/**
 * Puts a link into text at an anchor, with a space on whichever side touches anything but
 * whitespace, so it is a word of its own.
 * @param text - The text.
 * @param anchor - Where it goes.
 * @param link - The link.
 * @returns The text after, and what was put in.
 */
export const insertLink = (text: string, anchor: number, link: string): Insertion => {
  const at = Math.min(Math.max(anchor, 0), text.length);
  const before = spaced(text[at - 1]) ? " " : "";
  const after = spaced(text[at]) ? " " : "";
  const put = `${before}${link}${after}`;

  return { at, length: put.length, text: `${text.slice(0, at)}${put}${text.slice(at)}` };
};

/**
 * Where a caret goes once a link was put in: on past it when it was at or after where it
 * went in, and where it was otherwise.
 * @param caret - Where it was.
 * @param insertion - What was put in.
 * @returns Where it goes.
 */
export const caretAfter = (caret: number, insertion: Insertion): number =>
  caret >= insertion.at ? caret + insertion.length : caret;

/** What a file being kept came to: the composers and what is pending, and its link put in. */
export interface Kept {
  readonly state: Uploading;
  readonly composers: Composers;
  /** Where the link went, and in which composer, or none. */
  readonly inserted: (Insertion & { readonly place: Place }) | undefined;
}

/**
 * A file was kept, and the Daemon gave its link: it is no longer pending, and its link goes
 * into its draft at its anchor. Every other anchor after it moves on past the link, and
 * one at the same place too when it was added later, so files added at one caret land in
 * the order added, whatever order they finish in. With no link, as when no public URL is
 * set, nothing goes in, and the composer notes that Uploads are off.
 * @param state - What is pending.
 * @param composers - The composers.
 * @param key - The file's key.
 * @param link - Its link, or `null` without a public URL.
 * @returns What it came to.
 */
export const uploaded = (
  state: Uploading,
  composers: Composers,
  key: string,
  link: string | null
): Kept => {
  const index = state.pending.findIndex((one) => one.key === key);
  const file = state.pending[index];

  if (file === undefined || file.failure !== undefined) {
    return { composers, inserted: undefined, state };
  }

  if (link === null) {
    return {
      composers,
      inserted: undefined,
      state: withNote(without(state, key), file.place, ["uploads.publicUrl"]),
    };
  }

  const { place } = file;
  const insertion = insertLink(draftOf(composers, place).text, file.anchor, link);

  const pending = state.pending.flatMap((one, at) => {
    if (one.key === key) {
      return [];
    }

    const moves =
      one.place === place &&
      (one.anchor > insertion.at || (one.anchor === insertion.at && at > index));

    return [moves ? { ...one, anchor: one.anchor + insertion.length } : one];
  });

  return {
    composers: reduceComposers(composers, {
      _tag: "Edited",
      text: insertion.text,
      timeline: place,
    }),
    inserted: { ...insertion, place },
    state: { ...state, pending },
  };
};

/**
 * Names in a list, as a sentence does: `a`, `a and b`, or `a, b, and c`.
 * @param names - The names.
 * @returns The list.
 */
const listed = (names: readonly string[]): string => {
  if (names.length <= 2) {
    return names.join(" and ");
  }

  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1) ?? ""}`;
};

/**
 * The note under a composer while Uploads are off, naming the options not set.
 * @param missing - The options not set.
 * @returns The note.
 */
export const offNote = (missing: readonly OwnerOptionName[]): string => {
  if (missing.length === 0) {
    return "Uploads are off.";
  }

  return `Uploads are off until ${listed(missing)} ${missing.length === 1 ? "is" : "are"} set.`;
};

/**
 * Why a file was not kept, or might not have been, in words.
 * @param file - The file.
 * @returns The words, or none while it is being sent.
 */
export const failureText = (
  file: Pick<Pending, "failure" | "name" | "size">
): string | undefined => {
  const { failure, name, size } = file;

  if (failure === undefined) {
    return undefined;
  }

  switch (failure._tag) {
    case "OverLimit": {
      return failure.before
        ? `${name} is ${sizeText(size)}, over the ${sizeText(failure.maxSize)} limit.`
        : `${name} is over the ${sizeText(failure.maxSize)} limit, so it was not kept.`;
    }

    case "StoreUnavailable": {
      return `The store that keeps Uploads could not be reached, so ${name} was not kept.`;
    }

    case "JournalFailed": {
      return `The Daemon could not write its Journal, so ${name} was not kept.`;
    }

    case "NoAnswer": {
      return failure.sent
        ? `The Daemon did not answer, so whether ${name} was kept is unknown.`
        : `The Daemon did not answer, so ${name} was not sent.`;
    }

    case "Unexpected": {
      return `The Daemon answered in a way the Frontend could not read, so whether ${name} was kept is unknown.`;
    }

    default: {
      return failure satisfies never;
    }
  }
};
