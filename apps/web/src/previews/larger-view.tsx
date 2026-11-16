/**
 * The larger view of an image: over the whole screen, as large as fits and no larger than
 * the image, with a link to its page under it. Pressing outside it or Escape closes it,
 * and focus returns to the control that opened it.
 *
 * @packageDocumentation
 */
import type { LinkShown } from "@iirc/frontend/previews";
import type { ReactElement } from "react";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "react-aria-components";

import styles from "./larger-view.module.css";

/**
 * A control, which opens the larger view of an image when pressed.
 * @param props - The control, which must be a React Aria button; what the image is said to
 *   show; where it is drawn from, which an animated image plays from; and its page's link.
 * @returns The control, and its larger view while it is open.
 */
export const OpensLarger = ({
  alt,
  children,
  link,
  src,
}: {
  readonly alt: string;
  readonly children: ReactElement;
  readonly link: LinkShown;
  readonly src: string;
}) => (
  <DialogTrigger>
    {children}
    <ModalOverlay className={styles.overlay} isDismissable>
      <Modal className={styles.modal}>
        <Dialog aria-label={alt} className={styles.dialog}>
          <img alt={alt} className={styles.large} referrerPolicy="no-referrer" src={src} />
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
