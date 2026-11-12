/**
 * A Pane's status bar: one line across the top of every Pane, whatever it shows, with its
 * number among several, its name, what it says after its name, and its control at the
 * right, and under that line whatever it discloses. Among several Panes, those without the focus have their names dimmed, as the
 * sidebar dims what another Pane shows, and the focused one's is accented.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";

import { alone, focusedId, paneNumber } from "./atoms.ts";

import styles from "./pane-bar.module.css";

/**
 * A Pane's status bar.
 * @param props - The Pane, its name, what the bar says after it, its control at the right,
 * and what it discloses under its line.
 * @returns The bar.
 */
export const PaneBar = ({
  below,
  children,
  end,
  name,
  pane,
}: {
  readonly pane: string;
  readonly name: string;
  readonly children?: ReactNode;
  readonly end?: ReactNode;
  readonly below?: ReactNode;
}) => {
  const number = useAtomValue(paneNumber(pane));
  const focused = useAtomValue(focusedId) === pane;
  const one = useAtomValue(alone);

  return (
    <header className={styles.bar} data-dim={number !== undefined && !one && !focused}>
      <div className={styles.line}>
        {number === undefined ? null : (
          <span className={styles.dim} title={`Pane ${number}`}>
            {number}
          </span>
        )}
        <h2 className={styles.name}>
          <bdi>{name}</bdi>
        </h2>
        {children}
        {end === undefined ? null : <span className={styles.end}>{end}</span>}
      </div>
      {below}
    </header>
  );
};

/**
 * Words on a Pane's bar after its name: dim, or a note that calls for the Owner, and
 * filling what is left of the line, cut with an ellipsis, unless `fill` is false.
 * @param props - The words, their tone, and whether they fill the line.
 * @returns The words.
 */
export const BarText = ({
  children,
  fill = true,
  tone = "Dim",
}: {
  readonly children: ReactNode;
  readonly tone?: "Dim" | "Note";
  readonly fill?: boolean;
}) => (
  <span
    className={`${tone === "Dim" ? styles.dim : styles.note} ${fill ? styles.rest : styles.fixed}`}
  >
    {children}
  </span>
);
