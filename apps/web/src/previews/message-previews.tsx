/**
 * A Message's Previews, under its text behind a left rule, one row each: a pulsing
 * placeholder while pending, a ready one's site and title on one line, which a press opens
 * to its description, a failed one as the plain link, saying why on hover, and one the
 * Daemon holds for a press as the plain link and "show preview", which fetches it. A link
 * that is itself a video or a sound is its summary with a native player under it, which
 * fetches nothing until pressed. A player is its text with its poster under it and a play
 * button, which says where it plays from, over the poster, or beside the text with no
 * poster; nothing loads from where it plays from until play is pressed, which swaps the
 * poster for the player in a sandboxed frame, already playing. An image is loaded only
 * once it scrolls into view. Its
 * Previews are asked for only once the Message scrolls into view, as an intersection
 * observer sees it, never ahead, and only while its Timeline's mode asks.
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
import { PlayerFrame, PreviewImage, PreviewPoster } from "./preview-image.tsx";

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
 * A link that is itself a video or a sound, as the browser's own player, which fetches
 * nothing from the Daemon's stream until the Owner presses play. Where it fails to play,
 * nothing is drawn, and the text beside it stands alone.
 * @param props - The media, and what to call it.
 * @returns The player, or nothing.
 */
const PreviewMedia = ({ media, name }: { readonly media: MediaShown; readonly name: string }) => {
  const [failed, setFailed] = useState(false);

  const shared = {
    "aria-label": `Play ${name}`,
    controls: true,
    "data-preview-media": media.kind,
    onError: () => {
      setFailed(true);
    },
    preload: "none",
    src: media.src,
  } as const;

  if (failed) {
    return null;
  }

  // A stranger's media carries no captions the Daemon could offer.
  return media.kind === "video" ? (
    // oxlint-disable-next-line jsx-a11y/media-has-caption
    <video {...shared} className={styles.video} />
  ) : (
    // oxlint-disable-next-line jsx-a11y/media-has-caption
    <audio {...shared} className={styles.audio} />
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

  if (playing) {
    return <PlayerFrame player={player} text={text} />;
  }

  return image?.drawn === "Poster" ? (
    <PreviewPoster image={image} key={image.src} onPlay={play} player={player} text={text} />
  ) : (
    <>
      {text}
      <PlayButton onPlay={play} over="text" player={player} />
    </>
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
        return (
          <div className={styles.media} data-preview="ready">
            {text}
            <PreviewMedia key={media.src} media={media} name={shown.summary} />
          </div>
        );
      }

      // A player is its text with its poster under it, and a play button over the poster,
      // which becomes the player, already playing, once pressed.
      if (player !== undefined) {
        return (
          <div className={styles.ready} data-preview="ready">
            <PreviewPlayer image={image} player={player} text={text} />
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
