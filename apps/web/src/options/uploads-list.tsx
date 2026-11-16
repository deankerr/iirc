/**
 * The Uploads, listed beside the options, newest first, the deleted ones too while "Show
 * deleted" is on, muted, saying expired or deleted and when, with nothing to do to them
 * and an icon for a thumbnail, as their bytes are gone: an image the browser draws as a
 * thumbnail of its own bytes, scaled down and fetched only once near the screen, an icon
 * for any other type, then its name, type, size, and when it was uploaded, where it was
 * said, each Network and Target a Message of ours held its link, newest first, which goes
 * to that Message in its Timeline when pressed, and buttons
 * that copy its link, rename it in place, and delete it once the Owner confirms. A live
 * one whose bytes the Daemon found gone has an icon too, since nothing is to be fetched,
 * says "missing" in the danger colour where the time would be, and offers no link, which
 * would only answer not found, leaving the Owner to rename it or delete its record. The link
 * is made from the public URL in force as it is drawn, and while none is set the list says
 * so once rather than offering a link that would not work. A rename or a delete waiting on
 * the Daemon shows on its button, and one that failed says why in its row.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineItem, Upload } from "@iirc/api";
import {
  deletedText,
  editFailureText,
  linkOf,
  saidPlace,
  shownName,
  sizeText,
  thumbnailed,
} from "@iirc/frontend/uploads";
import { useRef, useState } from "react";

import { jumpTo } from "../search/atoms.ts";
import { Button, ToggleButton } from "../ui/button.tsx";
import { datedClockFor } from "../ui/clock.ts";
import { formattedAt } from "../ui/dates.ts";
import { Icon } from "../ui/icon.tsx";
import { DeleteDialog } from "./delete-dialog.tsx";
import { RenameField } from "./rename-field.tsx";
import { timeShown } from "./ui.ts";
import { uploadsState } from "./uploads-state.ts";
import {
  askToDelete,
  copiedLink,
  copyLink,
  deletedShown,
  moreUploads,
  publicUrl,
  renameUpload,
  showDeleted,
  uploadEditsState,
  uploadMissing,
} from "./uploads.ts";

import styles from "./uploads-list.module.css";

/**
 * Where an Upload's bytes are read on the API's own origin, under the page's sign-in.
 * @param upload - The Upload.
 * @returns The path.
 */
const contentOf = (upload: Upload) => `/api/uploads/${upload.id}/content`;

/**
 * An Upload's thumbnail: its own bytes, for an image the browser draws while they are held,
 * else an icon, which is also all a missing Upload gets, since nothing is to be fetched.
 * @param props - The Upload, and whether its bytes are missing.
 * @returns The thumbnail.
 */
const Thumbnail = ({ missing, upload }: { readonly upload: Upload; readonly missing: boolean }) => (
  <span className={styles.thumbnail}>
    {thumbnailed(upload.type) && upload.deleted === undefined && !missing ? (
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
);

/**
 * An Upload's details: its type, size, and when it was uploaded, or in that place when its
 * bytes are missing, that they are, or when and why it was deleted.
 * @param props - The Upload, and whether its bytes are missing.
 * @returns The details.
 */
const Details = ({ missing, upload }: { readonly upload: Upload; readonly missing: boolean }) => {
  const shown = useAtomValue(timeShown);
  const { deleted } = upload;

  const at = (instant: number) =>
    formattedAt(datedClockFor(shown), instant) ?? "at a time unavailable";

  let said = at(upload.at);

  if (deleted !== undefined) {
    said = `${deletedText(deleted.why)} ${at(deleted.at)}`;
  }

  return (
    <span className={styles.details}>
      <bdi>{upload.type}</bdi> · {sizeText(upload.size)} ·{" "}
      {missing ? <span className={styles.missing}>missing</span> : said}
    </span>
  );
};

/**
 * Where an Upload was said: each Message of ours that held its link, newest first, as its
 * Network and Target, which goes to the Message in its Timeline when pressed.
 * @param props - The name the Upload is shown by, and the Messages.
 * @returns Where, or nothing before it was said.
 */
const Said = ({
  name,
  said,
}: {
  readonly name: string;
  readonly said: readonly TimelineItem[];
}) => {
  const jump = useAtomSet(jumpTo);

  return said.length === 0 ? null : (
    <span className={styles.said}>
      said in{" "}
      {said.map((item, index) => {
        const place = saidPlace(item);

        return (
          <span key={`${item.timeline}.${item.sequence}`}>
            {index === 0 ? null : ", "}
            <Button
              aria-label={`Go to where ${name} was said in ${place}`}
              className={styles.place}
              onPress={() => {
                jump(item);
              }}
              variant="text"
            >
              <bdi>{place}</bdi>
            </Button>
          </span>
        );
      })}
    </span>
  );
};

/**
 * One Upload's row.
 * @param props - The Upload, and its link, if a public URL is set.
 * @returns The row.
 */
const Row = ({ link, upload }: { readonly upload: Upload; readonly link: string | undefined }) => {
  const copied = useAtomValue(copiedLink);
  const copy = useAtomSet(copyLink);
  const rename = useAtomSet(renameUpload);
  const askDelete = useAtomSet(askToDelete);
  const doing = useAtomValue(uploadEditsState).doing.get(upload.id);
  const { deleted } = upload;
  // Only a live Upload can be missing: a deleted one's bytes are meant to be gone.
  const missing = useAtomValue(uploadMissing(upload.id)) && deleted === undefined;
  const [renaming, setRenaming] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const name = shownName(upload);
  const waiting = doing?._tag === "Waiting" ? doing.of : undefined;

  return (
    <li
      className={deleted === undefined ? styles.row : `${styles.row} ${styles.deleted}`}
      ref={row}
    >
      <Thumbnail missing={missing} upload={upload} />
      <span className={styles.about}>
        {renaming && deleted === undefined ? (
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
        <Details missing={missing} upload={upload} />
        <Said name={name} said={upload.said} />
        {doing?._tag === "Failed" ? (
          <span className={styles.failure} role="alert">
            {editFailureText(doing.failure, name, doing.of)}
          </span>
        ) : null}
      </span>
      {deleted === undefined ? (
        <span className={styles.actions}>
          {link === undefined || missing ? null : (
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
          {link === undefined || missing ? null : (
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
      ) : null}
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
  const withDeleted = useAtomValue(deletedShown);
  const showWithDeleted = useAtomSet(showDeleted);

  return (
    <section aria-label="Uploads" className={styles.view}>
      <div className={styles.head}>
        <h2 className={styles.heading}>Uploads</h2>
        <ToggleButton
          isSelected={withDeleted}
          onChange={showWithDeleted}
          size="small"
          variant="quiet"
        >
          Show deleted
        </ToggleButton>
      </div>
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
