/**
 * The Uploads, as a list the options show beside them: every one held, newest first, as
 * pages read and the stream of their Changes give them, where the next page begins, and the
 * sequence of the last Change folded in, which the stream is followed after. A page only
 * ever extends the list at its end, and the stream only ever gives what is newer than
 * everything held, so an Upload is held once. Its link, whether it gets a thumbnail, and its
 * size are derived as it is drawn, never held.
 *
 * @packageDocumentation
 */
import type { Upload, UploadId } from "@iirc/api";

/**
 * The Uploads held, newest first, where the next page begins, and how far they were
 * folded: `next` is an Upload's id, as a page gave it, or `null` once the last page was
 * read, and `through` the sequence of the last Upload Change folded in. Both are none
 * before the first page was read.
 */
export interface Uploads {
  readonly uploads: readonly Upload[];
  readonly next: UploadId | null | undefined;
  readonly through: number | undefined;
}

/** Nothing held, and no page read. */
export const initialUploads: Uploads = { next: undefined, through: undefined, uploads: [] };

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
 * - `Forgotten`: the page signed out, so nothing is held.
 */
export type UploadsEvent =
  | { readonly _tag: "Paged"; readonly after: UploadId | undefined; readonly page: UploadsPage }
  | { readonly _tag: "Changed"; readonly sequence: number; readonly upload: Upload }
  | { readonly _tag: "Forgotten" };

/**
 * A page's Uploads after those held, passing over any already held.
 * @param held - The Uploads held.
 * @param page - The page's Uploads, newest first.
 * @returns The Uploads held now.
 */
const extended = (held: readonly Upload[], page: readonly Upload[]): readonly Upload[] => {
  const ids = new Set(held.map((upload) => upload.id));
  const added: Upload[] = [];

  for (const upload of page) {
    if (!ids.has(upload.id)) {
      ids.add(upload.id);
      added.push(upload);
    }
  }

  return [...held, ...added];
};

/**
 * Folds one event into the Uploads held. A page is folded only when it was read from where
 * the list stands, the first page into an empty list and each later one from `next`, so one
 * read twice, or late, is folded once. Only the first page says how far the list was folded,
 * since the stream gives what is newer than any later page. A Change is folded only when it
 * is after the last folded in: one not held is newer than all, so it goes first, and one
 * held is replaced in place.
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

      return {
        next: page.next,
        through: state.through ?? page.through,
        uploads: extended(state.uploads, page.uploads),
      };
    }

    case "Changed": {
      const { sequence, upload } = event;

      if (state.through === undefined || sequence <= state.through) {
        return state;
      }

      const known = state.uploads.some((one) => one.id === upload.id);

      return {
        ...state,
        through: sequence,
        uploads: known
          ? state.uploads.map((one) => (one.id === upload.id ? upload : one))
          : [upload, ...state.uploads],
      };
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
