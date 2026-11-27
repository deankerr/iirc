/**
 * A play button, in the middle of the box of what it plays, over its poster or alone. It
 * says what it plays by name, and on hover where it has words for it, and starts it when
 * pressed. It is a plain button, reachable by keyboard, and draws nothing of what it plays.
 * What it starts takes its place, so it says whether the press was the keyboard's or
 * assistive technology's: then the focus was on it, and goes with what it started. A
 * pointer's press leaves the focus be, so a key typed next still reaches the page rather
 * than another site's frame.
 *
 * @packageDocumentation
 */
import { Button as AriaButton } from "react-aria-components";

import { Icon } from "../../ui/icon.tsx";

import styles from "./play-button.module.css";

/**
 * What a play button is: its accessible name, the words a hover says, if any, and what a
 * press does, told whether the focus follows to what it starts.
 */
export interface Play {
  readonly label: string;
  readonly words: string | undefined;
  readonly onPlay: (follows: boolean) => void;
}

/**
 * A play button.
 * @param props - What it is.
 * @returns The button.
 */
export const PlayButton = ({ label, onPlay, words }: Play) => (
  <span className={styles.place} title={words}>
    <AriaButton
      aria-label={label}
      className={styles.button}
      onPress={({ pointerType }) => {
        onPlay(pointerType === "keyboard" || pointerType === "virtual");
      }}
    >
      <Icon name="play" />
    </AriaButton>
  </span>
);
