/**
 * The dialog that asks before an Upload is deleted, opened from its row in the list. It
 * says what deleting promises: the link stops working at once, everywhere it was said, and
 * a copy already opened or saved elsewhere cannot be called back. Nothing is sent until the
 * Owner confirms, and Cancel, Escape, or a press outside sends nothing. It is open only
 * while the Upload asked about is listed and live, so one deleted elsewhere, or expired,
 * meanwhile closes it.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { shownName } from "@iirc/frontend/uploads";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";

import { Button } from "../ui/button.tsx";
import { uploadsState } from "./uploads-state.ts";
import { closeDelete, confirmDelete, uploadEditsState } from "./uploads.ts";

import styles from "./remove-dialog.module.css";

/**
 * The dialog, while a delete is asked.
 * @returns The dialog.
 */
export const DeleteDialog = () => {
  const { asking } = useAtomValue(uploadEditsState);
  const { uploads } = useAtomValue(uploadsState);
  const close = useAtomSet(closeDelete);
  const confirm = useAtomSet(confirmDelete);
  // A deleted Upload stays listed while the deleted show, but has nothing left to delete.
  const upload = uploads.find((one) => one.id === asking && one.deleted === undefined);

  return (
    <ModalOverlay
      className={styles.overlay}
      isDismissable
      isOpen={upload !== undefined}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          close(undefined);
        }
      }}
    >
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog} role="alertdialog">
          {upload === undefined ? null : (
            <div className={styles.content}>
              <Heading className={styles.heading} slot="title">
                Delete <bdi>{shownName(upload)}</bdi>?
              </Heading>
              <p className={styles.body}>
                Its link stops working at once, wherever it was said. A copy someone already opened
                or saved cannot be called back.
              </p>
              <div className={styles.actions}>
                <Button
                  // The Owner asked, so the answer that does what they asked takes focus.
                  // oxlint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  onPress={() => {
                    confirm(undefined);
                  }}
                  variant="primary"
                >
                  Delete
                </Button>
                <Button
                  onPress={() => {
                    close(undefined);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
