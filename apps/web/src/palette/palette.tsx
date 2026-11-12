/**
 * The command palette: React Aria's Autocomplete over a Menu, in a modal Dialog, as its own
 * command palette is built. It lists what the core ranks for the query, in sections for
 * what was chosen recently, the commands, the Timelines, the themes, the fonts, and the
 * options, or the themes alone, each row with its name, a dim description, and a command's
 * keys. Arrows move, Enter chooses, and Escape clears the query, then closes, and focus
 * returns where it was. A theme or a font is drawn while its row is highlighted, and the
 * one in effect comes back as the highlight moves on or the palette closes.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { showChord } from "@iirc/frontend/keymap";
import type { Entry } from "@iirc/frontend/palette";
import { fontDescription, themeDescription } from "@iirc/frontend/palette";
import { useEffect } from "react";
import {
  Autocomplete,
  Collection,
  Dialog,
  Header,
  Input,
  Keyboard,
  Menu,
  MenuItem,
  MenuSection,
  Modal,
  ModalOverlay,
  SearchField,
  Text,
} from "react-aria-components";
import type { Key } from "react-aria-components";

import { closePalette, highlightEntry, paletteSections, pickEntry, queryPalette } from "./atoms.ts";
import { paletteState, platform } from "./state.ts";

import styles from "./palette.module.css";

/** What a Timeline is, in a few words. */
const kinds = { Channel: "Channel", Direct: "Direct Message", Network: "Network" } as const;

/**
 * What a row is called, as typed to find it and read out.
 * @param entry - The entry.
 * @returns Its name.
 */
const nameOf = (entry: Entry) => (entry._tag === "Command" ? `/${entry.name}` : entry.name);

/**
 * One row: its name, a dim description, and a command's keys.
 * @param props - The entry.
 * @returns The row's content.
 */
const Row = ({ entry }: { readonly entry: Entry }) => {
  switch (entry._tag) {
    case "Command": {
      return (
        <>
          <Text className={styles.name} slot="label">
            {entry.usage}
          </Text>
          <Text className={styles.description} slot="description">
            {entry.description}
          </Text>
          {entry.chords.length === 0 ? null : (
            <Keyboard className={styles.keys}>
              {entry.chords.map((chord) => showChord(chord, platform)).join(" ")}
            </Keyboard>
          )}
        </>
      );
    }

    case "Timeline": {
      return (
        <>
          <Text className={styles.name} slot="label">
            <bdi>{entry.name}</bdi>
          </Text>
          <Text className={styles.description} slot="description">
            {kinds[entry.kind]} on {entry.network}
          </Text>
        </>
      );
    }

    case "Option": {
      return (
        <>
          <Text className={styles.name} slot="label">
            {entry.name}
          </Text>
          <Text className={styles.description} slot="description">
            {entry.description}
          </Text>
        </>
      );
    }

    case "Theme": {
      return (
        <>
          <Text className={styles.name} slot="label">
            {entry.name}
          </Text>
          <Text className={styles.description} slot="description">
            {entry.current ? `${themeDescription(entry)}, in effect` : themeDescription(entry)}
          </Text>
        </>
      );
    }

    case "Font": {
      return (
        <>
          <Text className={styles.name} slot="label">
            {entry.name}
          </Text>
          <Text className={styles.description} slot="description">
            {entry.current
              ? `${fontDescription(entry.name)}, in effect`
              : fontDescription(entry.name)}
          </Text>
        </>
      );
    }

    default: {
      return entry satisfies never;
    }
  }
};

/**
 * Tells the palette which row is highlighted, as it is and as it stops being, so a theme's
 * or a font's row draws it while highlighted. React Aria's Autocomplete moves a virtual focus, which no
 * focus event reports, and says it only as a row's `isFocused`, so this is the one place a
 * row tells the core something from an effect. It draws nothing.
 * @param props - The row's key, and whether it is highlighted.
 * @returns Nothing.
 */
const Highlighted = ({
  highlighted,
  id,
}: {
  readonly id: string;
  readonly highlighted: boolean;
}) => {
  const highlight = useAtomSet(highlightEntry);

  useEffect(() => {
    highlight({ highlighted, key: id });

    return () => {
      highlight({ highlighted: false, key: id });
    };
  }, [highlight, highlighted, id]);

  return null;
};

/**
 * How many entries are listed, in words, for a screen reader to announce.
 * @param count - How many.
 * @returns The words.
 */
const resultsText = (count: number) => {
  if (count === 0) {
    return "No results";
  }

  return count === 1 ? "1 result" : `${count} results`;
};

/**
 * The palette, open while the core says so.
 * @returns The palette.
 */
export const Palette = () => {
  const { open, query, scope } = useAtomValue(paletteState);
  const themesOnly = scope === "Themes";
  const shown = useAtomValue(paletteSections);
  const close = useAtomSet(closePalette);
  const setQuery = useAtomSet(queryPalette);
  const pick = useAtomSet(pickEntry);
  const count = shown.flatMap((section) => section.entries).length;

  // A key is read back as the entry it names, never cast.
  const onAction = (key: Key) => {
    const entry = shown
      .flatMap((section) => section.entries)
      .find((one) => one.key === String(key));

    if (entry !== undefined) {
      pick(entry);
    }
  };

  return (
    <ModalOverlay
      className={styles.overlay}
      isDismissable
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          close();
        }
      }}
    >
      <Modal className={styles.modal}>
        <Dialog aria-label="Command palette" className={styles.dialog}>
          {/* A status, polite, present from the moment it opens, so each change is announced. */}
          <output aria-live="polite" className={styles.status}>
            {resultsText(count)}
          </output>
          <Autocomplete inputValue={query} onInputChange={setQuery}>
            <SearchField
              aria-label="Command, Timeline, or option"
              autoFocus
              className={styles.search}
            >
              <span aria-hidden="true" className={styles.prompt}>
                &gt;
              </span>
              <Input
                className={styles.input}
                placeholder={themesOnly ? "a theme" : "a command, a Timeline, or an option"}
              />
            </SearchField>
            <Menu
              aria-label="Commands, Timelines, and options"
              className={styles.menu}
              items={shown}
              onAction={onAction}
              renderEmptyState={() => <p className={styles.empty}>Nothing matches.</p>}
            >
              {(section) => (
                <MenuSection className={styles.section} id={section.id}>
                  <Header className={styles.header}>{section.title}</Header>
                  <Collection items={section.entries}>
                    {(entry) => (
                      <MenuItem className={styles.item} id={entry.key} textValue={nameOf(entry)}>
                        {({ isFocused }) => (
                          <>
                            <Highlighted highlighted={isFocused} id={entry.key} />
                            <Row entry={entry} />
                          </>
                        )}
                      </MenuItem>
                    )}
                  </Collection>
                </MenuSection>
              )}
            </Menu>
          </Autocomplete>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
