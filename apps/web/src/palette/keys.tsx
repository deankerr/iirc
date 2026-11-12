/**
 * The one key listener for the whole page, on the document, mounted once with the shell.
 * It hands each key pressed to `pressed`, which asks the keymap what it does and carries
 * that out. A key no binding takes goes on untouched, as does one a widget already handled
 * or an input method is composing, except a key that types, which the composer takes
 * first.
 *
 * @packageDocumentation
 */
import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect } from "react";

import { pressed, typedInComposer } from "./press.ts";

/**
 * Listens for keys on the document while mounted.
 * @returns Nothing to render.
 */
export const Keys = () => {
  const registry = useContext(RegistryContext);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      pressed(registry, event);
    };

    // A key that types goes to the composer first, in the capture phase, before any
    // widget's own handler sees it: it is the composer that takes the focus, for the
    // character this very key makes. React Aria's typeahead, a list's own, listens in
    // React's capture phase, below the document's, and would move the focus to a row.
    const onTyping = (event: KeyboardEvent) => {
      typedInComposer(registry, event);
    };

    document.addEventListener("keydown", onTyping, true);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onTyping, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [registry]);

  return null;
};
