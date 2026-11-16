/**
 * A Message's Previews, under its text behind a left rule, one row each: a pulsing
 * placeholder while pending, a ready one's site and title on one line, which a press opens
 * to its description, and a failed one as the plain link, saying why on hover. Its
 * Previews are asked for only once the Message scrolls into view, as an intersection
 * observer sees it, never ahead.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineItem } from "@iirc/api";
import { mayPreview, previewsOf } from "@iirc/frontend/previews";
import type { LinkShown, PreviewShown } from "@iirc/frontend/previews";
import { useEffect, useMemo, useRef } from "react";
import { Button as AriaButton, Disclosure, DisclosurePanel } from "react-aria-components";

import { previewsMode, previewsShown, previewsState } from "./atoms.ts";

import styles from "./message-previews.module.css";

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
 * One Preview.
 * @param props - The Preview, as drawn.
 * @returns Its row.
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
      if (shown.description === undefined) {
        return (
          <div className={styles.ready} data-preview="ready">
            <bdi className={styles.summary}>{shown.summary}</bdi>
          </div>
        );
      }

      return (
        <Disclosure className={styles.ready} data-preview="ready">
          <AriaButton className={styles.summary} slot="trigger">
            <bdi>{shown.summary}</bdi>
          </AriaButton>
          <DisclosurePanel className={styles.description}>
            <bdi>{shown.description}</bdi>
          </DisclosurePanel>
        </Disclosure>
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
  const mode = useAtomValue(previewsMode);
  const state = useAtomValue(previewsState);
  const show = useAtomSet(previewsShown);
  const block = useRef<HTMLUListElement>(null);
  const { content, position, timeline } = item;
  const watched = mayPreview(mode, content);

  const shown = useMemo(
    () => previewsOf(state, mode, timeline, position, content),
    [content, mode, position, state, timeline]
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
          <PreviewRow shown={one} />
        </li>
      ))}
    </ul>
  );
};
