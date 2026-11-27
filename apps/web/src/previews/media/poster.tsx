/**
 * The still before a video or a player plays: its poster in the box it plays in, with a
 * play button over the middle and what else sits in its corner. It loads only once it is
 * near the view, and an animated poster is drawn as its first frame, since nothing moves
 * until play is pressed. Only the play button and the corner take a press. Where the poster
 * cannot be loaded, it draws nothing and says so, and what plays decides what stands.
 *
 * @packageDocumentation
 */
import type { PictureShown, Size } from "@iirc/frontend/previews";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { FirstFrame, useFirstFrame } from "./first-frame.tsx";
import { MediaBox } from "./media-box.tsx";
import { useNearView } from "./near-view.ts";
import { PlayButton } from "./play-button.tsx";
import type { Play } from "./play-button.tsx";

import box from "./media-box.module.css";

/** A poster, the box it stands in, its play button, its corner, and what it says on failure. */
interface PosterProps {
  readonly corner?: ReactNode;
  readonly onFail: () => void;
  readonly play: Play;
  readonly poster: PictureShown;
  readonly size: Size;
}

/**
 * A poster that does not move.
 * @param props - The poster and what goes with it.
 * @returns The poster, or nothing once it failed.
 */
const StillPoster = ({ corner, onFail, play, poster, size }: PosterProps) => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const near = useNearView(element);
  const [loaded, setLoaded] = useState(false);

  return (
    <MediaBox loaded={loaded} reference={setElement} size={size}>
      {near ? (
        <>
          <img
            alt={poster.alt}
            className={box.picture}
            decoding="async"
            loading="lazy"
            onError={onFail}
            onLoad={() => {
              setLoaded(true);
            }}
            referrerPolicy="no-referrer"
            src={poster.src}
          />
          <PlayButton {...play} />
          {corner}
        </>
      ) : null}
    </MediaBox>
  );
};

/**
 * A poster that is animated, drawn still as its first frame from the Daemon's bytes.
 * @param props - The poster and what goes with it.
 * @returns The poster, or nothing once it failed.
 */
const FramePoster = ({ corner, onFail, play, poster, size }: PosterProps) => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const near = useNearView(element);
  const fetched = useFirstFrame(near ? poster.src : undefined);
  const failed = fetched._tag === "Failed";

  useEffect(() => {
    if (failed) {
      onFail();
    }
  }, [failed, onFail]);

  return (
    <MediaBox loaded={fetched._tag === "Ready"} reference={setElement} size={size}>
      {fetched._tag === "Ready" ? (
        <>
          <FirstFrame className={box.picture} frame={fetched.frame} />
          <PlayButton {...play} />
          {corner}
        </>
      ) : null}
    </MediaBox>
  );
};

/**
 * A poster with its play button over it, in the box what it stands for plays in.
 * @param props - The poster, the shape of its box, its play button, what sits in its
 *   corner, and what it says once it cannot be loaded.
 * @returns The poster.
 */
export const Poster = (props: PosterProps) =>
  props.poster.animated ? <FramePoster {...props} /> : <StillPoster {...props} />;
