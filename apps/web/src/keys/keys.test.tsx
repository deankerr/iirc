// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { NetworkId, TimelineId } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { configurationShown } from "@iirc/frontend/options";
import { deviceUiKey } from "@iirc/frontend/ui";
import { Schema } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { edit, perform, restoreDraft } from "../composer/atoms.ts";
import { composerState } from "../composer/composer-state.ts";
import { editing, openOptions, optionsSync, optionsState } from "../options/atoms.ts";
import { readChoice } from "../page/device.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, holds, registryFor, run } from "../testing/fake-daemon.ts";
import { open, openTimeline, sync, timelinesState } from "../timelines/atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const idOf = (sequence: number) => `${sequence.toString(16).padStart(14, "0")}-00000000-00000000`;

const libera = Schema.decodeSync(NetworkId)("libera");
const own = idOf(1);
const channel = idOf(2);

const describeTimeline = (
  id: string,
  name: string,
  kind: "Network" | "Channel"
): typeof Timeline.Encoded => ({
  changed: 1,
  closed: false,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  life: 1,
  name,
  network: "libera",
  read: null,
  removed: false,
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

const slash = { ctrlKey: true, key: "P", shiftKey: true };
const go = { ctrlKey: true, key: "k" };

/**
 * Types text into the composer, as the browser does, the caret at its end.
 * @param container - The page.
 * @param text - The text.
 */
const typeIn = async (container: HTMLElement, text: string) => {
  const composer = composerOf(container);

  await act(async () => {
    Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      composer,
      text
    );
    composer.setSelectionRange(text.length, text.length);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/**
 * What the Composer's list holds, by each candidate's name, none while it is closed.
 * @returns The names.
 */
const listed = () =>
  [
    ...document.querySelectorAll('[role="listbox"][aria-label="Completions"] [role="option"] bdi'),
  ].map((one) => one.textContent);

const closed = () => document.querySelector('[role="listbox"][aria-label="Completions"]') === null;

describe("the keys", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
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

    const outside = await press(document.body, { code: "KeyI", key: "i" });
    const focused = document.activeElement === composer;
    const caret = [composer.selectionStart, composer.selectionEnd];
    const inside = await press(composer, { code: "KeyI", key: "i" });

    expect({ caret, focused, inside, outside }).toStrictEqual({
      caret: [14, 14],
      focused: true,
      inside: false,
      outside: false,
    });
  });

  it("gives a key that types to the composer from the sidebar's tree, before its typeahead can move to a row", async () => {
    const { container } = await signedIn();
    const composer = composerOf(container);
    const rows = [...container.querySelectorAll<HTMLElement>('nav [role="row"]')];

    const first = rows.find(
      (row) => row.textContent?.includes("libera") && !row.hasAttribute("aria-disabled")
    );

    await act(async () => {
      first?.focus();
      await Promise.resolve();
    });
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

  it("leaves a key typed into a field inside a shadow root to that field, not the composer", async () => {
    const { container } = await signedIn();
    const composer = composerOf(container);
    const host = document.createElement("div");
    const field = document.createElement("input");

    host.attachShadow({ mode: "open" }).append(field);
    document.body.append(host);

    // A browser retargets a key from a shadow root to its host at the document, and says
    // where it really was only in its path, which happy-dom's events do not do alone.
    await act(async () => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyI",
        composed: true,
        key: "i",
      });

      event.composedPath = () => [field, host, document.body, document.documentElement, document];
      host.dispatchEvent(event);
      await Promise.resolve();
    });
    host.remove();

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

  it("starts /go in the Composer on Mod+K from an option's editor, committing nothing", async () => {
    const { container, daemon, registry } = await signedIn();
    const name = "network.libera.nicks";

    await act(async () => {
      await run(registry, openOptions, "*nicks");
    });
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

    await settled(() => composerOf(container).value === "/go ");

    expect({
      editing: container.querySelector(`input[aria-label="Value of ${name}"]`) === editor,
      puts: daemon.puts.length,
      taken,
      value: editor.value,
    }).toStrictEqual({ editing: true, puts: 0, taken: true, value: "changed,not,sent" });
  });

  describe("starting a command", () => {
    const enter = { code: "Enter", key: "Enter" };

    it("starts / on Mod+Shift+P and /go on Mod+K from the page body with no Timeline open, the list open and the Composer focused", async () => {
      const { container } = await signedIn();
      const composer = composerOf(container);

      const first = await press(document.body, slash);
      await settled(() => composer.value === "/");

      const withSlash = {
        focused: document.activeElement === composer,
        listsSet: listed().includes("/set"),
        value: composer.value,
      };

      const second = await press(document.body, go);
      await settled(() => composer.value === "/go ");

      expect({
        first,
        go: { focused: document.activeElement === composer, list: listed(), value: composer.value },
        second,
        slash: withSlash,
      }).toStrictEqual({
        first: true,
        go: { focused: true, list: ["libera", "#iirc"], value: "/go " },
        second: true,
        slash: { focused: true, listsSet: true, value: "/" },
      });
    });

    it("sets a draft aside, which comes back when the command runs, sending nothing and recalling nothing of it", async () => {
      const { container, daemon, registry } = await signedIn();

      await typeIn(container, "hello");
      await press(document.body, go);
      await settled(() => composerOf(container).value === "/go ");
      await typeIn(container, "/go #iirc");
      await press(composerOf(container), enter);
      await settled(() => openedName(registry) === "#iirc");

      const nowhere = draftOf(registry.get(composerState), "Nowhere");

      expect({
        aside: nowhere.aside,
        history: nowhere.history,
        said: daemon.says,
        text: nowhere.text,
      }).toStrictEqual({ aside: undefined, history: ["/go #iirc"], said: [], text: "hello" });
    });

    it("brings the draft back in the Composer it was set aside from, and Escape does it in one press, closing the list", async () => {
      const { container, daemon, registry } = await signedIn();
      const composer = composerOf(container);

      await act(async () => {
        registry.set(open, Schema.decodeSync(TimelineId)(channel));
        await Promise.resolve();
      });

      await typeIn(container, "hello");
      await press(composer, go);
      await settled(() => composer.value === "/go ");
      const during = { list: listed(), value: composer.value };

      await press(composer, { code: "Escape", key: "Escape" });
      await settled(() => composer.value === "hello");

      await press(composer, go);
      await settled(() => composer.value === "/go ");
      await typeIn(container, "/go libera");
      await press(composer, enter);
      await settled(() => openedName(registry) === "libera");
      await press(document.body, { altKey: true, key: "ArrowDown" });
      await settled(() => openedName(registry) === "#iirc");

      expect({
        back: composer.value,
        closed: closed(),
        during,
        said: daemon.says,
      }).toStrictEqual({
        back: "hello",
        closed: true,
        during: { list: ["libera", "#iirc"], value: "/go " },
        said: [],
      });
    });

    it("starts a command over one already started, taking the key as it does with the list open, and Escape then clears it", async () => {
      const { container } = await signedIn();
      const composer = composerOf(container);

      await press(document.body, slash);
      await settled(() => composer.value === "/");
      await press(composer, go);
      await settled(() => composer.value === "/go ");
      await press(composer, { code: "Escape", key: "Escape" });
      await settled(() => composer.value === "");

      expect({ closed: closed(), value: composer.value }).toStrictEqual({
        closed: true,
        value: "",
      });
    });

    it("leaves /theme in the Composer with the themes listed when it is sent alone", async () => {
      const { container } = await signedIn();
      const composer = composerOf(container);

      await typeIn(container, "/theme");
      await press(composer, enter);
      await settled(() => composer.value === "/theme ");

      expect({ themes: listed().includes("nord"), value: composer.value }).toStrictEqual({
        themes: true,
        value: "/theme ",
      });
    });

    it("leaves nothing of what was typed over a command in what the composer last took once it is put away", async () => {
      const { registry } = await signedIn();
      const secret = "hunter2-correct-horse";

      registry.set(edit, { text: "keep this", timeline: "Nowhere" });
      registry.set(perform, [{ _tag: "StartCommand", text: "/" }]);
      registry.set(edit, { text: `/set network.libera.password ${secret}`, timeline: "Nowhere" });
      registry.set(restoreDraft, "Nowhere");

      expect({
        held: holds(registry, secret),
        text: draftOf(registry.get(composerState), "Nowhere").text,
      }).toStrictEqual({ held: false, text: "keep this" });
    });

    it("reads the options again once a command is started, so what it lists of them is as configured now", async () => {
      const { registry } = await signedIn();
      const configured = () => configurationShown(registry.get(optionsState), libera) !== undefined;
      const before = configured();

      await press(document.body, slash);
      await settled(configured);

      expect({ after: configured(), before }).toStrictEqual({ after: true, before: false });
    });
  });

  it("edits the text's size in a number field within its bounds, set for every device on Enter", async () => {
    const { container, daemon, registry } = await signedIn();
    const name = "ui.size";
    const selector = `input[aria-label="Value of ${name}"]`;

    await act(async () => {
      await run(registry, openOptions, "ui.size");
    });
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

  it("edits a font's family in place for this device alone, though it overrides nothing, and leaves every device's font", async () => {
    const { container, daemon, registry } = await signedIn();
    const name = "ui.font";
    const selector = `input[aria-label="Value of ${name}"]`;

    await act(async () => {
      await run(registry, openOptions, "ui.font");
    });
    await act(async () => {
      registry.set(editing, name);
      await Promise.resolve();
    });
    await settled(() => document.querySelector('[role="menu"]') !== null);

    // A family of the device's own is text, which "Custom…", last in the menu, opens.
    const custom = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].at(-1);

    if (custom === undefined) {
      throw new Error("no Custom…");
    }

    await act(async () => {
      custom.focus();
      await Promise.resolve();
    });
    await press(custom, { key: "Enter" });
    await settled(() => container.querySelector(selector) !== null);

    const editor = container.querySelector<HTMLInputElement>(selector);

    if (editor === null) {
      throw new Error("no editor");
    }

    await act(async () => {
      editor.focus();
      editor.value = "Fira Code";
      await Promise.resolve();
    });

    await press(editor, { key: "Enter" });
    await settled(() => readChoice(deviceUiKey) !== undefined);

    expect({ kept: readChoice(deviceUiKey), shared: daemon.ui.options.font }).toStrictEqual({
      kept: '{"font":"Fira Code"}',
      shared: "system",
    });
  });
});
