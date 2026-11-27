/**
 * A link card's words: its title, then its description, each only when it has it, with the
 * card's expand button before them, floated to their trailing end. Collapsed they are cut to
 * three lines in all, the title one and the description two, or either alone all three;
 * expanded they are whole. A description's line breaks are drawn as breaks, and every word
 * is text, never markup.
 *
 * @packageDocumentation
 */
import type { ReactNode, Ref } from "react";
import { useLayoutEffect, useState } from "react";

import styles from "./card.module.css";

/**
 * A card's words.
 * @param props - The title and the description, each if it has it; the expand button, if
 *   the card has one; and a ref to the words, to measure whether they are cut.
 * @returns The words.
 */
export const Summary = ({
  control,
  description,
  reference,
  title,
}: {
  readonly control: ReactNode;
  readonly description: string | undefined;
  readonly reference: Ref<HTMLDivElement>;
  readonly title: string | undefined;
}) => (
  <div className={styles.words} ref={reference}>
    {control}
    {title === undefined ? null : <bdi className={styles.title}>{title}</bdi>}
    {description === undefined ? null : <bdi className={styles.description}>{description}</bdi>}
  </div>
);

/**
 * Whether any of a card's words run past the lines they are cut to, measured as they are
 * laid out and again whenever their size changes, and kept as last measured while there is
 * nothing to measure, as while the card is expanded and its words are whole. Where no
 * browser lays them out, they never are.
 * @param element - The words, or none to keep what was last measured.
 * @returns Whether they are cut.
 */
export const useCut = (element: HTMLElement | null): boolean => {
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      if (element !== null) {
        setCut([...element.children].some((part) => part.scrollHeight > part.clientHeight));
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
