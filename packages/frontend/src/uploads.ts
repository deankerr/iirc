/**
 * The Uploads, as a list the options show beside them: every live one held, newest first,
 * and the deleted ones too while those are asked for, as pages read and the stream of
 * their Changes give them, where the next page begins, and
 * the sequence of the last Change folded in, which the stream is followed after. A page only
 * ever extends the list at its end, and the stream only ever gives what is newer than
 * everything held, so an Upload is held once. Beside them, the ids of those whose bytes the
 * Daemon found gone from the Store. Its link, whether it gets a thumbnail, and its size are
 * derived as it is drawn, never held. Beside them, what the Owner asked of each,
 * a rename or a delete, while it waits on the Daemon or after it failed.
 *
 * @packageDocumentation
 */
import { uploadNameMaxLength } from "@iirc/api";
import type { TimelineItem, Upload, UploadId } from "@iirc/api";

import { contained } from "./contained.ts";

/**
 * The Uploads held, newest first, where the next page begins, and how far they were
 * folded: `next` is an Upload's id, as a page gave it, or `null` once the last page was
 * read, and `through` the sequence of the last Upload Change folded in. Both are none
 * before the first page was read. `unpaged` holds each Upload a Change gave that was not
 * held, as that Change gave it, so a later page read before the Change, and arriving after
 * it, is folded as the Change left it rather than bringing back what it undid. Whether
 * deleted Uploads are shown is `showDeleted`: while it is not, a deleted one is never held.
 * `missing` is the ids of the live Uploads whose bytes the Daemon confirmed are gone, as the
 * stream last said, which is the one place a row learns it from.
 */
export interface Uploads {
  readonly missing: ReadonlySet<UploadId>;
  readonly showDeleted: boolean;
  readonly uploads: readonly Upload[];
  readonly next: UploadId | null | undefined;
  readonly through: number | undefined;
  readonly unpaged: ReadonlyMap<UploadId, Upload>;
}

/** Nothing held, no page read, and the deleted not shown. */
export const initialUploads: Uploads = {
  missing: new Set(),
  next: undefined,
  showDeleted: false,
  through: undefined,
  unpaged: new Map(),
  uploads: [],
};

/** A page of the Uploads, newest first, as the API gives it. */
export interface UploadsPage {
  readonly uploads: readonly Upload[];
  readonly next: UploadId | null;
  readonly through: number;
}

/**
 * What happened.
 *
 * - `Paged`: a page was read, from just after `after`, or the first page when none.
 * - `Changed`: the stream gave an Upload whole, as it is now, by the Change at `sequence`.
 * - `Answered`: the Daemon answered a rename or a delete with the Upload as it is now,
 *   ahead of the Change the stream gives for it.
 * - `Said`: a read of an Upload, made because a Message of ours may have said it, gave
 *   where it was said, which replaces only that, so a read that lands late never undoes a
 *   Change folded since.
 * - `Missing`: the stream gave the ids of every Upload whose bytes are gone, whole, which
 *   replaces those held.
 * - `DeletedShown`: the Owner chose whether the deleted Uploads show, which starts the list
 *   over, to be read again with them or without.
 * - `Forgotten`: the page signed out, so nothing is held.
 */
export type UploadsEvent =
  | { readonly _tag: "Paged"; readonly after: UploadId | undefined; readonly page: UploadsPage }
  | { readonly _tag: "Changed"; readonly sequence: number; readonly upload: Upload }
  | { readonly _tag: "Answered"; readonly upload: Upload }
  | { readonly _tag: "Said"; readonly id: UploadId; readonly said: Upload["said"] }
  | { readonly _tag: "Missing"; readonly ids: readonly UploadId[] }
  | { readonly _tag: "DeletedShown"; readonly shown: boolean }
  | { readonly _tag: "Forgotten" };

/**
 * Whether an Upload is held in the list: any while the deleted show, else only a live one.
 * @param state - The Uploads held, for whether the deleted show.
 * @param upload - The Upload.
 * @returns Whether the list holds it.
 */
const listed = (state: Pick<Uploads, "showDeleted">, upload: Upload): boolean =>
  state.showDeleted || upload.deleted === undefined;

/**
 * A page's Uploads after those held, passing over any already held, each as a Change since
 * gave it, if one did, and passing over any deleted unless they show.
 * @param state - The Uploads held.
 * @param page - The page's Uploads, newest first.
 * @returns The Uploads held now.
 */
const extended = (state: Uploads, page: readonly Upload[]): readonly Upload[] => {
  const { unpaged, uploads: held } = state;
  const ids = new Set(held.map((upload) => upload.id));
  const added: Upload[] = [];

  for (const read of page) {
    const upload = unpaged.get(read.id) ?? read;

    if (!ids.has(upload.id) && listed(state, upload)) {
      ids.add(upload.id);
      added.push(upload);
    }
  }

  return [...held, ...added];
};

/**
 * The Uploads held once one is as an answer or a Change gives it: replaced in place, or
 * dropped when deleted unless the deleted show.
 * @param state - The Uploads held.
 * @param upload - The Upload, as it is now.
 * @returns The Uploads held now.
 */
const replaced = (state: Uploads, upload: Upload): readonly Upload[] =>
  listed(state, upload)
    ? state.uploads.map((one) => (one.id === upload.id ? upload : one))
    : state.uploads.filter((one) => one.id !== upload.id);

/**
 * Whether a Change gives an Upload that a page not yet read holds: one uploaded before the
 * oldest held, while more pages follow, as a rename of an old Upload is. That page gives
 * it as it is when read, so the Change is passed over rather than put first, out of order.
 * @param state - The Uploads held.
 * @param upload - The Upload the Change gives.
 * @returns Whether a later page holds it.
 */
const unread = (state: Uploads, upload: Upload): boolean => {
  const oldest = state.uploads.at(-1);

  return (
    state.next !== null && state.next !== undefined && oldest !== undefined && upload.at < oldest.at
  );
};

/**
 * Folds one event into the Uploads held. A page is folded only when it was read from where
 * the list stands, the first page into an empty list and each later one from `next`, so one
 * read twice, or late, is folded once. Only the first page says how far the list was folded,
 * since the stream gives what is newer than any later page. A Change is folded only when it
 * is after the last folded in: one held is replaced in place, or dropped once deleted unless
 * the deleted show, and one not held is newer than all, so it goes first, unless it is
 * deleted and the deleted do not show, or a page not yet read holds it, when it is kept
 * aside for that page. An answer to a rename or a delete is folded at once, into one held
 * only, and moves nothing on, since the stream still gives its Change. Choosing whether the
 * deleted show starts the list over, as it was before any page was read, and changes
 * nothing when it is chosen as it already is. Which are missing is replaced whole when the
 * stream says, and empties with the list, as a restarted stream says it again.
 * @param state - The Uploads held.
 * @param event - What happened.
 * @returns The Uploads held now.
 */
export const reduceUploads = (state: Uploads, event: UploadsEvent): Uploads => {
  switch (event._tag) {
    case "Paged": {
      const { after, page } = event;

      if (after !== state.next) {
        return state;
      }

      const unpaged = new Map(state.unpaged);

      for (const read of page.uploads) {
        unpaged.delete(read.id);
      }

      return {
        missing: state.missing,
        next: page.next,
        showDeleted: state.showDeleted,
        through: state.through ?? page.through,
        unpaged,
        uploads: extended(state, page.uploads),
      };
    }

    case "Changed": {
      const { sequence, upload } = event;

      if (state.through === undefined || sequence <= state.through) {
        return state;
      }

      const known = state.uploads.some((one) => one.id === upload.id);
      const after = { ...state, through: sequence };

      if (known) {
        return { ...after, uploads: replaced(state, upload) };
      }

      return !listed(state, upload) || unread(state, upload)
        ? { ...after, unpaged: new Map(state.unpaged).set(upload.id, upload) }
        : { ...after, uploads: [upload, ...state.uploads] };
    }

    case "Answered": {
      const { upload } = event;

      return state.uploads.some((one) => one.id === upload.id)
        ? { ...state, uploads: replaced(state, upload) }
        : state;
    }

    case "Said": {
      const { id, said } = event;

      return {
        ...state,
        uploads: state.uploads.map((one) => (one.id === id ? { ...one, said } : one)),
      };
    }

    case "Missing": {
      return { ...state, missing: new Set(event.ids) };
    }

    case "DeletedShown": {
      return event.shown === state.showDeleted
        ? state
        : { ...initialUploads, showDeleted: event.shown };
    }

    case "Forgotten": {
      return initialUploads;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * An Upload's deletion in words, for the row to say beside when: `expired` when the Daemon
 * deleted it once it was old, else `deleted`.
 * @param why - Why it was deleted.
 * @returns The word.
 */
export const deletedText = (why: NonNullable<Upload["deleted"]>["why"]): "expired" | "deleted" =>
  why === "expired" ? "expired" : "deleted";

/** What the Owner asked of an Upload in the list: a new name, or that it be deleted. */
export type Asked = "Rename" | "Delete";

/**
 * Why a rename or a delete did not go as asked, or might not have.
 *
 * - `UnknownUpload`: the Daemon has no such Upload, or it was deleted.
 * - `JournalFailed`: the Daemon could not write its Journal.
 * - `NoAnswer`: the Daemon did not answer, so whether it was done is unknown.
 * - `Unexpected`: the Daemon answered in a way the Frontend could not read.
 */
export type EditFailure =
  | { readonly _tag: "UnknownUpload" }
  | { readonly _tag: "JournalFailed" }
  | { readonly _tag: "NoAnswer" }
  | { readonly _tag: "Unexpected" };

/**
 * Where what the Owner asked of one Upload stands: `Waiting` on the Daemon, or `Failed`,
 * shown in its row until it is asked again.
 */
export type UploadEdit =
  | { readonly _tag: "Waiting"; readonly of: Asked }
  | { readonly _tag: "Failed"; readonly of: Asked; readonly failure: EditFailure };

/**
 * What the Owner asked of the Uploads listed: the one a delete is being confirmed for, if
 * any, and where each rename or delete sent stands, by its Upload's id, until it is done.
 */
export interface UploadEdits {
  readonly asking: UploadId | undefined;
  readonly doing: ReadonlyMap<UploadId, UploadEdit>;
}

/** Nothing asked. */
export const initialUploadEdits: UploadEdits = { asking: undefined, doing: new Map() };

/**
 * What happened.
 *
 * - `AskedToDelete`: the Owner asked to delete an Upload, which is confirmed first.
 * - `Closed`: the Owner let the question go, deleting nothing.
 * - `Sent`: a rename or a delete was sent, which closes the question.
 * - `Answered`: the Daemon answered it, done or failed as `failure` says.
 * - `Forgotten`: the page signed out.
 */
export type UploadEditsEvent =
  | { readonly _tag: "AskedToDelete"; readonly id: UploadId }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Sent"; readonly id: UploadId; readonly of: Asked }
  | { readonly _tag: "Answered"; readonly id: UploadId; readonly failure: EditFailure | undefined }
  | { readonly _tag: "Forgotten" };

/**
 * Folds one event into what the Owner asked of the Uploads listed. A rename or a delete is
 * held while it waits, and once failed until it is sent again; one done is let go of, as
 * the Upload as answered shows it.
 * @param state - What was asked.
 * @param event - What happened.
 * @returns What is asked now.
 */
export const reduceUploadEdits = (state: UploadEdits, event: UploadEditsEvent): UploadEdits => {
  switch (event._tag) {
    case "AskedToDelete": {
      return { ...state, asking: event.id };
    }

    case "Closed": {
      return { ...state, asking: undefined };
    }

    case "Sent": {
      return {
        asking: event.of === "Delete" ? undefined : state.asking,
        doing: new Map(state.doing).set(event.id, { _tag: "Waiting", of: event.of }),
      };
    }

    case "Answered": {
      const { failure, id } = event;
      const was = state.doing.get(id);

      if (was?._tag !== "Waiting") {
        return state;
      }

      const doing = new Map(state.doing);

      if (failure === undefined) {
        doing.delete(id);
      } else {
        doing.set(id, { _tag: "Failed", failure, of: was.of });
      }

      return { ...state, doing };
    }

    case "Forgotten": {
      return initialUploadEdits;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * A name typed for an Upload, as the contract takes it: the text as typed, of 1 to 1024
 * code units, or none.
 * @param text - The text.
 * @returns The name, or none.
 */
export const nameOf = (text: string): string | undefined =>
  text.length === 0 || text.length > uploadNameMaxLength ? undefined : text;

/**
 * Why a rename or a delete did not go as asked, or might not have, in words.
 * @param failure - Why.
 * @param name - The name the Upload is shown by.
 * @param of - What was asked.
 * @returns The words.
 */
export const editFailureText = (failure: EditFailure, name: string, of: Asked): string => {
  const done = of === "Rename" ? "renamed" : "deleted";

  switch (failure._tag) {
    case "UnknownUpload": {
      return `The Daemon no longer has ${name}, so it was not ${done}.`;
    }

    case "JournalFailed": {
      return `The Daemon could not write its Journal, so ${name} was not ${done}.`;
    }

    case "NoAnswer": {
      return `The Daemon did not answer, so whether ${name} was ${done} is unknown.`;
    }

    case "Unexpected": {
      return `The Daemon answered in a way the Frontend could not read, so whether ${name} was ${done} is unknown.`;
    }

    default: {
      return failure satisfies never;
    }
  }
};

/**
 * An Upload's link, from the public URL in force, which is kept with no trailing `/`, so
 * changing it changes every link from then on. None while no public URL is set.
 * @param publicUrl - `uploads.publicUrl`, if set.
 * @param upload - The Upload.
 * @returns The link, or none.
 */
export const linkOf = (
  publicUrl: string | undefined,
  upload: Pick<Upload, "id" | "safeName">
): string | undefined =>
  publicUrl === undefined ? undefined : `${publicUrl}/${upload.id}/${upload.safeName}`;

/**
 * The name an Upload is shown by: the one it was given, else its safe name.
 * @param upload - The Upload.
 * @returns The name.
 */
export const shownName = (upload: Pick<Upload, "name" | "safeName">): string =>
  upload.name ?? upload.safeName;

/** The image types every browser the Frontend serves can draw. */
const drawable = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

/**
 * Whether an Upload of a type is shown as a thumbnail of its own bytes, which a browser
 * draws only for an image type it knows. Its type was read from its bytes by the Daemon.
 * @param type - The type.
 * @returns Whether it is.
 */
export const thumbnailed = (type: string): boolean => drawable.has(type.toLowerCase());

/** The units of a size past bytes, each 1024 of the one before. */
const units = ["KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/**
 * A size in bytes as text, in binary units: whole bytes under 1 KiB, then one decimal
 * under 10 of a unit and whole numbers past that, such as `512 B`, `1.2 MiB`, or `340 KiB`.
 * It reads no locale.
 * @param size - The size, in bytes.
 * @returns The text.
 */
export const sizeText = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }

  let value = size / 1024;
  let unit = 0;

  // A value that rounds to 1024 of a unit is 1 of the next.
  while (unit < units.length - 1 && Math.round(value) >= 1024) {
    value /= 1024;
    unit += 1;
  }

  const shown = value < 9.95 ? value.toFixed(1) : Math.round(value).toFixed(0);

  return `${shown} ${units[unit]}`;
};

/**
 * Where an Upload was said, in words: the Network and the Target of a Message, the
 * Target's direction marks closed so they reach nothing after it.
 * @param item - The Message.
 * @returns The words, such as `libera #iirc`.
 */
export const saidPlace = (item: TimelineItem): string =>
  item.content._tag === "Message"
    ? `${item.network} ${contained(item.content.target)}`
    : item.network;

/**
 * The Uploads held whose link a Message of ours among some items holds, as `/<id>/`, by
 * its own text or the text the Ircd confirmed: those whose `said` the items may have
 * changed, to be read again, since no Upload Change says so. Each is given once, in the
 * order held.
 * @param state - The Uploads held.
 * @param items - The items, as a change of the Timelines gave them.
 * @returns Their ids.
 */
export const saidIn = (state: Pick<Uploads, "uploads">, items: readonly TimelineItem[]) => {
  const texts = items.flatMap(({ content }) => {
    if (content._tag !== "Message" || content.ours === null) {
      return [];
    }

    const { delivery } = content.ours;

    return delivery._tag === "Confirmed" ? [content.text, delivery.text] : [content.text];
  });

  return state.uploads.flatMap(({ id }) =>
    texts.some((text) => text.includes(`/${id}/`)) ? [id] : []
  );
};
