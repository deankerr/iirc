// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { formatted } from "@iirc/frontend/render";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Inlines } from "./inlines.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

/** The registry the text is drawn in, which holds the theme's defaults. */
const registry = AtomRegistry.make();

/**
 * Draws text as `Inlines` does, in a container on the page.
 * @param text - What a Network sent.
 * @returns The container.
 */
const drawn = (text: string) => {
  const container = document.createElement("div");

  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <Inlines inlines={formatted(text)} />
      </RegistryContext.Provider>
    );
  });
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  return container;
};

/**
 * The run of a drawn text that holds some text.
 * @param page - The drawn text.
 * @param text - The run's text.
 * @returns The run's element, if one is drawn.
 */
const runOf = (page: HTMLElement, text: string) =>
  [...page.querySelectorAll("span")].find((span) => span.textContent === text);

describe("formatted text on the page", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      unmount();
    }
  });

  it("draws a link as an anchor that opens apart, with no opener", () => {
    const link = drawn("see https://example.com/x").querySelector("a");

    expect({
      href: link?.getAttribute("href"),
      rel: link?.getAttribute("rel"),
      target: link?.getAttribute("target"),
    }).toStrictEqual({
      href: "https://example.com/x",
      rel: "noopener noreferrer",
      target: "_blank",
    });
  });

  it("draws bold as a class on its run, and a mIRC colour as the theme's palette slot", () => {
    const page = drawn("\u0002bold\u0002 and \u000304red\u0003");

    expect({
      bold: runOf(page, "bold")?.className.includes("bold"),
      plain: runOf(page, " and ")?.className.includes("bold"),
      red: runOf(page, "red")?.style.color,
    }).toStrictEqual({ bold: true, plain: false, red: "var(--irc-4)" });
  });
});
