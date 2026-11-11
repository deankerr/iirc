/**
 * The dialog `/theme import` opens: a terminal theme's text, pasted or read from a file the
 * Owner picks, the format the core read it as or why it could not, the name to save it
 * under, and Save, which imports it for every device. The text is read in a Worker, apart
 * from the page, so the dialog stays responsive, and text that takes over a second to read
 * is refused in words. While its text reads as a theme, the whole page is drawn in it, and
 * closing the dialog draws the theme in effect again.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useEffect, useId } from "react";
import { Dialog, FileTrigger, Form, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { FormProps } from "react-aria-components";

import { Button } from "../ui/button.tsx";
import {
  cancelImport,
  chooseFile,
  editImport,
  importDraft,
  importRead,
  offeredName,
  saveImport,
} from "./atoms.ts";

import styles from "./import-dialog.module.css";

/** The sample nicks the preview shows, one in each of the first eight slots. */
const sampleNicks = ["ada", "bob", "cy", "dee", "eve", "fay", "gus", "hal"];

/**
 * A sample of the theme being read, drawn from the page's own colours, which are its while
 * it reads: nicks in their slots, and mIRC's first sixteen colours.
 * @returns The sample.
 */
const Sample = () => (
  <div aria-hidden="true" className={styles.sample}>
    <p>
      {sampleNicks.map((nick, slot) => (
        <span key={nick} style={{ color: `var(--nick-${slot})` }}>
          {`<${nick}> `}
        </span>
      ))}
    </p>
    <p>
      {Array.from({ length: 16 }, (_, index) => (
        <span key={index} style={{ color: `var(--irc-${index})` }}>
          {`${index} `}
        </span>
      ))}
      <span className={styles.muted}>dim </span>
      <span className={styles.accent}>accent </span>
      <span className={styles.highlight}>highlight</span>
    </p>
  </div>
);

/**
 * The dialog's form.
 * @returns The form.
 */
const Importing = () => {
  const draft = useAtomValue(importDraft);
  const read = useAtomValue(importRead);
  const edit = useAtomSet(editImport);
  const cancel = useAtomSet(cancelImport);
  const save = useAtomSet(saveImport);
  const choose = useAtomSet(chooseFile);
  const statusId = useId();
  const textId = useId();
  const nameId = useId();
  const name = offeredName(draft, read?._tag === "Parsed" ? read.value : undefined);

  const onSubmit: NonNullable<FormProps["onSubmit"]> = (event) => {
    event.preventDefault();
    save(undefined);
  };

  const onSelect = (files: FileList | null) => {
    const file = files?.item(0);

    if (file !== null && file !== undefined) {
      choose({ name: file.name, size: file.size, text: async () => await file.text() });
    }
  };

  let status = "Paste a theme's text, or choose its file.";

  if (read === undefined && draft.text.trim() !== "") {
    status = "Reading…";
  } else if (read?._tag === "Parsed") {
    status = `Read as ${read.value.format}.`;
  } else if (read?._tag === "Invalid") {
    ({ message: status } = read);
  }

  return (
    <Form className={styles.form} onSubmit={onSubmit}>
      <Heading className={styles.heading} slot="title">
        Import a theme
      </Heading>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={textId}>
          A theme file&apos;s text: base16 or base24, iTerm2, Alacritty, Kitty, Ghostty, or Windows
          Terminal
        </label>
        <textarea
          aria-describedby={statusId}
          // The dialog was just opened by the Owner, to paste into.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className={styles.text}
          id={textId}
          onChange={(event) => {
            edit({ text: event.currentTarget.value });
          }}
          rows={8}
          spellCheck={false}
          value={draft.text}
        />
      </div>
      <div className={styles.row}>
        <FileTrigger
          acceptedFileTypes={[".yaml", ".yml", ".itermcolors", ".toml", ".conf", ".json", ""]}
          onSelect={onSelect}
        >
          <Button>Choose a file…</Button>
        </FileTrigger>
        {draft.fileName === undefined ? null : (
          <span className={styles.muted}>{draft.fileName}</span>
        )}
      </div>
      <p
        aria-live="polite"
        className={read?._tag === "Invalid" ? styles.failure : styles.status}
        id={statusId}
      >
        {status}
      </p>
      {read?._tag === "Parsed" ? <Sample /> : null}
      <div className={styles.field}>
        <label className={styles.label} htmlFor={nameId}>
          Name
        </label>
        <input
          autoCapitalize="off"
          className={styles.input}
          id={nameId}
          onChange={(event) => {
            edit({ name: event.currentTarget.value });
          }}
          spellCheck={false}
          value={name}
        />
      </div>
      {draft.notice === undefined ? null : (
        <p className={styles.failure} role="alert">
          {draft.notice}
        </p>
      )}
      <div className={styles.row}>
        <Button isDisabled={read?._tag !== "Parsed"} type="submit" variant="primary">
          Save
        </Button>
        <Button
          onPress={() => {
            cancel(undefined);
          }}
        >
          Cancel
        </Button>
      </div>
    </Form>
  );
};

/**
 * The import dialog, while it is open.
 * @returns The dialog.
 */
export const ImportDialog = () => {
  const { open } = useAtomValue(importDraft);
  const cancel = useAtomSet(cancelImport);

  // Unmounted, as when the page signs out, the import closes, ending its reads.
  useEffect(
    () => () => {
      cancel(undefined);
    },
    [cancel]
  );

  return (
    <ModalOverlay
      className={styles.overlay}
      isDismissable
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          cancel(undefined);
        }
      }}
    >
      <Modal className={styles.modal}>
        <Dialog aria-label="Import a theme" className={styles.dialog}>
          <Importing />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
