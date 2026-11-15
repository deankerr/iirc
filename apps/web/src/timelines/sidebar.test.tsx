// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { NetworkId, TimelineId } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { openOf } from "@iirc/frontend/timelines";
import { Redacted, Schema } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { perform } from "../composer/atoms.ts";
import { pageState } from "../page/atoms.ts";
import { readChoice } from "../page/device.ts";
import { drawerState } from "../page/drawer.ts";
import { paletteSections, pickEntry } from "../palette/atoms.ts";
import { check, signInWithKey, signOut } from "../sign-in/atoms.ts";
import {
  eventually,
  fakeDaemon,
  liberaConfiguration,
  registryFor,
  run,
  theKey,
} from "../testing/fake-daemon.ts";
import { open, paned, sync, timelinesState } from "./atoms.ts";
import { leavingState } from "./closing.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const idOf = (sequence: number) => `${sequence.toString(16).padStart(14, "0")}-00000000-00000000`;

const timelineId = Schema.decodeSync(TimelineId);
const own = timelineId(idOf(1));
const iirc = timelineId(idOf(2));
const other = timelineId(idOf(3));
const peer = timelineId(idOf(4));

const describeTimeline = (
  id: string,
  name: string,
  kind: "Network" | "Channel" | "Direct",
  closed = false
): typeof Timeline.Encoded => ({
  changed: 1,
  closed,
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
 * Does something to the page, letting React render it.
 * @param doing - What to do.
 */
const doing = async (doing: () => void) => {
  await act(async () => {
    doing();
    await Promise.resolve();
  });
};

/**
 * Presses a key on an element, as the browser dispatches it.
 * @param target - Where it is pressed.
 * @param init - The key and the modifiers held.
 */
const press = async (target: EventTarget, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

  // happy-dom says AltGraph is held whenever Alt is, which a browser does not.
  Object.defineProperty(event, "getModifierState", { value: () => false });

  await doing(() => {
    target.dispatchEvent(event);
  });
};

/**
 * The sidebar's rows.
 * @returns Each row.
 */
const rows = () => [...document.querySelectorAll<HTMLElement>('nav [role="row"]')];

/** Timelines beside the three every test has, and how many of them the sidebar lists. */
interface More {
  readonly timelines: readonly (typeof Timeline.Encoded)[];
  readonly listed: number;
}

const noMore: More = { listed: 0, timelines: [] };

/**
 * The Frontend signed in, on a wide screen, to a Daemon with one Network, connected, with
 * its own Timeline, `#iirc`, and `#other`, and any more given.
 * @param more - More Timelines, and how many of them the sidebar lists.
 * @param fake - The fake Daemon.
 * @returns The registry.
 */
const signedIn = async (more = noMore, fake = fakeDaemon()) => {
  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(own, "libera", "Network") },
    { gaps: [], items: [], timeline: describeTimeline(iirc, "#iirc", "Channel") },
    { gaps: [], items: [], timeline: describeTimeline(other, "#other", "Channel") },
    ...more.timelines.map((timeline) => ({ gaps: [], items: [], timeline })),
  ]);

  const registry = registryFor(fake.fetch);

  registry.set(pageState, { compact: false, focused: true, visible: true });
  await run(registry, check, undefined);
  registry.mount(sync);

  const container = document.createElement("div");

  document.body.append(container);
  const root = createRoot(container);

  await doing(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    );
  });

  mounted.push(() => {
    root.unmount();
    container.remove();
  });

  await settled(
    () => rows().length === 3 + more.listed && rows()[0]?.getAttribute("aria-label") !== null
  );
  await settled(() => (rows()[0]?.getAttribute("aria-label") ?? "").endsWith(", connected"));

  return registry;
};

/**
 * A row, by the name it shows.
 * @param name - The name.
 * @returns It.
 */
const row = (name: string) => {
  const found = rows().find((one) => one.querySelector("bdi")?.textContent === name);

  if (found === undefined) {
    throw new Error(`no row: ${name}`);
  }

  return found;
};

/**
 * A button, by its label or its text.
 * @param name - Its label or text.
 * @returns It, or none.
 */
const buttonNamed = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].find(
    (one) => (one.getAttribute("aria-label") ?? one.textContent) === name
  );

/**
 * Presses a button, by its label or its text.
 * @param name - Its label or text.
 */
const pressButton = async (name: string) => {
  const found = buttonNamed(name);

  if (found === undefined) {
    throw new Error(`no button: ${name}`);
  }

  await doing(() => {
    found.click();
  });
};

/**
 * The sidebar's edge.
 * @returns It, or none.
 */
const edge = () => document.querySelector<HTMLElement>('[aria-label="Resize the sidebar"]');

/**
 * The composer's textarea.
 * @returns It.
 */
const composer = () => {
  const found = document.querySelector("textarea");

  if (found === null) {
    throw new Error("no composer");
  }

  return found;
};

/**
 * The open Timeline in the focused Pane.
 * @param registry - The registry.
 * @returns Its id.
 */
const openNow = (registry: AtomRegistry.AtomRegistry) => openOf(registry.get(timelinesState));

describe("the sidebar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  it("draws a Network as its own Timeline's row, which opens it and is chosen, with its Channels under it", async () => {
    const registry = await signedIn();
    const before = rows().map((one) => one.querySelector("bdi")?.textContent);

    await doing(() => {
      row("libera").click();
    });
    await settled(() => openNow(registry) === own);

    expect({
      before,
      chosen: rows().map((one) => one.getAttribute("aria-selected")),
      level: row("libera").getAttribute("aria-level"),
      open: openNow(registry),
    }).toStrictEqual({
      before: ["libera", "#iirc", "#other"],
      chosen: ["true", "false", "false"],
      level: "1",
      open: own,
    });
  });

  it("expands and collapses a Network with its chevron, choosing nothing", async () => {
    const registry = await signedIn();
    const chevron = row("libera").querySelector<HTMLElement>('[slot="chevron"], button');

    await doing(() => {
      chevron?.click();
    });

    const collapsed = rows().length;

    await doing(() => {
      chevron?.click();
    });

    expect({ collapsed, expanded: rows().length, open: openNow(registry) }).toStrictEqual({
      collapsed: 1,
      expanded: 3,
      open: undefined,
    });
  });

  it("says how a connection stands as a symbol, keeping the word in its label and title", async () => {
    await signedIn();
    const standing = row("libera").querySelector<HTMLElement>("[title]");

    expect({
      label: row("libera").getAttribute("aria-label"),
      symbol: standing?.textContent,
      title: standing?.title,
    }).toStrictEqual({ label: "libera, connected", symbol: "●", title: "connected" });
  });

  it("marks a Timeline another Pane shows, more quietly, with that Pane's number", async () => {
    const registry = await signedIn();

    await doing(() => {
      registry.set(open, iirc);
      registry.set(paned, { _tag: "Split", axis: "Horizontal", timeline: other });
    });
    await settled(() => openNow(registry) === other);

    expect(
      rows().map((one) => [
        one.getAttribute("aria-label"),
        one.getAttribute("aria-selected"),
        // The Pane's number, the one mark that is a number alone.
        [...one.querySelectorAll('[aria-hidden="true"]')]
          .map((mark) => mark.textContent)
          .find((text) => /^\d+$/u.test(text)) ?? null,
      ])
    ).toStrictEqual([
      ["libera, connected", "false", null],
      ["#iirc, in Pane 1", "false", "1"],
      ["#other", "true", null],
    ]);
  });
});

/**
 * The names the sidebar's rows show.
 * @returns Them, in order.
 */
const names = () => rows().map((one) => one.querySelector("bdi")?.textContent);

/**
 * Chooses an item of the menu open, by its text, with Enter, as a browser's keys do.
 * @param text - Its text.
 */
const chooseFromMenu = async (text: string) => {
  await settled(() => document.querySelector('[role="menu"]') !== null);

  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (one) => one.textContent === text
  );

  await doing(() => {
    item?.focus();
  });

  await doing(() => {
    for (const type of ["keydown", "keyup"]) {
      item?.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "Enter" })
      );
    }
  });

  await settled(() => document.querySelector('[role="menu"]') === null);
};

describe("closing a Timeline from the sidebar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  it("closes a Direct Message from its row's menu, out of the sidebar until something arrives in it", async () => {
    const fake = fakeDaemon();

    await signedIn({ listed: 1, timelines: [describeTimeline(peer, "peer", "Direct")] }, fake);

    const menus = rows().map((one) => one.querySelector('button[aria-label^="More for"]') !== null);

    await pressButton("More for peer");
    await chooseFromMenu("Close");
    await settled(() => !names().includes("peer"));

    const closed = names();

    // Something arrives in it, which the Daemon says by `closed` going false.
    await doing(() => {
      fake.send({
        data: JSON.stringify({
          dropped: [],
          gaps: [],
          items: [],
          merged: [],
          removals: [],
          sequence: 20,
          timelines: [
            {
              ...describeTimeline(peer, "peer", "Direct"),
              changed: 20,
              unread: { activity: 0, direct: 1, highlights: 0, messages: 0 },
            },
          ],
        }),
        event: "changed",
        id: "1.20",
      });
    });
    await settled(() => names().includes("peer"));

    expect({
      back: [names(), row("peer").getAttribute("aria-label")],
      closed,
      closes: fake.daemon.closes,
      menus,
    }).toStrictEqual({
      back: [["libera", "#iirc", "#other", "peer"], "peer, 1 unread"],
      closed: ["libera", "#iirc", "#other"],
      closes: [{ network: "libera", target: "peer" }],
      // A Network's own row has no menu, and every Channel's and Direct Message's does.
      menus: [false, true, true, true],
    });
  });

  it("offers to leave a Channel the Daemon answers is joined, from its context menu, and leaves it as /part does", async () => {
    const fake = fakeDaemon();

    fake.daemon.joined.set("libera", ["#iirc"]);
    await signedIn(undefined, fake);

    await doing(() => {
      row("#iirc").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      );
    });
    await chooseFromMenu("Close");
    await settled(() => document.querySelector('[role="alertdialog"]') !== null);

    const offered = document.querySelector('[role="alertdialog"] h2')?.textContent;

    await pressButton("Leave");
    await settled(() => document.querySelector('[role="alertdialog"]') === null);

    expect({
      channels: fake.daemon.configurations.get("libera")?.configuration.channels,
      closes: fake.daemon.closes,
      listed: names(),
      offered,
      puts: fake.daemon.puts.length,
    }).toStrictEqual({
      channels: [],
      // The close is sent, and the Daemon's `Joined` answer is what opens the offer.
      closes: [{ network: "libera", target: "#iirc" }],
      // Leaving does not close it: the part shows in it, and it is closed once Self has left.
      listed: ["libera", "#iirc", "#other"],
      offered: "You are in #iirc. Leave it?",
      puts: 1,
    });
  });

  it("leaves a joined Channel the Configuration does not want by parting it, never by an edit that would refuse it", async () => {
    const fake = fakeDaemon();

    // The Ircd put Self there, or Self joined it by hand: it is not among those saved.
    fake.daemon.joined.set("libera", ["#iirc"]);
    fake.daemon.configurations.set("libera", {
      configuration: { ...liberaConfiguration, channels: [] },
      sequence: 1,
    });
    await signedIn(undefined, fake);

    await pressButton("More for #iirc");
    await chooseFromMenu("Close");
    await settled(() => document.querySelector('[role="alertdialog"]') !== null);
    await pressButton("Leave");
    await settled(() => document.querySelector('[role="alertdialog"]') === null);

    expect({
      acts: fake.daemon.acts.map((one) => one.action),
      closes: fake.daemon.closes,
      puts: fake.daemon.puts.length,
    }).toStrictEqual({
      acts: [{ _tag: "Part", channel: "#iirc", reason: null }],
      closes: [{ network: "libera", target: "#iirc" }],
      puts: 0,
    });
  });

  it("offers to leave the Channel the Daemon checked, not the status-prefixed Target typed", async () => {
    const fake = fakeDaemon();

    fake.daemon.joined.set("libera", ["#iirc"]);
    const registry = await signedIn(undefined, fake);

    // What `/close-timeline @#iirc` asks.
    registry.set(perform, [
      { _tag: "CloseTimeline", network: Schema.decodeSync(NetworkId)("libera"), target: "@#iirc" },
    ]);
    await settled(() => document.querySelector('[role="alertdialog"]') !== null);

    const offered = document.querySelector('[role="alertdialog"] h2')?.textContent;

    await pressButton("Leave");
    await settled(() => document.querySelector('[role="alertdialog"]') === null);

    expect({
      channels: fake.daemon.configurations.get("libera")?.configuration.channels,
      closes: fake.daemon.closes,
      offered,
    }).toStrictEqual({
      channels: [],
      closes: [{ network: "libera", target: "@#iirc" }],
      offered: "You are in #iirc. Leave it?",
    });
  });

  it("lets an offer go on signing out", async () => {
    const fake = fakeDaemon();

    fake.daemon.joined.set("libera", ["#iirc"]);
    const registry = await signedIn(undefined, fake);

    await pressButton("More for #iirc");
    await chooseFromMenu("Close");
    await settled(() => document.querySelector('[role="alertdialog"]') !== null);

    await act(async () => {
      await run(registry, signOut, undefined);
    });

    const out = registry.get(leavingState)._tag;

    await act(async () => {
      await run(registry, signInWithKey, Redacted.make(theKey));
    });
    await settled(() => rows().length === 3);

    expect({
      dialog: document.querySelector('[role="alertdialog"]'),
      leaving: registry.get(leavingState)._tag,
      out,
    }).toStrictEqual({ dialog: null, leaving: "Idle", out: "Idle" });
  });

  it("offers nothing from a close's answer that lands after signing out and in again", async () => {
    const fake = fakeDaemon();

    fake.daemon.joined.set("libera", ["#iirc"]);
    fake.daemon.holdCloses = true;
    const registry = await signedIn(undefined, fake);

    await pressButton("More for #iirc");
    await chooseFromMenu("Close");
    await settled(() => fake.daemon.held.closes.length === 1);

    await act(async () => {
      await run(registry, signOut, undefined);
      await run(registry, signInWithKey, Redacted.make(theKey));
    });
    await settled(() => rows().length === 3);

    // The Daemon answers `Joined` for the close asked under the earlier sign-in. A close
    // asked after it waits its turn behind it, so once that one is done, so is the first.
    fake.daemon.holdCloses = false;
    await doing(() => {
      for (const release of fake.daemon.held.closes) {
        release();
      }
    });
    await pressButton("More for #other");
    await chooseFromMenu("Close");
    await settled(() => !names().includes("#other"));

    expect({
      closes: fake.daemon.closes,
      dialog: document.querySelector('[role="alertdialog"]'),
      leaving: registry.get(leavingState)._tag,
    }).toStrictEqual({
      closes: [
        { network: "libera", target: "#iirc" },
        { network: "libera", target: "#other" },
      ],
      dialog: null,
      leaving: "Idle",
    });
  });

  it("lists a closed Timeline while a Pane has it open from the palette, and not once it moves on", async () => {
    const registry = await signedIn({
      listed: 0,
      timelines: [describeTimeline(peer, "peer", "Direct", true)],
    });

    const before = names();

    const entry = registry
      .get(paletteSections)
      .flatMap((section) => section.entries)
      .find((one) => one.key === `timeline:${peer}`);

    await doing(() => {
      if (entry !== undefined) {
        registry.set(pickEntry, entry);
      }
    });
    await settled(() => names().includes("peer"));

    const opened = [names(), row("peer").getAttribute("aria-selected")];

    await doing(() => {
      registry.set(open, iirc);
    });
    await settled(() => !names().includes("peer"));

    expect({ after: names(), before, opened }).toStrictEqual({
      after: ["libera", "#iirc", "#other"],
      before: ["libera", "#iirc", "#other"],
      opened: [["libera", "#iirc", "#other", "peer"], "true"],
    });
  });
});

describe("the shell", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  it("has no bar on a wide screen, with the options and signing out at the sidebar's foot", async () => {
    await signedIn();
    const footer = document.querySelector("nav footer");

    expect({
      bar: document.querySelector("body > div > div > header"),
      footer: [...(footer?.querySelectorAll("button") ?? [])].map(
        (one) => one.getAttribute("aria-label") ?? one.textContent
      ),
    }).toStrictEqual({ bar: null, footer: ["Options", "Sign out", "Hide the sidebar"] });
  });

  it("hides the sidebar by its button and shows it from beside the composer, keeping that on this device", async () => {
    await signedIn();
    await pressButton("Hide the sidebar");

    const hidden = {
      kept: readChoice("iirc.sidebar"),
      nav: document.querySelector("nav") === null,
      show: buttonNamed("Show the sidebar") !== undefined,
    };

    await pressButton("Show the sidebar");

    expect({
      hidden,
      shown: {
        kept: readChoice("iirc.sidebar"),
        nav: document.querySelector("nav") === null,
        show: buttonNamed("Show the sidebar") !== undefined,
      },
    }).toStrictEqual({
      hidden: { kept: "hidden", nav: true, show: true },
      shown: { kept: undefined, nav: false, show: false },
    });
  });

  it("hides and shows the sidebar with Alt+N and /sidebar, while typing too", async () => {
    await signedIn();
    await press(composer(), { altKey: true, code: "KeyN", key: "n" });
    const byKey = document.querySelector("nav") === null;

    await press(composer(), { altKey: true, code: "KeyN", key: "n" });
    const back = document.querySelector("nav") === null;

    await doing(() => {
      const field = composer();

      Reflect.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        field,
        "/sidebar off"
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(composer(), { key: "Enter" });
    await settled(() => document.querySelector("nav") === null);

    expect({ back, byKey, command: document.querySelector("nav") === null }).toStrictEqual({
      back: false,
      byKey: true,
      command: true,
    });
  });

  it("says, and moves from, the width drawn where the window is narrower than twice the width kept", async () => {
    await signedIn();
    const separator = edge();
    const wide = window.innerWidth;

    const said = () => [
      separator?.getAttribute("aria-valuenow"),
      separator?.getAttribute("aria-valuemax"),
    ];

    if (separator !== null) {
      await press(separator, { key: "End" });
    }

    const kept = said();

    // Half of 700 pixels is less than the 480 kept, and is what the shell draws.
    await doing(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
      window.dispatchEvent(new Event("resize"));
    });

    const narrowed = said();

    if (separator !== null) {
      await press(separator, { key: "ArrowLeft" });
    }

    const moved = said();

    await doing(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: wide });
      window.dispatchEvent(new Event("resize"));
    });

    expect({ kept, moved, narrowed }).toStrictEqual({
      kept: ["480", "480"],
      moved: ["334", "350"],
      narrowed: ["350", "350"],
    });
  });

  it("resizes the sidebar from its edge with the keys, within bounds, keeping its width", async () => {
    await signedIn();
    const separator = edge();
    // The separator, in the sidebar's column, in the shell's body, in the shell.
    const shell = separator?.parentElement?.parentElement?.parentElement;

    const widthAfter = async (init: KeyboardEventInit) => {
      if (separator !== null) {
        await press(separator, init);
      }

      return separator?.getAttribute("aria-valuenow");
    };

    const widths = [
      await widthAfter({ key: "ArrowRight" }),
      await widthAfter({ key: "ArrowLeft", shiftKey: true }),
      await widthAfter({ key: "End" }),
      await widthAfter({ key: "ArrowRight" }),
      await widthAfter({ key: "Home" }),
    ];

    expect({
      drawn: shell?.style.getPropertyValue("--sidebar-width"),
      focusable: separator?.tabIndex,
      kept: readChoice("iirc.sidebar-width"),
      role: separator?.tagName,
      widths,
    }).toStrictEqual({
      drawn: "140px",
      focusable: 0,
      kept: "140",
      role: "HR",
      widths: ["216", "152", "480", "480", "140"],
    });
  });

  it("on a compact screen, has one bar with the drawer's button, and a drawer with the sidebar's foot", async () => {
    const registry = await signedIn();

    await doing(() => {
      registry.set(pageState, { compact: true, focused: true, visible: true });
    });

    const compact = { edge: edge() === null, nav: document.querySelector("nav") === null };

    await press(composer(), { altKey: true, code: "KeyN", key: "n" });
    await settled(() => document.querySelector('[role="dialog"] nav footer') !== null);

    expect({
      bars: document.querySelectorAll("body > div > div > header").length,
      compact,
      drawer: registry.get(drawerState),
      footer: [...document.querySelectorAll('[role="dialog"] footer button')].map(
        (one) => one.getAttribute("aria-label") ?? one.textContent
      ),
      kept: readChoice("iirc.sidebar"),
    }).toStrictEqual({
      bars: 1,
      compact: { edge: true, nav: true },
      drawer: "Sidebar",
      footer: ["Options", "Sign out"],
      kept: undefined,
    });
  });
});
