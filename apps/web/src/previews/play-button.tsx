/**
 * A play button, which says what it plays by name, and on hover where it has words for it,
 * and starts it when pressed. It is a plain button, reachable by keyboard, and draws
 * nothing of what it plays.
 *
 * @packageDocumentation
 */
import { Button as AriaButton } from "react-aria-components";

import { Icon } from "../ui/icon.tsx";

import styles from "./play-button.module.css";

/**
 * What a play button is: its accessible name, the words a hover says, if any, and what a
 * press does.
 */
export interface Play {
  readonly label: string;
  readonly words: string | undefined;
  readonly onPlay: () => void;
}

/**
 * A play button, after a card's words or centred over a poster.
 * @param props - What it is, and where it is drawn.
 * @returns The button.
 */
export const PlayButton = ({
  label,
  onPlay,
  over,
  words,
}: Play & { readonly over: "poster" | "text" }) => (
  <span className={styles.place} data-over={over} title={words}>
    <AriaButton aria-label={label} className={styles.button} onPress={onPlay}>
      <Icon name="play" />
    </AriaButton>
  </span>
);
