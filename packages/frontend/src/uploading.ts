/**
 * Uploading from the composer: the files the Owner pasted, dropped, picked, or photographed,
 * each pending until the Daemon answers, and where its link goes in the draft. Each has an
 * anchor, the place in the draft where the caret was when it was added, which follows the
 * draft as it is edited, so the link goes in where the Owner meant it whatever they type
 * meanwhile. The link is only text in the draft, said when the Owner sends it. A file kept
 * stays listed under its composer until its draft is sent, or it is dismissed, so it can be
 * renamed first, which puts its new link in the draft in place of the old.
 *
 * The runtime names each file with a key, since the core makes no randomness, sends it,
 * and folds back what became of it.
 *
 * @packageDocumentation
 */
import type { OwnerOptionName, Upload, UploadsStatus } from "@iirc/api";
import type { Aliases } from "@iirc/api/ui";

import { typesCredential } from "./commands.ts";
import { draftOf, filesTextOf, linesOf, withFilesText } from "./composer.ts";
import type { Composers, Place } from "./composer.ts";
import { plainOf } from "./formatting.ts";
import { sizeText } from "./uploads.ts";
import type { EditFailure } from "./uploads.ts";

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
 * - `StoreFull`: keeping it would take Uploads past `maxTotal`, in bytes, which they may
 *   hold in all, so nothing was kept.
 * - `StoreUnavailable`: the store that keeps Uploads could not be reached.
 * - `JournalFailed`: the Daemon could not write its Journal.
 * - `NoAnswer`: the Daemon did not answer, `sent` once the file was being sent, so whether
 *   it was kept is unknown, or before, as whether Uploads were on was asked.
 * - `Unexpected`: the Daemon answered in a way the Frontend could not read.
 */
export type UploadFailure =
  | { readonly _tag: "OverLimit"; readonly maxSize: number; readonly before: boolean }
  | { readonly _tag: "StoreFull"; readonly maxTotal: number }
  | { readonly _tag: "StoreUnavailable" }
  | { readonly _tag: "JournalFailed" }
  | { readonly _tag: "NoAnswer"; readonly sent: boolean }
  | { readonly _tag: "Unexpected" };

/**
 * Where a file pending stands.
 *
 * - `Checking`: whether Uploads are on is being asked, before anything is sent.
 * - `Sending`: it is being sent, with how much of it was, of how much, as the browser last
 *   said, if it has.
 * - `Failed`: it was not kept, or might not have been, and is shown until dismissed.
 * - `Kept`: it was kept as `upload`, as last answered, and `link` went into the draft, while
 *   a rename is `renaming`, and why the last one failed, if it did. It is shown until its
 *   draft is sent or it is dismissed.
 */
export type Stage =
  | { readonly _tag: "Checking" }
  | {
      readonly _tag: "Sending";
      readonly progress: { readonly loaded: number; readonly total: number } | undefined;
    }
  | { readonly _tag: "Failed"; readonly failure: UploadFailure }
  | {
      readonly _tag: "Kept";
      readonly upload: Upload;
      readonly link: string;
      readonly renaming: boolean;
      readonly failure: EditFailure | undefined;
    };

/** A file pending in a composer, from the moment it was added until it is let go of. */
export interface Pending extends AddedFile {
  readonly place: Place;
  /** Where its link goes in the draft. */
  readonly anchor: number;
  readonly stage: Stage;
}

/**
 * Every file pending, in the order added, the note each composer shows while Uploads are
 * off, naming the options not set, and the composers whose Owner tried to send while a file
 * added to them was still uploading. That is all that is kept of it: what it says is
 * derived from the files pending, by `heldNoteIn`, and it is let go of once none waits.
 */
export interface Uploading {
  readonly pending: readonly Pending[];
  readonly notes: ReadonlyMap<Place, readonly OwnerOptionName[]>;
  readonly held: ReadonlySet<Place>;
}

/** Nothing pending, and no note. */
export const initialUploading: Uploading = { held: new Set(), notes: new Map(), pending: [] };

/**
 * Whether Uploads were on as files were added, as the Daemon said, or that it did not say.
 */
export type Readiness = UploadsStatus | { readonly _tag: "NoAnswer" };

/**
 * What happened.
 *
 * - `Added`: files were added to a composer with its caret at `anchor`. Each is pending at
 *   once, in the order added, checking whether Uploads are on, so its place in the draft
 *   follows every edit from then.
 * - `Checked`: the Daemon said whether Uploads are on, or did not, as files were added.
 *   Those still checking are let go of while they are off, with a note naming the options
 *   to set, fail without an answer, and are sent while they are on, but for one larger
 *   than `maxSize`, which fails before it is sent.
 * - `Progressed`: the browser sent more of a file.
 * - `Failed`: a file was not kept, or might not have been.
 * - `Off`: the Daemon said Uploads are off as a file was sent, so it was not kept.
 * - `Dropped`: a file was cancelled, or its failure dismissed.
 * - `HeldBack`: the Owner tried to send a draft while a file added to it was uploading, and
 *   it was not sent. The composer says why for as long as a file added to it waits.
 * - `NoteDismissed`: the note under a composer was dismissed, and what it says of a draft
 *   held back.
 * - `Renaming`: a rename of a file kept was sent.
 * - `RenameFailed`: it did not go as asked, or might not have.
 * - `Sent`: a composer's draft was sent, so the files kept for it are let go of.
 */
export type UploadingEvent =
  | {
      readonly _tag: "Added";
      readonly place: Place;
      readonly anchor: number;
      readonly files: readonly AddedFile[];
    }
  | { readonly _tag: "Checked"; readonly keys: readonly string[]; readonly readiness: Readiness }
  | {
      readonly _tag: "Progressed";
      readonly key: string;
      readonly loaded: number;
      readonly total: number;
    }
  | { readonly _tag: "Failed"; readonly key: string; readonly failure: UploadFailure }
  | { readonly _tag: "Off"; readonly key: string; readonly missing: readonly OwnerOptionName[] }
  | { readonly _tag: "Dropped"; readonly key: string }
  | { readonly _tag: "HeldBack"; readonly place: Place }
  | { readonly _tag: "NoteDismissed"; readonly place: Place }
  | { readonly _tag: "Renaming"; readonly key: string }
  | { readonly _tag: "RenameFailed"; readonly key: string; readonly failure: EditFailure }
  | { readonly _tag: "Sent"; readonly place: Place };

/**
 * The files pending under a composer, in the order added.
 * @param state - What is pending.
 * @param place - The composer's place.
 * @returns Its files.
 */
export const pendingIn = (state: Uploading, place: Place): readonly Pending[] =>
  state.pending.filter((one) => one.place === place);

const keysAt = (state: Uploading, tag: Stage["_tag"]): ReadonlySet<string> =>
  new Set(state.pending.filter((one) => one.stage._tag === tag).map((one) => one.key));

/**
 * The files of a state that are being sent.
 * @param state - What is pending.
 * @returns Their keys.
 */
export const sending = (state: Uploading): ReadonlySet<string> => keysAt(state, "Sending");

/**
 * The files of a state whose readiness is still being asked.
 * @param state - What is pending.
 * @returns Their keys.
 */
export const checking = (state: Uploading): ReadonlySet<string> => keysAt(state, "Checking");

/**
 * Why a file pending was not kept, or might not have been, or none while it is not failed.
 * @param file - The file.
 * @returns Why.
 */
export const failureOf = (file: Pick<Pending, "stage">): UploadFailure | undefined =>
  file.stage._tag === "Failed" ? file.stage.failure : undefined;

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

/**
 * Whether a file holds its draft back: it is still being checked or sent.
 * @param file - The file.
 * @returns Whether it waits.
 */
const waits = (file: Pick<Pending, "stage">) =>
  file.stage._tag === "Checking" || file.stage._tag === "Sending";

/**
 * A state with no composer held back that has no file waiting, so a draft held back once
 * says nothing once its files are in, failed, or cancelled, and nothing later brings it
 * back.
 * @param state - What is pending.
 * @returns What is pending now.
 */
const settled = (state: Uploading): Uploading => {
  const waiting = new Set(state.pending.filter(waits).map((one) => one.place));

  return [...state.held].every((place) => waiting.has(place))
    ? state
    : { ...state, held: new Set([...state.held].filter((place) => waiting.has(place))) };
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
 * The stage a file checking comes to once the Daemon said whether Uploads are on: sent
 * while they are, unless larger than `maxSize`, and failed without an answer.
 * @param file - The file.
 * @param readiness - What the Daemon said, Uploads off aside.
 * @returns Its stage.
 */
const checkedStage = (
  file: Pending,
  readiness: Exclude<Readiness, { readonly _tag: "Off" }>
): Stage => {
  if (readiness._tag === "NoAnswer") {
    return { _tag: "Failed", failure: { _tag: "NoAnswer", sent: false } };
  }

  return file.size > readiness.maxSize
    ? { _tag: "Failed", failure: { _tag: "OverLimit", before: true, maxSize: readiness.maxSize } }
    : { _tag: "Sending", progress: undefined };
};

/**
 * Folds what the Daemon said of whether Uploads are on into the files still checking among
 * those it was asked for.
 * @param state - What is pending.
 * @param keys - The files it was asked for.
 * @param readiness - What it said.
 * @returns What is pending now.
 */
const checked = (state: Uploading, keys: readonly string[], readiness: Readiness): Uploading => {
  const asked = new Set(keys);
  const isAsked = (one: Pending) => asked.has(one.key) && one.stage._tag === "Checking";
  const places = new Set(state.pending.filter(isAsked).map((one) => one.place));

  if (places.size === 0) {
    return state;
  }

  if (readiness._tag === "Off") {
    let after: Uploading = {
      ...state,
      pending: state.pending.filter((one) => !isAsked(one)),
    };

    for (const place of places) {
      after = withNote(after, place, readiness.missing);
    }

    return after;
  }

  let after: Uploading = {
    ...state,
    pending: state.pending.map((one) =>
      isAsked(one) ? { ...one, stage: checkedStage(one, readiness) } : one
    ),
  };

  if (readiness._tag === "On") {
    for (const place of places) {
      after = withNote(after, place, undefined);
    }
  }

  return after;
};

const folded = (state: Uploading, event: UploadingEvent): Uploading => {
  switch (event._tag) {
    case "Added": {
      const { anchor, files, place } = event;

      return files.length === 0
        ? state
        : {
            ...state,
            pending: [
              ...state.pending,
              ...files.map((file): Pending => ({
                ...file,
                anchor,
                place,
                stage: { _tag: "Checking" },
              })),
            ],
          };
    }

    case "Checked": {
      return checked(state, event.keys, event.readiness);
    }

    case "Progressed": {
      const { key, loaded, total } = event;

      return changed(state, key, (one) =>
        one.stage._tag === "Sending"
          ? { ...one, stage: { ...one.stage, progress: { loaded, total } } }
          : one
      );
    }

    case "Failed": {
      return changed(state, event.key, (one) => ({
        ...one,
        stage: { _tag: "Failed", failure: event.failure },
      }));
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

    case "HeldBack": {
      return { ...state, held: new Set(state.held).add(event.place) };
    }

    case "NoteDismissed": {
      const held = new Set(state.held);

      held.delete(event.place);

      return withNote({ ...state, held }, event.place, undefined);
    }

    case "Renaming": {
      return changed(state, event.key, (one) =>
        one.stage._tag === "Kept"
          ? { ...one, stage: { ...one.stage, failure: undefined, renaming: true } }
          : one
      );
    }

    case "RenameFailed": {
      return changed(state, event.key, (one) =>
        one.stage._tag === "Kept"
          ? { ...one, stage: { ...one.stage, failure: event.failure, renaming: false } }
          : one
      );
    }

    case "Sent": {
      return {
        ...state,
        pending: state.pending.filter(
          (one) => !(one.place === event.place && one.stage._tag === "Kept")
        ),
      };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * Folds one event into what is pending. Files added are pending at once, checking, and
 * those found while Uploads are off are let go of: the composer notes it instead, naming
 * the options to set, and the note goes once files are found there while they are on.
 * @param state - What is pending.
 * @param event - What happened.
 * @returns What is pending now.
 */
export const reduceUploading = (state: Uploading, event: UploadingEvent): Uploading =>
  settled(folded(state, event));

/**
 * One edit of a draft's text: what lay from `start` to `oldEnd` before lies from `start` to
 * `newEnd` after, and the rest is as it was.
 */
export interface Edit {
  readonly start: number;
  readonly oldEnd: number;
  readonly newEnd: number;
}

/**
 * Where the Owner's selection was as they edited a draft: where it began just before the
 * edit, and where the caret was just after.
 */
export interface Typing {
  readonly from: number;
  readonly caret: number;
}

/**
 * The edit found as the text between the common start and the common end of the text
 * before and after. Where text repeats, more than one edit explains the change, and this
 * guesses the one that keeps the most of the start.
 * @param before - The text before.
 * @param after - The text after.
 * @returns The edit.
 */
const diffed = (before: string, after: string): Edit => {
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

  return { newEnd: after.length - end, oldEnd: before.length - end, start };
};

/**
 * The edit that changed a draft's text from `before` to `after`. Where the Owner typed it,
 * the selection says it exactly: it began at the lesser of where the selection began and
 * where the caret is after, and ended at the caret, what it replaced being as much longer
 * or shorter as the text was. That is taken when the text agrees with it, outside what it
 * says was replaced. Otherwise, as for an undo, a drag, or a change the composer made
 * itself, such as a completion or a recall, the edit is found from the texts alone.
 * @param before - The text before.
 * @param after - The text after.
 * @param typing - Where the Owner's selection was, if they typed it.
 * @returns The edit.
 */
export const editOf = (before: string, after: string, typing?: Typing): Edit => {
  if (typing !== undefined) {
    const start = Math.min(typing.from, typing.caret);
    const newEnd = typing.caret;
    const oldEnd = newEnd + before.length - after.length;

    if (
      start >= 0 &&
      newEnd <= after.length &&
      oldEnd >= start &&
      oldEnd <= before.length &&
      before.slice(0, start) === after.slice(0, start) &&
      before.slice(oldEnd) === after.slice(newEnd)
    ) {
      return { newEnd, oldEnd, start };
    }
  }

  return diffed(before, after);
};

/**
 * Where an anchor is once the text it is in was edited from `before` to `after`. An anchor
 * before the edit, or exactly where text was typed, stays, so text typed at the anchor goes
 * after the link: paste a screenshot, then type a caption, and the link leads. One after
 * the edit moves with the text after it. One the edit replaced goes to the end of what
 * replaced it.
 * @param anchor - Where it was.
 * @param before - The text before.
 * @param after - The text after.
 * @param typing - Where the Owner's selection was, if they typed it.
 * @returns Where it is, within the text after.
 */
export const anchorAfter = (
  anchor: number,
  before: string,
  after: string,
  typing?: Typing
): number => {
  if (before === after) {
    return Math.min(Math.max(anchor, 0), after.length);
  }

  const { newEnd, oldEnd, start } = editOf(before, after, typing);
  let moved = newEnd;

  if (anchor <= start) {
    moved = anchor;
  } else if (anchor >= oldEnd) {
    moved = anchor + after.length - before.length;
  }

  return Math.min(Math.max(moved, 0), after.length);
};

/**
 * Where files added to a composer are anchored, from the caret as it was read in the text
 * it showed then. While a command stands over a draft set aside, the files belong to the
 * draft, where the command's caret means nothing, so they go at its end.
 * @param composers - The composers, as they are now.
 * @param place - The composer's place.
 * @param caret - The caret, when the files were added.
 * @param text - The plain text the composer showed then.
 * @returns The anchor, within the text the files belong to.
 */
export const anchorAdded = (
  composers: Composers,
  place: Place,
  caret: number,
  text: string
): number => {
  const draft = draftOf(composers, place);

  return draft.aside === undefined
    ? anchorAfter(caret, text, plainOf(draft.text))
    : plainOf(draft.aside.text).length;
};

/**
 * What is pending once the composers changed, as the Owner typed, recalled, or sent: each
 * anchor follows its draft's text. A draft that came to show its Timeline takes its files
 * with it.
 * @param state - What is pending.
 * @param before - The composers before.
 * @param after - The composers after.
 * @param typing - Where the Owner's selection was in the draft they typed in, if they did.
 * @returns What is pending now.
 */
export const followed = (
  state: Uploading,
  before: Composers,
  after: Composers,
  typing?: Typing & { readonly place: Place }
): Uploading => {
  if (state.pending.length === 0 || before === after) {
    return state;
  }

  const carriedTo = (place: Place) => after.carried.get(place) ?? place;

  return settled({
    // A send held back stays held with the files it waits on.
    held: new Set([...state.held].map(carriedTo)),
    notes: state.notes,
    pending: state.pending.map((one) => {
      const place = carriedTo(one.place);
      // An anchor is a place in the plain text, as a caret is.
      const was = plainOf(filesTextOf(before, one.place));
      const now = plainOf(filesTextOf(after, place));
      const typed = place === one.place && typing?.place === place ? typing : undefined;

      return was === now && place === one.place
        ? one
        : { ...one, anchor: anchorAfter(one.anchor, was, now, typed), place };
    }),
  });
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
  /** Where the link went, and in which composer, or none, as while the draft is set aside, which has no caret. */
  readonly inserted: (Insertion & { readonly place: Place }) | undefined;
}

/**
 * A file was kept, and the Daemon gave its Upload: it stays listed, kept, and its link goes
 * into its draft at its anchor. Every other anchor after it moves on past the link, and
 * one at the same place too when it was added later, so files added at one caret land in
 * the order added, whatever order they finish in. With no link, as when no public URL is
 * set, nothing goes in, the file is let go of, and the composer notes that Uploads are off.
 * @param state - What is pending.
 * @param composers - The composers.
 * @param key - The file's key.
 * @param upload - Its Upload, as the Daemon answered.
 * @returns What it came to.
 */
export const uploaded = (
  state: Uploading,
  composers: Composers,
  key: string,
  upload: Upload
): Kept => {
  const { link } = upload;
  const index = state.pending.findIndex((one) => one.key === key);
  const file = state.pending[index];

  if (file?.stage._tag !== "Sending") {
    return { composers, inserted: undefined, state };
  }

  if (link === null) {
    return {
      composers,
      inserted: undefined,
      state: settled(withNote(without(state, key), file.place, ["uploads.publicUrl"])),
    };
  }

  const { place } = file;
  const insertion = insertLink(plainOf(filesTextOf(composers, place)), file.anchor, link);

  const pending = state.pending.map((one, at): Pending => {
    if (one.key === key) {
      return {
        ...one,
        anchor: insertion.at,
        stage: { _tag: "Kept", failure: undefined, link, renaming: false, upload },
      };
    }

    const moves =
      one.place === place &&
      (one.anchor > insertion.at || (one.anchor === insertion.at && at > index));

    return moves ? { ...one, anchor: one.anchor + insertion.length } : one;
  });

  return {
    composers: withFilesText(composers, place, insertion.text),
    // No caret is in a draft set aside, so none moves.
    inserted: draftOf(composers, place).aside === undefined ? { ...insertion, place } : undefined,
    state: settled({ ...state, pending }),
  };
};

/**
 * A link put into a draft once more, renamed: where the old one stood in the text before,
 * as many times as it did, oldest place first, and how long the old and new links are.
 */
export interface Relink {
  readonly starts: readonly number[];
  readonly from: number;
  readonly to: number;
}

/**
 * Where a place in a draft goes once a link in it was relinked: on by the change in length
 * of each link wholly before it, and to the end of the new link when it was within the
 * old, so a caret or an anchor stays in the text around it.
 * @param at - Where it was.
 * @param relink - What was relinked.
 * @returns Where it goes.
 */
export const relinkedAt = (at: number, relink: Relink): number => {
  const { from, starts, to } = relink;
  let moved = 0;

  for (const start of starts) {
    if (at >= start + from) {
      moved += to - from;
    } else {
      return at > start ? start + moved + to : at + moved;
    }
  }

  return at + moved;
};

/**
 * Where a link stands in a text, as many times as it does, each after the last.
 * @param text - The text.
 * @param link - The link.
 * @returns Where each begins.
 */
const placesOf = (text: string, link: string): readonly number[] => {
  const starts: number[] = [];
  let at = text.indexOf(link);

  while (at !== -1) {
    starts.push(at);
    at = text.indexOf(link, at + link.length);
  }

  return starts;
};

/** What a file kept came to once renamed: the composers and what is pending, and what was relinked. */
export interface Renamed {
  readonly state: Uploading;
  readonly composers: Composers;
  /** Where its old link stood in which composer, or none when nothing was replaced, or the draft is set aside, which has no caret. */
  readonly relinked: (Relink & { readonly place: Place }) | undefined;
}

/**
 * A file kept was renamed, and the Daemon gave its Upload as it is now: it is held as that,
 * and its new link goes into its draft in place of its old, wherever the old now stands,
 * however the Owner edited around it. Every other anchor there follows, by `relinkedAt`.
 * Where the Owner edited the old link away, or no public URL gives a new one, the draft
 * stays as it is.
 * @param state - What is pending.
 * @param composers - The composers.
 * @param key - The file's key.
 * @param upload - Its Upload, as the Daemon answered the rename.
 * @returns What it came to.
 */
export const renamed = (
  state: Uploading,
  composers: Composers,
  key: string,
  upload: Upload
): Renamed => {
  const file = state.pending.find((one) => one.key === key);

  if (file?.stage._tag !== "Kept") {
    return { composers, relinked: undefined, state };
  }

  const { place, stage } = file;
  const was = stage.link;
  const now = upload.link ?? was;
  const text = plainOf(filesTextOf(composers, place));
  const starts = now === was ? [] : placesOf(text, was);

  const held = changed(state, key, (one) => ({
    ...one,
    stage: { ...stage, link: now, renaming: false, upload },
  }));

  if (starts.length === 0) {
    return { composers, relinked: undefined, state: held };
  }

  const relink: Relink = { from: was.length, starts, to: now.length };

  return {
    composers: withFilesText(composers, place, text.split(was).join(now)),
    relinked: draftOf(composers, place).aside === undefined ? { ...relink, place } : undefined,
    state: {
      ...held,
      pending: held.pending.map((one) =>
        one.place === place ? { ...one, anchor: relinkedAt(one.anchor, relink) } : one
      ),
    },
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
 * Why a composer's draft cannot be sent yet, or none: a file added to it is still being
 * checked or sent, so its link is not in yet. A failed or kept file holds nothing back, nor
 * does a command started over the draft, whose files belong to the draft set aside, and nor
 * does a draft that types a Credential's value, which is let go of as it is submitted.
 * @param state - What is pending.
 * @param composers - The composers.
 * @param place - The composer's place.
 * @param aliases - The aliases, one of which a line may expand to a Credential's value.
 * @returns Why, in words, or none.
 */
export const heldBack = (
  state: Uploading,
  composers: Composers,
  place: Place,
  aliases: Aliases
): string | undefined => {
  const waiting = pendingIn(state, place).filter(waits);

  // A command over the draft is not what they wait for: they belong to the draft set aside.
  if (
    waiting.length === 0 ||
    draftOf(composers, place).aside !== undefined ||
    linesOf(draftOf(composers, place).text).some((line) => typesCredential(line, aliases))
  ) {
    return undefined;
  }

  const names = listed(waiting.map((one) => one.name));

  return `Wait for ${names} to finish uploading, or cancel ${waiting.length === 1 ? "it" : "them"}.`;
};

/**
 * What a composer says of a send held back, or none: while the Owner's attempt stands, why
 * the draft cannot be sent now, which names only the files still checking or being sent.
 * @param state - What is pending.
 * @param composers - The composers.
 * @param place - The composer's place.
 * @param aliases - The aliases, as `heldBack` takes them.
 * @returns Why, in words, or none.
 */
export const heldNoteIn = (
  state: Uploading,
  composers: Composers,
  place: Place,
  aliases: Aliases
): string | undefined =>
  state.held.has(place) ? heldBack(state, composers, place, aliases) : undefined;

/**
 * Why a file was not kept, or might not have been, in words.
 * @param file - The file.
 * @returns The words, or none while it is being sent.
 */
export const failureText = (
  file: Pick<Pending, "name" | "size"> & { readonly failure: UploadFailure | undefined }
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

    case "StoreFull": {
      return `Storage is full: uploads can total ${sizeText(failure.maxTotal)}, so ${name} was not kept.`;
    }

    case "StoreUnavailable": {
      return `The storage that keeps uploads could not be reached, so ${name} was not kept.`;
    }

    case "JournalFailed": {
      return `The daemon could not write its history, so ${name} was not kept.`;
    }

    case "NoAnswer": {
      return failure.sent
        ? `The daemon did not answer, so it's unknown whether ${name} was kept.`
        : `The daemon did not answer, so ${name} was not sent.`;
    }

    case "Unexpected": {
      return `The daemon sent a reply this device could not read, so it's unknown whether ${name} was kept.`;
    }

    default: {
      return failure satisfies never;
    }
  }
};
