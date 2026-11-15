/**
 * The Uploads, as a list the options show beside them: every one held, newest first, as
 * pages read and the stream of their Changes give them, and where the next page begins. An
 * Upload is held by its id, so one given again, by a page or the stream, replaces what is
 * held in place and is never held twice. Its link, whether it gets a thumbnail, and its
 * size are derived as it is drawn, never held.
 *
 * @packageDocumentation
 */
import type { Upload, UploadId } from "@iirc/api";

/**
 * The Uploads held, newest first, and where the next page begins: an Upload's id, as a page
 * gave it, `null` once the last page was read, or none before any was.
 */
export interface Uploads {
  readonly uploads: readonly Upload[];
  readonly next: UploadId | null | undefined;
}

/** Nothing held, and no page read. */
export const initialUploads: Uploads = { next: undefined, uploads: [] };

/** A page of the Uploads, newest first, as the API gives it. */
export interface UploadsPage {
  readonly uploads: readonly Upload[];
  readonly next: UploadId | null;
}

/**
 * What happened.
 *
 * - `Paged`: a page was read, from just after `after`, or the first page when none.
 * - `Changed`: the stream gave an Upload whole, as it is now.
 * - `Forgotten`: the page signed out, so nothing is held.
 */
export type UploadsEvent =
  | { readonly _tag: "Paged"; readonly after: UploadId | undefined; readonly page: UploadsPage }
  | { readonly _tag: "Changed"; readonly upload: Upload }
  | { readonly _tag: "Forgotten" };

/**
 * A page's Uploads folded into those held. One held is replaced in place. One not held goes
 * just before the next of the page's that is held, so the first page read again puts what
 * is new above what was held, and the rest go after everything held, so a later page goes
 * at the end.
 * @param held - The Uploads held.
 * @param page - The page's Uploads, newest first.
 * @returns The Uploads held now.
 */
const merged = (held: readonly Upload[], page: readonly Upload[]): readonly Upload[] => {
  const heldIds = new Set(held.map((upload) => upload.id));
  const given = new Map<UploadId, Upload>();
  const before = new Map<UploadId, readonly Upload[]>();
  let waiting: Upload[] = [];

  for (const upload of page) {
    if (!given.has(upload.id)) {
      given.set(upload.id, upload);

      if (heldIds.has(upload.id)) {
        before.set(upload.id, waiting);
        waiting = [];
      } else {
        waiting.push(upload);
      }
    }
  }

  return [
    ...held.flatMap((upload) => [...(before.get(upload.id) ?? []), given.get(upload.id) ?? upload]),
    ...waiting,
  ];
};

/**
 * Where the next page begins once a page is read. The first page sets it only before any
 * page was read, since reading it again, as following the stream again does, says nothing
 * of the pages after it. A later page sets it only when it was read from where the list
 * stands, so one asked for twice moves it once.
 * @param state - The Uploads held.
 * @param after - Where the page was read from.
 * @param page - The page.
 * @returns Where the next page begins.
 */
const nextAfter = (
  state: Uploads,
  after: UploadId | undefined,
  page: UploadsPage
): UploadId | null | undefined => {
  if (after === undefined) {
    return state.next === undefined ? page.next : state.next;
  }

  return after === state.next ? page.next : state.next;
};

/**
 * Folds one event into the Uploads held.
 * @param state - The Uploads held.
 * @param event - What happened.
 * @returns The Uploads held now.
 */
export const reduceUploads = (state: Uploads, event: UploadsEvent): Uploads => {
  switch (event._tag) {
    case "Paged": {
      return {
        next: nextAfter(state, event.after, event.page),
        uploads: merged(state.uploads, event.page.uploads),
      };
    }

    case "Changed": {
      const { upload } = event;
      const known = state.uploads.some((one) => one.id === upload.id);

      return {
        ...state,
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
