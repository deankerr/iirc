/**
 * A labelled password field that holds no value of its own. It is a plain, uncontrolled
 * `<input>`: what is typed lives only in the input until its form is read, and no React
 * state or prop ever holds it. React Aria's fields keep every keystroke in state, so a
 * secret never goes through one.
 *
 * @packageDocumentation
 */
import { useId } from "react";

import styles from "./password-field.module.css";

interface PasswordFieldProps {
  readonly label: string;
  /** The name the form submits it under. */
  readonly name: string;
  /**
   * `current-password` lets a password manager fill in and save what the Owner holds, and
   * `new-password` offers to save a value given for the first time.
   */
  readonly autoComplete: "current-password" | "new-password" | "off";
  /** Whether it takes focus as it appears, as a prompt the Owner asked for does. */
  readonly autoFocus?: boolean | undefined;
  /** The id of the text that says what is wrong with it, while something is. */
  readonly errorId?: string | undefined;
}

/**
 * A password field with its label above it.
 * @param props - Its label, name, autocomplete, and error.
 * @returns The field.
 */
export const PasswordField = ({
  autoComplete,
  autoFocus,
  errorId,
  label,
  name,
}: PasswordFieldProps) => {
  const id = useId();

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={errorId}
        aria-invalid={errorId === undefined ? undefined : true}
        autoCapitalize="off"
        autoComplete={autoComplete}
        // Only a prompt the Owner opened asks for it.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        className={styles.input}
        id={id}
        name={name}
        required
        spellCheck={false}
        type="password"
      />
    </div>
  );
};
