/**
 * The options view: every option of every Network, and every option under `ui`, as the
 * core derives them from the Schemas, filtered as the Owner types. An option under `ui`
 * this device overrides says so, beside the value every device shares. React Aria's GridList gives it its
 * keyboard: arrows move, Enter edits the focused value in place as its raw text, turns a
 * toggle over, or opens the password prompt for a Credential, Escape lets an edit go, and
 * Delete or Backspace asks to unset it. Escape anywhere else in it, or the close button on
 * its Pane's status bar, shows what the Pane showed before. An edit is a plain, uncontrolled input read once
 * when Enter is pressed. A Credential's value is never edited here.
 *
 * @packageDocumentation
 */
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { parseUiText } from "@iirc/frontend/options";
import type { Option, Value } from "@iirc/frontend/options";
import type { KeyboardEvent } from "react";
import { useContext, useId, useRef } from "react";
import { GridList, GridListItem, Input, SearchField } from "react-aria-components";
import type { Key } from "react-aria-components";

import { composerFocus } from "../composer/atoms.ts";
import { pressed } from "../palette/press.ts";
import { PaneBar } from "../panes/pane-bar.tsx";
import { Button, IconButton } from "../ui/button.tsx";
import {
  change,
  closeOptions,
  confirming as confirmingAtom,
  editing as editingAtom,
  filterOptions,
  notice as noticeAtom,
  optionsFilter,
  optionRows,
  optionsState,
  promptCredential,
} from "./atoms.ts";
import { changeUiOption } from "./ui.ts";

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
 * Sets an option to a value in its text syntax: a Network's through its Configuration, and
 * one under `ui` for every device, or for this device alone while it overrides it here.
 * @returns How to set one.
 */
const useSetTo = () => {
  const configure = useAtomSet(change);
  const changeUi = useAtomSet(changeUiOption);
  const notice = useAtomSet(noticeAtom);

  return (option: Option, text: string) => {
    if (option._tag === "Network") {
      configure({ edit: { _tag: "Set", path: option.path, text }, network: option.network });

      return;
    }

    const value = parseUiText(option.option, text);

    if (value._tag === "Invalid") {
      notice(value.message);

      return;
    }

    changeUi({ device: option.device !== undefined, option: option.option, value: value.value });
  };
};

/**
 * Unsets an option: a Network's back to what a new Network starts with, and one under `ui`
 * back to its default for every device, or, while this device overrides it, back to the
 * value every device shares.
 * @returns How to unset one.
 */
const useUnset = () => {
  const configure = useAtomSet(change);
  const changeUi = useAtomSet(changeUiOption);

  return (option: Option) => {
    if (option._tag === "Network") {
      configure({ edit: { _tag: "Unset", path: option.path }, network: option.network });
    } else {
      changeUi({ device: option.device !== undefined, option: option.option, value: undefined });
    }
  };
};

/**
 * What unsetting an option goes back to, in words.
 * @param option - The option.
 * @returns The question.
 */
const unsetQuestion = (option: Option): string => {
  if (option._tag === "Ui" && option.device !== undefined) {
    return `Stop overriding ${option.name} on this device?`;
  }

  return option.starts === "unset" || option.starts === undefined
    ? `Unset ${option.name}?`
    : `Unset ${option.name}, back to ${option.starts}?`;
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
  const setTo = useSetTo();
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
      setTo(option, input.value);
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
  const unset = useUnset();
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
      <p id={id}>{unsetQuestion(option)}</p>
      <Button
        // The question is the Owner's own, so its answer takes focus.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onKeyDown={escape}
        onPress={() => {
          ask(undefined);
          unset(option);
          done();
        }}
        size="small"
        variant="primary"
      >
        Unset
      </Button>
      <Button onKeyDown={escape} onPress={keep} size="small">
        Keep
      </Button>
    </div>
  );
};

/**
 * The options view, filtered, in a Pane.
 * @param props - The Pane.
 * @returns The view.
 */
export const OptionsView = ({ pane }: { readonly pane: string }) => {
  const rows = useAtomValue(optionRows);
  const { confirming, editing, notice } = useAtomValue(optionsState);
  const filter = useAtomValue(optionsFilter) ?? "";
  const setFilter = useAtomSet(filterOptions);
  const edit = useAtomSet(editingAtom);
  const ask = useAtomSet(confirmingAtom);
  const setTo = useSetTo();
  const prompt = useAtomSet(promptCredential);
  const close = useAtomSet(closeOptions);
  const registry = useContext(RegistryContext);
  const list = useRef<HTMLDivElement>(null);
  const noticeId = useId();

  // Closing shows what the Pane showed before, and gives the composer the focus, as closing
  // the search does.
  const closeNow = () => {
    close();
    registry.set(composerFocus, registry.get(composerFocus) + 1);
  };

  // Escape closes the view, unless something in it took it first: an edit, a question, or
  // the filter clearing its text.
  const onViewKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      editing !== undefined ||
      confirming !== undefined
    ) {
      return;
    }

    event.preventDefault();
    closeNow();
  };

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

      setTo(option, on ? "off" : "on");
    } else if (option._tag === "Network" && option.kind._tag === "Credential") {
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
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- it only hears Escape from what is inside it, each of which takes its own keys.
    <section aria-label="Options" className={styles.view} onKeyDown={onViewKeyDown}>
      <PaneBar
        end={
          <IconButton
            icon="close"
            keys="Esc"
            label="Close the options"
            onPress={closeNow}
            size="small"
          />
        }
        name="options"
        pane={pane}
      />
      <div className={styles.header}>
        <SearchField
          aria-label="Filter options"
          className={styles.filter}
          onChange={setFilter}
          value={filter}
        >
          <Input className={styles.filterInput} placeholder="network.libera.* or *nick*" />
        </SearchField>
      </div>
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
          renderEmptyState={() => <p className={styles.muted}>No option matches.</p>}
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
                {option._tag === "Ui" && option.device !== undefined ? (
                  <span className={styles.device}>
                    {" "}
                    on this device, over <Shown value={option.shared} />
                  </span>
                ) : null}
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
