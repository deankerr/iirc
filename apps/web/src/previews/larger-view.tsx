/**
 * The larger view of an image or a video: over the whole screen, as large as fits and no
 * larger than it, with a link to its page under it. A video plays there, already playing,
 * with its controls. Pressing outside it or Escape closes it, and focus returns to the
 * control that opened it.
 *
 * @packageDocumentation
 */
import type { LinkShown } from "@iirc/frontend/previews";
import type { ReactElement } from "react";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "react-aria-components";

import styles from "./larger-view.module.css";

/**
 * What the larger view draws: an image, from where it is drawn, which an animated image
 * plays from; or a video, from where it streams, under its still poster if it has one.
 */
export type Large =
  | { readonly _tag: "Image"; readonly src: string }
  | { readonly _tag: "Video"; readonly src: string; readonly poster: string | undefined };

/**
 * A control, which opens the larger view of an image or a video when pressed.
 * @param props - The control, which must be a React Aria button; what it is said to show;
 *   what is drawn large; its page's link; and what else happens as it opens.
 * @returns The control, and its larger view while it is open.
 */
export const OpensLarger = ({
  alt,
  children,
  large,
  link,
  onOpen,
}: {
  readonly alt: string;
  readonly children: ReactElement;
  readonly large: Large;
  readonly link: LinkShown;
  readonly onOpen?: (() => void) | undefined;
}) => (
  <DialogTrigger
    onOpenChange={(open) => {
      if (open) {
        onOpen?.();
      }
    }}
  >
    {children}
    <ModalOverlay className={styles.overlay} isDismissable>
      <Modal className={styles.modal}>
        <Dialog aria-label={alt} className={styles.dialog}>
          {large._tag === "Image" ? (
            <img alt={alt} className={styles.large} referrerPolicy="no-referrer" src={large.src} />
          ) : (
            // oxlint-disable-next-line jsx-a11y/media-has-caption -- a stranger's media carries no captions the Daemon could offer
            <video
              autoPlay
              className={styles.large}
              controls
              poster={large.poster}
              src={large.src}
            />
          )}
          {link.href === undefined ? (
            <bdi className={styles.page}>{link.text}</bdi>
          ) : (
            <a className={styles.page} href={link.href} rel="noopener noreferrer" target="_blank">
              <bdi>{link.text}</bdi>
            </a>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  </DialogTrigger>
);
