/**
 * A link card: a ready Preview with a title or a description, collapsed or expanded.
 *
 * Collapsed it is one row on a quiet surface: its thumbnail, if it has one, then its words,
 * cut to three lines. Expanded it is its words whole, then its media under them, inset
 * alike. Collapsing unmounts the media, which stops whatever played. A picture its page
 * calls a thumbnail is never drawn larger: it stays the card's thumbnail once expanded,
 * beside the words.
 *
 * It expands only when that shows more: when it has media to draw under its words that has
 * not failed, or its words are cut. Then it has its expand button, and a click anywhere on it expands it, or, once
 * expanded, collapses it, unless the click landed on its media or a control, or ended a
 * text selection. Otherwise it is inert. A thumbnail that plays expands it and plays at once.
 *
 * @packageDocumentation
 */
import { hasMedia, thumbnailOf } from "@iirc/frontend/previews";
import type { LinkCardShown, MediaShown } from "@iirc/frontend/previews";
import type { MouseEvent } from "react";
import { useRef, useState } from "react";

import { Media } from "../media/media.tsx";
import { ExpandButton } from "./expand-button.tsx";
import { Summary, useCut } from "./summary.tsx";
import { Thumbnail } from "./thumbnail.tsx";

import styles from "./card.module.css";

const noMedia: MediaShown = { _tag: "None" };

/** What a click on a card leaves alone: its media, and every control in it. */
const leftAlone = "[data-card-media], button, a, audio, video, iframe";

/**
 * Whether a click on a card is its own: inside it, not on its media or a control, and not the
 * end of a selection of its text. A click in its lightbox reaches it too, as React hands a
 * click up through what drew a thing rather than where it stands, and is not the card's.
 * @param event - The click.
 * @returns Whether it is.
 */
const clickedCard = ({ currentTarget, target }: MouseEvent<HTMLElement>): boolean => {
  if (!(target instanceof Element) || !currentTarget.contains(target)) {
    return false;
  }

  if (currentTarget.contains(target.closest(leftAlone))) {
    return false;
  }

  const selection = globalThis.getSelection();

  return (
    selection === null || selection.isCollapsed || !currentTarget.contains(selection.anchorNode)
  );
};

/**
 * A link card.
 * @param props - The card; whether it is expanded; whether its media plays at once; whether
 *   its media failed; and what expanding or collapsing, a press of a thumbnail that plays,
 *   and its media failing do.
 * @returns The card.
 */
export const LinkCard = ({
  card,
  expanded,
  failed,
  onExpand,
  onFail,
  onPlay,
  playing,
}: {
  readonly card: LinkCardShown;
  readonly expanded: boolean;
  readonly failed: boolean;
  readonly onExpand: (expanded: boolean) => void;
  readonly onFail: () => void;
  readonly onPlay: () => void;
  readonly playing: boolean;
}) => {
  const [words, setWords] = useState<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { description, name, title } = card;
  const cut = useCut(expanded ? null : words);
  const media = failed ? noMedia : card.media;
  // Once expanded it can always collapse, though what made it more has since failed.
  const more = expanded || cut || hasMedia({ media });

  const toggle = () => {
    onExpand(!expanded);
  };

  const label = media._tag === "Player" ? `play from ${media.host}` : `play ${name}`;
  // What is drawn under the words once expanded: any media but a picture that stays a thumbnail.
  const under = media._tag === "None" || media._tag === "ThumbnailOnly" ? undefined : media;

  return (
    // The expand button is the card's control for the keyboard and assistive technology. A
    // click anywhere else on the card is only a pointer's shortcut to it.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className={styles.card}
      data-layout={expanded ? "expanded" : "collapsed"}
      data-preview="ready"
      onClick={
        more
          ? (event) => {
              if (clickedCard(event)) {
                toggle();
              }
            }
          : undefined
      }
    >
      {expanded && media._tag !== "ThumbnailOnly" ? null : (
        <Thumbnail
          label={label}
          onFail={onFail}
          onPlay={() => {
            // The thumbnail goes as the card expands, so focus stays in the card.
            button.current?.focus();
            onPlay();
          }}
          thumbnail={thumbnailOf(media)}
        />
      )}
      {/* Keyed by its words, words answered anew are measured, and cut, anew. */}
      <Summary
        control={
          more ? (
            <ExpandButton expanded={expanded} name={name} onPress={toggle} reference={button} />
          ) : null
        }
        description={description}
        key={`${title ?? ""}\n${description ?? ""}`}
        reference={setWords}
        title={title}
      />
      {expanded && under !== undefined ? (
        <div className={styles.media} data-card-media>
          <Media link={card.link} media={under} name={name} onFail={onFail} playing={playing} />
        </div>
      ) : null}
    </div>
  );
};
