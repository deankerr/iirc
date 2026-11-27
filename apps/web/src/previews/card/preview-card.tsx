/**
 * One ready Preview's card, a link card or a media card, which owns whether a link card is
 * collapsed or expanded. That is kept by the link, so it survives the row scrolling away and
 * back, and is forgotten when the page is loaded again. Whether its media plays at once, and
 * whether it failed, are the card's own, held for that media alone: media the Daemon
 * answers anew plays nothing until pressed, gets a try of its own, and a row drawn again is
 * expanded but not playing.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { CardShown, MediaShown } from "@iirc/frontend/previews";
import { useCallback, useState } from "react";

import { expandedIn, expandPreview } from "../atoms.ts";
import { LinkCard } from "./link-card.tsx";
import { MediaCard } from "./media-card.tsx";

/**
 * Where a card's media is drawn from, which says which media it is.
 * @param media - The card's media.
 * @returns Its source, or none for a card with no media.
 */
const sourceOf = (media: MediaShown): string | undefined => {
  if (media._tag === "None") {
    return undefined;
  }

  return media._tag === "ThumbnailOnly" ? media.picture.src : media.src;
};

/**
 * A ready Preview's card.
 * @param props - The card, and its link's `linkKey`, which its expanded state is kept by.
 * @returns The card.
 */
export const PreviewCard = ({
  card,
  held,
}: {
  readonly card: CardShown;
  readonly held: string;
}) => {
  const expanded = useAtomValue(expandedIn(held));
  const expand = useAtomSet(expandPreview);
  const src = sourceOf(card.media);
  // Each by the source of the media it was for, so neither outlives that media.
  const [pressed, setPressed] = useState<string | undefined>();
  const [failed, setFailed] = useState<string | undefined>();

  // A press is for the media as it stood: once the card has other media, or none, as under
  // `text`, it is forgotten, so the same media drawn again waits for a press of its own.
  if (pressed !== undefined && pressed !== src) {
    setPressed(undefined);
  }

  const fail = useCallback(() => {
    setFailed(src);
  }, [src]);

  if (card._tag === "MediaCard") {
    return <MediaCard card={card} />;
  }

  return (
    <LinkCard
      card={card}
      expanded={expanded}
      failed={src !== undefined && failed === src}
      onExpand={(next) => {
        setPressed(undefined);
        expand({ expanded: next, key: held });
      }}
      onFail={fail}
      onPlay={() => {
        setPressed(src);
        expand({ expanded: true, key: held });
      }}
      playing={src !== undefined && pressed === src}
    />
  );
};
