/**
 * The search, in a Pane: its field, a line saying how it stands, and what it found, newest
 * first, each result with where and when it was said, its sender in their colour, and its
 * text with what was searched for marked. Enter in the field searches, ArrowDown moves into
 * the results, where the arrows move, Enter jumps to the result chosen, and Escape, from
 * either, shows what the Pane showed before. The results are virtualised, and the next page
 * is asked for as the Owner nears their end.
 *
 * @packageDocumentation
 */
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { KeyboardEvent } from "react";
import { Fragment, useContext, useId, useLayoutEffect, useRef } from "react";

import { composerFocus } from "../composer/atoms.ts";
import { Nick } from "../timelines/line.tsx";
import { dateOf } from "../ui/dates.ts";
import {
  closeSearch,
  jumpTo,
  moreResults,
  resultRows,
  searchCapped,
  searchFocus,
  searchState,
  selectResult,
  submitSearch,
  typeSearch,
} from "./atoms.ts";
import type { ResultRow } from "./atoms.ts";

import styles from "./search-view.module.css";

// The Owner's own clock and time zone, which only the view reads.
const when = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "short",
  year: "numeric",
});

/** How near the end of the results, in rows, the next page is asked for. */
const nearEnd = 8;

/** How many rows PageUp and PageDown move by. */
const pageRows = 10;

/**
 * One result: where and when it was said, by whom, and its text, what was searched for
 * marked, each run a text node.
 * @param props - The result.
 * @returns The result.
 */
const Result = ({ row }: { readonly row: ResultRow }) => {
  const { found, place } = row;
  const date = dateOf(found.item.position.at);
  const nick = <Nick colour={found.colour} nick={found.nick} />;

  return (
    <>
      <span className={styles.where}>
        <bdi className={styles.place}>{place}</bdi>{" "}
        {date === undefined ? (
          <span className={styles.time}>at a time unavailable</span>
        ) : (
          <time className={styles.time} dateTime={date.toISOString()}>
            {when.format(date)}
          </time>
        )}
      </span>
      <span className={styles.line}>
        <span className={styles.sender}>
          {found.kind === "Privmsg" ? <>&lt;{nick}&gt;</> : null}
          {found.kind === "Notice" ? <>-{nick}-</> : null}
          {found.kind === "Action" ? <>* {nick}</> : null}
        </span>{" "}
        <bdi className={styles.text}>
          {found.runs.map((run, index) =>
            // A result's runs never move, so their order is their identity.
            run.match ? (
              // oxlint-disable-next-line react/no-array-index-key
              <mark className={styles.match} key={index}>
                {run.text}
              </mark>
            ) : (
              // oxlint-disable-next-line react/no-array-index-key
              <Fragment key={index}>{run.text}</Fragment>
            )
          )}
        </bdi>
      </span>
    </>
  );
};

/**
 * How the search stands, in words, for the line a screen reader hears as it changes.
 * @returns The words.
 */
const useStanding = (): string => {
  const search = useAtomValue(searchState);
  const isCapped = useAtomValue(searchCapped);
  const count = search.results.length;

  if (search.error !== undefined) {
    return "";
  }

  if (search.searched === undefined) {
    return "Type at least three characters and press Enter. from:<nick>, in:<#channel|nick>, network:<id>, since:<date>, and until:<date> narrow it, and quotes keep a phrase whole.";
  }

  if (count === 0) {
    return search.wanted || search.reading ? "Searching…" : "Nothing found.";
  }

  if (isCapped) {
    return `The newest ${count} found are shown. Narrow the search to find older ones.`;
  }

  return search.more
    ? `${count} found, newest first, more as you scroll.`
    : `${count} found, newest first.`;
};

/**
 * The search view.
 * @returns The view.
 */
export const SearchView = () => {
  const registry = useContext(RegistryContext);
  const search = useAtomValue(searchState);
  const rows = useAtomValue(resultRows);
  const focusAsked = useAtomValue(searchFocus);
  const standing = useStanding();
  const type = useAtomSet(typeSearch);
  const submit = useAtomSet(submitSearch);
  const more = useAtomSet(moreResults);
  const select = useAtomSet(selectResult);
  const close = useAtomSet(closeSearch);
  const jump = useAtomSet(jumpTo);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const errorId = `${id}-error`;

  // TanStack Virtual hands back new functions each render, which nothing here memoizes.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 40,
    getItemKey: (index) => rows[index]?.found.key ?? index,
    getScrollElement: () => list.current,
    overscan: 12,
    // The selected option stays in the page wherever the results are scrolled, so
    // `aria-activedescendant` always names an element.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);

      return search.selected >= range.count || indexes.includes(search.selected)
        ? indexes
        : [...indexes, search.selected].toSorted((left, right) => left - right);
    },
  });

  // The field takes the focus as the search shows, and each time it is shown again.
  useLayoutEffect(() => {
    field.current?.focus();
  }, [focusAsked]);

  /** Gives the composer the focus, as the search goes. */
  const toComposer = () => {
    registry.set(composerFocus, registry.get(composerFocus) + 1);
  };

  /**
   * Selects a result, brings it into view, and asks for the next page near the end.
   * @param index - The result's index.
   */
  const moveTo = (index: number) => {
    const to = Math.min(rows.length - 1, Math.max(0, index));

    if (to < 0) {
      return;
    }

    select(to);
    virtualizer.scrollToIndex(to, { align: "auto" });

    if (to >= rows.length - nearEnd) {
      more();
    }
  };

  /**
   * Jumps to a result, and gives the composer the focus.
   * @param index - The result's index.
   */
  const jumpAt = (index: number) => {
    const row = rows[index];

    if (row !== undefined) {
      jump(row.found.item);
      toComposer();
    }
  };

  /**
   * Shows what the Pane showed before, and gives the composer the focus, as Escape does.
   * @param event - The key.
   * @returns Whether it was Escape.
   */
  const escaped = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return false;
    }

    event.preventDefault();
    close();
    toComposer();

    return true;
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves = new Map([
      ["ArrowDown", search.selected + 1],
      ["ArrowUp", search.selected - 1],
      ["End", rows.length - 1],
      ["Home", 0],
      ["PageDown", search.selected + pageRows],
      ["PageUp", search.selected - pageRows],
    ]);

    const to = moves.get(event.key);

    if (to !== undefined) {
      event.preventDefault();
      moveTo(to);
    } else if (event.key === "Enter") {
      event.preventDefault();
      jumpAt(search.selected);
    } else {
      escaped(event);
    }
  };

  const selected = rows[search.selected];
  const items = virtualizer.getVirtualItems();

  return (
    <section aria-label="Search" className={styles.view}>
      <search>
        <form
          className={styles.header}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className={styles.label} htmlFor={`${id}-query`}>
            Search
          </label>
          <input
            aria-describedby={search.error === undefined ? undefined : errorId}
            aria-invalid={search.error === undefined ? undefined : true}
            autoComplete="off"
            className={styles.query}
            id={`${id}-query`}
            onChange={(event) => {
              type(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && rows.length > 0) {
                event.preventDefault();
                list.current?.focus();
              } else {
                escaped(event);
              }
            }}
            ref={field}
            spellCheck={false}
            type="text"
            value={search.query}
          />
        </form>
      </search>
      {search.error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {search.error}
        </p>
      )}
      <output aria-live="polite" className={styles.standing}>
        {standing}
      </output>
      <div
        aria-activedescendant={selected === undefined ? undefined : `${id}-${search.selected}`}
        aria-label="Results"
        className={styles.results}
        onFocus={(event) => {
          // Focus entering the results shows the selected one.
          if (event.target === event.currentTarget && selected !== undefined) {
            virtualizer.scrollToIndex(search.selected, { align: "auto" });
          }
        }}
        onKeyDown={onListKey}
        onScroll={(event) => {
          const element = event.currentTarget;

          if (element.scrollHeight - element.scrollTop - element.clientHeight < 200) {
            more();
          }
        }}
        ref={list}
        // A virtualised listbox, its options drawn only near the view, which no `select` can be.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="listbox"
        tabIndex={rows.length === 0 ? -1 : 0}
      >
        <div className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index];

            return row === undefined ? null : (
              // The listbox takes the keys for its options, by `aria-activedescendant`.
              // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
              <div
                aria-selected={item.index === search.selected}
                className={styles.result}
                data-index={item.index}
                id={`${id}-${item.index}`}
                key={item.key}
                onClick={() => {
                  select(item.index);
                  jumpAt(item.index);
                }}
                ref={virtualizer.measureElement}
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option of the listbox above
                role="option"
                style={{ transform: `translateY(${item.start}px)` }}
                tabIndex={-1}
              >
                <Result row={row} />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
