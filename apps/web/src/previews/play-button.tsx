/**
 * A player's play button, which says where it plays from. Nothing plays yet, so it is
 * disabled, and its hover words are on the element around it, since a disabled button
 * is hovered by nothing. It draws no frame and loads nothing from where it plays from.
 *
 * @packageDocumentation
 */
import type { PlayerShown } from "@iirc/frontend/previews";
import { Button as AriaButton } from "react-aria-components";

import { Icon } from "../ui/icon.tsx";

import styles from "./play-button.module.css";

/**
 * The play button of a player, beside its summary or centred over its poster.
 * @param props - The player, as drawn, and where the button is drawn.
 * @returns The button.
 */
export const PlayButton = ({
  over,
  player,
}: {
  readonly player: PlayerShown;
  readonly over: "poster" | "text";
}) => (
  <span className={styles.hover} data-over={over} title={player.words}>
    <AriaButton aria-label={`Play from ${player.host}`} className={styles.button} isDisabled>
      <Icon name="play" />
    </AriaButton>
  </span>
);
