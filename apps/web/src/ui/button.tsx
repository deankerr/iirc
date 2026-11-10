/**
 * A button, from React Aria, in the theme.
 *
 * @packageDocumentation
 */
import { Button as AriaButton } from "react-aria-components";
import type { ButtonProps as AriaButtonProps } from "react-aria-components";

import styles from "./button.module.css";

interface ButtonProps extends Omit<AriaButtonProps, "className"> {
  /** `primary` for the one thing a screen is for, `quiet` for the rest. */
  readonly variant?: "primary" | "quiet";
}

/**
 * A button. While `isPending`, it ignores presses and says so to assistive technology.
 * @param props - React Aria's, and its variant.
 * @returns The button.
 */
export const Button = ({ variant = "quiet", ...props }: ButtonProps) => (
  <AriaButton {...props} className={`${styles.button} ${styles[variant]}`} />
);
