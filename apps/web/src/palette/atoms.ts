/**
 * The palette, as atoms: what it lists, derived from the Timelines, the options, the
 * keymap, and its own state, and what carries out a choice. The core ranks the entries and
 * says what a choice asks for, and the composer's runtime carries it out.
 *
 * @packageDocumentation
 */
import { contextOf } from "@iirc/frontend/composer";
import { listed } from "@iirc/frontend/options";
import { choose, sections } from "@iirc/frontend/palette";
import type { Entry, Section } from "@iirc/frontend/palette";
import { Atom } from "effect/reactivity";

import { channelState } from "../channel/state.ts";
import { perform } from "../composer/atoms.ts";
import { optionsState } from "../options/atoms.ts";
import { themesListed } from "../theme/atoms.ts";
import { sidebarNetworks, timelinesState } from "../timelines/atoms.ts";
import { keymapState, paletteHappened, paletteHighlight, paletteState } from "./state.ts";

/** A section as the palette's menu lists it, with the id a collection keys it by. */
export interface ListedSection extends Section {
  readonly id: string;
}

/** What the palette lists for its query, ranked by the core. */
export const paletteSections = Atom.make((get): readonly ListedSection[] => {
  const { query, recent, scope } = get(paletteState);

  const listing = {
    context: contextOf(get(timelinesState), get(channelState)),
    keymap: get(keymapState),
    options: listed(get(optionsState), ""),
    sidebar: get(sidebarNetworks),
    ...get(themesListed),
  };

  return sections(listing, query, recent, scope).map((section) => ({
    ...section,
    id: section.title,
  }));
});

/** Closes the palette, choosing nothing. */
export const closePalette = Atom.fnSync((_, get) => {
  get.registry.set(paletteHighlight, undefined);
  paletteHappened(get.registry, { _tag: "Closed" });
}).pipe(Atom.keepAlive);

/**
 * Says which entry the palette highlights, or that one no longer is, which previews a theme
 * while its entry is highlighted.
 */
export const highlightEntry = Atom.fnSync(
  (change: { readonly key: string; readonly highlighted: boolean }, get) => {
    const { registry } = get;

    if (change.highlighted) {
      registry.set(paletteHighlight, change.key);
    } else if (registry.get(paletteHighlight) === change.key) {
      registry.set(paletteHighlight, undefined);
    }
  }
).pipe(Atom.keepAlive);

/** Says what the Owner typed into the palette. */
export const queryPalette = Atom.fnSync((query: string, get) => {
  paletteHappened(get.registry, { _tag: "Queried", query });
}).pipe(Atom.keepAlive);

/**
 * Chooses an entry: the palette remembers it and closes, and what the core says it asks
 * for is carried out.
 */
export const pickEntry = Atom.fnSync((entry: Entry, get) => {
  const { registry } = get;

  const intents = choose(
    entry,
    contextOf(registry.get(timelinesState), registry.get(channelState))
  );

  registry.set(paletteHighlight, undefined);
  paletteHappened(registry, { _tag: "Chosen", key: entry.key });
  registry.set(perform, intents);
}).pipe(Atom.keepAlive);
