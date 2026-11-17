// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { uiDefaults } from "@iirc/api";
import { Redacted } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { uiSync } from "../options/ui.ts";
import { check, signInWithKey, signOut } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, theKey } from "../testing/fake-daemon.ts";
import { watchTheme } from "../theme/atoms.ts";
import { App } from "./app.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const cleanups: (() => void)[] = [];

/**
 * How the root is drawn now.
 * @returns The theme's name and the text's font.
 */
const drawnRoot = () => ({
  font: document.documentElement.style.getPropertyValue("--font-text"),
  theme: document.documentElement.dataset.theme,
});

/**
 * What the page draws: the wait, or the shell.
 * @param container - The container.
 * @returns Which.
 */
const drawing = (container: HTMLElement) => {
  const shell = container.querySelector("nav[aria-label='Networks']") !== null;

  return { shell, wait: !shell && container.textContent.includes("Reading…") };
};

/**
 * Renders the Frontend over a registry, with the theme drawn on the root as the page draws
 * it, and keeps how the root was drawn on each first frame that drew the shell, which alone
 * draws the Networks.
 * @param registry - The registry.
 * @returns The container, and how the root was drawn on the shell's first frame, once it was.
 */
const render = async (registry: AtomRegistry.AtomRegistry) => {
  const container = document.createElement("div");
  const firstShellFrames: ReturnType<typeof drawnRoot>[] = [];

  document.body.append(container);
  // As the page starts: the options followed, and the theme drawn on the root.
  cleanups.push(registry.mount(uiSync), watchTheme(registry));

  // Each frame that adds the shell, from none drawn, is a first frame of it.
  let drawn = false;

  const observer = new MutationObserver(() => {
    const now = drawing(container).shell;

    if (now && !drawn) {
      firstShellFrames.push(drawnRoot());
    }

    drawn = now;
  });

  observer.observe(container, { childList: true, subtree: true });

  const root = createRoot(container);

  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    );
    await Promise.resolve();
  });

  cleanups.push(() => {
    observer.disconnect();
    root.unmount();
    container.remove();
  });

  return { container, firstShellFrames };
};

/**
 * The `ui` options with a theme and a font the Owner chose.
 * @param theme - The theme.
 * @param font - The font.
 * @param sequence - The sequence of the last Change.
 * @returns The options in force, as the wire carries them.
 */
const chosen = (theme: string, font: string, sequence: number) => ({
  options: { ...uiDefaults, font, theme },
  sequence,
});

/** The root as the theme's defaults draw it. */
const defaults = { font: "var(--font-device)", theme: uiDefaults.theme };

describe("the page as it starts", () => {
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      act(cleanup);
    }
  });

  it("draws a wait until the ui options are read, then the shell in the Owner's theme and font", async () => {
    const fake = fakeDaemon();

    fake.daemon.signedIn = true;
    fake.daemon.ui = chosen("gruvbox-dark", "jetbrains-mono", 1);
    fake.daemon.holdUiFollows = true;
    const registry = registryFor(fake.fetch);

    await run(registry, check, undefined);
    const { container, firstShellFrames } = await render(registry);

    await eventually(() => fake.daemon.uiFollowsHeld.length > 0);
    const waiting = { drawing: drawing(container), root: drawnRoot() };

    fake.daemon.holdUiFollows = false;
    await act(async () => {
      for (const release of fake.daemon.uiFollowsHeld.splice(0)) {
        release();
      }

      await eventually(() => drawing(container).shell);
    });

    expect({ firstShellFrames, waiting }).toStrictEqual({
      firstShellFrames: [
        { font: '"JetBrains Mono Variable", var(--font-device)', theme: "gruvbox-dark" },
      ],
      waiting: { drawing: { shell: false, wait: true }, root: defaults },
    });
  });

  it("offers to sign out from the wait, which a follow that never answers would otherwise hold", async () => {
    const fake = fakeDaemon();

    fake.daemon.signedIn = true;
    fake.daemon.hangUiChanges = true;
    const registry = registryFor(fake.fetch);

    await run(registry, check, undefined);
    const { container } = await render(registry);

    const button = [...container.querySelectorAll("button")].find(
      (one) => one.textContent === "Sign out"
    );

    await act(async () => {
      button?.click();
      await eventually(() => !fake.daemon.signedIn);
    });

    expect({ offered: button !== undefined, signedIn: fake.daemon.signedIn }).toStrictEqual({
      offered: true,
      signedIn: false,
    });
  });

  it("draws a wait again on the next sign-in, never the last sign-in's options or the defaults", async () => {
    const fake = fakeDaemon();

    fake.daemon.signedIn = true;
    fake.daemon.ui = chosen("gruvbox-dark", "jetbrains-mono", 1);
    const registry = registryFor(fake.fetch);

    await run(registry, check, undefined);
    const { container, firstShellFrames } = await render(registry);

    await act(async () => {
      await eventually(() => drawing(container).shell);
    });

    await act(async () => {
      await run(registry, signOut, undefined);
    });

    // The options change while signed out, and the next sign-in's follow is held.
    fake.daemon.ui = chosen("solarized-light", "inter", 2);
    fake.daemon.holdUiFollows = true;

    await act(async () => {
      await run(registry, signInWithKey, Redacted.make(theKey));
    });
    await eventually(() => fake.daemon.uiFollowsHeld.length > 0);
    const waiting = { drawing: drawing(container), root: drawnRoot() };

    fake.daemon.holdUiFollows = false;
    await act(async () => {
      for (const release of fake.daemon.uiFollowsHeld.splice(0)) {
        release();
      }

      await eventually(() => drawing(container).shell);
    });

    expect({ firstShellFrames, waiting }).toStrictEqual({
      firstShellFrames: [
        { font: '"JetBrains Mono Variable", var(--font-device)', theme: "gruvbox-dark" },
        { font: '"Inter Variable", var(--font-device-sans)', theme: "solarized-light" },
      ],
      waiting: { drawing: { shell: false, wait: true }, root: defaults },
    });
  });
});
