/**
 * The Frontend: which screen shows follows from whether the browser is signed in.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";

import { check, signInState } from "../sign-in/atoms.ts";
import { SignInScreen } from "../sign-in/sign-in-screen.tsx";
import { Button } from "../ui/button.tsx";
import { Shell } from "./shell.tsx";

import styles from "./app.module.css";

/**
 * While it is not yet known whether the browser is signed in, and why, if the Daemon
 * could not say.
 * @param props - The check.
 * @returns The screen.
 */
const Checking = ({ check: attempt }: { readonly check: Attempt }) => {
  const checkAgain = useAtomSet(check);

  return (
    <main className={styles.checking}>
      {attempt._tag === "Failed" ? (
        <>
          <p className={styles.failure} role="alert">
            {explain(attempt.failure)}
          </p>
          <Button
            onPress={() => {
              checkAgain();
            }}
            variant="primary"
          >
            Try again
          </Button>
        </>
      ) : (
        <p className={styles.muted}>Asking the Daemon…</p>
      )}
    </main>
  );
};

/**
 * The screen for the sign-in state.
 * @returns The screen.
 */
export const App = () => {
  const state = useAtomValue(signInState);

  switch (state._tag) {
    case "Unknown": {
      return <Checking check={state.check} />;
    }

    case "SignedOut": {
      return <SignInScreen attempt={state.signIn} />;
    }

    case "SignedIn": {
      return <Shell signOut={state.signOut} />;
    }

    default: {
      return state satisfies never;
    }
  }
};
