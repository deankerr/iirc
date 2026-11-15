/**
 * The files pending in a composer, above its line: each with a preview of its own bytes,
 * read in the page, for an image every browser draws, else an icon, its name and size, and
 * how much was sent, with a button that cancels it, or, once it failed, why, with one that
 * dismisses it. And the note while Uploads are off, with a way to the options that turn
 * them on, and why a send was held back while any file waits.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Place } from "@iirc/frontend/composer";
import {
  failureOf,
  failureText,
  heldNoteIn,
  noteIn,
  offNote,
  pendingIn,
} from "@iirc/frontend/uploading";
import type { Pending } from "@iirc/frontend/uploading";
import { sizeText } from "@iirc/frontend/uploads";

import { openOptions } from "../options/atoms.ts";
import { Button, IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { composerState } from "./atoms.ts";
import { uploadingState } from "./uploading-state.ts";
import { dismissUploadNote, dropUpload, previews } from "./uploading.ts";

import styles from "./composer.module.css";

/**
 * One file pending.
 * @param props - The file.
 * @returns Its row.
 */
const Row = ({ file }: { readonly file: Pending }) => {
  const preview = useAtomValue(previews).get(file.key);
  const drop = useAtomSet(dropUpload);
  const failure = failureText({ ...file, failure: failureOf(file) });
  // A file still checking whether Uploads are on shows as one sent nothing yet.
  const progress = file.stage._tag === "Sending" ? file.stage.progress : undefined;

  return (
    <li className={styles.upload}>
      <span className={styles.thumbnail}>
        {preview === undefined ? (
          <Icon className={styles.fileIcon} name="file" />
        ) : (
          // The name beside it says what it is.
          <img alt="" className={styles.image} src={preview} />
        )}
      </span>
      <span className={styles.about}>
        <span className={styles.name}>
          <bdi>{file.name}</bdi> · {sizeText(file.size)}
        </span>
        {failure === undefined ? (
          <progress
            aria-label={`Sending ${file.name}`}
            className={styles.progress}
            max={progress?.total}
            value={progress?.loaded}
          />
        ) : (
          <span className={styles.failure} role="alert">
            {failure}
          </span>
        )}
      </span>
      <IconButton
        icon="close"
        label={
          failure === undefined ? `Cancel upload of ${file.name}` : `Dismiss upload of ${file.name}`
        }
        onPress={() => {
          drop(file.key);
        }}
        size="small"
      />
    </li>
  );
};

/**
 * What a composer holds of uploading: its files pending, and the note while Uploads are off.
 * @param props - The composer's place.
 * @returns Them, or nothing.
 */
export const PendingUploads = ({ place }: { readonly place: Place }) => {
  const state = useAtomValue(uploadingState);
  const options = useAtomSet(openOptions);
  const dismissNote = useAtomSet(dismissUploadNote);
  const composers = useAtomValue(composerState);
  const files = pendingIn(state, place);
  const missing = noteIn(state, place);
  // Derived as it is drawn from the files still pending, so it names only those, and goes
  // with the last of them, whichever way it went.
  const held = heldNoteIn(state, composers, place);

  return (
    <>
      {held === undefined ? null : (
        <div className={`${styles.notice} ${styles.failure}`} role="alert">
          <p>{held}</p>
          <IconButton
            icon="close"
            label="Dismiss the note"
            onPress={() => {
              dismissNote(place);
            }}
            size="small"
          />
        </div>
      )}
      {missing === undefined ? null : (
        <div className={styles.notice}>
          <output className={styles.note}>{offNote(missing)}</output>
          <Button
            onPress={() => {
              options("");
            }}
            size="small"
          >
            Open the options
          </Button>
          <IconButton
            icon="close"
            label="Dismiss the note"
            onPress={() => {
              dismissNote(place);
            }}
            size="small"
          />
        </div>
      )}
      {files.length === 0 ? null : (
        <ul aria-label="Uploads" className={styles.uploads}>
          {files.map((file) => (
            <Row file={file} key={file.key} />
          ))}
        </ul>
      )}
    </>
  );
};
