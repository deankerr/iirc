// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, holds, registryFor, run } from "../testing/fake-daemon.ts";
import { App } from "./app.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

/**
 * Renders the Frontend into a fresh container, on a registry over the fake Daemon.
 * @param registry - The registry.
 * @returns The container.
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

  mounted.push(() => {
    root.unmount();
    container.remove();
  });

  return container;
};

/**
 * Everything React keeps for a container, from the root fiber on it: each fiber's
 * `alternate`, `memoizedProps`, and `memoizedState` are its own properties, so a walk from
 * here reaches what a past render kept as well as the current one.
 * @param container - The container.
 * @returns Where to start looking.
 */
const reactRoot = (container: HTMLElement) =>
  new Map(
    Object.keys(container)
      .filter((key) => key.startsWith("__react"))
      // oxlint-disable-next-line anti-slop/no-reflect-get, anti-slop/no-unknown-returns -- a walk over values of any shape, looking for a secret, reads properties it cannot name.
      .map((key): readonly [string, unknown] => [key, Reflect.get(container, key)])
  );

/**
 * What React DOM's value tracker on an input holds, the last value it saw, which no walk
 * reaches.
 * @param input - The input.
 * @returns The value it holds, or `undefined` when there is none.
 */
const tracked = (
  input: HTMLInputElement & {
    // React DOM's internal, not in the DOM's types, and absent from a React without it.
    readonly _valueTracker?: { readonly getValue: () => string } | null;
  }
) => input._valueTracker?.getValue() ?? undefined;

/**
 * Sets a field's value as a keystroke does, beneath React's own tracking, then says so.
 * @param field - The field.
 * @param value - The value.
 */
const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const prototype =
      field instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;

    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/**
 * Waits until the page shows an element.
 * @param container - The container.
 * @param selector - The element.
 * @returns It.
 */
const shown = async <E extends Element>(container: HTMLElement, selector: string) => {
  await eventually(() => container.querySelector(selector) !== null);

  const found = container.querySelector<E>(selector);

  if (found === null) {
    throw new Error(`never shown: ${selector}`);
  }

  return found;
};

/**
 * A browser signed in to a Daemon with one Network, and no Timeline open.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  const container = await render(registry);

  return { ...fake, container, registry };
};

describe("the shell", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("says how to start, in one paragraph, when no Timeline is open", async () => {
    const { container } = await signedIn();
    const main = await shown<HTMLElement>(container, "main");

    const paragraphs = [...main.querySelectorAll("p")].filter((one) =>
      one.textContent.startsWith("Choose a Timeline")
    );

    expect({
      nested: paragraphs.some((one) => one.querySelector("p") !== null),
      text: paragraphs.map((one) => one.textContent),
    }).toStrictEqual({
      nested: false,
      text: [
        "Choose a Timeline, or add a Network with /network add <id> <host>[/port] [plain] <nick>. /set opens the options.",
      ],
    });
  });

  it("asks for a Credential in a prompt, and keeps its value in no fiber, prop, state, tracker, or atom", async () => {
    const { container, daemon, registry } = await signedIn();
    const secret = "hunter2-held-by-the-vault";
    const composer = await shown<HTMLTextAreaElement>(container, "textarea");

    await typeInto(composer, "/set network.libera.password");
    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });

    const field = await shown<HTMLInputElement>(container, 'input[name="value"]');

    await typeInto(field, secret);
    const whileTyped = holds(reactRoot(container), secret);

    await act(async () => {
      field.form?.requestSubmit();
      await Promise.resolve();
    });
    await eventually(() => daemon.credentials.has("libera.password"));
    // Let the prompt close and React settle, so past renders are what it keeps.
    await act(async () => {
      await Promise.resolve();
    });

    expect({
      atoms: holds(registry, secret),
      field: field.value,
      held: daemon.credentials.get("libera.password"),
      react: holds(reactRoot(container), secret),
      tracker: tracked(field),
      whileTyped,
    }).toStrictEqual({
      atoms: false,
      field: "",
      held: secret,
      react: false,
      tracker: "",
      whileTyped: false,
    });
  });
});
