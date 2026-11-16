/**
 * The Uploads, listed beside the options, newest first: an image the browser draws as a
 * thumbnail of its own bytes, scaled down and fetched only once near the screen, an icon
 * for any other type, then its name, type, size, and when it was uploaded, and buttons
 * that copy its link, rename it in place, and delete it once the Owner confirms. The link
 * is made from the public URL in force as it is drawn, and while none is set the list says
 * so once rather than offering a link that would not work. A rename or a delete waiting on
 * the Daemon shows on its button, and one that failed says why in its row.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Upload } from "@iirc/api";
import { editFailureText, linkOf, shownName, sizeText, thumbnailed } from "@iirc/frontend/uploads";
import { useRef, useState } from "react";

import { Button } from "../ui/button.tsx";
import { datedClockFor } from "../ui/clock.ts";
import { formattedAt } from "../ui/dates.ts";
import { Icon } from "../ui/icon.tsx";
import { DeleteDialog } from "./delete-dialog.tsx";
import { RenameField } from "./rename-field.tsx";
import { timeShown } from "./ui.ts";
import {
  askToDelete,
  copiedLink,
  copyLink,
  moreUploads,
  publicUrl,
  renameUpload,
  uploadEditsState,
  uploadsState,
} from "./uploads.ts";

import styles from "./uploads-list.module.css";

/**
 * Where an Upload's bytes are read on the API's own origin, under the page's sign-in.
 * @param upload - The Upload.
 * @returns The path.
 */
const contentOf = (upload: Upload) => `/api/uploads/${upload.id}/content`;

/**
 * One Upload's row.
 * @param props - The Upload, and its link, if a public URL is set.
 * @returns The row.
 */
const Row = ({ link, upload }: { readonly upload: Upload; readonly link: string | undefined }) => {
  const shown = useAtomValue(timeShown);
  const copied = useAtomValue(copiedLink);
  const copy = useAtomSet(copyLink);
  const rename = useAtomSet(renameUpload);
  const askDelete = useAtomSet(askToDelete);
  const doing = useAtomValue(uploadEditsState).doing.get(upload.id);
  const [renaming, setRenaming] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const when = formattedAt(datedClockFor(shown), upload.at) ?? "at a time unavailable";
  const name = shownName(upload);
  const waiting = doing?._tag === "Waiting" ? doing.of : undefined;

  return (
    <li className={styles.row} ref={row}>
      <span className={styles.thumbnail}>
        {thumbnailed(upload.type) ? (
          // The name beside it says what it is.
          <img
            alt=""
            className={styles.image}
            decoding="async"
            loading="lazy"
            src={contentOf(upload)}
          />
        ) : (
          <Icon className={styles.icon} name="file" />
        )}
      </span>
      <span className={styles.about}>
        {renaming ? (
          <RenameField
            label={`New name for ${name}`}
            name={name}
            onClose={() => {
              setRenaming(false);
              // Focus goes back to the button that opened the field.
              requestAnimationFrame(() => {
                row.current?.querySelector<HTMLElement>("[data-rename]")?.focus();
              });
            }}
            onRename={(to) => {
              rename({ id: upload.id, name: to });
            }}
          />
        ) : (
          <span className={styles.name}>
            <bdi>{name}</bdi>
          </span>
        )}
        <span className={styles.details}>
          <bdi>{upload.type}</bdi> · {sizeText(upload.size)} · {when}
        </span>
        {doing?._tag === "Failed" ? (
          <span className={styles.failure} role="alert">
            {editFailureText(doing.failure, name, doing.of)}
          </span>
        ) : null}
      </span>
      <span className={styles.actions}>
        {link === undefined ? null : (
          <Button
            aria-label={`Copy the link to ${name}`}
            onPress={() => {
              copy({ id: upload.id, safeName: upload.safeName });
            }}
            size="small"
            variant="quiet"
          >
            Copy link
          </Button>
        )}
        {link === undefined ? null : (
          <output aria-live="polite" className={styles.copied}>
            {copied === link ? "copied" : ""}
          </output>
        )}
        <Button
          aria-label={`Rename ${name}`}
          isDisabled={renaming || waiting === "Delete"}
          isPending={waiting === "Rename"}
          onPress={() => {
            setRenaming(true);
          }}
          data-rename
          size="small"
          variant="quiet"
        >
          Rename
        </Button>
        <Button
          aria-label={`Delete ${name}`}
          isDisabled={waiting === "Rename"}
          isPending={waiting === "Delete"}
          onPress={() => {
            askDelete(upload.id);
          }}
          size="small"
          variant="quiet"
        >
          Delete
        </Button>
      </span>
    </li>
  );
};

/**
 * The Uploads, newest first, with "More" while more follow.
 * @returns The list.
 */
export const UploadsList = () => {
  const { next, uploads } = useAtomValue(uploadsState);
  const base = useAtomValue(publicUrl);
  const more = useAtomSet(moreUploads);

  return (
    <section aria-label="Uploads" className={styles.view}>
      <h2 className={styles.heading}>Uploads</h2>
      {base === undefined ? (
        <p className={styles.muted}>No link to copy until uploads.publicUrl is set.</p>
      ) : null}
      {next !== undefined && uploads.length === 0 ? (
        <p className={styles.muted}>Nothing uploaded yet.</p>
      ) : null}
      <ul aria-label="Uploads" className={styles.list}>
        {uploads.map((upload) => (
          <Row key={upload.id} link={linkOf(base, upload)} upload={upload} />
        ))}
      </ul>
      {next === undefined || next === null ? null : (
        <Button
          className={styles.more}
          onPress={() => {
            more(undefined);
          }}
          size="small"
        >
          More
        </Button>
      )}
      <DeleteDialog />
    </section>
  );
};
