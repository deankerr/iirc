/**
 * A player's play button, which says where it plays from, on hover and by name, and
 * starts the player when pressed. It is a plain button, reachable by keyboard, and draws
 * nothing of the player itself.
 *
 * @packageDocumentation
 */
import type { PlayerShown } from "@iirc/frontend/previews";
import { Button as AriaButton } from "react-aria-components";

import { Icon } from "../ui/icon.tsx";

import styles from "./play-button.module.css";

/**
 * The play button of a player, beside its summary or centred over its poster.
 * @param props - The player, as drawn, where the button is drawn, and what a press does.
 * @returns The button.
 */
export const PlayButton = ({
  onPlay,
  over,
  player,
}: {
  readonly player: PlayerShown;
  readonly over: "poster" | "text";
  readonly onPlay: () => void;
}) => (
  <span className={styles.place} data-over={over} title={player.words}>
    <AriaButton aria-label={`Play from ${player.host}`} className={styles.button} onPress={onPlay}>
      <Icon name="play" />
    </AriaButton>
  </span>
);
