/**
 * A Message's Previews, under its text behind one left rule, each a card stacked under the
 * last: a pulsing placeholder while pending; once ready, the host it was read from when
 * another than its link's, its title, its description, cut to three lines until pressed,
 * and its media under them, each only when it has it; a failure as one muted line of why,
 * never the link again; and one the Daemon holds for a press as the plain link and "show
 * preview", which fetches it. Folded as `ui.previews.folded` says, a card is its name alone,
 * which a press opens. A link that is itself a video or a sound is the browser's own player,
 * which fetches nothing until pressed. A video, a link to one or a page that names one, has
 * a control in its corner that opens it large, pausing it where it plays in place. A page's
 * video is its poster under its words with a play button over it, or the video itself with
 * no poster; nothing is streamed until play is pressed, which swaps the poster for the
 * video, already playing. A player is its poster under its words with a play button, which
 * says where it plays from, over it, or after the words with no poster; nothing loads from
 * where it plays from until play is pressed, which swaps the poster for the player in a
 * sandboxed frame, already playing. An image is loaded only once it scrolls into view. Its
 * Previews are asked for only once the Message scrolls into view, as an intersection
 * observer sees it, never ahead, and only while its Timeline's mode asks.
 *
 * @packageDocumentation
 */
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineItem } from "@iirc/api";
import {
  foldedOf,
  mayPreview,
  messageKey,
  modeIn,
  opening,
  playsIn,
  previewsOf,
} from "@iirc/frontend/previews";
import type {
  CardShown,
  Fold,
  ImageShown,
  LinkShown,
  MediaShown,
  PlayerShown,
  PreviewShown,
  Size,
} from "@iirc/frontend/previews";
import type { CSSProperties, ReactElement } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { mediaHeightShown, previewsFoldedShown } from "../options/ui.ts";
import {
  pressPreview,
  previewsModes,
  previewsOpened,
  previewsShown,
  previewsState,
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
 * A link as a Preview draws it: an anchor that opens in a new tab, or its text alone when
 * the core found no link in it.
 * @param props - The link.
 * @returns The link.
 */
const PlainLink = ({ link }: { readonly link: LinkShown }) =>
  link.href === undefined ? (
    <bdi className={styles.plain}>{link.text}</bdi>
  ) : (
    <a className={styles.plain} href={link.href} rel="noopener noreferrer" target="_blank">
      <bdi>{link.text}</bdi>
    </a>
  );

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
 * One Preview.
 * @param props - The Preview, as drawn, how it stands folded, what presses a link waiting
 *   for it, and what opens it from its fold.
 * @returns Its card, or what stands in its place.
 */
const PreviewRow = ({
  fold,
  onOpen,
  onPress,
  shown,
}: {
  readonly fold: Fold;
  readonly shown: PreviewShown;
  readonly onOpen: () => void;
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
      // Folded, it is its name alone, which a press opens.
      if (fold === "Folded") {
        return (
          <div className={styles.folded} data-preview="folded">
            <AriaButton
              aria-expanded={false}
              aria-label={`Open the preview of ${shown.name}`}
              className={styles.name}
              onPress={onOpen}
            >
              <bdi>{shown.name}</bdi>
            </AriaButton>
          </div>
        );
      }

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

    // Pressed twice, the second press is refused, and the Message is asked for again.
    case "Waiting": {
      return (
        <div className={styles.waiting} data-preview="waiting">
          <PlainLink link={shown.link} />
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
 * A Message's Previews, if it may have any, asked for once it scrolls into view, as cards
 * `ui.previews.folded` folds, with their media as
 * tall as `ui.previews.mediaHeight` at most. Folded, or one chip, they are still watched,
 * so the Message is asked for once it is seen.
 * @param props - The Message's item.
 * @returns Its Previews, or nothing.
 */
export const MessagePreviews = ({ item }: { readonly item: TimelineItem }) => {
  const modes = useAtomValue(previewsModes);
  const state = useAtomValue(previewsState);
  const folded = useAtomValue(previewsFoldedShown);
  const mediaHeight = useAtomValue(mediaHeightShown);
  const [opened, setOpened] = useAtom(previewsOpened);
  const show = useAtomSet(previewsShown);
  const press = useAtomSet(pressPreview);
  const block = useRef<HTMLUListElement>(null);
  const { content, position, timeline } = item;
  const mode = modeIn(modes, timeline);
  const players = modes?.players ?? noPlayers;
  const watched = mayPreview(mode, content);
  const key = messageKey(timeline, position);

  const shown = useMemo(
    () => previewsOf(state, mode, timeline, position, content, players),
    [content, mode, players, position, state, timeline]
  );

  const folding = foldedOf(folded, opened, key, shown);

  const open = (rows: readonly PreviewShown[]) => {
    setOpened(opening(opened, key, rows));
  };

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
    <ul
      aria-label="Previews"
      className={styles.previews}
      ref={block}
      style={mediaStyle(mediaHeight)}
    >
      {folding._tag === "Chip" ? (
        <li className={styles.row}>
          <AriaButton
            aria-label={`Show ${folding.count === 1 ? "1 preview" : `${folding.count} previews`}`}
            className={styles.chip}
            data-preview="chip"
            onPress={() => {
              open(shown);
            }}
          >
            [+{folding.count}]
          </AriaButton>
        </li>
      ) : (
        folding.rows.map((row) => (
          <li className={styles.row} key={row.shown.key}>
            <PreviewRow
              fold={row.fold}
              onOpen={() => {
                open([row.shown]);
              }}
              onPress={(link) => {
                press({ link, position, timeline });
              }}
              shown={row.shown}
            />
          </li>
        ))
      )}
    </ul>
  );
};
