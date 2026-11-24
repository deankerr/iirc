/**
 * Signing out, which asks first, since a slip ends the Sign-in and getting back in takes a
 * key. Sign out in the question signs out, and Cancel, Escape, or a press outside leaves
 * the Sign-in as it was. The focus goes into the question and back to the button.
 *
 * @packageDocumentation
 */
import { useAtomSet } from "@effect/atom-react";
import type { Attempt } from "@iirc/frontend/sign-in";
import { Dialog, DialogTrigger, Heading, Modal, Text } from "react-aria-components";

import { Button } from "../ui/button.tsx";
import { ModalOverlay } from "../ui/overlays.tsx";
import { signOut } from "./atoms.ts";

import styles from "./sign-out-button.module.css";

/**
 * The button that asks to sign out, and the question it asks. A failed sign-out is said
 * by whatever holds the button, from the attempt.
 * @param props - The attempt to sign out, and the button's size.
 * @returns The button, and the question while it is asked.
 */
export const SignOutButton = ({
  attempt,
  size,
}: {
  readonly attempt: Attempt;
  readonly size?: "regular" | "small" | undefined;
}) => {
  const signOutNow = useAtomSet(signOut);

  return (
    <DialogTrigger>
      <Button isPending={attempt._tag === "Waiting"} size={size} variant="quiet">
        sign out
      </Button>
      <ModalOverlay className={styles.overlay} isDismissable>
        <Modal className={styles.modal}>
          <Dialog className={styles.dialog} role="alertdialog">
            {({ close }) => (
              <div className={styles.content}>
                <Heading className={styles.heading} slot="title">
                  Sign out?
                </Heading>
                <Text className={styles.body} elementType="p" slot="description">
                  This browser forgets its session and needs an API key to sign in again. The daemon
                  stays on your networks.
                </Text>
                <div className={styles.actions}>
                  <Button
                    onPress={() => {
                      close();
                      signOutNow();
                    }}
                    variant="primary"
                  >
                    sign out
                  </Button>
                  <Button
                    // A slip is what this asks against, so the answer that changes nothing
                    // takes focus.
                    // oxlint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    onPress={close}
                  >
                    cancel
                  </Button>
                </div>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
};
