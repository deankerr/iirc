/**
 * What a word typed in a composer can be completed from, as atoms, and the one way to have
 * its list follow a draft that was not typed, as a command started from a key is. Apart from
 * the composer's commands, so they can open the list without depending on completion's runtime.
 *
 * @packageDocumentation
 */
import { reduceCompletion, sourcesOf } from "@iirc/frontend/completion";
import type { Emoji, Sources } from "@iirc/frontend/completion";
import type { Place } from "@iirc/frontend/composer";
import { listed } from "@iirc/frontend/options";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { keymapState } from "../keys/state.ts";
import { optionsState } from "../options/atoms.ts";
import { uiInEffect } from "../options/ui.ts";
import { themesListed } from "../theme/atoms.ts";
import { timelinesState } from "../timelines/atoms.ts";
import { chantypesState } from "./chantypes-state.ts";
import { completionState } from "./completion-state.ts";
import { ranState } from "./composer-state.ts";

/** Every emoji by its names, once loaded, and none until completion first wants them. */
export const emojiState = Atom.make<readonly Emoji[] | undefined>(undefined).pipe(Atom.keepAlive);

/** What a word typed at a place can be completed from, as things are now. */
export const sourcesAt = Atom.family((place: Place) =>
  Atom.make((get): Sources =>
    sourcesOf(get(timelinesState), place, {
      chantypes: get(chantypesState),
      emoji: get(emojiState),
      keymap: get(keymapState),
      options: listed(get(optionsState), ""),
      ran: get(ranState),
      suffix: get(uiInEffect).suffix,
      ...get(themesListed),
      font: get(uiInEffect).font,
    })
  )
);

/**
 * Has completion follow a draft as if it were typed, its caret at the end, so a draft that
 * starts with `/` opens its list.
 * @param registry - The registry.
 * @param place - The composer's place.
 * @param text - The draft's plain text.
 */
export const followed = (registry: AtomRegistry.AtomRegistry, place: Place, text: string) => {
  const step = reduceCompletion(
    registry.get(completionState),
    { _tag: "Typed", caret: text.length, place, text },
    registry.get(sourcesAt(place))
  );

  registry.set(completionState, step.state);
};
