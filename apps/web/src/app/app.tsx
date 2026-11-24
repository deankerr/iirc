/**
 * The Frontend: which screen shows follows from whether the browser is signed in, and
 * once it is, from whether the shared options under `ui` are read.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";

import { uiKnown } from "../options/ui.ts";
import { check, signInState } from "../sign-in/atoms.ts";
import { SignInScreen } from "../sign-in/sign-in-screen.tsx";
import { SignOutButton } from "../sign-in/sign-out-button.tsx";
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
            try again
          </Button>
        </>
      ) : (
        <p className={styles.muted}>connecting…</p>
      )}
    </main>
  );
};

/**
 * Signed in, while the shared options under `ui` are not read yet, with a way to sign out,
 * since a follow that keeps failing is asked again for as long as the page is signed in.
 * @param props - The attempt to sign out.
 * @returns The screen.
 */
const Reading = ({ signOut: attempt }: { readonly signOut: Attempt }) => (
  <main className={styles.checking}>
    <p className={styles.muted}>loading…</p>
    {attempt._tag === "Failed" ? (
      <p className={styles.failure} role="alert">
        {explain(attempt.failure)}
      </p>
    ) : null}
    <SignOutButton attempt={attempt} />
  </main>
);

/**
 * The screen for the sign-in state. Signed in, the shell waits for the shared options under
 * `ui`, so it never draws first in a theme, font, or format the Owner has overridden. They
 * are read on every load and again after each sign-in, since signing out forgets them.
 * @returns The screen.
 */
export const App = () => {
  const state = useAtomValue(signInState);
  // Read whatever the state, so the options are followed, and forgotten on signing out.
  const known = useAtomValue(uiKnown);

  switch (state._tag) {
    case "Unknown": {
      return <Checking check={state.check} />;
    }

    case "SignedOut": {
      return <SignInScreen attempt={state.signIn} />;
    }

    case "SignedIn": {
      return known ? <Shell signOut={state.signOut} /> : <Reading signOut={state.signOut} />;
    }

    default: {
      return state satisfies never;
    }
  }
};
