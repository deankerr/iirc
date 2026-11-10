/**
 * The one key listener for the whole page, on the document, mounted once with the shell.
 * It hands each key pressed to `pressed`, which asks the keymap what it does and carries
 * that out. A key no binding takes goes on untouched, as does one a widget already handled
 * or an input method is composing.
 *
 * @packageDocumentation
 */
import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect } from "react";

import { pressed } from "./press.ts";

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

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [registry]);

  return null;
};
