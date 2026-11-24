/**
 * The field that renames an Upload in place, in the list and under the composer: it opens
 * holding the name the Upload has, selected, and Enter or Save renames it to the name typed,
 * as the core reads one, while Escape or Cancel lets it go. A name the Upload already has
 * sends nothing.
 *
 * @packageDocumentation
 */
import { nameOf } from "@iirc/frontend/uploads";
import { useState } from "react";
import { Input, TextField } from "react-aria-components";

import { Button } from "../ui/button.tsx";

import styles from "./rename-field.module.css";

interface RenameFieldProps {
  /** The name the Upload has. */
  readonly name: string;
  /** The field's accessible name. */
  readonly label: string;
  /** Renames it, to a name it does not have. */
  readonly onRename: (name: string) => void;
  /** Closes the field, renamed or not. */
  readonly onClose: () => void;
}

/**
 * The field, open.
 * @param props - The name, the field's label, and what renaming and closing do.
 * @returns The field.
 */
export const RenameField = ({ label, name, onClose, onRename }: RenameFieldProps) => {
  const [text, setText] = useState(name);
  const typed = nameOf(text);

  const save = () => {
    if (typed === undefined) {
      return;
    }

    if (typed !== name) {
      onRename(typed);
    }

    onClose();
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <TextField
        aria-label={label}
        // The Owner asked to rename it, so the field takes focus to type in.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className={styles.field}
        isInvalid={typed === undefined}
        onChange={setText}
        onKeyDown={(event) => {
          // Escape closes the field alone, not what holds it.
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else {
            event.continuePropagation();
          }
        }}
        value={text}
      >
        <Input
          className={styles.input}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
      </TextField>
      <Button isDisabled={typed === undefined} size="small" type="submit">
        save
      </Button>
      <Button onPress={onClose} size="small" variant="quiet">
        cancel
      </Button>
    </form>
  );
};
