/**
 * What a signed-in browser sees: the Networks and their Timelines, the Panes, each showing
 * a Timeline or the options, with its Channel's members beside it when shown, the composer
 * under them, writing to the focused Pane's Timeline, the command palette and the keys, and
 * signing out.
 *
 * @packageDocumentation
 */
import { useAtomSet } from "@effect/atom-react";
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";

import { MainComposer } from "../composer/composer.tsx";
import { CredentialPrompt } from "../options/credential-prompt.tsx";
import { Keys } from "../palette/keys.tsx";
import { Palette } from "../palette/palette.tsx";
import { PaneSwitcher } from "../panes/pane-switcher.tsx";
import { PaneTree } from "../panes/pane-tree.tsx";
import { Pane } from "../panes/pane.tsx";
import { signOut } from "../sign-in/atoms.ts";
import { ImportDialog } from "../theme/import-dialog.tsx";
import { Sidebar } from "../timelines/sidebar.tsx";
import { Button } from "../ui/button.tsx";

import styles from "./shell.module.css";

/**
 * The shell, with the attempt to sign out.
 * @param props - The attempt to sign out.
 * @returns The shell.
 */
export const Shell = ({ signOut: attempt }: { readonly signOut: Attempt }) => {
  const signOutNow = useAtomSet(signOut);

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
          <PaneSwitcher />
          <div className={styles.view}>
            <PaneTree render={(pane) => <Pane pane={pane} />} />
          </div>
          <CredentialPrompt />
          <MainComposer />
        </main>
      </div>
      <Palette />
      <ImportDialog />
      <Keys />
    </div>
  );
};
