/**
 * How wide a Pane is, as the browser lays it out, which decides whether its members fit
 * beside its Timeline. Only a page in a browser measures; elsewhere, as in a test, a Pane
 * is as wide as it is told.
 *
 * @packageDocumentation
 */
import { useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useLayoutEffect } from "react";
import type { RefObject } from "react";

import { paneMeasured } from "../channel/state.ts";

/** Takes a Pane's width, or that it is gone. */
const measured = Atom.fnSync(
  ({ pane, width }: { readonly pane: string; readonly width: number | undefined }, get) => {
    paneMeasured(get.registry, pane, width);
  }
).pipe(Atom.keepAlive);

/**
 * Measures a Pane as long as it is drawn.
 * @param pane - The Pane's id.
 * @param element - The Pane's element.
 */
export const useMeasured = (pane: string, element: RefObject<HTMLElement | null>) => {
  const take = useAtomSet(measured);

  useLayoutEffect(() => {
    const node = element.current;

    // Outside a browser, as in a test, nothing measures.
    const observer =
      node === null || typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(([entry]) => {
            if (entry !== undefined) {
              take({ pane, width: entry.contentRect.width });
            }
          });

    if (node !== null) {
      observer?.observe(node);
    }

    return () => {
      observer?.disconnect();
      take({ pane, width: undefined });
    };
  }, [element, pane, take]);
};
