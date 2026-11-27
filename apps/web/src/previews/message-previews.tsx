/**
 * A Message's Previews, under its text, each a row stacked under the last: a pulsing
 * placeholder of a collapsed card's shape while pending; once ready, its card; and a failure
 * as one muted line of why, never the link again. Only an open Preview is drawn, as the
 * toggle after its link leaves it, and a closed one draws nothing and takes no room.
 *
 * Its Previews are asked for only once the Message is within a screen's height of the view,
 * never ahead, only while its Timeline's mode asks, and only while one of them is open.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineItem } from "@iirc/api";
import {
  asksFor,
  chosenIn,
  isOpen,
  linkKey,
  mayPreview,
  messageKey,
  modeIn,
  previewableCount,
  previewsOf,
} from "@iirc/frontend/previews";
import type { PreviewShown } from "@iirc/frontend/previews";
import type { CSSProperties, RefObject } from "react";
import { useCallback, useMemo } from "react";
import { Button as AriaButton } from "react-aria-components";

import { mediaHeightShown } from "../options/ui.ts";
import { Icon } from "../ui/icon.tsx";
import {
  directIn,
  previewsModes,
  previewsOpening,
  previewsShown,
  previewsState,
  retryPreview,
  togglePreview,
} from "./atoms.ts";
import { PreviewCard } from "./card/preview-card.tsx";
import { useNearView } from "./media/near-view.ts";

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
 * One open Preview. A failure is one line of why, which in a Timeline that waits for a
 * press is a button that presses its link again.
 * @param props - The Preview, as drawn, its link's `linkKey`, and what a press of its
 *   failure does, if anything.
 * @returns Its card, or what stands in its place.
 */
const PreviewRow = ({
  held,
  retry,
  shown,
}: {
  readonly held: string;
  readonly retry: (() => void) | undefined;
  readonly shown: PreviewShown;
}) => {
  switch (shown._tag) {
    case "Pending": {
      return (
        <div className={styles.pending} data-preview="pending">
          <span className={styles.unseen}>
            Previewing <bdi>{shown.link.text}</bdi>
          </span>
        </div>
      );
    }

    case "LinkCard":
    case "MediaCard": {
      return <PreviewCard card={shown} held={held} />;
    }

    case "Failed": {
      return retry === undefined ? (
        <p className={styles.failed} data-preview="failed" title={shown.reason}>
          {shown.reason}
        </p>
      ) : (
        <AriaButton className={styles.retry} data-preview="failed" onPress={retry}>
          <span className={styles.failed} title={shown.reason}>
            {shown.reason}
          </span>
          <span className={styles.again}>try again</span>
        </AriaButton>
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
  const { content, position, timeline } = item;
  const mode = modeIn(modes, timeline);

  if (!asksFor(mode)) {
    return null;
  }

  const open = isOpen(state, modes, opening, { direct, position, timeline }, link);

  const failed = previewsOf(
    state,
    mode,
    timeline,
    position,
    content,
    modes?.players ?? noPlayers
  ).find((one) => one.key === String(link) && one._tag === "Failed");

  const reason = failed?._tag === "Failed" ? failed.reason : undefined;

  const button = (
    <AriaButton
      aria-expanded={open}
      aria-label={reason === undefined ? `preview of ${text}` : `preview of ${text}: ${reason}`}
      className={styles.toggle}
      data-failed={reason === undefined ? undefined : true}
      data-preview-toggle={open ? "open" : "closed"}
      onPress={() => {
        toggle({ link, open: !open, position, timeline });
      }}
    >
      <Icon name={open && reason === undefined ? "previewShown" : "previewHidden"} />
    </AriaButton>
  );

  // A hover of a toggle whose link has no Preview says why.
  return reason === undefined ? button : <span title={reason}>{button}</span>;
};

/**
 * A Message's open Previews, if it may have any, as cards with their media as tall as
 * `ui.previews.mediaHeight` at most. The Message is watched as it comes near the view, by
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
  const retry = useAtomSet(retryPreview);
  const { content, position, timeline } = item;
  const direct = useAtomValue(directIn(timeline));
  const mode = modeIn(modes, timeline);
  const players = modes?.players ?? noPlayers;
  const watched = mayPreview(mode, content);
  const links = previewableCount(content);
  // The Daemon fetches a link here only on a press, so a failure is pressed to try again.
  const waits = direct && chosenIn(modes, timeline) === undefined;

  const shown = useMemo(
    () => previewsOf(state, mode, timeline, position, content, players),
    [content, mode, players, position, state, timeline]
  );

  // A failure takes no room of its own, as its link's toggle says why, unless a press of it
  // tries again.
  const drawn = shown.filter(
    (one) =>
      (one._tag !== "Failed" || waits) &&
      isOpen(state, modes, opening, { direct, position, timeline }, Number(one.key))
  );

  // Seen once, and told then, and again only as what it is told changes: the core asks for
  // a Message once, however often it comes back near the view, and only while one of its
  // Previews is open. Where no browser observes, nothing is asked for.
  const near = useCallback(() => {
    show({ direct, links, position, timeline });
  }, [direct, links, position, show, timeline]);

  useNearView(watched ? line : null, near);

  if (drawn.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Previews" className={styles.previews} style={mediaStyle(mediaHeight)}>
      {drawn.map((one) => (
        <li className={styles.row} key={one.key}>
          <PreviewRow
            held={linkKey(messageKey(timeline, position), Number(one.key))}
            retry={
              waits
                ? () => {
                    retry({ link: Number(one.key), position, timeline });
                  }
                : undefined
            }
            shown={one}
          />
        </li>
      ))}
    </ul>
  );
};
