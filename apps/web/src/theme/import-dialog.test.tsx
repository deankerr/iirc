// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { Effect } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { signedOut } from "../options/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import {
  eventually,
  fakeDaemon,
  instantThemeReader,
  registryFor,
  run,
} from "../testing/fake-daemon.ts";
import { importDraft, tooLong } from "./atoms.ts";
import type { ThemeReaderPort } from "./reader.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

/** Kitty's layout, which the instant reader reads at once. */
const kitty = [
  "foreground #f8f8f2",
  "background #282a36",
  ...Array.from({ length: 16 }, (_, index) => `color${index} #808080`),
].join("\n");

/**
 * Renders the Frontend into a fresh container, on a registry over the fake Daemon.
 * @param registry - The registry.
 * @returns How to unmount it.
 */
const render = async (registry: AtomRegistry.AtomRegistry) => {
  const container = document.createElement("div");

  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    );
    await Promise.resolve();
  });

  let done = false;

  const unmount = () => {
    if (!done) {
      done = true;
      root.unmount();
      container.remove();
    }
  };

  mounted.push(unmount);

  return unmount;
};

/**
 * Sets a field's value as a keystroke does, beneath React's own tracking, then says so.
 * @param field - The field.
 * @param value - The value.
 */
const typeInto = async (field: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      value
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/**
 * Waits until the page shows an element, anywhere in the document, as a dialog's portal is.
 * @param selector - The element.
 * @returns It.
 */
const shown = async <E extends Element>(selector: string) => {
  await eventually(() => document.querySelector(selector) !== null);

  const found = document.querySelector<E>(selector);

  if (found === null) {
    throw new Error(`never shown: ${selector}`);
  }

  return found;
};

/**
 * The import dialog, opened by `/theme import` in a signed-in page whose themes are read by
 * the reader given.
 * @param reader - The reader.
 * @returns The registry, the dialog's text field, what its status says, and how to unmount.
 */
const importing = async (reader: ThemeReaderPort) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  const registry = registryFor(fake.fetch, {}, undefined, reader);

  await run(registry, check, undefined);
  const unmount = await render(registry);

  const composer = await shown<HTMLTextAreaElement>("main textarea");

  await typeInto(composer, "/theme import");
  await act(async () => {
    composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await Promise.resolve();
  });

  const dialog = await shown<HTMLElement>('[role="dialog"][aria-label="Import a theme"]');
  const text = await shown<HTMLTextAreaElement>('[role="dialog"] textarea');

  const status = () =>
    dialog.querySelector(`[id="${text.getAttribute("aria-describedby") ?? ""}"]`)?.textContent;

  return { registry, status, text, unmount };
};

describe("the import dialog", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("reads a theme with the reader and says its format", async () => {
    const { status, text } = await importing(instantThemeReader);

    await typeInto(text, kitty);
    await eventually(() => status() === "Read as Kitty.");

    expect(status()).toBe("Read as Kitty.");
  });

  it("ends a read the next text supersedes, and refuses one that takes too long, staying responsive", async () => {
    const started: string[] = [];
    const ended: string[] = [];

    // A reader that never answers, as Effect's YAML parser can take seconds on some text.
    const slow: ThemeReaderPort = {
      read: (one) =>
        Effect.suspend(() => {
          started.push(one);

          return Effect.never;
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              ended.push(one);
            })
          )
        ),
    };

    const { status, text } = await importing(slow);

    await typeInto(text, "base00: a");
    const reading = status();

    // Still taking text while the first reads: the newer text ends the older read.
    await typeInto(text, "base00: ab");
    const typed = text.value;

    await eventually(() => status() === tooLong);

    expect({ ended, reading, started, status: status(), typed }).toStrictEqual({
      ended: ["base00: a", "base00: ab"],
      reading: "Reading…",
      started: ["base00: a", "base00: ab"],
      status: tooLong,
      typed: "base00: ab",
    });
  });

  it("closes the import as it unmounts or the page signs out, ending a read in flight", async () => {
    const ended: string[] = [];

    const never: ThemeReaderPort = {
      read: (one) =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              ended.push(one);
            })
          )
        ),
    };

    const first = await importing(never);

    await typeInto(first.text, "base00: a");
    act(first.unmount);
    const unmounted = { ended: [...ended], open: first.registry.get(importDraft).open };

    const second = await importing(never);

    await typeInto(second.text, "base00: b");
    await act(async () => {
      signedOut(second.registry);
      await Promise.resolve();
    });

    expect({
      signedOut: { ended, open: second.registry.get(importDraft).open },
      unmounted,
    }).toStrictEqual({
      signedOut: { ended: ["base00: a", "base00: b"], open: false },
      unmounted: { ended: ["base00: a"], open: false },
    });
  });
});
