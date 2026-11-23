/**
 * The larger view of an image or a video: over the whole screen, as large as fits and no
 * larger than it, with a link to its page under it. A video plays there, already playing,
 * with its controls. A press anywhere on an image's view closes it, except on the link to its
 * page. A press on a video is its player's, so its view has a close control in its corner,
 * and a press on the dimmed screen around either closes it too. Escape closes either, and
 * focus returns to the control that opened it.
 *
 * @packageDocumentation
 */
import type { LinkShown } from "@iirc/frontend/previews";
import type { ReactElement } from "react";
import { Button, Dialog, DialogTrigger, Modal } from "react-aria-components";

import { Icon } from "../ui/icon.tsx";
import { ModalOverlay } from "../ui/overlays.tsx";

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
            // The image is the view's close control: a press on it closes, as its slot asks.
            <Button aria-label="Close" className={styles.closes} slot="close">
              <img
                alt={alt}
                className={styles.large}
                referrerPolicy="no-referrer"
                src={large.src}
              />
            </Button>
          ) : (
            <span className={styles.player}>
              {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a stranger's media carries no captions the Daemon could offer */}
              <video
                autoPlay
                className={styles.large}
                controls
                poster={large.poster}
                src={large.src}
              />
              <Button
                aria-label="Close"
                className={`${styles.control} ${styles.close}`}
                slot="close"
              >
                <Icon name="close" />
              </Button>
            </span>
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
