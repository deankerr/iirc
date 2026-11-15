/**
 * The Uploads, listed beside the options, newest first: an image the browser draws as a
 * thumbnail of its own bytes, scaled down and fetched only once near the screen, an icon
 * for any other type, then its name, type, size, and when it was uploaded, and a button
 * that copies its link. The link is made from the public URL in force as it is drawn, and
 * while none is set the list says so once rather than offering a link that would not work.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Upload } from "@iirc/api";
import { linkOf, shownName, sizeText, thumbnailed } from "@iirc/frontend/uploads";

import { Button } from "../ui/button.tsx";
import { datedClockFor } from "../ui/clock.ts";
import { formattedAt } from "../ui/dates.ts";
import { Icon } from "../ui/icon.tsx";
import { timeShown } from "./ui.ts";
import { copiedLink, copyLink, moreUploads, publicUrl, uploadsState } from "./uploads.ts";

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
  const when = formattedAt(datedClockFor(shown), upload.at) ?? "at a time unavailable";
  const name = shownName(upload);

  return (
    <li className={styles.row}>
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
        <span className={styles.name}>
          <bdi>{name}</bdi>
        </span>
        <span className={styles.details}>
          <bdi>{upload.type}</bdi> · {sizeText(upload.size)} · {when}
        </span>
      </span>
      {link === undefined ? null : (
        <span className={styles.copy}>
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
          <output aria-live="polite" className={styles.copied}>
            {copied === link ? "copied" : ""}
          </output>
        </span>
      )}
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
    </section>
  );
};
