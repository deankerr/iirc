/**
 * A media card: a link that is itself an image, a video, or a sound, or rarely a player with
 * no words, as its media alone, flush with the text, on no surface. It is never collapsed,
 * and nothing plays until pressed. Media that cannot be drawn leaves nothing, so its row
 * takes no room.
 *
 * @packageDocumentation
 */
import type { MediaCardShown } from "@iirc/frontend/previews";
import { useState } from "react";

import { Media } from "../media/media.tsx";

import styles from "./card.module.css";

/**
 * A media card.
 * @param props - The card.
 * @returns The card, or nothing once its media failed.
 */
export const MediaCard = ({ card }: { readonly card: MediaCardShown }) => {
  // Keyed by its source, so media the Daemon answers anew gets a try of its own.
  const [failed, setFailed] = useState<string | undefined>();

  if (failed === card.media.src) {
    return null;
  }

  return (
    <div className={styles.card} data-layout="media" data-preview="ready">
      <Media
        link={card.link}
        media={card.media}
        name={card.name}
        onFail={() => {
          setFailed(card.media.src);
        }}
        playing={false}
      />
    </div>
  );
};
