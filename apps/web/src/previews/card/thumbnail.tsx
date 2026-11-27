/**
 * The square at a collapsed link card's start, as tall as the card: its picture cropped to
 * fill it, keeping the top, where a face or a title usually is; the poster of what plays
 * under a play glyph; or the glyph alone for what plays with none. An animated picture or
 * poster is drawn as its first frame, since nothing moves until the card is expanded, and
 * nothing is loaded until it is near the view.
 *
 * A picture is part of the card, not a control of its own, so a click on it is a click on
 * the card. One that fails says so, and the card drops it. A thumbnail that plays is a
 * button of its own, which expands the card and plays at once; a poster that fails leaves
 * the glyph alone.
 *
 * @packageDocumentation
 */
import type { PictureShown, ThumbnailShown } from "@iirc/frontend/previews";
import { useCallback, useEffect, useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { Icon } from "../../ui/icon.tsx";
import { FirstFrame, useFirstFrame } from "../media/first-frame.tsx";
import { useNearView } from "../media/near-view.ts";

import styles from "./thumbnail.module.css";

/**
 * A thumbnail's picture, cropped to its square, loaded once it is near the view.
 * @param props - The picture, and what it says when it cannot be drawn.
 * @returns The picture, or nothing yet.
 */
const ThumbnailPicture = ({
  onFail,
  picture,
}: {
  readonly onFail: () => void;
  readonly picture: PictureShown;
}) => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const near = useNearView(element);
  const fetched = useFirstFrame(near && picture.animated ? picture.src : undefined);
  const failed = fetched._tag === "Failed";

  useEffect(() => {
    if (failed) {
      onFail();
    }
  }, [failed, onFail]);

  if (!near) {
    return <span aria-hidden className={styles.picture} ref={setElement} />;
  }

  if (!picture.animated) {
    return (
      <img
        alt=""
        className={styles.picture}
        decoding="async"
        onError={onFail}
        referrerPolicy="no-referrer"
        src={picture.src}
      />
    );
  }

  return fetched._tag === "Ready" ? (
    <FirstFrame className={styles.picture} frame={fetched.frame} />
  ) : null;
};

/**
 * The play glyph, over the middle of a poster or alone.
 * @returns The glyph.
 */
const PlayGlyph = () => (
  <span aria-hidden className={styles.play}>
    <Icon name="play" />
  </span>
);

/**
 * A poster that plays, under the play glyph, or the glyph alone once the poster fails.
 * @param props - The poster, what the button is called, and what a press does.
 * @returns The button.
 */
const PosterThumbnail = ({
  label,
  onPlay,
  poster,
}: {
  readonly label: string;
  readonly onPlay: () => void;
  readonly poster: PictureShown;
}) => {
  const [failed, setFailed] = useState(false);

  const fail = useCallback(() => {
    setFailed(true);
  }, []);

  return (
    <AriaButton aria-label={label} className={styles.thumb} data-thumb="poster" onPress={onPlay}>
      {failed ? null : <ThumbnailPicture onFail={fail} picture={poster} />}
      <PlayGlyph />
    </AriaButton>
  );
};

/**
 * A collapsed link card's thumbnail.
 * @param props - The thumbnail; what one that plays is called and what its press does; and
 *   what a picture says when it cannot be drawn.
 * @returns The thumbnail, or nothing for none.
 */
export const Thumbnail = ({
  label,
  onFail,
  onPlay,
  thumbnail,
}: {
  readonly label: string;
  readonly onFail: () => void;
  readonly onPlay: () => void;
  readonly thumbnail: ThumbnailShown;
}) => {
  switch (thumbnail._tag) {
    case "None": {
      return null;
    }

    case "Picture": {
      return (
        <span className={styles.thumb} data-thumb="picture">
          <ThumbnailPicture
            key={thumbnail.picture.src}
            onFail={onFail}
            picture={thumbnail.picture}
          />
        </span>
      );
    }

    case "Poster": {
      return (
        <PosterThumbnail
          key={thumbnail.poster.src}
          label={label}
          onPlay={onPlay}
          poster={thumbnail.poster}
        />
      );
    }

    case "Play": {
      return (
        <AriaButton aria-label={label} className={styles.thumb} data-thumb="play" onPress={onPlay}>
          <PlayGlyph />
        </AriaButton>
      );
    }

    default: {
      return thumbnail satisfies never;
    }
  }
};
