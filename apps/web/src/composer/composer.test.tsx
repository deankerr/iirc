// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId } from "@iirc/api";
import type { Member, Timeline } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import type { DeviceUi } from "@iirc/frontend/ui";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { channelSync } from "../channel/atoms.ts";
import { deviceUi } from "../options/device.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, holds, registryFor, run } from "../testing/fake-daemon.ts";
import { drawnTheme, watchTheme } from "../theme/atoms.ts";
import { open, sync } from "../timelines/atoms.ts";
import { placeOf } from "./atoms.ts";
import { completer, emojiLoader } from "./completion.ts";
import { composerState } from "./composer-state.ts";
import { emojiState } from "./sources.ts";

import inlineStyles from "../timelines/inlines.module.css";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel",
  network = "libera"
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
  network,
  read: null,
  removed: false,
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

const member = (nick: string): typeof Member.Encoded => ({
  account: { _tag: "Unknown" },
  away: { _tag: "Known", at: 1, from: "ircd", value: null },
  nick,
  prefixes: { _tag: "Known", at: 1, from: "ircd", value: [] },
});

const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * A browser signed in to a Daemon with `#iirc` open, its members `op` and `peer`, the page
 * drawn, and this device's `ui` options overridden as given.
 * @param overrides - This device's overrides of the options under `ui`.
 * @param prepare - What else the fake Daemon is to be before the browser signs in.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async (
  overrides: DeviceUi = {},
  prepare: (daemon: ReturnType<typeof fakeDaemon>["daemon"]) => void = () => {}
) => {
  const fake = fakeDaemon();

  prepare(fake.daemon);

  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    { gaps: [], items: [], timeline: listed(iirc, "#iirc", "Channel") },
  ]);
  fake.daemon.channels.set(iirc, {
    header: {
      chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
      chantypes: "#&",
      held: null,
      lists: { bans: "b", exceptions: "e", invitations: "I" },
      members: 2,
      modes: { _tag: "Known", at: 1, from: "ircd", value: [] },
      name: "#iirc",
      network: "libera",
      ranks: [
        { mode: "o", symbol: "@" },
        { mode: "v", symbol: "+" },
      ],
      standing: "Joined",
      timeline: iirc,
      topic: { _tag: "Known", at: 1, from: "ircd", value: null },
    },
    members: [member("op"), member("peer")],
  });

  const registry = registryFor(fake.fetch);

  registry.set(deviceUi, overrides);
  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(channelSync);
  registry.mount(completer);

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

  await settled(() => fake.daemon.followers.length === 1);

  await act(async () => {
    registry.set(open, Schema.decodeSync(TimelineId)(iirc));
    await Promise.resolve();
  });
  await settled(() => container.querySelector('[role="log"]') !== null);

  return { ...fake, container, registry };
};

const composerOf = (container: HTMLElement) => {
  const composer = container.querySelector("textarea");

  if (composer === null) {
    throw new Error("no composer");
  }

  return composer;
};

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
 * Presses a key in the composer, as the browser dispatches it.
 * @param container - The page.
 * @param key - The key.
 * @param held - The modifiers held.
 * @returns Whether the key was left to the browser.
 */
const pressIn = async (container: HTMLElement, key: string, held: KeyboardEventInit = {}) => {
  let left = true;

  await act(async () => {
    left = composerOf(container).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: key, key, ...held })
    );
    await Promise.resolve();
  });

  return left;
};

/**
 * Moves the composer's caret without typing, as an arrow, Home, or a click does, and says
 * so as the browser does, with a `selectionchange` on the document.
 * @param container - The page.
 * @param caret - Where it goes.
 */
// Only the composer in focus has a caret the Owner can move.
const moveCaret = async (container: HTMLElement, caret: number) => {
  await act(async () => {
    composerOf(container).focus();
    composerOf(container).setSelectionRange(caret, caret);
    document.dispatchEvent(new Event("selectionchange"));
    await Promise.resolve();
  });
};

const sendButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');

/**
 * What React DOM's value tracker on the composer holds, the last value it saw, which no walk
 * reaches.
 * @param container - The page.
 * @returns The value it holds, or `undefined` when there is none.
 */
const trackedIn = (container: HTMLElement) => {
  const composer: HTMLTextAreaElement & {
    // React DOM's internal, not in the DOM's types, and absent from a React without it.
    readonly _valueTracker?: { readonly getValue: () => string } | null;
  } = composerOf(container);

  return composer._valueTracker?.getValue() ?? undefined;
};

/**
 * Does something to the page, and reads what the composer's textarea and React DOM's tracker
 * of it hold the instant it is done, before anything else has run.
 * @param container - The page.
 * @param act_ - What to do.
 * @returns What the textarea and its tracker held then.
 */
const atOnce = async (container: HTMLElement, act_: () => void) => {
  const seen = await act(async () => {
    act_();

    const held = { tracker: trackedIn(container), value: composerOf(container).value };

    await Promise.resolve();

    return held;
  });

  return seen;
};

/**
 * What the composer, its Timeline's draft, and the fake Daemon hold of a secret after a send
 * that was refused: nothing in the textarea or the tracker React DOM keeps of it, nothing in
 * the draft or the history of what was sent, and nothing the Daemon was asked.
 * @param shown - The page, the registry, and the fake, as `signedIn` returns them.
 * @param secret - The secret.
 * @returns What each holds.
 */
const leftOf = (
  {
    container,
    daemon,
    registry,
  }: Pick<Awaited<ReturnType<typeof signedIn>>, "container" | "daemon" | "registry">,
  secret: string
) => {
  const draft = draftOf(registry.get(composerState), Schema.decodeSync(TimelineId)(iirc));

  return {
    acts: daemon.acts,
    draft: draft.text,
    draftHolds: holds(draft, secret),
    history: draft.history,
    said: daemon.says,
    sentToDaemon: holds(daemon, secret),
    tracker: trackedIn(container),
    value: composerOf(container).value,
  };
};

describe("the Composer's habits", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("sends on Enter, as it always has, with no send button and spelling checked", async () => {
    const { container, daemon } = await signedIn();

    await typeIn(container, "hello");

    const left = await pressIn(container, "Enter");

    await settled(() => daemon.says.length === 1);

    expect({
      button: sendButton(container),
      left,
      said: daemon.says.map((one) => one.text),
      spellcheck: composerOf(container).getAttribute("spellcheck"),
    }).toStrictEqual({ button: null, left: false, said: ["hello"], spellcheck: "true" });
  });

  it("under ui.enter newline, leaves Enter to begin a line and sends on Ctrl+Enter", async () => {
    const { container, daemon } = await signedIn({ enter: "newline" });

    await typeIn(container, "one");

    const enter = await pressIn(container, "Enter");
    const shiftEnter = await pressIn(container, "Enter", { shiftKey: true });
    const kept = composerOf(container).value;
    const ctrlEnter = await pressIn(container, "Enter", { ctrlKey: true });

    await settled(() => daemon.says.length === 1);

    expect({
      ctrlEnter,
      enter,
      kept,
      said: daemon.says.map((one) => one.text),
      shiftEnter,
    }).toStrictEqual({
      ctrlEnter: false,
      enter: true,
      kept: "one",
      said: ["one"],
      shiftEnter: true,
    });
  });

  it("draws a send button only under ui.enter newline, which sends as Ctrl+Enter does", async () => {
    const { container, daemon, registry } = await signedIn({ enter: "newline" });
    const button = sendButton(container);

    await typeIn(container, "from a phone");
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    await settled(() => daemon.says.length === 1);

    await act(async () => {
      registry.set(deviceUi, { enter: "send" });
      await Promise.resolve();
    });

    expect({
      after: sendButton(container),
      composer: composerOf(container).value,
      said: daemon.says.map((one) => one.text),
    }).toStrictEqual({ after: null, composer: "", said: ["from a phone"] });
  });

  it("names the chord that sends in a paste's confirmation, which that chord or the button confirms", async () => {
    const { container, daemon, registry } = await signedIn({ enter: "newline" });
    const lines = ["1", "2", "3", "4", "5", "6"];

    await typeIn(container, lines.join("\n"));
    await pressIn(container, "Enter", { ctrlKey: true });

    const alert = () => container.querySelector('[role="alert"]')?.textContent ?? "";

    await settled(() => alert().includes("Send 6 lines"));

    const newline = alert();

    await act(async () => {
      registry.set(deviceUi, { enter: "send" });
      await Promise.resolve();
    });

    const send = alert();
    const plainEnter = await pressIn(container, "Enter");

    await settled(() => daemon.says.length === lines.length);

    expect({
      newline: newline.includes("Ctrl+Enter sends them, Escape keeps them here."),
      plainEnter,
      said: daemon.says.map((one) => one.text),
      send: send.includes("? Enter sends them, Escape keeps them here."),
    }).toStrictEqual({ newline: true, plainEnter: false, said: lines, send: true });
  });

  it("under ui.enter newline, lets go of a Credential in any line at once on Ctrl+Enter, and sends nothing", async () => {
    const shown = await signedIn({ enter: "newline" });
    const secret = "hunter2-held-by-the-vault";
    const typed = `hello\n/set network.libera.password ${secret}`;

    await typeIn(shown.container, typed);
    const whileTyped = trackedIn(shown.container);

    const first = await atOnce(shown.container, () => {
      composerOf(shown.container).dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Enter",
          ctrlKey: true,
          key: "Enter",
        })
      );
    });

    expect({ ...leftOf(shown, secret), first, whileTyped }).toStrictEqual({
      acts: [],
      draft: "",
      draftHolds: false,
      first: { tracker: "", value: "" },
      history: [],
      said: [],
      sentToDaemon: false,
      tracker: "",
      value: "",
      whileTyped: typed,
    });
  });

  it("under ui.enter newline, lets go of a Credential in any line at once on the send button, and sends nothing", async () => {
    const shown = await signedIn({ enter: "newline" });
    const secret = "hunter2-held-by-the-vault";

    await typeIn(shown.container, `/set network.libera.password ${secret}\nhello`);

    const first = await atOnce(shown.container, () => {
      sendButton(shown.container)?.click();
    });

    expect({ ...leftOf(shown, secret), first }).toStrictEqual({
      acts: [],
      draft: "",
      draftHolds: false,
      first: { tracker: "", value: "" },
      history: [],
      said: [],
      sentToDaemon: false,
      tracker: "",
      value: "",
    });
  });

  it("checks spelling only as ui.spellcheck says", async () => {
    const { container, registry } = await signedIn({ spellcheck: false });
    const off = composerOf(container).getAttribute("spellcheck");

    await act(async () => {
      registry.set(deviceUi, { spellcheck: true });
      await Promise.resolve();
    });

    expect([off, composerOf(container).getAttribute("spellcheck")]).toStrictEqual([
      "false",
      "true",
    ]);
  });

  it("puts ui.suffix after a nick completed at the start of a line", async () => {
    const { container } = await signedIn({ suffix: ", " });

    await typeIn(container, "pe");
    await pressIn(container, "Tab");
    await settled(() => composerOf(container).value === "peer, ");

    expect(composerOf(container).value).toBe("peer, ");
  });
});

/**
 * The list above the composer, as a screen reader is given it: its options' names, usage,
 * and description, which is highlighted, and what the textarea says of it.
 * @param container - The page.
 * @returns What it lists, or none while it is closed.
 */
const listIn = (container: HTMLElement) => {
  const listbox = container.querySelector('[role="listbox"][aria-label="Completions"]');
  const composer = composerOf(container);

  if (listbox === null) {
    return { controls: composer.getAttribute("aria-controls"), list: undefined };
  }

  const options = [...listbox.querySelectorAll('[role="option"]')];
  const highlighted = options.findIndex((one) => one.getAttribute("aria-selected") === "true");

  return {
    active:
      highlighted === -1
        ? composer.getAttribute("aria-activedescendant") === null
        : composer.getAttribute("aria-activedescendant") === options[highlighted]?.id,
    controls: composer.getAttribute("aria-controls") === listbox.id,
    highlighted,
    names: options.map((one) => one.querySelector("bdi")?.textContent ?? ""),
    texts: options.map((one) => one.textContent),
  };
};

/**
 * The note above the composer that its Network is not connected, if drawn.
 * @param container - The page.
 * @returns The note's text, or `undefined` while none is drawn.
 */
const offlineNoteIn = (container: HTMLElement) =>
  [...container.querySelectorAll("p")]
    .map((note) => note.textContent)
    .find((text) => text.includes("is not connected")) ?? undefined;

describe("the Composer's note on its Network's connection", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("says nothing while the connection is not known yet, though the window is read", async () => {
    const { container, daemon } = await signedIn({}, (held) => {
      held.holdKnown = true;
    });

    expect({
      note: offlineNoteIn(container),
      waiting: daemon.held.known.length > 0,
    }).toStrictEqual({ note: undefined, waiting: true });
  });

  it("says the Network is not connected once it is read to be so", async () => {
    const { container } = await signedIn({}, (held) => {
      held.sessions.set("libera", { _tag: "Offline", since: null });
    });

    await settled(() => offlineNoteIn(container) !== undefined);

    expect(offlineNoteIn(container)).toBe(
      "libera is not connected: nothing can be said there until it is."
    );
  });
});

describe("the Composer's list", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("opens as a draft starts with /, each command with its usage and description, and narrows as keys are typed", async () => {
    const { container } = await signedIn();
    const closed = listIn(container);

    await typeIn(container, "/");
    const all = listIn(container);

    await typeIn(container, "/jo");
    const narrowed = listIn(container);

    await typeIn(container, "/join #ii");
    const channels = listIn(container);

    expect({
      all: [all.names?.includes("/join"), all.names?.includes("/set"), all.highlighted],
      channels: channels.names,
      closed,
      hidden: container.querySelector("[aria-hidden] bdi"),
      // Its name, what it takes, and what it does.
      joinText: /^\/join<#channel>.*Join/su.test(narrowed.texts?.[0] ?? ""),
      narrowed: { ...narrowed, texts: undefined },
    }).toStrictEqual({
      all: [true, true, -1],
      channels: ["#iirc"],
      closed: { controls: null, list: undefined },
      hidden: null,
      joinText: true,
      narrowed: {
        active: true,
        controls: true,
        highlighted: -1,
        // `/invexes` is found by its description, which says "join".
        names: ["/join", "/invexes"],
        texts: undefined,
      },
    });
  });

  it("moves with Tab and the arrows, writing the one highlighted into the draft, and Escape gives back what was typed", async () => {
    const { container } = await signedIn();

    await typeIn(container, "/m");
    const names = listIn(container).names ?? [];
    const down = await pressIn(container, "ArrowDown");
    const { texts: _texts, ...seen } = listIn(container);
    const first = [composerOf(container).value, seen];

    await pressIn(container, "Tab");
    const second = [composerOf(container).value, listIn(container).highlighted];

    await pressIn(container, "ArrowUp");
    await pressIn(container, "ArrowUp");
    const wrapped = [composerOf(container).value, listIn(container).highlighted];

    const escape = await pressIn(container, "Escape");

    expect({
      down,
      escape,
      escaped: [composerOf(container).value, listIn(container).list],
      first,
      second,
      wrapped,
    }).toStrictEqual({
      down: false,
      escape: false,
      escaped: ["/m", undefined],
      first: [`${names[0]} `, { active: true, controls: true, highlighted: 0, names }],
      second: [`${names[1]} `, 1],
      wrapped: [`${names.at(-1)} `, names.length - 1],
    });
  });

  it("sends on Enter what the draft says, never a candidate it does not show", async () => {
    const { container, daemon } = await signedIn();

    await typeIn(container, "/m");
    await pressIn(container, "Enter");
    await settled(() => container.querySelector('[role="alert"]') !== null);

    const refused = {
      list: listIn(container).list,
      said: daemon.says.length,
      value: composerOf(container).value,
    };

    await typeIn(container, "/me");
    await pressIn(container, "ArrowDown");
    const highlighted = composerOf(container).value;

    await typeIn(container, `${highlighted}waves`);
    await pressIn(container, "Enter");
    await settled(() => daemon.says.length === 1);

    expect({
      highlighted,
      refused,
      said: daemon.says.map((one) => [one.kind, one.text]),
    }).toStrictEqual({
      highlighted: "/me ",
      refused: { list: undefined, said: 0, value: "/m" },
      said: [["Action", "waves"]],
    });
  });

  it("opens on Tab for a nick, asked of the members, the first written in", async () => {
    const { container } = await signedIn();

    await typeIn(container, "hi pe");
    await pressIn(container, "Tab");
    await settled(() => composerOf(container).value === "hi peer ");

    expect(listIn(container)).toStrictEqual({
      active: true,
      controls: true,
      highlighted: 0,
      names: ["peer"],
      texts: ["peer"],
    });
  });

  it("lets go of the list when the caret moves, leaving Up to recall and Escape to what else is open", async () => {
    const { container, daemon } = await signedIn();

    await typeIn(container, "said before");
    await pressIn(container, "Enter");
    await settled(() => daemon.says.length === 1);

    await typeIn(container, "/jo");
    const open = listIn(container).names;

    await moveCaret(container, 1);
    const moved = listIn(container);
    const escape = await pressIn(container, "Escape");
    const escaped = composerOf(container).value;

    await pressIn(container, "ArrowUp");

    expect({
      escape,
      escaped,
      moved,
      open,
      recalled: composerOf(container).value,
    }).toStrictEqual({
      // Not completion's: it is the composer's own, with nothing to let go of.
      escape: false,
      escaped: "/jo",
      moved: { controls: null, list: undefined },
      open: ["/join", "/invexes"],
      recalled: "said before",
    });
  });

  it("writes in a candidate tapped, keeping the focus in the composer", async () => {
    const { container } = await signedIn();

    composerOf(container).focus();
    await typeIn(container, "/set ");

    const [, option] = container.querySelectorAll<HTMLElement>('[role="option"]');
    const name = option?.querySelector("bdi")?.textContent;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

    await act(async () => {
      option?.dispatchEvent(down);
      option?.click();
      await Promise.resolve();
    });

    expect({
      focused: document.activeElement === composerOf(container),
      kept: down.defaultPrevented,
      value: composerOf(container).value,
    }).toStrictEqual({ focused: true, kept: true, value: `/set ${name ?? ""} ` });
  });
});

const oftc = idOf(10);
const oftcHelp = idOf(11);
const old = idOf(12);

/**
 * Another live Network, `oftc`, with a Channel, and one, `old`, removed with its Timelines
 * kept, which the Daemon reads as kept.
 * @param daemon - The fake Daemon.
 */
const withOtherNetworks = (daemon: ReturnType<typeof fakeDaemon>["daemon"]) => {
  daemon.timelines.set("oftc", [
    { gaps: [], items: [], timeline: listed(oftc, "oftc", "Network", "oftc") },
    { gaps: [], items: [], timeline: listed(oftcHelp, "#help", "Channel", "oftc") },
  ]);
  daemon.timelines.set("old", [
    {
      gaps: [],
      items: [],
      timeline: { ...listed(old, "old", "Network", "old"), removed: true },
    },
  ]);
  daemon.kept.add("old");
};

/**
 * The text of each candidate in the list, one per option.
 * @param container - The page.
 * @returns The texts, none while the list is closed.
 */
const textsOf = (container: HTMLElement) => listIn(container).texts ?? [];

/**
 * The font the page draws its text in, as the root's custom property has it.
 * @returns The font stack.
 */
const font = () => document.documentElement.style.getPropertyValue("--font-text");

const alertdialog = () => document.querySelector('[role="alertdialog"]');

describe("the Composer's list of everything it can complete", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("lists the Timelines of both Networks after /go with their Network and kind, and picking one then Enter opens it in the focused Pane", async () => {
    const { container, registry } = await signedIn({}, withOtherNetworks);

    await typeIn(container, "/go ");
    const listedAll = textsOf(container);

    await typeIn(container, "/go hel");
    await pressIn(container, "ArrowDown");
    const picked = composerOf(container).value;

    await pressIn(container, "Enter");
    await settled(() => placeOf(registry) === oftcHelp);

    expect({ listedAll, opened: placeOf(registry), picked }).toStrictEqual({
      listedAll: [
        "liberaNetwork on libera",
        "#iircChannel on libera",
        "oftcNetwork on oftc",
        "#helpChannel on oftc",
        "oldNetwork on old",
      ],
      opened: oftcHelp,
      picked: "/go #help",
    });
  });

  it("lists the themes after /theme, draws the one highlighted, and gives the one in effect back on Escape, and when the draft is typed over", async () => {
    const { container, registry } = await signedIn();
    const stop = await act(() => watchTheme(registry));

    mounted.push(stop);

    const background = () => registry.get(drawnTheme).tokens.background;
    const inEffect = background();

    await typeIn(container, "/theme ");
    const names = listIn(container).names ?? [];
    const row = textsOf(container);

    await typeIn(container, "/theme nord");
    await pressIn(container, "ArrowDown");
    const first = composerOf(container).value;
    const drawn = background();

    await pressIn(container, "Escape");
    const escaped = background();

    await typeIn(container, "/theme drac");
    await pressIn(container, "ArrowDown");
    const second = background();

    await typeIn(container, "hello");
    const typedOver = background();

    expect({
      differs: [drawn !== inEffect, second !== drawn],
      escaped: escaped === inEffect,
      first,
      listsBuiltIn: [names.includes("dark"), names.includes("nord")],
      row: row.find((one) => one.startsWith("dark")),
      typedOver: typedOver === inEffect,
    }).toStrictEqual({
      differs: [true, true],
      escaped: true,
      first: "/theme nord",
      listsBuiltIn: [true, true],
      row: "darkbuilt-in theme",
      typedOver: true,
    });
  });

  it("lists the fonts after /set ui.font and a family typed by name, and draws the one highlighted until the list closes", async () => {
    const { container, registry } = await signedIn();
    const stop = await act(() => watchTheme(registry));

    mounted.push(stop);

    const inEffect = font();

    await typeIn(container, "/set ui.font ");
    const names = listIn(container).names ?? [];
    const row = textsOf(container);

    await typeIn(container, "/set ui.font Fira Code");
    await pressIn(container, "ArrowDown");
    const typed = [composerOf(container).value, font().includes("Fira Code")];

    await pressIn(container, "Escape");
    const escaped = font();

    expect({
      escaped: escaped === inEffect,
      names,
      row: row.find((one) => one.includes("in effect")),
      typed,
    }).toStrictEqual({
      escaped: true,
      names: [
        "system",
        "jetbrains-mono",
        "ibm-plex-mono",
        "source-code-pro",
        "commit-mono",
        "atkinson-hyperlegible-mono",
        "system-sans",
        "ibm-plex-sans",
        "atkinson-hyperlegible-next",
        "source-sans-3",
        "inter",
      ],
      row: "systemfont: the device's own monospace font, in effect",
      typed: ["/set ui.font Fira Code", true],
    });
  });

  it("lists the Networks after /network remove, a removed one too, and only Enter asks, never highlighting or picking one", async () => {
    const { container, daemon } = await signedIn({}, withOtherNetworks);

    await typeIn(container, "/network remove ");
    const listedAll = textsOf(container);

    await pressIn(container, "ArrowDown");
    await pressIn(container, "ArrowDown");
    const highlighted = [composerOf(container).value, alertdialog() === null];

    const [option] = container.querySelectorAll<HTMLElement>('[role="option"]');

    await act(async () => {
      option?.click();
      await Promise.resolve();
    });
    const picked = [composerOf(container).value, alertdialog() === null];

    await pressIn(container, "Enter");
    await settled(() => alertdialog() !== null);

    expect({
      acts: daemon.acts,
      asked: alertdialog()?.querySelector("h2")?.textContent,
      highlighted,
      listedAll,
      picked,
      removals: daemon.removals,
    }).toStrictEqual({
      acts: [],
      asked: "Remove libera?",
      highlighted: ["/network remove oftc", true],
      listedAll: [
        "liberanetwork: remove it, asking first whether its Timelines stay readable",
        "oftcnetwork: remove it, asking first whether its Timelines stay readable",
        "oldnetwork: drop the Timelines kept since it was removed, which frees its name",
      ],
      picked: ["/network remove libera", true],
      removals: [],
    });
  });

  it("shows the keys bound to a command in the list", async () => {
    const { container } = await signedIn();

    await typeIn(container, "/sidebar");
    const sidebar = textsOf(container);

    await typeIn(container, "/join");
    const join = textsOf(container);

    expect({
      join: join[0]?.endsWith("Alt+N"),
      sidebar: sidebar[0]?.endsWith("Alt+N"),
    }).toStrictEqual({
      join: false,
      sidebar: true,
    });
  });

  it("lists what was run recently first after a bare /, once it is run from the Composer", async () => {
    const { container, daemon } = await signedIn();

    await typeIn(container, "/");
    const before = listIn(container).names?.slice(0, 3);

    await typeIn(container, "/me waves");
    await pressIn(container, "Enter");
    await settled(() => daemon.says.length === 1);

    await typeIn(container, "/");
    const after = listIn(container).names?.slice(0, 3);

    expect({ after, before }).toStrictEqual({
      after: ["/me", "/away", "/back"],
      before: ["/away", "/back", "/ban"],
    });
  });
});

/**
 * A signed-in browser, with the loader of the emoji names mounted as the page mounts it.
 * @returns The page, as `signedIn` gives it.
 */
const withEmoji = async () => {
  const page = await signedIn();

  page.registry.mount(emojiLoader);

  return page;
};

describe("the Composer's emoji", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("loads no names until an emoji word is typed, and then lists the emoji that match, each with its name", async () => {
    const { container, registry } = await withEmoji();

    await typeIn(container, "hello 12:30 foo:smi");
    await typeIn(container, "/m");

    const before = registry.get(emojiState);

    await typeIn(container, "hi :smi");
    await settled(() => registry.get(emojiState) !== undefined);
    await settled(() => listIn(container).names !== undefined);

    const { names, texts } = listIn(container);

    expect({
      before,
      first: [names?.[0], texts?.[0]],
      smile: names?.includes("\u{1F604} :smile:"),
    }).toStrictEqual({
      before: undefined,
      first: ["\u{1F604} :smile:", "\u{1F604} :smile:"],
      smile: true,
    });
  });
});

/**
 * Types text into the composer as the browser does, the caret where it is left after it.
 * @param container - The page.
 * @param text - The composer's text after.
 * @param caret - Where the caret is after.
 */
const editTo = async (container: HTMLElement, text: string, caret: number) => {
  const composer = composerOf(container);

  await act(async () => {
    Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      composer,
      text
    );
    composer.setSelectionRange(caret, caret);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/**
 * Selects some of the composer's text, as a drag or Shift and the arrows do.
 * @param container - The page.
 * @param start - Where the selection begins.
 * @param end - Where it ends.
 */
const select = async (container: HTMLElement, start: number, end: number) => {
  await act(async () => {
    composerOf(container).focus();
    composerOf(container).setSelectionRange(start, end);
    document.dispatchEvent(new Event("selectionchange"));
    await Promise.resolve();
  });
};

/**
 * Presses a chord with Ctrl in the composer, as the browser dispatches it.
 * @param container - The page.
 * @param letter - The letter's key.
 * @param shift - Whether Shift is held.
 * @returns Whether the key was left to the browser.
 */
const chordIn = async (container: HTMLElement, letter: string, shift = false) => {
  let left = true;

  await act(async () => {
    left = composerOf(container).dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: `Key${letter.toUpperCase()}`,
        ctrlKey: true,
        key: shift ? letter.toUpperCase() : letter,
        shiftKey: shift,
      })
    );
    await Promise.resolve();
  });

  return left;
};

/**
 * The backdrop behind the composer, if one is drawn.
 * @param container - The page.
 * @returns It, or none.
 */
const backdropOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-composer-backdrop]") ?? undefined;

/**
 * The runs the backdrop draws, each its text and whether it is bold.
 * @param container - The page.
 * @returns The runs.
 */
const drawnRuns = (container: HTMLElement) =>
  [...(backdropOf(container)?.querySelectorAll("span") ?? [])].map((span) => ({
    bold: span.classList.contains(inlineStyles.bold),
    coloured: span.style.color !== "",
    text: span.textContent,
  }));

describe("the Composer's formatting", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("bolds the selection on Mod+B, draws it bold behind the text, and sends the codes", async () => {
    const { container, daemon } = await signedIn();

    await typeIn(container, "a b c");

    const before = backdropOf(container);

    await select(container, 2, 3);

    const left = await chordIn(container, "b");
    const drawn = drawnRuns(container);
    const shown = composerOf(container).value;
    const selection = [composerOf(container).selectionStart, composerOf(container).selectionEnd];

    await pressIn(container, "Enter");
    await settled(() => daemon.says.length === 1);

    expect({
      before,
      drawn,
      left,
      said: daemon.says.map((one) => one.text),
      selection,
      shown,
    }).toStrictEqual({
      before: undefined,
      drawn: [
        { bold: false, coloured: false, text: "a " },
        { bold: true, coloured: false, text: "b" },
        { bold: false, coloured: false, text: " c" },
      ],
      left: false,
      said: ["a \u0002b\u0002 c"],
      selection: [2, 3],
      shown: "a b c",
    });
  });

  it("with nothing selected, says the style pending and types it next", async () => {
    const { container, daemon } = await signedIn();

    await typeIn(container, "hello ");
    await chordIn(container, "b");

    const pending = container.querySelector("[data-composer-pending]")?.textContent;

    await editTo(container, "hello you", 9);

    const after = container.querySelector("[data-composer-pending]");

    await pressIn(container, "Enter");
    await settled(() => daemon.says.length === 1);

    expect({ after, pending, said: daemon.says.map((one) => one.text) }).toStrictEqual({
      after: null,
      pending: "bold",
      said: ["hello \u0002you"],
    });
  });

  it("offers the colours on Mod+Shift+K, and colours the selection with the one chosen", async () => {
    const { container, daemon } = await signedIn();

    await typeIn(container, "a b c");
    await select(container, 2, 3);
    await chordIn(container, "k", true);

    const colours = container.querySelector('[role="listbox"][aria-label="Colours"]');

    const offered = [...(colours?.querySelectorAll('[role="option"]') ?? [])].map((one) =>
      one.getAttribute("aria-label")
    );

    // From the default, past white, black, blue, and green, to red, and back from brown.
    await pressIn(container, "ArrowRight");
    await pressIn(container, "ArrowDown");
    await pressIn(container, "ArrowRight");
    await pressIn(container, "ArrowRight");
    await pressIn(container, "ArrowRight");
    await pressIn(container, "ArrowRight");
    await pressIn(container, "ArrowLeft");
    await pressIn(container, "Enter");

    const drawn = drawnRuns(container);
    const gone = container.querySelector('[aria-label="Colours"]');

    await pressIn(container, "Enter");
    await settled(() => daemon.says.length === 1);

    expect({
      drawn,
      gone,
      offered: [offered.length, offered[0], offered[5]],
      said: daemon.says.map((one) => one.text),
    }).toStrictEqual({
      drawn: [
        { bold: false, coloured: false, text: "a " },
        { bold: false, coloured: true, text: "b" },
        { bold: false, coloured: false, text: " c" },
      ],
      gone: null,
      offered: [17, "default colour", "red"],
      said: ["a \u000304b\u000399 c"],
    });
  });
});
