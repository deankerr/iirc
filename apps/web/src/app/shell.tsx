/**
 * What a signed-in browser sees: the Networks, and signing out.
 *
 * @packageDocumentation
 */
import { useAtomSet } from "@effect/atom-react";
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";

import { NetworkList } from "../networks/network-list.tsx";
import { signOut } from "../sign-in/atoms.ts";
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
      <main className={styles.main}>
        <NetworkList />
      </main>
    </div>
  );
};
