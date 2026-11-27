/**
 * Another site's player, in the one box its poster and it share, so playing it moves nothing
 * below it. It rests as its poster under a play button, or the play button alone in the box
 * with no poster or once the poster fails to load, and the button says where it plays from.
 * Nothing loads from the player's host until play is pressed, which swaps in the player in a
 * sandboxed frame, already playing, the focus going with it from a press of the keyboard's.
 *
 * @packageDocumentation
 */
import type { PlayerShown } from "@iirc/frontend/previews";
import { useCallback, useEffect, useRef, useState } from "react";

import { MediaBox } from "./media-box.tsx";
import { PlayButton } from "./play-button.tsx";
import { Poster } from "./poster.tsx";

import box from "./media-box.module.css";

/**
 * A player.
 * @param props - The player, and whether it plays at once.
 * @returns The player's frame, its poster, or its play button.
 */
export const EmbeddedPlayer = ({
  player,
  playing: started,
}: {
  readonly player: PlayerShown;
  readonly playing: boolean;
}) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const [playing, setPlaying] = useState(started);
  // Whether the focus was on the play button the frame took the place of.
  const [follows, setFollows] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);

  const failPoster = useCallback(() => {
    setPosterFailed(true);
  }, []);

  useEffect(() => {
    if (follows) {
      frame.current?.focus();
    }
  }, [follows]);

  if (playing) {
    // The frame is sandboxed, so what plays there can run scripts and open a window of its
    // own, but cannot navigate this page, submit a form, or reach anything else of it, and
    // is told its origin and no more of where it was embedded.
    return (
      <MediaBox size={player.box}>
        <iframe
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          className={box.fill}
          ref={frame}
          referrerPolicy="strict-origin"
          // oxlint-disable-next-line react/iframe-missing-sandbox -- the frame is another site's, which the page's frame-src limits to the Owner's player hosts, so its own origin gives it nothing of ours, and a player needs both to play
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          src={player.src}
          title={`player from ${player.host}`}
        />
      </MediaBox>
    );
  }

  const play = {
    label: `play from ${player.host}`,
    onPlay: (focused: boolean) => {
      setFollows(focused);
      setPlaying(true);
    },
    words: player.words,
  };

  return player.poster === undefined || posterFailed ? (
    <MediaBox size={player.box}>
      <PlayButton {...play} />
    </MediaBox>
  ) : (
    <Poster
      key={player.poster.src}
      onFail={failPoster}
      play={play}
      poster={player.poster}
      size={player.box}
    />
  );
};
