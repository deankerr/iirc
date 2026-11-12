// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import type { Timeline } from "@iirc/api";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { editing, openOptions, optionsSync } from "../options/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { openTimeline, sync, timelinesState } from "../timelines/atoms.ts";
import { paletteState } from "./state.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const idOf = (sequence: number) => `${sequence.toString(16).padStart(14, "0")}-00000000-00000000`;

const own = idOf(1);
const channel = idOf(2);

const describeTimeline = (
  id: string,
  name: string,
  kind: "Network" | "Channel"
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

/**
 * Waits until something holds, letting React render what changed meanwhile.
 * @param holds - What must hold.
 */
const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * The Frontend signed in to a Daemon with one Network, its own Timeline and `#iirc`, both
 * read, with no Timeline open.
 * @returns The registry, and the page.
 */
const signedIn = async () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.through = 1;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(own, "libera", "Network") },
    { gaps: [], items: [], timeline: describeTimeline(channel, "#iirc", "Channel") },
  ]);

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(optionsSync);

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

  await settled(
    () =>
      [...registry.get(timelinesState).networks.values()].some(
        (network) => network.timelines.size === 2
      ) && fake.daemon.followers.length === 1
  );

  return { container, daemon: fake.daemon, registry };
};

/**
 * Presses a key where focus is, or on an element, as the browser dispatches it.
 * @param target - Where it is pressed.
 * @param init - The key and the modifiers held.
 * @returns Whether anything prevented its default.
 */
const press = async (target: EventTarget, init: KeyboardEventInit) => {
  let prevented = false;

  await act(async () => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

    target.dispatchEvent(event);
    prevented = event.defaultPrevented;
    await Promise.resolve();
  });

  return prevented;
};

/**
 * Types into a field as typing forward does: `beforeinput` saying it inserts text, the
 * value set beneath React's own tracking, then `input`.
 * @param field - The field.
 * @param value - Its value after.
 */
const typeInto = async (field: HTMLInputElement, value: string) => {
  await act(async () => {
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, data: value, inputType: "insertText" })
    );
    Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" })
    );
    await Promise.resolve();
  });
};

/**
 * The palette's search field, once it shows, with focus in it. In a browser it takes focus
 * as it opens, which the end-to-end run shows. happy-dom's documents fail React Aria's
 * `instanceof Document` check, so its Dialog takes focus back from the field, and the test
 * puts it there again.
 * @returns The field.
 */
const searchField = async () => {
  await settled(() => document.querySelector('[role="dialog"] input') !== null);
  const search = document.querySelector<HTMLInputElement>('[role="dialog"] input');

  if (search === null) {
    throw new Error("no search field");
  }

  await act(async () => {
    search.focus();
    await Promise.resolve();
  });

  return search;
};

const composerOf = (container: HTMLElement) => {
  const found = container.querySelector("textarea");

  if (found === null) {
    throw new Error("no composer");
  }

  return found;
};

const openedName = (registry: AtomRegistry.AtomRegistry) => {
  const shown = registry.get(openTimeline);

  return shown._tag === "Shown" ? shown.description?.name : shown._tag;
};

/**
 * The palette's status: an `output`, whose role is `status`.
 * @returns It, or none.
 */
const statusRegion = () => document.querySelector('[role="dialog"] output');

/**
 * The rows the palette lists, by their names, as the Owner reads them.
 * @returns Their names, in order.
 */
const rows = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map(
    (row) => row.querySelector('[slot="label"]')?.textContent ?? ""
  );

describe("the palette and the keys", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("opens on Mod+K from the composer, filters as typed, opens a Timeline on Enter, and gives focus back", async () => {
    const { container, registry } = await signedIn();
    const composer = composerOf(container);

    await act(async () => {
      composer.focus();
      await Promise.resolve();
    });

    const opened = await press(composer, { ctrlKey: true, key: "k" });
    const search = await searchField();
    const everything = rows();

    await typeInto(search, "iirc");
    const filtered = rows();

    await press(search, { key: "Enter" });
    await settled(() => openedName(registry) === "#iirc");
    await settled(() => document.activeElement === composer);

    expect({
      closed: document.querySelector('[role="dialog"]'),
      everything: everything.includes("#iirc") && everything.includes("/next"),
      filtered: filtered[0],
      focused: document.activeElement === composer,
      opened,
      recent: registry.get(paletteState).recent,
    }).toStrictEqual({
      closed: null,
      everything: true,
      filtered: "#iirc",
      focused: true,
      opened: true,
      recent: [`timeline:${channel}`],
    });
  });

  it("closes on Escape, choosing nothing, and gives focus back", async () => {
    const { container } = await signedIn();
    const composer = composerOf(container);

    await act(async () => {
      composer.focus();
      await Promise.resolve();
    });
    await press(composer, { ctrlKey: true, key: "k" });
    const search = await searchField();

    await press(search, { key: "Escape" });
    await settled(() => document.querySelector('[role="dialog"]') === null);
    await settled(() => document.activeElement === composer);

    expect(document.activeElement).toBe(composer);
  });

  it("moves to the next and previous Timeline in the sidebar's order with Alt+arrows", async () => {
    const { registry } = await signedIn();
    const names: (string | undefined)[] = [];

    for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp"]) {
      // oxlint-disable-next-line no-await-in-loop -- pressed in order
      await press(document.body, { altKey: true, key });
      // oxlint-disable-next-line no-await-in-loop -- each read before the next
      await settled(() => registry.get(openTimeline)._tag === "Shown");
      names.push(openedName(registry));
    }

    expect(names).toStrictEqual(["libera", "#iirc", "libera", "#iirc"]);
  });

  it("gives a key that types to the composer, with the caret at the end of its draft, and swallows nothing", async () => {
    const { container, registry } = await signedIn();
    const composer = composerOf(container);

    await act(async () => {
      Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        composer,
        "half a thought"
      );
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    const outside = await press(document.body, { code: "KeyI", key: "i" });
    const focused = document.activeElement === composer;
    const caret = [composer.selectionStart, composer.selectionEnd];
    const inside = await press(composer, { code: "KeyI", key: "i" });

    expect({
      caret,
      focused,
      inside,
      outside,
      palette: registry.get(paletteState).open,
    }).toStrictEqual({
      caret: [14, 14],
      focused: true,
      inside: false,
      outside: false,
      palette: false,
    });
  });

  it("gives a key that types to the composer from the sidebar's tree, before its typeahead can move to a row", async () => {
    const { container } = await signedIn();
    const composer = composerOf(container);
    const rows = [...container.querySelectorAll<HTMLElement>('nav [role="row"]')];

    const first = rows.find(
      (row) => row.textContent?.includes("libera") && !row.hasAttribute("aria-disabled")
    );

    first?.focus();
    const before = document.activeElement === first;

    await press(document.activeElement ?? document.body, { code: "KeyI", key: "#" });

    expect({
      before,
      composer: document.activeElement === composer,
      row: first !== undefined,
    }).toStrictEqual({
      before: true,
      composer: true,
      row: true,
    });
  });

  it("does not give Space, Enter, or a key with Ctrl held to the composer", async () => {
    const { container } = await signedIn();
    const composer = composerOf(container);
    const button = container.querySelector<HTMLButtonElement>("button");

    button?.focus();

    for (const init of [
      { code: "Space", key: " " },
      { code: "Enter", key: "Enter" },
      { code: "KeyA", ctrlKey: true, key: "a" },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- pressed in order
      await press(button ?? document.body, init);
    }

    expect(document.activeElement).not.toBe(composer);
  });

  it("says what a command could not read, lets go of it when the text is edited, and dismisses any notice with a button", async () => {
    const { container } = await signedIn();
    const composer = composerOf(container);

    /**
     * Sets the composer's text as typing does.
     * @param value - The text.
     */
    const write = async (value: string) => {
      await act(async () => {
        Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          composer,
          value
        );
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
    };

    const said = () => container.querySelector('[role="alert"] p')?.textContent;

    const dismiss = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');

    await write("/d");
    await press(composer, { code: "Enter", key: "Enter" });
    await settled(() => said() !== undefined);
    const first = said();

    await write("/de");
    const edited = said();

    await press(composer, { code: "Enter", key: "Enter" });
    await settled(() => said() !== undefined);

    await act(async () => {
      dismiss()?.click();
      await Promise.resolve();
    });

    expect({
      dismissed: said(),
      edited,
      first,
      text: composer.value,
    }).toStrictEqual({
      dismissed: undefined,
      edited: undefined,
      first: "There is no command /d. Start with // to say text that begins with /.",
      text: "/de",
    });
  });

  it("starts a command that needs arguments in the composer, focused", async () => {
    const { container } = await signedIn();
    const composer = composerOf(container);

    await press(document.body, { ctrlKey: true, key: "k" });
    const search = await searchField();

    await typeInto(search, "network");
    await press(search, { key: "Enter" });
    await settled(() => document.activeElement === composer);

    expect(composer.value).toBe("/network ");
  });

  it("keeps a draft with text in it, focuses it, and says what was not put in", async () => {
    const { container } = await signedIn();
    const composer = composerOf(container);

    await act(async () => {
      Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        composer,
        "half a thought"
      );
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    await press(composer, { ctrlKey: true, key: "k" });
    const search = await searchField();

    await typeInto(search, "network");
    await press(search, { key: "Enter" });
    await settled(() => document.activeElement === composer);

    expect({
      notice: container.querySelector('[role="alert"] p')?.textContent,
      text: composer.value,
    }).toStrictEqual({
      notice: "/network was not put in, since the composer has text. Clear it and choose again.",
      text: "half a thought",
    });
  });

  it("announces how many results there are, from the moment it opens", async () => {
    await signedIn();

    await press(document.body, { ctrlKey: true, key: "k" });
    const search = await searchField();

    const opened = {
      live: statusRegion()?.getAttribute("aria-live"),
      text: statusRegion()?.textContent,
    };

    const listed = rows().length;

    await typeInto(search, "zzzz");
    const none = statusRegion()?.textContent;

    await typeInto(search, "iirc");
    const some = { listed: rows().length, text: statusRegion()?.textContent };

    expect({ none, opened, some }).toStrictEqual({
      none: "No results",
      opened: { live: "polite", text: `${listed} results` },
      some: { listed: some.listed, text: `${some.listed} results` },
    });
    expect(some.listed).toBeGreaterThan(1);
  });

  it("opens the palette with Mod+K from an option's editor, committing nothing", async () => {
    const { container, daemon, registry } = await signedIn();
    const name = "network.libera.nicks";

    await run(registry, openOptions, "*nicks");
    await act(async () => {
      registry.set(editing, name);
      await Promise.resolve();
    });
    await settled(() => container.querySelector(`input[aria-label="Value of ${name}"]`) !== null);

    const editor = container.querySelector<HTMLInputElement>(
      `input[aria-label="Value of ${name}"]`
    );

    if (editor === null) {
      throw new Error("no editor");
    }

    await act(async () => {
      editor.focus();
      editor.value = "changed,not,sent";
      await Promise.resolve();
    });

    const taken = await press(editor, { ctrlKey: true, key: "k" });
    const search = await searchField();

    await press(search, { key: "Escape" });
    await settled(() => document.querySelector('[role="dialog"]') === null);

    expect({
      editing: container.querySelector(`input[aria-label="Value of ${name}"]`) === editor,
      puts: daemon.puts.length,
      taken,
      value: editor.value,
    }).toStrictEqual({ editing: true, puts: 0, taken: true, value: "changed,not,sent" });
  });

  it("edits the text's size in a number field within its bounds, set for every device on Enter", async () => {
    const { container, daemon, registry } = await signedIn();
    const name = "ui.size";
    const selector = `input[aria-label="Value of ${name}"]`;

    await run(registry, openOptions, "ui.size");
    await act(async () => {
      registry.set(editing, name);
      await Promise.resolve();
    });
    await settled(() => container.querySelector(selector) !== null);

    const editor = container.querySelector<HTMLInputElement>(selector);

    if (editor === null) {
      throw new Error("no editor");
    }

    const field = [editor.type, editor.min, editor.max, editor.step, editor.value];

    await act(async () => {
      editor.focus();
      editor.value = "17";
      await Promise.resolve();
    });

    await press(editor, { key: "Enter" });
    await settled(() => daemon.ui.options.size === 17);

    expect(field).toStrictEqual(["number", "10", "24", "1", "14"]);
  });
});
