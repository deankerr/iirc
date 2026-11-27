/**
 * A sound the Daemon streams, as the browser's own player, as wide as the room it has, which
 * fetches nothing until play is pressed. Where it cannot be played, it draws nothing and
 * says it failed.
 *
 * @packageDocumentation
 */
import type { SoundShown } from "@iirc/frontend/previews";
import { useState } from "react";

import styles from "./sound.module.css";

/**
 * A sound.
 * @param props - The sound, what to call it, whether it plays at once, and what it says when
 *   it cannot be played.
 * @returns The player, or nothing once it failed.
 */
export const Sound = ({
  name,
  onFail,
  playing,
  sound,
}: {
  readonly name: string;
  readonly onFail: () => void;
  readonly playing: boolean;
  readonly sound: SoundShown;
}) => {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return null;
  }

  return (
    // oxlint-disable-next-line jsx-a11y/media-has-caption -- a stranger's media carries no captions the Daemon could offer
    <audio
      aria-label={name}
      autoPlay={playing}
      className={styles.sound}
      controls
      onError={() => {
        setFailed(true);
        onFail();
      }}
      preload={playing ? undefined : "none"}
      src={sound.src}
    />
  );
};
