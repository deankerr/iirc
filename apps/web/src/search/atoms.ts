/**
 * The search, as atoms: the core's search in the Timelines' state, what it found as rows a
 * view draws, and the commands that show it, search a query, page it, move through it,
 * close it, and jump to a result. A query is read by the core against the Timelines and
 * the Owner's time zone, which only the runtime knows. The pages themselves are reads the
 * core's `wanted` gives, which `sync` makes as it makes every other.
 *
 * @packageDocumentation
 */
import type { TimelineItem } from "@iirc/api";
import { contextOf } from "@iirc/frontend/composer";
import { contained } from "@iirc/frontend/render";
import { capped, foundOf, parseQuery } from "@iirc/frontend/search";
import type { Day, Found } from "@iirc/frontend/search";
import { reduceTimelines, resolve } from "@iirc/frontend/timelines";
import type { TimelinesEvent } from "@iirc/frontend/timelines";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { channelState } from "../channel/state.ts";
import { cancelCompletion } from "../composer/completion-state.ts";
import { timelinesState } from "../timelines/atoms.ts";

/** The search, as the core holds it. */
export const searchState = Atom.make((get) => get(timelinesState).search);

/** Whether the search stopped at the most it holds, with more beyond. */
export const searchCapped = Atom.make((get) => capped(get(searchState)));

/**
 * How many times the search's field was asked to take focus. The field focuses itself each
 * time this changes, and as it first shows.
 */
export const searchFocus = Atom.make(0).pipe(Atom.keepAlive);

/** A result as the view draws it: what it shows, and where it was said, in words. */
export interface ResultRow {
  readonly found: Found;
  /** Its Network and Timeline, such as `libera #iirc`. */
  readonly place: string;
}

/** What the search found, as rows, newest first, each with its match marked. */
export const resultRows = Atom.make((get): readonly ResultRow[] => {
  const state = get(timelinesState);
  const { results, searched } = state.search;
  const sought = searched?.text ?? "";

  return results.flatMap((item) => {
    const found = foundOf(item, sought);

    const name = state.networks
      .get(item.network)
      ?.timelines.get(resolve(state, item.timeline))?.name;

    return found === undefined
      ? []
      : [
          {
            found,
            place: `${item.network} ${name === undefined ? "(a Timeline gone)" : contained(name)}`,
          },
        ];
  });
});

/**
 * Folds one event into the Timelines' state.
 * @param registry - The registry.
 * @param event - What happened.
 */
const navigated = (registry: AtomRegistry.AtomRegistry, event: TimelinesEvent) => {
  registry.set(timelinesState, reduceTimelines(registry.get(timelinesState), event));
};

/**
 * The instant a day begins in the Owner's time zone, as this browser keeps it, so a day
 * that begins at another offset, as one that changes the clocks does, is read right. The
 * core reads no zone, so the runtime gives it this.
 * @param day - The day.
 * @returns The instant, in milliseconds since the epoch.
 */
const dayStart = ({ day, month, year }: Day): number => {
  const start = new Date(0);

  // `setFullYear` reads a year below 100 as written, where the constructor adds 1900.
  start.setFullYear(year, month - 1, day);
  start.setHours(0, 0, 0, 0);

  return start.getTime();
};

/**
 * Shows the search in the Pane it shows in, or the focused one, and searches the query
 * when one is given, read against the Timelines held, the Network in focus, and the
 * Owner's time zone. Without one, it shows what it last found. Its field takes the focus.
 */
export const showSearch = Atom.fnSync((query: string | undefined, get) => {
  const { registry } = get;
  const state = registry.get(timelinesState);

  cancelCompletion(registry);

  const parsed =
    query === undefined
      ? undefined
      : parseQuery(query, {
          dayStart,
          focused: contextOf(state, registry.get(channelState)).focus?.network,
          networks: [...state.networks.values()].map((network) => ({
            network: network.network,
            timelines: [...network.timelines.values()],
          })),
        });

  navigated(registry, { _tag: "SearchShown", parsed, query });
  registry.set(searchFocus, registry.get(searchFocus) + 1);
}).pipe(Atom.keepAlive);

/** Searches what the field holds, as Enter in it does. */
export const submitSearch = Atom.fnSync((_, get) => {
  get.registry.set(showSearch, get.registry.get(searchState).query);
}).pipe(Atom.keepAlive);

/** Keeps what the Owner typed in the field. */
export const typeSearch = Atom.fnSync((query: string, get) => {
  navigated(get.registry, { _tag: "SearchChanged", change: { _tag: "Typed", query } });
}).pipe(Atom.keepAlive);

/** Asks for the next page, when more lie beyond what was found. */
export const moreResults = Atom.fnSync((_, get) => {
  navigated(get.registry, { _tag: "SearchChanged", change: { _tag: "More" } });
}).pipe(Atom.keepAlive);

/** Selects a result, by its index. */
export const selectResult = Atom.fnSync((index: number, get) => {
  navigated(get.registry, { _tag: "SearchChanged", change: { _tag: "Selected", index } });
}).pipe(Atom.keepAlive);

/** Closes the search, showing what its Pane showed before. What it found is kept. */
export const closeSearch = Atom.fnSync((_, get) => {
  navigated(get.registry, { _tag: "SearchClosed" });
}).pipe(Atom.keepAlive);

/**
 * Opens a result's Timeline read around it, with it brought into view and marked, letting
 * go of what was being completed, since the composer then stands under that Timeline.
 */
export const jumpTo = Atom.fnSync((item: TimelineItem, get) => {
  cancelCompletion(get.registry);
  navigated(get.registry, { _tag: "Jumped", position: item.position, timeline: item.timeline });
}).pipe(Atom.keepAlive);

/** Lets go of the item jumped to, once the Owner scrolls away from it. */
export const leaveTarget = Atom.fnSync((timeline: TimelineItem["timeline"], get) => {
  navigated(get.registry, { _tag: "TargetLeft", timeline });
}).pipe(Atom.keepAlive);
