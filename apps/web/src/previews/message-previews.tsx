/**
 * A Message's Previews, under its text behind one left rule, each a card stacked under the
 * last: a pulsing placeholder while pending; once ready, the host it was read from when
 * another than its link's, its title, its description, cut to three lines until pressed,
 * and its media under them, each only when it has it; and a failure as one muted line of
 * why, never the link again. Only an open Preview is drawn, as the toggle after its link
 * leaves it, and a closed one draws nothing and takes no room. A link that is itself a video or a sound is the browser's own player,
 * which fetches nothing until pressed. A video, a link to one or a page that names one, has
 * a control in its corner that opens it large, pausing it where it plays in place. A page's
 * video is its poster under its words with a play button over it, or the video itself with
 * no poster; nothing is streamed until play is pressed, which swaps the poster for the
 * video, already playing. A player is its poster under its words with a play button, which
 * says where it plays from, over it, or after the words with no poster; nothing loads from
 * where it plays from until play is pressed, which swaps the poster for the player in a
 * sandboxed frame, already playing. An image is loaded only once it scrolls into view. Its
 * Previews are asked for only once the Message scrolls into view, as an intersection
 * observer sees it, never ahead, only while its Timeline's mode asks, and only while one of
 * them is open. The toggle after each link opens or closes its Preview.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineItem } from "@iirc/api";
import {
  asksFor,
  isOpen,
  mayPreview,
  modeIn,
  playsIn,
  previewableCount,
  previewsOf,
} from "@iirc/frontend/previews";
import type {
  CardShown,
  ImageShown,
  LinkShown,
  MediaShown,
  PlayerShown,
  PreviewShown,
  Size,
} from "@iirc/frontend/previews";
import type { CSSProperties, ReactElement, RefObject } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { mediaHeightShown } from "../options/ui.ts";
import {
  directIn,
  previewsModes,
  previewsOpening,
  previewsShown,
  previewsState,
  togglePreview,
} from "./atoms.ts";
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

/**
 * The custom property a Message's Previews draw their media's height from.
 * @param pixels - How tall media is at most, in pixels.
 * @returns The style that sets it.
 */
const mediaStyle = (pixels: number): CSSProperties => {
  const style: Record<`--${string}`, string> = { "--preview-media-height": `${pixels}px` };

  return style;
};

/** No host listed as a player, before the shared options are read. */
const noPlayers: readonly string[] = [];

/**
 * A video as the browser's own player, with the control in its corner that opens it large
 * and pauses it. It streams nothing from the Daemon until the Owner presses play, or opens
 * it large, and plays in place only as the Owner asks.
 * @param props - The media, what to call it, the page's link, what happens on failure, and
 * the shape of its box.
 * @returns The video in its box.
 */
const VideoPlayer = ({
  autoPlay,
  link,
  media,
  name,
  onError,
  poster,
  box,
}: {
  readonly autoPlay: boolean;
  readonly link: LinkShown;
  readonly media: MediaShown;
  readonly name: string;
  readonly onError: () => void;
  readonly poster: string | undefined;
  readonly box: Size;
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
      box={box}
      src={media.src}
    />
  );
};

/**
 * A video or a sound with no poster, as the browser's own player, which fetches nothing
 * from the Daemon's stream until the Owner presses play. A video has the control to open
 * it large. Where it fails to play, nothing is drawn, and the words above it stand alone.
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
        box={playsIn({})}
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
 * Whether an element's text runs past the lines it is cut to, measured as it is laid out
 * and again whenever its size changes. Where no browser lays it out, it never does.
 * @param element - The element.
 * @returns Whether it is cut.
 */
const useCut = (element: HTMLElement | null): boolean => {
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      if (element !== null) {
        setCut(element.scrollHeight > element.clientHeight);
      }
    };

    measure();

    const observer =
      element === null || typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);

    if (element !== null) {
      observer?.observe(element);
    }

    return () => {
      observer?.disconnect();
    };
  }, [element]);

  return cut;
};

/**
 * A card's description, cut to three lines. One that was cut is a press, which shows all of
 * it, and another cuts it again. Whether it is open is its card's, so a poster that becomes
 * its video or player, drawing the words again, leaves it as it was.
 * @param props - The description, whether it is open, and what a press sets it to.
 * @returns It.
 */
const Description = ({
  onOpen,
  open,
  text,
}: {
  readonly onOpen: (open: boolean) => void;
  readonly open: boolean;
  readonly text: string;
}) => {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const cut = useCut(open ? null : element);

  const words = (
    <bdi className={styles.description} data-open={open} ref={setElement}>
      {text}
    </bdi>
  );

  return cut || open ? (
    <AriaButton
      aria-expanded={open}
      className={styles.more}
      onPress={() => {
        onOpen(!open);
      }}
    >
      {words}
    </AriaButton>
  ) : (
    words
  );
};

/**
 * A card's words, each only when it has it: the host it was read from, its title, and its
 * description.
 * @param props - The card, the description shown whole if any, and what a press of it sets.
 * @returns Its words, or nothing when it has none.
 */
const CardWords = ({
  onOpen,
  opened,
  shown,
}: {
  readonly onOpen: (description: string | undefined) => void;
  readonly opened: string | undefined;
  readonly shown: CardShown;
}) => {
  const { description, host, title } = shown;

  if (host === undefined && title === undefined && description === undefined) {
    return null;
  }

  return (
    <div className={styles.words}>
      {host === undefined ? null : <bdi className={styles.host}>{host}</bdi>}
      {title === undefined ? null : <bdi className={styles.title}>{title}</bdi>}
      {/* Keyed by its text, a description answered anew is measured, and cut, anew. */}
      {description === undefined ? null : (
        <Description
          key={description}
          onOpen={(open) => {
            onOpen(open ? description : undefined);
          }}
          open={opened === description}
          text={description}
        />
      )}
    </div>
  );
};

/**
 * A player: its card's words with its poster under them and a play button, which says
 * where it plays from, over the poster, or after the words with no poster or once it fails
 * to load. Pressing play swaps the poster, or the button, for the player. Whether it plays
 * is this view's own, held nowhere else, and nothing is loaded from the player's host
 * before then.
 * @param props - The player, its image if it has one, and its card's words.
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
  const box = playsIn({ player, poster: image });

  if (playing) {
    return <PlayerFrame player={player} box={box} text={text} />;
  }

  return image?.drawn === "Poster" ? (
    <PreviewPoster
      corner={null}
      image={image}
      key={image.src}
      play={{ label, onPlay: play, words: player.words }}
      box={box}
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
 * A page's video: its card's words with its poster under them, a play button over the
 * poster, and the control that opens it large in the poster's corner; a poster that fails
 * to load leaves the video as a link to one is drawn, the browser's own player with that
 * control. Pressing play swaps the poster for the video in the same place, already
 * playing, which streams only then. Where it fails to play, the words stand alone.
 * @param props - The video's media, its poster, the page's link, what to call it, and its
 * card's words.
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

  // The box the poster, the video, and the video without its poster all stand in.
  const box = playsIn({ poster: image });

  if (failed) {
    return text;
  }

  const fail = () => {
    setFailed(true);
  };

  if (playing) {
    return (
      <VideoFrame
        box={
          <VideoPlayer
            autoPlay
            link={link}
            media={media}
            name={name}
            onError={fail}
            poster={poster}
            box={box}
          />
        }
        text={text}
      />
    );
  }

  // A poster that fails is a video with none, as a link to one is, with its own ⤢.
  const without = (
    <VideoFrame
      box={
        <VideoPlayer
          autoPlay={false}
          link={link}
          media={media}
          name={name}
          onError={fail}
          poster={undefined}
          box={box}
        />
      }
      text={text}
    />
  );

  return (
    <PreviewPoster
      without={without}
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
      box={box}
      text={text}
    />
  );
};

/**
 * A ready Preview's card: its words, and its media under them. Keyed by its source, each
 * media gets a fresh try when it changes, and one that fails leaves the words alone, or,
 * for a link that is itself media, which has none, nothing.
 * @param props - The card.
 * @returns Its parts.
 */
const Card = ({ shown }: { readonly shown: CardShown }) => {
  // The description shown whole, by its text, so one answered anew starts cut.
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const words = <CardWords onOpen={setOpened} opened={opened} shown={shown} />;
  const { image, link, media, name, player } = shown;

  // A page's video with a poster is its poster under the words, and plays in its place.
  if (media !== undefined && media.kind === "video" && image?.drawn === "Poster") {
    return (
      <PosterVideo
        image={image}
        key={media.src}
        link={link}
        media={media}
        name={name}
        text={words}
      />
    );
  }

  // A video with no poster, or a sound, is the browser's own player under the words.
  if (media !== undefined) {
    return (
      <>
        {words}
        <PreviewMedia key={media.src} link={link} media={media} name={name} />
      </>
    );
  }

  // A player is its poster under the words, and a play button over the poster, which
  // becomes the player, already playing, once pressed. Keyed by its address, a press plays
  // only the player it was given for: one the Daemon answers anew waits for a press of its
  // own.
  if (player !== undefined) {
    return <PreviewPlayer image={image} key={player.src} player={player} text={words} />;
  }

  return (
    <>
      {words}
      {image === undefined ? null : (
        <PreviewImage image={image} key={image.src} link={link} without={null} />
      )}
    </>
  );
};

/**
 * One open Preview.
 * @param props - The Preview, as drawn.
 * @returns Its card, or what stands in its place.
 */
const PreviewRow = ({ shown }: { readonly shown: PreviewShown }) => {
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
      return (
        <div className={styles.card} data-preview="ready">
          <Card shown={shown} />
        </div>
      );
    }

    case "Failed": {
      return (
        <p className={styles.failed} data-preview="failed" title={shown.reason}>
          {shown.reason}
        </p>
      );
    }

    default: {
      return shown satisfies never;
    }
  }
};

/**
 * The toggle after a link that may be previewed, which opens or closes its Preview: a
 * button that says whether it is open, drawn only once its Timeline's mode is read and
 * asks.
 * @param props - The Message's item, the link's index among its links that may be
 *   previewed, and its text.
 * @returns The toggle, or nothing.
 */
export const PreviewToggle = ({
  item,
  link,
  text,
}: {
  readonly item: TimelineItem;
  readonly link: number;
  readonly text: string;
}) => {
  const modes = useAtomValue(previewsModes);
  const state = useAtomValue(previewsState);
  const opening = useAtomValue(previewsOpening);
  const direct = useAtomValue(directIn(item.timeline));
  const toggle = useAtomSet(togglePreview);
  const { position, timeline } = item;

  if (!asksFor(modeIn(modes, timeline))) {
    return null;
  }

  const open = isOpen(state, modes, opening, { direct, position, timeline }, link);

  return (
    <AriaButton
      aria-expanded={open}
      aria-label={`Preview of ${text}`}
      className={styles.toggle}
      data-preview-toggle={open ? "open" : "closed"}
      onPress={() => {
        toggle({ link, open: !open, position, timeline });
      }}
    >
      {open ? "−" : "+"}
    </AriaButton>
  );
};

/**
 * A Message's open Previews, if it may have any, as cards with their media as tall as
 * `ui.previews.mediaHeight` at most. The Message is watched as it scrolls into view, by
 * its line, so it is asked for then, while one of its Previews is open, or once one opens.
 * @param props - The Message's item, and its line, which is watched.
 * @returns Its open Previews, or nothing.
 */
export const MessagePreviews = ({
  item,
  line,
}: {
  readonly item: TimelineItem;
  readonly line: RefObject<HTMLElement | null>;
}) => {
  const modes = useAtomValue(previewsModes);
  const state = useAtomValue(previewsState);
  const opening = useAtomValue(previewsOpening);
  const mediaHeight = useAtomValue(mediaHeightShown);
  const show = useAtomSet(previewsShown);
  const { content, position, timeline } = item;
  const direct = useAtomValue(directIn(timeline));
  const mode = modeIn(modes, timeline);
  const players = modes?.players ?? noPlayers;
  const watched = mayPreview(mode, content);
  const links = previewableCount(content);

  const shown = useMemo(
    () => previewsOf(state, mode, timeline, position, content, players),
    [content, mode, players, position, state, timeline]
  );

  const drawn = shown.filter((one) =>
    isOpen(state, modes, opening, { direct, position, timeline }, Number(one.key))
  );

  // Seen once, and told then: the core asks for a Message once, however often it comes
  // back into view, and only while one of its Previews is open. Where no browser
  // observes, nothing is asked for.
  useEffect(() => {
    const element = line.current;

    const observer =
      !watched || element === null || typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries, self) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              self.disconnect();
              show({ direct, links, position, timeline });
            }
          });

    if (element !== null) {
      observer?.observe(element);
    }

    return () => {
      observer?.disconnect();
    };
  }, [direct, line, links, position, show, timeline, watched]);

  if (drawn.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Previews" className={styles.previews} style={mediaStyle(mediaHeight)}>
      {drawn.map((one) => (
        <li className={styles.row} key={one.key}>
          <PreviewRow shown={one} />
        </li>
      ))}
    </ul>
  );
};
