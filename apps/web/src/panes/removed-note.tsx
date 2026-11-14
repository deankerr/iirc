/**
 * The line under a Pane's status bar while it shows a Timeline of a Network removed with
 * its Timelines kept: that it was removed, that the Timeline is only read, and a button
 * that asks to drop them, as `/network remove` does.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { removedIn } from "@iirc/frontend/timelines";
import { Atom } from "effect/reactivity";

import { askToRemove } from "../options/removal.ts";
import { timelinesState } from "../timelines/atoms.ts";
import { Button } from "../ui/button.tsx";

import styles from "./removed-note.module.css";

/** The removed Network each Pane's Timeline belongs to, if it does. */
const removedNetwork = Atom.family((pane: string) =>
  Atom.make((get) => removedIn(get(timelinesState), pane))
);

/**
 * The line, or nothing when the Pane's Timeline is not of a removed Network.
 * @param props - The Pane.
 * @returns The line.
 */
export const RemovedNote = ({ pane }: { readonly pane: string }) => {
  const network = useAtomValue(removedNetwork(pane));
  const ask = useAtomSet(askToRemove);

  return network === undefined ? null : (
    <p className={styles.note} role="note">
      <span>
        <bdi>{network}</bdi> was removed. Its Timelines are kept to read and search, and nothing can
        be said here.
      </span>
      <Button
        onPress={() => {
          ask(network);
        }}
        size="small"
      >
        Drop them…
      </Button>
    </p>
  );
};
