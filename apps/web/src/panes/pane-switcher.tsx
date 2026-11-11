/**
 * The Panes, as a compact row of their numbers and names, shown on a compact screen, where
 * only the focused Pane shows, and while zoomed, so every Pane is a press away. Choosing
 * one focuses it, as Alt+Shift and an arrow does. The layout stays as it was.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { panesOf } from "@iirc/frontend/layout";
import { opened } from "@iirc/frontend/timelines";
import { Atom } from "effect/reactivity";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import type { Key } from "react-aria-components";

import { timelinesState } from "../timelines/atoms.ts";
import { alone, focusedId, focusPane } from "./atoms.ts";

import styles from "./pane-switcher.module.css";

/** Every Pane, with its number and what it shows, in a word or a name. */
const choices = Atom.make((get) => {
  const state = get(timelinesState);

  return panesOf(state.layout.root).map((pane, index) => {
    const shown = opened(state, pane.id);
    let name = "empty";

    if (pane.view.main._tag === "Options") {
      name = "options";
    } else if (pane.view.main._tag === "Search") {
      name = "search";
    } else if (shown._tag === "Shown") {
      name = shown.description?.name ?? "Timeline";
    } else if (shown._tag !== "Closed") {
      name = "…";
    }

    return { id: pane.id, name, number: index + 1 };
  });
});

/**
 * The switcher, while one Pane shows alone among several.
 * @returns The switcher, or nothing.
 */
export const PaneSwitcher = () => {
  const one = useAtomValue(alone);
  const panes = useAtomValue(choices);
  const focused = useAtomValue(focusedId);
  const focus = useAtomSet(focusPane);

  if (!one || panes.length < 2) {
    return null;
  }

  return (
    <ToggleButtonGroup
      aria-label="Panes"
      className={styles.switcher}
      disallowEmptySelection
      onSelectionChange={(keys: Set<Key>) => {
        const [key] = keys;
        const pane = panes.find((one) => one.id === key);

        if (pane !== undefined) {
          focus(pane.id);
        }
      }}
      selectedKeys={[focused]}
      selectionMode="single"
    >
      {panes.map((pane) => (
        <ToggleButton className={styles.choice} id={pane.id} key={pane.id}>
          <span className={styles.number}>{pane.number}</span> <bdi>{pane.name}</bdi>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
};
