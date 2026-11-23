/**
 * The offer to leave a Channel the Owner asked to close while Self is in it, which the
 * Daemon never closes. Leave parts it, as `/part` does, and Cancel, Escape, or a press
 * outside sends nothing.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { offerOf } from "@iirc/frontend/closing";
import type { Leaving } from "@iirc/frontend/closing";
import { Dialog, Heading, Modal } from "react-aria-components";

import { Button } from "../ui/button.tsx";
import { ModalOverlay } from "../ui/overlays.tsx";
import { confirmLeaving, dismissLeaving, leavingState } from "./closing.ts";

import styles from "./leave-dialog.module.css";

/**
 * The offer, while it stands.
 * @param props - The offer.
 * @returns The dialog's content.
 */
const Offered = ({
  leaving,
}: {
  readonly leaving: Extract<Leaving, { readonly _tag: "Offered" }>;
}) => {
  const dismiss = useAtomSet(dismissLeaving);
  const leave = useAtomSet(confirmLeaving);
  const offer = offerOf(leaving.channel, leaving.network);

  return (
    <div className={styles.content}>
      <Heading className={styles.heading} slot="title">
        <bdi>{offer.title}</bdi>
      </Heading>
      <p className={styles.body}>{offer.body}</p>
      {leaving.failure === undefined ? null : (
        <p className={styles.failure} role="alert">
          {leaving.failure}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          // The Owner asked to be rid of it, so leaving takes focus.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          isPending={leaving.sending}
          onPress={() => {
            leave(undefined);
          }}
          variant="primary"
        >
          Leave
        </Button>
        <Button
          isDisabled={leaving.sending}
          onPress={() => {
            dismiss(undefined);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
};

/**
 * The dialog, while something is offered.
 * @returns The dialog.
 */
export const LeaveDialog = () => {
  const leaving = useAtomValue(leavingState);
  const dismiss = useAtomSet(dismissLeaving);

  return (
    <ModalOverlay
      className={styles.overlay}
      isDismissable
      isOpen={leaving._tag === "Offered"}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          dismiss(undefined);
        }
      }}
    >
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog} role="alertdialog">
          {leaving._tag === "Offered" ? <Offered leaving={leaving} /> : null}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
