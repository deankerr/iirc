/**
 * The one family of buttons, from React Aria, in the theme. Every button and toggle on the
 * page is one of these, in one of a few variants and two sizes, so each looks and behaves
 * as the others do: the same height for its size, padding, focus ring, hover, pressed,
 * pending, and disabled looks, and a finger's size where the pointer is coarse. Its height
 * is its own, one line of text, its padding, and its border, never its container's.
 *
 * An icon-only button is an `IconButton`, which always has a name and a tooltip that says
 * what it does, with its key where the keymap binds one.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import { chordsFor, showChord } from "@iirc/frontend/keymap";
import type { ReactElement, ReactNode } from "react";
import {
  Button as AriaButton,
  ToggleButton as AriaToggleButton,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components";
import type {
  ButtonProps as AriaButtonProps,
  ToggleButtonProps as AriaToggleButtonProps,
} from "react-aria-components";

import { keymapState, platform } from "../palette/state.ts";
import { Icon } from "./icon.tsx";
import type { IconName } from "./icon.tsx";

import styles from "./button.module.css";

/**
 * How a button looks:
 * - `default`: bordered, for an action among others.
 * - `primary`: filled with the accent, for the one thing a screen or a question is for.
 * - `quiet`: no border until hovered, for the actions a bar or a footer holds.
 * - `text`: as the text around it, for a button that reads as part of a sentence.
 */
type Variant = "default" | "primary" | "quiet" | "text";

/**
 * How big a button is: `regular` in a form or a dialog, and `small` in a bar, a notice, or
 * a row, as tall as a line of text and its border.
 */
type Size = "regular" | "small";

/** What every button of the family takes beside React Aria's own. */
interface Look {
  readonly variant?: Variant | undefined;
  readonly size?: Size | undefined;
  /** A class for the button's place in its layout, such as a margin, never its look. */
  readonly className?: string | undefined;
}

/**
 * The classes of a button of the family.
 * @param look - Its variant, size, and placement.
 * @param icon - Whether it holds an icon alone.
 * @returns The classes.
 */
const classesOf = ({ className, size = "regular", variant = "default" }: Look, icon = false) =>
  [styles.button, styles[variant], styles[size], icon ? styles.icon : "", className ?? ""]
    .filter((one) => one !== "")
    .join(" ");

interface ButtonProps extends Omit<AriaButtonProps, "className">, Look {}

/**
 * A button. While `isPending`, it ignores presses and says so to assistive technology.
 * @param props - React Aria's, and its look.
 * @returns The button.
 */
export const Button = ({ className, size, variant, ...props }: ButtonProps) => (
  <AriaButton {...props} className={classesOf({ className, size, variant })} />
);

interface ToggleButtonProps extends Omit<AriaToggleButtonProps, "className">, Look {}

/**
 * A button that stays pressed while what it shows is shown, accented while it is.
 * @param props - React Aria's, and its look.
 * @returns The toggle.
 */
export const ToggleButton = ({ className, size, variant, ...props }: ToggleButtonProps) => (
  <AriaToggleButton {...props} className={classesOf({ className, size, variant })} />
);

/**
 * The keys bound to a command, as the Owner's platform writes them, or none.
 * @param command - The command's id in the registry.
 * @returns The keys.
 */
const useKeysOf = (command: string | undefined): string | undefined => {
  const keymap = useAtomValue(keymapState);
  const chords = command === undefined ? [] : chordsFor(keymap, command);

  return chords.length === 0
    ? undefined
    : chords.map((chord) => showChord(chord, platform)).join(" ");
};

interface TipProps {
  /** What the control does, in a few words. */
  readonly label: string;
  /** The command in the registry whose keys the tip shows, where the keymap binds it. */
  readonly command?: string | undefined;
  /** Keys to show where no command binds them, such as Escape in a view. */
  readonly keys?: string | undefined;
  /** The control, one of the family. */
  readonly children: ReactElement;
}

/**
 * A tooltip over a control, on hover or keyboard focus, saying what it does and its keys.
 * A touch never shows one, so a tap does what it says at once.
 * @param props - What it says, and the control.
 * @returns The control, with its tooltip.
 */
export const Tip = ({ children, command, keys, label }: TipProps) => {
  const bound = useKeysOf(command) ?? keys;

  return (
    <TooltipTrigger closeDelay={0} delay={600}>
      {children}
      <Tooltip className={styles.tip} offset={4} placement="top">
        {label}
        {bound === undefined ? null : <kbd className={styles.keys}>{bound}</kbd>}
      </Tooltip>
    </TooltipTrigger>
  );
};

interface IconButtonProps
  extends Omit<AriaButtonProps, "className" | "children" | "aria-label">, Look {
  /** The glyph it shows. */
  readonly icon: IconName;
  /** Its accessible name, which its tooltip says too. */
  readonly label: string;
  /** The command whose keys its tooltip shows. */
  readonly command?: string | undefined;
  /** Keys its tooltip shows where no command binds them. */
  readonly keys?: string | undefined;
  /** What it draws after its icon, such as a mark, hidden from assistive technology. */
  readonly children?: ReactNode;
}

/**
 * A button that shows an icon alone, named for assistive technology and with a tooltip.
 * Quiet unless told otherwise, as most are in a bar.
 * @param props - React Aria's, its icon, name, keys, and look.
 * @returns The button, with its tooltip.
 */
export const IconButton = ({
  children,
  className,
  command,
  icon,
  keys,
  label,
  size,
  variant = "quiet",
  ...props
}: IconButtonProps) => (
  <Tip command={command} keys={keys} label={label}>
    <AriaButton
      {...props}
      aria-label={label}
      className={classesOf({ className, size, variant }, true)}
    >
      <Icon name={icon} />
      {children}
    </AriaButton>
  </Tip>
);
