/**
 * What a signed-in browser sees: the Networks and their Timelines, the open Timeline or
 * the options, the composer under them, and signing out.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";

import { MainComposer } from "../composer/composer.tsx";
import { mainView } from "../options/atoms.ts";
import { CredentialPrompt } from "../options/credential-prompt.tsx";
import { OptionsView } from "../options/options-view.tsx";
import { signOut } from "../sign-in/atoms.ts";
import { Sidebar } from "../timelines/sidebar.tsx";
import { TimelineView } from "../timelines/timeline-view.tsx";
import { Button } from "../ui/button.tsx";

import styles from "./shell.module.css";

/**
 * The shell, with the attempt to sign out.
 * @param props - The attempt to sign out.
 * @returns The shell.
 */
export const Shell = ({ signOut: attempt }: { readonly signOut: Attempt }) => {
  const signOutNow = useAtomSet(signOut);
  const main = useAtomValue(mainView);

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <h1 className={styles.title}>iirc</h1>
        {attempt._tag === "Failed" ? (
          <p className={styles.failure} role="alert">
            {explain(attempt.failure)}
          </p>
        ) : null}
        <Button
          isPending={attempt._tag === "Waiting"}
          onPress={() => {
            signOutNow();
          }}
        >
          Sign out
        </Button>
      </header>
      <div className={styles.body}>
        <Sidebar />
        <main className={styles.main}>
          <div className={styles.view}>
            {main._tag === "Options" ? <OptionsView /> : <TimelineView />}
          </div>
          <CredentialPrompt />
          <MainComposer />
        </main>
      </div>
    </div>
  );
};
