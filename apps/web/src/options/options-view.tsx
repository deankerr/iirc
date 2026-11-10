/**
 * The options view: every option of every Network, as the core derives them from the
 * Configuration's Schema, filtered as the Owner types. React Aria's GridList gives it its
 * keyboard: arrows move, Enter edits the focused value in place as its raw text, turns a
 * toggle over, or opens the password prompt for a Credential, Escape lets an edit go, and
 * Delete or Backspace asks to unset it. An edit is a plain, uncontrolled input read once
 * when Enter is pressed. A Credential's value is never edited here.
 *
 * @packageDocumentation
 */
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Option, Value } from "@iirc/frontend/options";
import type { KeyboardEvent } from "react";
import { useContext, useId, useRef } from "react";
import { GridList, GridListItem, Input, SearchField } from "react-aria-components";
import type { Key } from "react-aria-components";

import { pressed } from "../palette/press.ts";
import { Button } from "../ui/button.tsx";
import {
  change,
  confirming as confirmingAtom,
  editing as editingAtom,
  filterOptions,
  optionsFilter,
  optionRows,
  optionsState,
  promptCredential,
} from "./atoms.ts";

import styles from "./options-view.module.css";

/**
 * An option's value, as the view shows it: a Credential by its name and whether it is
 * held, never a value.
 * @param props - The value.
 * @returns The value.
 */
const Shown = ({ value }: { readonly value: Value }) => {
  switch (value._tag) {
    case "Shown": {
      return <bdi>{value.text}</bdi>;
    }

    case "Unset": {
      return <span className={styles.muted}>unset</span>;
    }

    case "Credential": {
      return (
        <span>
          <bdi>{value.name}</bdi>{" "}
          <span className={value.held === true ? styles.held : styles.missing}>
            {value.held === true ? "held" : "not held"}
          </span>
        </span>
      );
    }

    default: {
      return value satisfies never;
    }
  }
};

/**
 * The text an editor starts with: the value in its syntax, or nothing.
 * @param option - The option.
 * @returns The text.
 */
const startingText = (option: Option) => (option.value._tag === "Shown" ? option.value.text : "");

/**
 * An option's value, edited in place as its raw text. It is uncontrolled: Enter reads it
 * once. A Credential option is never edited here: Enter opens the password prompt.
 * @param props - The option, and how to give focus back to its row.
 * @returns The editor.
 */
const Editor = ({ option, done }: { readonly option: Option; readonly done: () => void }) => {
  const changeNow = useAtomSet(change);
  const stopEditing = useAtomSet(editingAtom);

  const registry = useContext(RegistryContext);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The GridList around it would take arrows, typing, and Enter as its own, so no key
    // leaves the editor. A key the keymap binds, such as Mod+K, is carried out here, as the
    // document's listener would, and changes nothing in the editor.
    event.stopPropagation();

    if (pressed(registry, event.nativeEvent)) {
      return;
    }

    const input = event.currentTarget;

    if (event.key === "Escape") {
      event.preventDefault();
      stopEditing(undefined);
      done();
    } else if (event.key === "Enter") {
      event.preventDefault();
      changeNow({
        edit: { _tag: "Set", path: option.path, text: input.value },
        network: option.network,
      });
      stopEditing(undefined);
      done();
    }
  };

  return (
    <input
      aria-label={`Value of ${option.name}`}
      autoCapitalize="off"
      autoComplete="off"
      // An editor opens because the Owner asked for it, so it takes focus.
      // oxlint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      className={styles.editor}
      defaultValue={startingText(option)}
      onKeyDown={onKeyDown}
      spellCheck={false}
      type="text"
    />
  );
};

/**
 * The bar that asks to confirm unsetting an option.
 * @param props - The option, and how to give focus back to its row.
 * @returns The bar.
 */
const Confirm = ({ option, done }: { readonly option: Option; readonly done: () => void }) => {
  const changeNow = useAtomSet(change);
  const ask = useAtomSet(confirmingAtom);
  const id = useId();

  const keep = () => {
    ask(undefined);
    done();
  };

  // Escape keeps it, from either answer.
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      keep();
    }
  };

  return (
    <div aria-labelledby={id} className={styles.confirm} role="alertdialog">
      <p id={id}>
        {option.starts === "unset" || option.starts === undefined
          ? `Unset ${option.name}?`
          : `Unset ${option.name}, back to ${option.starts}?`}
      </p>
      <Button
        // The question is the Owner's own, so its answer takes focus.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onKeyDown={escape}
        onPress={() => {
          ask(undefined);
          changeNow({ edit: { _tag: "Unset", path: option.path }, network: option.network });
          done();
        }}
        variant="primary"
      >
        Unset
      </Button>
      <Button onKeyDown={escape} onPress={keep}>
        Keep
      </Button>
    </div>
  );
};

/**
 * The options view, filtered.
 * @returns The view.
 */
export const OptionsView = () => {
  const rows = useAtomValue(optionRows);
  const { confirming, editing, notice } = useAtomValue(optionsState);
  const filter = useAtomValue(optionsFilter) ?? "";
  const setFilter = useAtomSet(filterOptions);
  const edit = useAtomSet(editingAtom);
  const ask = useAtomSet(confirmingAtom);
  const changeNow = useAtomSet(change);
  const prompt = useAtomSet(promptCredential);
  const list = useRef<HTMLDivElement>(null);
  const noticeId = useId();

  const named = (key: Key | null | undefined) => rows.find((option) => option.name === key);

  // Focus goes back to an option's row once an edit or a question about it is done.
  const focusRow = (name: string) => () => {
    requestAnimationFrame(() => {
      [...(list.current?.querySelectorAll<HTMLElement>("[data-key]") ?? [])]
        .find((row) => row.dataset.key === name)
        ?.focus();
    });
  };

  const onAction = (key: Key) => {
    const option = named(key);

    if (option === undefined) {
      return;
    }

    if (option.kind._tag === "Toggle") {
      const on = option.value._tag === "Shown" && option.value.text === "on";

      changeNow({
        edit: { _tag: "Set", path: option.path, text: on ? "off" : "on" },
        network: option.network,
      });
    } else if (option.kind._tag === "Credential") {
      prompt({ network: option.network, path: option.path });
    } else {
      edit(option.name);
    }
  };

  // Delete or Backspace on a row asks to unset its option.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing !== undefined || (event.key !== "Delete" && event.key !== "Backspace")) {
      return;
    }

    const row =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-key]") : null;

    const option = named(row?.dataset.key);

    if (option?.unsettable === true) {
      event.preventDefault();
      ask(option.name);
    }
  };

  const asked = named(confirming);

  return (
    <section aria-label="Options" className={styles.view}>
      <header className={styles.header}>
        <h2 className={styles.title}>Options</h2>
        <SearchField
          aria-label="Filter options"
          className={styles.filter}
          onChange={setFilter}
          value={filter}
        >
          <Input className={styles.filterInput} placeholder="network.libera.* or *nick*" />
        </SearchField>
      </header>
      {notice === undefined ? null : (
        <p className={styles.notice} id={noticeId} role="alert">
          {notice}
        </p>
      )}
      {asked === undefined ? null : <Confirm done={focusRow(asked.name)} option={asked} />}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the GridList's own rows take the keys; this only hears Delete from them. */}
      <div className={styles.scroller} onKeyDown={onKeyDown} ref={list}>
        <GridList
          {...(notice === undefined ? {} : { "aria-describedby": noticeId })}
          aria-label="Options"
          className={styles.list}
          items={rows}
          onAction={onAction}
          renderEmptyState={() => (
            <p className={styles.muted}>
              {filter === ""
                ? "No Network is configured yet. Add one with /network add."
                : "No option matches."}
            </p>
          )}
        >
          {(option) => (
            <GridListItem className={styles.row} id={option.name} textValue={option.name}>
              <span className={styles.name}>
                <bdi>{option.name}</bdi>
              </span>
              <span className={styles.value}>
                {editing === option.name ? (
                  <Editor done={focusRow(option.name)} option={option} />
                ) : (
                  <Shown value={option.value} />
                )}
              </span>
              <span className={styles.starts}>
                {option.starts === undefined ? "must be given" : <bdi>{option.starts}</bdi>}
              </span>
              <span className={styles.description}>{option.description}</span>
            </GridListItem>
          )}
        </GridList>
      </div>
    </section>
  );
};
