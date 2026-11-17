/**
 * The files pending in a composer, above its line: each with a preview of its own bytes,
 * read in the page, for an image every browser draws, else an icon, its name and size, and
 * how much was sent, with a button that cancels it, or, once it failed, why, with one that
 * dismisses it. Once kept, until the draft is sent, its link, with a button that renames it
 * in place and one that dismisses it, leaving its link in the draft. And the note while
 * Uploads are off, with a way to the options that turn them on, and why a send was held
 * back while any file waits.
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
import type { Pending, Stage } from "@iirc/frontend/uploading";
import { editFailureText, shownName, sizeText } from "@iirc/frontend/uploads";
import { useRef, useState } from "react";

import { openOptions } from "../options/atoms.ts";
import { RenameField } from "../options/rename-field.tsx";
import { Button, IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { composerState } from "./composer-state.ts";
import { uploadingState } from "./uploading-state.ts";
import { dismissUploadNote, dropUpload, previews, renameKept } from "./uploading.ts";

import styles from "./composer.module.css";

/**
 * A file's preview, or an icon.
 * @param props - The file's key.
 * @returns The thumbnail.
 */
const Thumbnail = ({ fileKey }: { readonly fileKey: string }) => {
  const preview = useAtomValue(previews).get(fileKey);

  return (
    <span className={styles.thumbnail}>
      {preview === undefined ? (
        <Icon className={styles.fileIcon} name="file" />
      ) : (
        // The name beside it says what it is.
        <img alt="" className={styles.image} src={preview} />
      )}
    </span>
  );
};

/**
 * One file kept, until its draft is sent: its name and size, and its link, or why a rename
 * failed, with a button that renames it in place, and one that dismisses it.
 * @param props - The file, and its stage.
 * @returns Its row.
 */
const KeptRow = ({
  file,
  stage,
}: {
  readonly file: Pending;
  readonly stage: Extract<Stage, { readonly _tag: "Kept" }>;
}) => {
  const drop = useAtomSet(dropUpload);
  const rename = useAtomSet(renameKept);
  const [renaming, setRenaming] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const name = shownName(stage.upload);

  return (
    <li className={styles.upload} ref={row}>
      <Thumbnail fileKey={file.key} />
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
              rename({ key: file.key, name: to });
            }}
          />
        ) : (
          <span className={styles.name}>
            <bdi>{name}</bdi> · {sizeText(stage.upload.size)}
          </span>
        )}
        {stage.failure === undefined ? (
          <span className={styles.link}>{stage.link}</span>
        ) : (
          <span className={styles.failure} role="alert">
            {editFailureText(stage.failure, name, "Rename")}
          </span>
        )}
      </span>
      <span className={styles.actions}>
        <Button
          aria-label={`Rename ${name}`}
          data-rename
          isDisabled={renaming}
          isPending={stage.renaming}
          onPress={() => {
            setRenaming(true);
          }}
          size="small"
          variant="quiet"
        >
          Rename
        </Button>
        <IconButton
          icon="close"
          label={`Dismiss ${name}, leaving its link`}
          onPress={() => {
            drop(file.key);
          }}
          size="small"
        />
      </span>
    </li>
  );
};

/**
 * One file pending.
 * @param props - The file.
 * @returns Its row.
 */
const Row = ({ file }: { readonly file: Pending }) => {
  const drop = useAtomSet(dropUpload);
  const failure = failureText({ ...file, failure: failureOf(file) });
  // A file still checking whether Uploads are on shows as one sent nothing yet.
  const progress = file.stage._tag === "Sending" ? file.stage.progress : undefined;

  if (file.stage._tag === "Kept") {
    return <KeptRow file={file} stage={file.stage} />;
  }

  return (
    <li className={styles.upload}>
      <Thumbnail fileKey={file.key} />
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
