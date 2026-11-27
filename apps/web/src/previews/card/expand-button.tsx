/**
 * A link card's one disclosure: the button in its top trailing corner, on its title's line,
 * that expands the card or collapses it again. It stays in the same place either way, keeps
 * one name, and says which the card is with `aria-expanded`. Two chevrons pointing out
 * expand, and pointing in collapse, unlike the caret after a link, which hides the Preview.
 *
 * @packageDocumentation
 */
import type { Ref } from "react";
import { Button as AriaButton } from "react-aria-components";

import { Icon } from "../../ui/icon.tsx";

import styles from "./expand-button.module.css";

/**
 * The button that expands a card or collapses it.
 * @param props - Whether the card is expanded, what it is called, what a press does, and a
 *   ref to the button, so a press elsewhere in the card can leave focus on it.
 * @returns The button.
 */
export const ExpandButton = ({
  expanded,
  name,
  onPress,
  reference,
}: {
  readonly expanded: boolean;
  readonly name: string;
  readonly onPress: () => void;
  readonly reference?: Ref<HTMLButtonElement>;
}) => (
  <AriaButton
    aria-expanded={expanded}
    aria-label={`full preview of ${name}`}
    className={styles.expand}
    onPress={onPress}
    ref={reference}
  >
    <Icon name={expanded ? "fold" : "unfold"} />
  </AriaButton>
);
