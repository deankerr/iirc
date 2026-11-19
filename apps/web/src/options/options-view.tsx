/**
 * The options view: every option under `store`, `uploads`, and `previews`, every option of every
 * Network, and every option under `ui`, as the core derives them from the Schemas, filtered
 * as the Owner types. An option under `ui` this device overrides says so, beside the value
 * every device shares. No device overrides one under `store`, `uploads`, or `previews`. React Aria's
 * GridList gives it its keyboard: arrows move, Enter opens a menu of an option's choices
 * where its kind lists them, which ends in "Custom…" where it also takes text, edits the
 * focused value in place as its raw text, or a whole number in a number field, turns a
 * toggle over, or opens the password prompt for a Credential, Escape lets an edit go, and Delete or Backspace asks to
 * unset it. Beside the filter, a button for each Network asks to remove it, or, removed
 * with its Timelines kept, to drop them. Escape anywhere else in it, or the close button on
 * its Pane's status bar, shows what the Pane showed before. An edit is a plain,
 * uncontrolled input read once when Enter is pressed. A Credential's value is never edited
 * here.
 *
 * @packageDocumentation
 */
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { menuOf, parseOwnerText, parseUiText } from "@iirc/frontend/options";
import type { Menu as Choices, Option, Value } from "@iirc/frontend/options";
import { writtenOnDevice } from "@iirc/frontend/ui";
import type { KeyboardEvent } from "react";
import { useContext, useId, useRef, useState } from "react";
import {
  GridList,
  GridListItem,
  Input,
  Menu,
  MenuItem,
  Popover,
  SearchField,
} from "react-aria-components";
import type { Key } from "react-aria-components";

import { composerFocus } from "../composer/atoms.ts";
import { pressed } from "../keys/press.ts";
import { PaneBar } from "../panes/pane-bar.tsx";
import { sidebarNetworks } from "../timelines/atoms.ts";
import { Button, IconButton } from "../ui/button.tsx";
import {
  change,
  closeOptions,
  confirming as confirmingAtom,
  editing as editingAtom,
  filterOptions,
  networksWaited,
  notice as noticeAtom,
  optionsFilter,
  optionRows,
  optionsState,
  promptCredential,
} from "./atoms.ts";
import { changeOwnerOption } from "./owner.ts";
import { askToRemove } from "./removal.ts";
import { changeUiOption } from "./ui.ts";

import styles from "./options-view.module.css";

/**
 * An option's value, as the view shows it: a Credential by its name and whether it is
 * held, never a value. What is still being read draws as a wait, never as a default or
 * as "not held".
 * @param props - The value.
 * @returns The value.
 */
const Shown = ({ value }: { readonly value: Value }) => {
  switch (value._tag) {
    case "Reading": {
      return <span className={styles.muted}>reading…</span>;
    }

    case "Shown": {
      return value.text === "" ? (
        <span className={styles.muted}>empty</span>
      ) : (
        <bdi>{value.text}</bdi>
      );
    }

    case "Unset": {
      return <span className={styles.muted}>unset</span>;
    }

    case "Credential": {
      return (
        <span>
          <bdi>{value.name}</bdi>{" "}
          {value.held === undefined || value.held === "NotKnown" ? (
            <span className={styles.muted}>
              {value.held === undefined ? "reading…" : "not known"}
            </span>
          ) : (
            <span className={value.held ? styles.held : styles.missing}>
              {value.held ? "held" : "not held"}
            </span>
          )}
        </span>
      );
    }

    default: {
      return value satisfies never;
    }
  }
};

/**
 * What an option starts as, in words: its text, or `empty` where that text is, such as an
 * empty list's.
 * @param starts - What it starts as.
 * @returns The words.
 */
const startsInWords = (starts: string) => (starts === "" ? "empty" : starts);

/**
 * What an option starts as, as the view shows it: in words, or that it must be given.
 * @param props - What it starts as, or nothing when it must be given.
 * @returns What it starts as.
 */
const Starts = ({ starts }: { readonly starts: string | undefined }) => {
  if (starts === undefined) {
    return "must be given";
  }

  return <bdi>{startsInWords(starts)}</bdi>;
};

/**
 * Sets an option to a value in its text syntax: a Network's through its Configuration, one
 * under `store`, `uploads`, or `previews` through the Daemon, and one under `ui` for every device, or for
 * this device alone while it overrides it here, and a font's family always for this device
 * alone.
 * @returns How to set one.
 */
const useSetTo = () => {
  const configure = useAtomSet(change);
  const changeUi = useAtomSet(changeUiOption);
  const changeOwner = useAtomSet(changeOwnerOption);
  const notice = useAtomSet(noticeAtom);

  return (option: Option, text: string) => {
    if (option._tag === "Network") {
      configure({ edit: { _tag: "Set", path: option.path, text }, network: option.network });

      return;
    }

    if (option._tag === "Owner") {
      const owned = parseOwnerText(option.option, text);

      if (owned._tag === "Invalid") {
        notice(owned.message);
      } else {
        changeOwner({ option: option.option, value: owned.value });
      }

      return;
    }

    const value = parseUiText(option.option, text);

    if (value._tag === "Invalid") {
      notice(value.message);

      return;
    }

    changeUi({
      device: writtenOnDevice(option.option, value.value, option.device !== undefined),
      option: option.option,
      value: value.value,
    });
  };
};

/**
 * Unsets an option: a Network's back to what a new Network starts with, one under `store`
 * or `uploads` back to its default or unset, and one under `ui` back to its default for
 * every device, or, while this device overrides it, back to the value every device shares.
 * @returns How to unset one.
 */
const useUnset = () => {
  const configure = useAtomSet(change);
  const changeUi = useAtomSet(changeUiOption);
  const changeOwner = useAtomSet(changeOwnerOption);

  return (option: Option) => {
    if (option._tag === "Network") {
      configure({ edit: { _tag: "Unset", path: option.path }, network: option.network });
    } else if (option._tag === "Owner") {
      changeOwner({ option: option.option, value: undefined });
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
    : `Unset ${option.name}, back to ${startsInWords(option.starts)}?`;
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

  // A number is a number field within its bounds, so Up and Down step it: by one for a
  // whole number, and by its own step for a decimal. A number or a word is a text field, as
  // a number field takes no word.
  const number =
    option.kind._tag === "Integer" || option.kind._tag === "Decimal"
      ? {
          max: option.kind.maximum,
          min: option.kind.minimum,
          step: option.kind._tag === "Integer" ? 1 : option.kind.step,
          type: "number",
        }
      : { type: "text" };

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
      {...number}
    />
  );
};

/** The key of the entry that ends a menu where its option also takes text. */
const customKey = "custom";

/**
 * An option's choices, as a menu under its value, with the one in force marked and focused.
 * Choosing one sets it, as `/set` with it does, and "Custom…" opens the editor instead.
 * @param props - The option, its menu, how to open its editor, and how to give focus back
 * to its row.
 * @returns The menu.
 */
const ChoiceMenu = ({
  custom,
  done,
  menu,
  option,
}: {
  readonly option: Option;
  readonly menu: Choices;
  readonly custom: () => void;
  readonly done: () => void;
}) => {
  const setTo = useSetTo();
  const stopEditing = useAtomSet(editingAtom);
  const anchor = useRef<HTMLSpanElement>(null);

  const entries = [
    ...menu.choices.map((text, index) => ({ id: String(index), text })),
    ...(menu.custom ? [{ id: customKey, text: "Custom…" }] : []),
  ];

  const chosen =
    menu.chosen === undefined ? [] : [menu.chosen === "Custom" ? customKey : String(menu.chosen)];

  const close = () => {
    stopEditing(undefined);
    done();
  };

  return (
    <>
      <span className={styles.anchor} ref={anchor} />
      <Popover
        className={styles.popover}
        isOpen
        offset={0}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            close();
          }
        }}
        placement="bottom start"
        triggerRef={anchor}
      >
        <Menu
          aria-label={`Value of ${option.name}`}
          autoFocus={chosen.length === 0 ? "first" : true}
          className={styles.menu}
          disallowEmptySelection
          items={entries}
          onAction={(key) => {
            if (key === customKey) {
              custom();

              return;
            }

            const choice = menu.choices[Number(key)];

            close();

            if (choice !== undefined) {
              setTo(option, choice);
            }
          }}
          selectedKeys={chosen}
          selectionMode="single"
        >
          {(entry) => (
            <MenuItem className={styles.entry} id={entry.id} textValue={entry.text}>
              {/* A choice is the option's own text, such as a font's name, so it is isolated. */}
              <bdi>{entry.text}</bdi>
            </MenuItem>
          )}
        </Menu>
      </Popover>
    </>
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
 * A button for each Network, which asks to remove it, and for each removed with its
 * Timelines kept, which asks to drop them, as `/network remove` does.
 * @returns The buttons, or nothing with no Network.
 */
const NetworkRemovals = () => {
  const networks = useAtomValue(sidebarNetworks);
  const ask = useAtomSet(askToRemove);

  return networks.length === 0 ? null : (
    <div className={styles.networks}>
      {networks.map(({ network, removed }) => (
        <Button
          key={network}
          onPress={() => {
            ask(network);
          }}
          size="small"
        >
          {/* A Network's id is ASCII, so it needs no isolating. */}
          {`${removed ? "Drop" : "Remove"} ${network}…`}
        </Button>
      ))}
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
  const waits = useAtomValue(networksWaited);
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
  // The option whose menu gave way to its editor, by "Custom…", while it is edited.
  const [customised, setCustomised] = useState<string | undefined>(undefined);

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

    // An option still being read is changed only once its value shows, so a toggle never
    // turns over from a value not known.
    if (option === undefined || option.value._tag === "Reading") {
      return;
    }

    if (option.kind._tag === "Toggle") {
      const on = option.value._tag === "Shown" && option.value.text === "on";

      setTo(option, on ? "off" : "on");
    } else if (option._tag === "Network" && option.kind._tag === "Credential") {
      prompt({ network: option.network, path: option.path });
    } else if (option._tag === "Owner" && option.kind._tag === "Credential") {
      prompt({ option: option.option });
    } else {
      setCustomised(undefined);
      edit(option.name);
    }
  };

  // "Custom…" lets the menu go, as Escape does, and once its row has the focus again opens
  // the editor, as Enter on the row does. An editor opened while the menu's popover still
  // holds the page loses the focus to its row.
  const customise = (name: string) => {
    edit(undefined);
    focusRow(name)();
    requestAnimationFrame(() => {
      setCustomised(name);
      edit(name);
    });
  };

  // Delete or Backspace on a row asks to unset its option.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing !== undefined || (event.key !== "Delete" && event.key !== "Backspace")) {
      return;
    }

    const row =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-key]") : null;

    const option = named(row?.dataset.key);

    // An option still being read is unset only once its value shows, as it is changed.
    if (option?.unsettable === true && option.value._tag !== "Reading") {
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
        <NetworkRemovals />
      </div>
      {notice === undefined ? null : (
        <p className={styles.notice} id={noticeId} role="alert">
          {notice}
        </p>
      )}
      {asked === undefined ? null : <Confirm done={focusRow(asked.name)} option={asked} />}
      {waits.length === 0 ? null : (
        <ul aria-label="Being read" className={styles.waits}>
          {waits.map((name) => (
            <li key={name}>
              Reading <bdi>{name}</bdi>…
            </li>
          ))}
        </ul>
      )}
      <div className={styles.body}>
        {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the GridList's own rows take the keys; this only hears Delete from them. */}
        <div className={styles.scroller} onKeyDown={onKeyDown} ref={list}>
          <GridList
            {...(notice === undefined ? {} : { "aria-describedby": noticeId })}
            aria-label="Options"
            className={styles.list}
            items={rows}
            // A row has no part of its own to move to but an open editor, whose caret takes
            // Left, Right, Home, and End, and whose number takes Up and Down, so the row
            // takes no arrow from it.
            keyboardNavigationBehavior="tab"
            onAction={onAction}
            renderEmptyState={() =>
              // While Networks are read, their options may yet match, which the waits say.
              waits.length === 0 ? <p className={styles.muted}>No option matches.</p> : null
            }
          >
            {(option) => {
              const menu =
                editing === option.name && customised !== option.name
                  ? menuOf(option.kind, option.value)
                  : undefined;

              const editor = editing === option.name && menu === undefined;

              return (
                <GridListItem className={styles.row} id={option.name} textValue={option.name}>
                  <span className={styles.name}>
                    <bdi>{option.name}</bdi>
                  </span>
                  <span className={styles.value}>
                    {/* The value stays where it is while it is edited, hidden under its editor, so
                      the row keeps its height however many lines the value takes. */}
                    <span className={styles.field}>
                      <span
                        aria-hidden={editor || undefined}
                        className={editor ? styles.hidden : undefined}
                        data-value
                      >
                        <Shown value={option.value} />
                      </span>
                      {editor ? <Editor done={focusRow(option.name)} option={option} /> : null}
                      {menu === undefined ? null : (
                        <ChoiceMenu
                          custom={() => {
                            customise(option.name);
                          }}
                          done={focusRow(option.name)}
                          menu={menu}
                          option={option}
                        />
                      )}
                    </span>
                    {option._tag === "Ui" && option.device !== undefined ? (
                      <span className={styles.device}>
                        on this device, over <Shown value={option.shared} />
                      </span>
                    ) : null}
                    {option._tag === "Ui" && option.note !== undefined ? (
                      <span className={styles.note}>{option.note}</span>
                    ) : null}
                  </span>
                  <span className={styles.starts}>
                    <Starts starts={option.starts} />
                  </span>
                  <span className={styles.description}>{option.description}</span>
                </GridListItem>
              );
            }}
          </GridList>
        </div>
      </div>
    </section>
  );
};
