/**
 * What a signed-in browser sees: the Networks and their Timelines, the Panes, each showing
 * a Timeline or the options, with its Channel's members beside it when shown, the composer
 * under them, writing to the focused Pane's Timeline, the command palette and the keys, and
 * signing out. On a compact screen the sidebar is a drawer instead, opened from a button in
 * the bar that marks what is unread.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Level } from "@iirc/api";
import { saidLevel } from "@iirc/frontend/activity";
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";
import { Atom } from "effect/reactivity";
import { Button as AriaButton, Dialog, Modal, ModalOverlay } from "react-aria-components";

import { MainComposer } from "../composer/composer.tsx";
import { CredentialPrompt } from "../options/credential-prompt.tsx";
import { compact, drawerShown, drawerState } from "../page/drawer.ts";
import { Keys } from "../palette/keys.tsx";
import { Palette } from "../palette/palette.tsx";
import { PaneSwitcher } from "../panes/pane-switcher.tsx";
import { PaneTree } from "../panes/pane-tree.tsx";
import { Pane } from "../panes/pane.tsx";
import { signOut } from "../sign-in/atoms.ts";
import { ImportDialog } from "../theme/import-dialog.tsx";
import { sidebarNetworks } from "../timelines/atoms.ts";
import { Sidebar } from "../timelines/sidebar.tsx";
import { Button } from "../ui/button.tsx";

import styles from "./shell.module.css";

/** The highest level said and unread across every Network, which the sidebar's button marks. */
const unread = Atom.make((get) => saidLevel(get(sidebarNetworks)));

/** What the sidebar's button says is unread, for a screen reader, by the highest level. */
const unreadWords: Readonly<Record<Level, string>> = {
  Activity: "",
  Direct: ", a Direct Message unread",
  Highlight: ", a Highlight unread",
  Message: ", Messages unread",
};

/** The class that colours the sidebar button's mark by the highest level unread. */
const markClass: Readonly<Record<Level, string>> = {
  Activity: "",
  Direct: styles.markDirect,
  Highlight: styles.markHighlight,
  Message: styles.markMessage,
};

/**
 * The button that opens the sidebar's drawer on a compact screen, marked while anything
 * said is unread anywhere, by the highest level.
 * @returns The button.
 */
const SidebarButton = () => {
  const level = useAtomValue(unread);
  const shown = useAtomValue(drawerShown);
  const setDrawer = useAtomSet(drawerState);

  return (
    <AriaButton
      aria-expanded={shown === "Sidebar"}
      aria-label={`Networks${level === undefined ? "" : unreadWords[level]}`}
      className={styles.menu}
      onPress={() => {
        setDrawer("Sidebar");
      }}
    >
      <span aria-hidden="true">≡</span>
      {level === undefined ? null : (
        <span aria-hidden="true" className={`${styles.mark} ${markClass[level]}`} />
      )}
    </AriaButton>
  );
};

/**
 * The sidebar as a drawer from the side, on a compact screen: a modal dialog, which a
 * press on the page beside it or Escape closes, and so does choosing what to show.
 * @returns The drawer.
 */
const SidebarDrawer = () => {
  const shown = useAtomValue(drawerShown);
  const setDrawer = useAtomSet(drawerState);

  return (
    <ModalOverlay
      className={styles.scrim}
      isDismissable
      isOpen={shown === "Sidebar"}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          setDrawer("None");
        }
      }}
    >
      <Modal className={styles.drawer}>
        <Dialog aria-label="Networks" className={styles.drawerDialog}>
          <Sidebar />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};

/**
 * The shell, with the attempt to sign out.
 * @param props - The attempt to sign out.
 * @returns The shell.
 */
export const Shell = ({ signOut: attempt }: { readonly signOut: Attempt }) => {
  const signOutNow = useAtomSet(signOut);
  const drawn = useAtomValue(compact);

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        {drawn ? <SidebarButton /> : null}
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
        {drawn ? null : <Sidebar />}
        <main className={styles.main}>
          <PaneSwitcher />
          <div className={styles.view}>
            <PaneTree render={(pane) => <Pane pane={pane} />} />
          </div>
          <CredentialPrompt />
          <MainComposer />
        </main>
      </div>
      {drawn ? <SidebarDrawer /> : null}
      <Palette />
      <ImportDialog />
      <Keys />
    </div>
  );
};
