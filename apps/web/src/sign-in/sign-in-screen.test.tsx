// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { Effect } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { fakeDaemon, holds, registryFor, run, theKey } from "../testing/fake-daemon.ts";
import { check, signInState, signInWithKey } from "./atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const wrongKey = "iirc_not-the-key-but-close";

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
 * React's own state and props for everything rendered into a container: the root fiber
 * React keeps on it, under a key of its own.
 * @param container - The container.
 * @returns Where to start looking, the container's React keys alone.
 */
const reactRoot = (container: HTMLElement) =>
  new Map(
    Object.keys(container)
      .filter((key) => key.startsWith("__react"))
      // oxlint-disable-next-line anti-slop/no-reflect-get, anti-slop/no-unknown-returns -- a walk over values of any shape, looking for a secret, reads properties it cannot name.
      .map((key): readonly [string, unknown] => [key, Reflect.get(container, key)])
  );

/**
 * What React DOM's value tracker on an input holds: the last value it saw typed, which it
 * keeps even on an uncontrolled input, in a closure no walk can reach. It is React's
 * internal, so it is read loosely, and only here.
 * @param input - The input.
 * @returns The value it holds, or `undefined` when there is no tracker.
 */
const tracked = (
  input: HTMLInputElement & {
    // React DOM's internal, not in the DOM's types, and absent from a React without it.
    readonly _valueTracker?: { readonly getValue: () => string } | null;
  }
) => input._valueTracker?.getValue() ?? undefined;

/**
 * Types a key into the field, as the Owner would, and submits the form.
 * @param container - The container.
 * @param key - The key.
 * @returns The field, whether React's state held the key while typed, and what React DOM's
 * tracker held then, which shows the tracker is there to be read.
 */
const submitKey = async (container: HTMLElement, key: string) => {
  const input = container.querySelector<HTMLInputElement>('input[name="key"]');
  const form = input?.form;

  if (input === null || input === undefined || form === null || form === undefined) {
    throw new Error("no key field in a form");
  }

  // As a keystroke does: the value changes beneath React's own tracking of it, then an
  // `input` event says so, which a controlled field would copy into its state.
  await act(async () => {
    Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, key);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });

  const typed = holds(reactRoot(container), key);
  const trackedWhileTyped = tracked(input);

  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });

  return { input, trackedWhileTyped, typed };
};

describe("the sign-in screen", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("keeps no key in React state, in an atom, or in the field after a failed sign-in", async () => {
    const { fetch } = fakeDaemon();
    const registry = registryFor(fetch);

    await run(registry, check, undefined);
    const container = await render(registry);
    const { input, trackedWhileTyped, typed } = await submitKey(container, wrongKey);

    await act(async () => {
      await Effect.runPromise(
        AtomRegistry.getResult(registry, signInWithKey, { suspendOnWaiting: true }).pipe(
          Effect.ignore
        )
      );
    });

    const alert = container.querySelector('[role="alert"]');

    expect({
      describedBy: input.getAttribute("aria-describedby") === alert?.id,
      field: input.value,
      inAtoms: holds(registry, wrongKey),
      inReact: holds(reactRoot(container), wrongKey),
      label: container.querySelector(`label[for="${input.id}"]`)?.textContent,
      state: registry.get(signInState),
      tracker: [trackedWhileTyped, tracked(input)],
      typed,
    }).toStrictEqual({
      describedBy: true,
      field: "",
      inAtoms: false,
      inReact: false,
      label: "Key",
      state: { _tag: "SignedOut", signIn: { _tag: "Failed", failure: "WrongKey" } },
      tracker: [wrongKey, ""],
      typed: false,
    });
  });

  it("signs in with the key, and keeps it nowhere after", async () => {
    const { fetch } = fakeDaemon();
    const registry = registryFor(fetch);

    await run(registry, check, undefined);
    const container = await render(registry);
    const { input, trackedWhileTyped } = await submitKey(container, theKey);

    await act(async () => {
      await Effect.runPromise(
        AtomRegistry.getResult(registry, signInWithKey, { suspendOnWaiting: true }).pipe(
          Effect.ignore
        )
      );
    });

    expect({
      field: input.value,
      inAtoms: holds(registry, theKey),
      inReact: holds(reactRoot(container), theKey),
      state: registry.get(signInState)._tag,
      tracker: [trackedWhileTyped, tracked(input)],
    }).toStrictEqual({
      field: "",
      inAtoms: false,
      inReact: false,
      state: "SignedIn",
      tracker: [theKey, ""],
    });
  });
});
