/**
 * A Message's Previews, under its text behind a left rule, one row each: a pulsing
 * placeholder while pending, a ready one's site and title on one line, which a press opens
 * to its description, a failed one as the plain link, saying why on hover, and one the
 * Daemon holds for a press as the plain link and "show preview", which fetches it. A link
 * that is itself a video or a sound is its summary with a native player under it, which
 * fetches nothing until pressed. A video, a link to one or a page that names one, has a
 * control in its corner that opens it large, pausing it where it plays in place. A page's
 * video is its text with its poster under it and a play button over the poster, or beside
 * the text with no poster; nothing is streamed until play is pressed, which swaps the
 * poster for the video, already playing. A player is its text with its poster under it and
 * a play button, which says where it plays from, over the poster, or beside the text with
 * no poster; nothing loads from where it plays from until play is pressed, which swaps the
 * poster for the player in a sandboxed frame, already playing. An image is loaded only
 * once it scrolls into view. Its Previews are asked for only once the Message scrolls into
 * view, as an intersection observer sees it, never ahead, and only while its Timeline's
 * mode asks.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineItem } from "@iirc/api";
import { mayPreview, modeIn, previewsOf } from "@iirc/frontend/previews";
import type {
  ImageShown,
  LinkShown,
  MediaShown,
  PlayerShown,
  PreviewShown,
} from "@iirc/frontend/previews";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton, Disclosure, DisclosurePanel } from "react-aria-components";

import { pressPreview, previewsModes, previewsShown, previewsState } from "./atoms.ts";
import { PlayButton } from "./play-button.tsx";
import {
  EnlargeControl,
  PlayerFrame,
  PreviewImage,
  PreviewPoster,
  VideoBox,
  VideoFrame,
} from "./preview-image.tsx";

import styles from "./message-previews.module.css";

/** No host listed as a player, before the shared options are read. */
const noPlayers: readonly string[] = [];

/**
 * A link as a Preview draws it: an anchor that opens in a new tab, or its text alone when
 * the core found no link in it.
 * @param props - The link, and what a hover says of it.
 * @returns The link.
 */
const PlainLink = ({
  link,
  title,
}: {
  readonly link: LinkShown;
  readonly title: string | undefined;
}) =>
  link.href === undefined ? (
    <bdi className={styles.plain} title={title}>
      {link.text}
    </bdi>
  ) : (
    <a
      className={styles.plain}
      href={link.href}
      rel="noopener noreferrer"
      target="_blank"
      title={title}
    >
      <bdi>{link.text}</bdi>
    </a>
  );

/**
 * A video as the browser's own player, with the control in its corner that opens it large
 * and pauses it. It streams nothing from the Daemon until the Owner presses play, or opens
 * it large, and plays in place only as the Owner asks.
 * @param props - The media, what to call it, the page's link, and what happens on failure.
 * @returns The video in its box.
 */
const VideoPlayer = ({
  autoPlay,
  link,
  media,
  name,
  onError,
  poster,
}: {
  readonly autoPlay: boolean;
  readonly link: LinkShown;
  readonly media: MediaShown;
  readonly name: string;
  readonly onError: () => void;
  readonly poster: string | undefined;
}) => {
  const video = useRef<HTMLVideoElement>(null);

  return (
    <VideoBox
      aria-label={autoPlay ? name : `Play ${name}`}
      autoPlay={autoPlay}
      corner={
        <EnlargeControl
          large={{ _tag: "Video", poster, src: media.src }}
          link={link}
          name={name}
          onOpen={() => {
            video.current?.pause();
          }}
        />
      }
      data-preview-media="video"
      onError={onError}
      poster={poster}
      preload={autoPlay ? undefined : "none"}
      reference={video}
      src={media.src}
    />
  );
};

/**
 * A link that is itself a video or a sound, as the browser's own player, which fetches
 * nothing from the Daemon's stream until the Owner presses play. A video has the control
 * to open it large. Where it fails to play, nothing is drawn, and the text beside it
 * stands alone.
 * @param props - The media, what to call it, and the page's link.
 * @returns The player, or nothing.
 */
const PreviewMedia = ({
  link,
  media,
  name,
}: {
  readonly link: LinkShown;
  readonly media: MediaShown;
  readonly name: string;
}) => {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return null;
  }

  if (media.kind === "video") {
    return (
      <VideoPlayer
        autoPlay={false}
        link={link}
        media={media}
        name={name}
        onError={() => {
          setFailed(true);
        }}
        poster={undefined}
      />
    );
  }

  // A stranger's media carries no captions the Daemon could offer.
  return (
    // oxlint-disable-next-line jsx-a11y/media-has-caption
    <audio
      aria-label={`Play ${name}`}
      className={styles.audio}
      controls
      data-preview-media="audio"
      onError={() => {
        setFailed(true);
      }}
      preload="none"
      src={media.src}
    />
  );
};

/**
 * A ready Preview's text: its summary, opening to its description when it has one.
 * @param props - The Preview, as drawn.
 * @returns Its text.
 */
const ReadyText = ({
  shown,
}: {
  readonly shown: Extract<PreviewShown, { readonly _tag: "Ready" }>;
}) => {
  if (shown.description === undefined) {
    return (
      <div className={styles.text}>
        <bdi className={styles.summary}>{shown.summary}</bdi>
      </div>
    );
  }

  return (
    <Disclosure className={styles.text}>
      <AriaButton className={styles.summary} slot="trigger">
        <bdi>{shown.summary}</bdi>
      </AriaButton>
      <DisclosurePanel className={styles.description}>
        <bdi>{shown.description}</bdi>
      </DisclosurePanel>
    </Disclosure>
  );
};

/**
 * A player: its text with its poster under it and a play button, which says where it plays
 * from, over the poster, or beside the text with no poster or once it fails to load.
 * Pressing play swaps the poster, or the button, for the player. Whether it plays is this
 * view's own, held nowhere else, and nothing is loaded from the player's host before then.
 * @param props - The player, its image if it has one, and its text.
 * @returns The player.
 */
const PreviewPlayer = ({
  image,
  player,
  text,
}: {
  readonly image: ImageShown | undefined;
  readonly player: PlayerShown;
  readonly text: ReactElement;
}) => {
  const [playing, setPlaying] = useState(false);

  const play = () => {
    setPlaying(true);
  };

  const label = `Play from ${player.host}`;

  if (playing) {
    return <PlayerFrame player={player} text={text} />;
  }

  return image?.drawn === "Poster" ? (
    <PreviewPoster
      corner={null}
      image={image}
      key={image.src}
      play={{ label, onPlay: play, words: player.words }}
      text={text}
    />
  ) : (
    <>
      {text}
      <PlayButton label={label} onPlay={play} over="text" words={player.words} />
    </>
  );
};

/**
 * A page's video: its text with its poster under it and a play button over the poster, or
 * beside the text with no poster or once it fails to load, and the control that opens it
 * large in the poster's corner. Pressing play swaps the poster for the video in the same
 * place, already playing, which streams only then. Where it fails to play, the text
 * stands alone.
 * @param props - The video's media, its poster, the page's link, what to call it, and its
 * text.
 * @returns The video.
 */
const PosterVideo = ({
  image,
  link,
  media,
  name,
  text,
}: {
  readonly image: ImageShown;
  readonly link: LinkShown;
  readonly media: MediaShown;
  readonly name: string;
  readonly text: ReactElement;
}) => {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  // A poster that moves is drawn as its first frame, and is no still for the video.
  const poster = image.animated ? undefined : image.src;

  if (failed) {
    return text;
  }

  if (playing) {
    return (
      <VideoFrame
        box={
          <VideoPlayer
            autoPlay
            link={link}
            media={media}
            name={name}
            onError={() => {
              setFailed(true);
            }}
            poster={poster}
          />
        }
        text={text}
      />
    );
  }

  return (
    <PreviewPoster
      corner={
        <EnlargeControl large={{ _tag: "Video", poster, src: media.src }} link={link} name={name} />
      }
      image={image}
      key={image.src}
      play={{
        label: `Play ${name}`,
        onPlay: () => {
          setPlaying(true);
        },
        words: undefined,
      }}
      text={text}
    />
  );
};

/**
 * One Preview.
 * @param props - The Preview, as drawn, and what presses a link waiting for it.
 * @returns Its row.
 */
const PreviewRow = ({
  onPress,
  shown,
}: {
  readonly shown: PreviewShown;
  readonly onPress: (link: number) => void;
}) => {
  switch (shown._tag) {
    case "Pending": {
      return (
        <div className={styles.pending} data-preview="pending">
          <span aria-hidden className={styles.pulse} />
          <span className={styles.unseen}>
            Previewing <bdi>{shown.link.text}</bdi>
          </span>
        </div>
      );
    }

    case "Ready": {
      const text = <ReadyText shown={shown} />;
      const { image, media, player } = shown;

      // A link that is itself a video or a sound is its text, with the player under it,
      // and one that fails to play leaves the text alone.
      if (media !== undefined) {
        // A page's video with a poster is its text with the poster under it, and plays in
        // its place.
        if (media.kind === "video" && image?.drawn === "Poster") {
          return (
            <div className={styles.ready} data-preview="ready">
              <PosterVideo
                image={image}
                key={media.src}
                link={shown.link}
                media={media}
                name={shown.summary}
                text={text}
              />
            </div>
          );
        }

        return (
          <div className={styles.media} data-preview="ready">
            {text}
            <PreviewMedia key={media.src} link={shown.link} media={media} name={shown.summary} />
          </div>
        );
      }

      // A player is its text with its poster under it, and a play button over the poster,
      // which becomes the player, already playing, once pressed.
      if (player !== undefined) {
        return (
          <div className={styles.ready} data-preview="ready">
            {/* Keyed by its address, a press plays only the player it was given for: one
                the Daemon answers anew waits for a press of its own. */}
            <PreviewPlayer image={image} key={player.src} player={player} text={text} />
          </div>
        );
      }

      // A link that is itself an image is the image alone; a page's is beside its text.
      // Keyed by its source, a new image gets a fresh try, and one that fails leaves
      // exactly the text it would have been without.
      return (
        <div className={styles.ready} data-preview="ready">
          {image?.drawn === "Whole" ? (
            <PreviewImage image={image} key={image.src} link={shown.link} without={text} />
          ) : (
            <>
              {text}
              {image === undefined ? null : (
                <PreviewImage image={image} key={image.src} link={shown.link} without={null} />
              )}
            </>
          )}
        </div>
      );
    }

    case "Plain": {
      return (
        <div
          className={styles.failed}
          data-preview={shown.reason === undefined ? "plain" : "failed"}
        >
          <PlainLink link={shown.link} title={shown.reason} />
        </div>
      );
    }

    // Pressed twice, the second press is refused, and the Message is asked for again.
    case "Waiting": {
      return (
        <div className={styles.waiting} data-preview="waiting">
          <PlainLink link={shown.link} title={undefined} />
          <AriaButton
            aria-label={`Show a preview of ${shown.link.text}`}
            className={styles.press}
            onPress={() => {
              onPress(shown.index);
            }}
          >
            show preview
          </AriaButton>
        </div>
      );
    }

    default: {
      return shown satisfies never;
    }
  }
};

/**
 * A Message's Previews, if it may have any, asked for once it scrolls into view.
 * @param props - The Message's item.
 * @returns Its Previews, or nothing.
 */
export const MessagePreviews = ({ item }: { readonly item: TimelineItem }) => {
  const modes = useAtomValue(previewsModes);
  const state = useAtomValue(previewsState);
  const show = useAtomSet(previewsShown);
  const press = useAtomSet(pressPreview);
  const block = useRef<HTMLUListElement>(null);
  const { content, position, timeline } = item;
  const mode = modeIn(modes, timeline);
  const players = modes?.players ?? noPlayers;
  const watched = mayPreview(mode, content);

  const shown = useMemo(
    () => previewsOf(state, mode, timeline, position, content, players),
    [content, mode, players, position, state, timeline]
  );

  // Seen once, and asked for then: the core asks for a Message once, however often it
  // comes back into view. Where no browser observes, nothing is asked for.
  useEffect(() => {
    const element = block.current;

    const observer =
      !watched || element === null || typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries, self) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              self.disconnect();
              show({ position, timeline });
            }
          });

    if (element !== null) {
      observer?.observe(element);
    }

    return () => {
      observer?.disconnect();
    };
  }, [position, show, timeline, watched]);

  if (shown.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Previews" className={styles.previews} ref={block}>
      {shown.map((one) => (
        <li className={styles.row} key={one.key}>
          <PreviewRow
            onPress={(link) => {
              press({ link, position, timeline });
            }}
            shown={one}
          />
        </li>
      ))}
    </ul>
  );
};
