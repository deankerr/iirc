/**
 * A video the Daemon streams, in the one box its poster and it share, so playing it moves
 * nothing below it. With a poster, it rests as the poster under a play button, or the play
 * button alone in the box once the poster fails to load, and the button swaps in the video,
 * already playing, the focus going with it from a press of the keyboard's. With no poster
 * it is the browser's own player, which fetches nothing until play is pressed. Either way a
 * control in its corner opens the lightbox, pausing the video where it plays in place.
 * Nothing is streamed until play is pressed. Where the video cannot be played, it draws
 * nothing and says it failed.
 *
 * @packageDocumentation
 */
import type { LinkShown, VideoShown } from "@iirc/frontend/previews";
import { useCallback, useEffect, useRef, useState } from "react";

import { LightboxButton } from "./lightbox-button.tsx";
import { MediaBox } from "./media-box.tsx";
import { PlayButton } from "./play-button.tsx";
import { Poster } from "./poster.tsx";

import box from "./media-box.module.css";

/**
 * A video.
 * @param props - The video, its page's link, what to call it, whether it plays at once, and
 *   what it says when it cannot be played.
 * @returns The video, its poster, or nothing once it failed.
 */
export const Video = ({
  link,
  name,
  onFail,
  playing: started,
  video,
}: {
  readonly link: LinkShown;
  readonly name: string;
  readonly onFail: () => void;
  readonly playing: boolean;
  readonly video: VideoShown;
}) => {
  const element = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(started);
  // Whether the focus was on the play button the video took the place of.
  const [follows, setFollows] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [failed, setFailed] = useState(false);

  const failPoster = useCallback(() => {
    setPosterFailed(true);
  }, []);

  useEffect(() => {
    if (follows) {
      element.current?.focus();
    }
  }, [follows]);

  if (failed) {
    return null;
  }

  // A poster that moves is drawn as its first frame, and is no still for the video.
  const still =
    video.poster === undefined || video.poster.animated || posterFailed
      ? undefined
      : video.poster.src;

  if (video.poster !== undefined && !playing) {
    const play = {
      label: `play ${name}`,
      onPlay: (focused: boolean) => {
        setFollows(focused);
        setPlaying(true);
      },
      words: undefined,
    };

    const corner = (
      <LightboxButton
        link={link}
        media={{ _tag: "Video", poster: still, src: video.src }}
        name={name}
      />
    );

    return posterFailed ? (
      <MediaBox size={video.box}>
        <PlayButton {...play} />
        {corner}
      </MediaBox>
    ) : (
      <Poster
        corner={corner}
        key={video.poster.src}
        onFail={failPoster}
        play={play}
        poster={video.poster}
        size={video.box}
      />
    );
  }

  return (
    <MediaBox size={video.box}>
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a stranger's media carries no captions the Daemon could offer */}
      <video
        aria-label={name}
        autoPlay={playing}
        className={box.fill}
        controls
        onError={() => {
          setFailed(true);
          onFail();
        }}
        poster={still}
        preload={playing ? undefined : "none"}
        ref={element}
        src={video.src}
      />
      <LightboxButton
        link={link}
        media={{ _tag: "Video", poster: still, src: video.src }}
        name={name}
        onOpen={() => {
          element.current?.pause();
        }}
      />
    </MediaBox>
  );
};
