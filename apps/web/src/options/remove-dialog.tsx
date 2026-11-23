/**
 * The dialog that asks before a Network is removed, opened by `/network remove`, the
 * options, or a removed Network's Pane. Removing one, it asks whether its
 * Timelines stay readable, as a pair of radios, keeping them unless the Owner chooses
 * otherwise. A Network removed with its Timelines kept is asked about only to drop them.
 * Nothing is sent until the Owner confirms, and Cancel, Escape, or a press outside sends
 * nothing.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { questionOf } from "@iirc/frontend/removal";
import type { Removal, Standing } from "@iirc/frontend/removal";
import { useId } from "react";
import { Dialog, Heading, Modal, RadioButton, RadioField, RadioGroup } from "react-aria-components";

import { Button } from "../ui/button.tsx";
import { ModalOverlay } from "../ui/overlays.tsx";
import {
  chooseKeep,
  closeRemoval,
  confirmRemoval,
  removalStanding,
  removalState,
} from "./removal.ts";

import styles from "./remove-dialog.module.css";

/**
 * The question, while it is asked.
 * @param props - The question, and how its Network stands.
 * @returns The dialog's content.
 */
const Asking = ({
  removal,
  standing,
}: {
  readonly removal: Extract<Removal, { readonly _tag: "Asking" }>;
  readonly standing: Standing;
}) => {
  const choose = useAtomSet(chooseKeep);
  const close = useAtomSet(closeRemoval);
  const confirm = useAtomSet(confirmRemoval);
  const bodyId = useId();
  const question = questionOf(removal.network, standing);

  return (
    <div className={styles.content}>
      <Heading className={styles.heading} slot="title">
        <bdi>{question.title}</bdi>
      </Heading>
      <p className={styles.body} id={bodyId}>
        {question.body}
      </p>
      {question.choosing ? (
        <RadioGroup
          aria-describedby={bodyId}
          aria-label="Its Timelines"
          className={styles.choices}
          isDisabled={removal.sending}
          onChange={(value) => {
            choose(value === "keep");
          }}
          value={removal.keep ? "keep" : "drop"}
        >
          <RadioField value="keep">
            <RadioButton className={styles.choice}>
              Keep its Timelines, to read and search
            </RadioButton>
          </RadioField>
          <RadioField value="drop">
            <RadioButton className={styles.choice}>
              Drop its Timelines, and free its name
            </RadioButton>
          </RadioField>
        </RadioGroup>
      ) : null}
      {removal.failure === undefined ? null : (
        <p className={styles.failure} role="alert">
          {removal.failure}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          // The Owner asked, so the answer that does what they asked takes focus.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={!question.choosing}
          isPending={removal.sending}
          onPress={() => {
            confirm(undefined);
          }}
          variant="primary"
        >
          {question.confirm}
        </Button>
        <Button
          isDisabled={removal.sending}
          onPress={() => {
            close(undefined);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
};

/**
 * What the Owner was told of a removal that stands.
 * @param props - The message.
 * @returns The dialog's content.
 */
const Told = ({ message }: { readonly message: string }) => {
  const close = useAtomSet(closeRemoval);

  return (
    <div className={styles.content}>
      <Heading className={styles.heading} slot="title">
        Removed
      </Heading>
      <p className={styles.failure} role="alert">
        {message}
      </p>
      <div className={styles.actions}>
        <Button
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onPress={() => {
            close(undefined);
          }}
          variant="primary"
        >
          OK
        </Button>
      </div>
    </div>
  );
};

/**
 * The dialog, while something is asked or told.
 * @returns The dialog.
 */
export const RemoveDialog = () => {
  const removal = useAtomValue(removalState);
  const standing = useAtomValue(removalStanding) ?? "Unknown";
  const close = useAtomSet(closeRemoval);

  return (
    <ModalOverlay
      className={styles.overlay}
      isDismissable
      isOpen={removal._tag !== "Closed"}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          close(undefined);
        }
      }}
    >
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog} role="alertdialog">
          {removal._tag === "Asking" ? <Asking removal={removal} standing={standing} /> : null}
          {removal._tag === "Told" ? <Told message={removal.message} /> : null}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
