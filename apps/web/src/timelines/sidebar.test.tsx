// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { NetworkId, TimelineId, uiDefaults } from "@iirc/api";
import type { Timeline, UiOptions } from "@iirc/api";
import { mainOf, openOf } from "@iirc/frontend/timelines";
import { Redacted, Schema } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/app.tsx";
import { perform } from "../composer/atoms.ts";
import { optionsState } from "../options/atoms.ts";
import { uiSync } from "../options/ui.ts";
import { pageState } from "../page/atoms.ts";
import { readChoice } from "../page/device.ts";
import { drawerState } from "../page/drawer.ts";
import { check, signInWithKey, signOut } from "../sign-in/atoms.ts";
import { watchDownloads } from "../testing/downloads.ts";
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
  kind: "Network" | "Channel" | "Direct"
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
  unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 },
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

/**
 * The sidebar's text.
 * @returns It.
 */
const sidebarText = () => document.querySelector("nav")?.textContent ?? "";

/**
 * The text of each of the sidebar's rows, all of it.
 * @returns Each.
 */
const rowTexts = () => rows().map((one) => one.textContent);

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
 * @param fetch - How the page reaches it, the fake's own unless a test stands between.
 * @returns The registry.
 */
const signedIn = async (
  more = noMore,
  fake = fakeDaemon(),
  fetch: typeof globalThis.fetch = fake.fetch
) => {
  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(own, "libera", "Network") },
    { gaps: [], items: [], timeline: describeTimeline(iirc, "#iirc", "Channel") },
    { gaps: [], items: [], timeline: describeTimeline(other, "#other", "Channel") },
    ...more.timelines.map((timeline) => ({ gaps: [], items: [], timeline })),
  ]);

  const registry = registryFor(fetch);

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
  // The Network's row, wherever a pin puts it.
  await settled(() =>
    rows().some((one) => (one.getAttribute("aria-label") ?? "").endsWith(", connected"))
  );

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
 * How a Network's row says its connection stands: to a screen reader, as a symbol drawn,
 * filled, half filled, or empty, whatever else holds it, and in its title.
 * @param name - The Network.
 * @returns Its label, the symbols drawn, and the title, if one is.
 */
const standing = (name: string) => ({
  label: row(name).getAttribute("aria-label"),
  symbols: [...row(name).querySelectorAll('[aria-hidden="true"]')].flatMap((mark) =>
    /^[●◐○]$/u.test(mark.textContent) ? [mark.textContent] : []
  ),
  title: row(name).querySelector<HTMLElement>("[title]")?.title ?? null,
});

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

  it("draws a wait, never none configured or a Network with no Timelines, until the lists are read", async () => {
    const fake = fakeDaemon();

    fake.daemon.signedIn = true;
    fake.daemon.timelines.set("libera", [
      { gaps: [], items: [], timeline: describeTimeline(own, "libera", "Network") },
      { gaps: [], items: [], timeline: describeTimeline(iirc, "#iirc", "Channel") },
    ]);

    const registry = registryFor(fake.fetch);

    registry.set(pageState, { compact: false, focused: true, visible: true });
    await run(registry, check, undefined);
    fake.daemon.holdNetworks = true;
    fake.daemon.holdLists = true;
    registry.mount(sync);

    const container = document.createElement("div");

    document.body.append(container);
    const root = createRoot(container);

    mounted.push(() => {
      root.unmount();
      container.remove();
    });

    await doing(() => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <App />
        </RegistryContext.Provider>
      );
    });

    await settled(() => fake.daemon.networksHeld.length > 0 && sidebarText() !== "");
    const unlisted = sidebarText();

    fake.daemon.holdNetworks = false;
    await doing(() => {
      for (const release of fake.daemon.networksHeld.splice(0)) {
        release();
      }
    });
    await settled(() => fake.daemon.listsHeld.length > 0 && rows().length > 0);
    const unread = rowTexts();

    fake.daemon.holdLists = false;
    await doing(() => {
      for (const release of fake.daemon.listsHeld.splice(0)) {
        release();
      }
    });
    await settled(() => rows().length === 2);

    expect({
      read: rowTexts().map((one) => one.includes("Reading…")),
      unlisted: [unlisted.includes("Reading…"), unlisted.includes("No Networks are configured")],
      unread: unread.map((one) => one.includes("Reading…")),
    }).toStrictEqual({
      read: [false, false],
      unlisted: [true, false],
      unread: [false, true],
    });
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

  it("marks a Network's connection only when it is not connected, saying both to a screen reader", async () => {
    const fake = fakeDaemon();

    fake.daemon.timelines.set("oftc", [
      {
        gaps: [],
        items: [],
        timeline: { ...describeTimeline(idOf(10), "oftc", "Network"), network: "oftc" },
      },
    ]);
    await signedIn({ listed: 1, timelines: [] }, fake);
    // Each Network's connection is read on its own, so oftc's may come after libera's.
    await settled(() => standing("oftc").label === "oftc, offline");

    expect([standing("libera"), standing("oftc")]).toStrictEqual([
      { label: "libera, connected", symbols: [], title: null },
      { label: "oftc, offline", symbols: ["○"], title: "offline" },
    ]);
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

  const item = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
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
              unread: {
                activity: 0,
                botDirect: 0,
                botMessages: 0,
                direct: 1,
                highlights: 0,
                messages: 0,
              },
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
      // Every Timeline's row has a menu, a Network's own too.
      menus: [true, true, true, true],
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
    // The close is still on its way, so #iirc stays out of the sidebar until it is answered.
    await settled(() => rows().length === 2);

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
});

/**
 * The fake Daemon with each close held before it reaches it, until the test lets it go, and
 * then either taken as the fake takes it, or refused as a Daemon whose Network has stopped.
 * @param fake - The fake Daemon.
 * @returns The fetch to hand the page, and the closes held.
 */
const holdingCloses = (fake: ReturnType<typeof fakeDaemon>) => {
  const closes: (() => void)[] = [];
  const state = { refusing: false };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if (!url.pathname.endsWith("/close")) {
      return await fake.fetch(input, init);
    }

    const { promise, resolve } = Promise.withResolvers<undefined>();

    closes.push(() => {
      resolve(undefined);
    });
    await promise;

    return state.refusing
      ? Response.json(
          { _tag: "NetworkStopped", network: "libera", outcome: "Uncertain", reason: "stopped" },
          { status: 503 }
        )
      : await fake.fetch(input, init);
  };

  return { closes, fetch, state };
};

describe("a close, while it is on its way", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  it("shows the row again, and says why, when the close is refused", async () => {
    const fake = fakeDaemon();
    const { closes, fetch, state } = holdingCloses(fake);
    const registry = await signedIn(undefined, fake, fetch);

    state.refusing = true;
    await doing(() => {
      registry.set(open, iirc);
    });
    await settled(() => document.querySelector("textarea") !== null);
    await pressButton("More for #other");
    await chooseFromMenu("Close");
    await settled(() => closes.length === 1);

    const whileHeld = names();

    await doing(() => {
      for (const release of closes.splice(0)) {
        release();
      }
    });
    await settled(() => names().includes("#other"));

    expect({
      after: names(),
      notice: document.querySelector('[role="alert"]')?.firstChild?.textContent,
      whileHeld,
    }).toStrictEqual({
      after: ["libera", "#iirc", "#other"],
      notice:
        "libera has stopped, so whether #other was closed is unknown. Closing it again is safe.",
      whileHeld: ["libera", "#iirc"],
    });
  });
});

/**
 * The Previews the menu open marks as the Timeline's choice.
 * @returns Their text, with the mark.
 */
const marked = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')].map(
    (one) => one.textContent
  );

describe("a Timeline's own Previews, from the sidebar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  it("sets a Timeline's choice from its menu, sending the option whole from the sequence read, and marks the one in force", async () => {
    const fake = fakeDaemon();

    fake.daemon.ui = {
      options: { ...uiDefaults, "previews.timelines": { [other]: "off" } },
      sequence: 4,
    };

    const registry = await signedIn(undefined, fake);

    registry.mount(uiSync);
    await settled(() => registry.get(optionsState).ui !== undefined);

    await pressButton("More for #iirc");
    await settled(() => document.querySelector('[role="menu"]') !== null);

    const before = marked();

    await chooseFromMenu("on");
    await settled(() => fake.daemon.ui.sequence !== 4);
    await pressButton("More for #other");
    await settled(() => document.querySelector('[role="menu"]') !== null);

    const otherMarked = marked();

    await chooseFromMenu("default");
    await settled(() => fake.daemon.uiChanges.length === 2);

    expect({
      before,
      changes: fake.daemon.uiChanges,
      network: buttonNamed("More for libera") !== undefined,
      now: fake.daemon.ui.options["previews.timelines"],
      otherMarked,
    }).toStrictEqual({
      before: ["✓default"],
      changes: [
        { ifSequence: "4", route: "PUT previews.timelines" },
        { ifSequence: String(fake.daemon.ui.sequence - 1), route: "PUT previews.timelines" },
      ],
      network: true,
      now: { [iirc]: "on" },
      otherMarked: ["✓off"],
    });
  });

  it("makes the choice once more from the options read again after a conflict", async () => {
    const fake = fakeDaemon();

    fake.daemon.ui = { options: uiDefaults, sequence: 4 };

    const registry = await signedIn(undefined, fake);

    registry.mount(uiSync);
    await settled(() => registry.get(optionsState).ui !== undefined);

    // Another device chooses for #other between this one's read and its change.
    fake.daemon.holdUiReads = true;
    await pressButton("More for #iirc");
    await chooseFromMenu("links only");
    await settled(() => fake.daemon.uiReadsHeld.length === 1);
    fake.daemon.ui = {
      options: { ...uiDefaults, "previews.timelines": { [other]: "off" } },
      sequence: 9,
    };
    fake.daemon.holdUiReads = false;
    await doing(() => {
      for (const release of fake.daemon.uiReadsHeld.splice(0)) {
        release();
      }
    });
    await settled(() => fake.daemon.uiChanges.length === 2);
    await settled(() => fake.daemon.ui.sequence !== 9);

    expect({
      changes: fake.daemon.uiChanges.map((one) => one.ifSequence),
      now: fake.daemon.ui.options["previews.timelines"],
    }).toStrictEqual({
      changes: ["4", "9"],
      now: { [iirc]: "links only", [other]: "off" },
    });
  });
});

/**
 * The Frontend signed in, as `signedIn` does, with the shared options holding the order
 * given, read.
 * @param order - The options of the Sidebar's order to hold.
 * @param more - More Timelines, and how many of them the sidebar lists.
 * @returns The fake Daemon and the registry.
 */
const arrangedWith = async (order: Partial<UiOptions>, more = noMore) => {
  const fake = fakeDaemon();

  fake.daemon.ui = { options: { ...uiDefaults, ...order }, sequence: 4 };

  const registry = await signedIn(more, fake);

  registry.mount(uiSync);
  await settled(() => registry.get(optionsState).ui !== undefined);

  return { fake, registry };
};

/** A Direct Message with `peer`, listed after the Channels. */
const withPeer: More = { listed: 1, timelines: [describeTimeline(peer, "peer", "Direct")] };

/**
 * The sidebar's headings, in order.
 * @returns Their text.
 */
const headings = () => [...document.querySelectorAll("nav h2")].map((one) => one.textContent);

/**
 * Presses a key and lets it go, as a browser dispatches both, on an element.
 * @param target - Where.
 * @param key - The key.
 */
const tap = async (target: EventTarget, key: string) => {
  await doing(() => {
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key }));
    }
  });
};

describe("the Sidebar in the Owner's order", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  // Catches the Sidebar drawn in the fixed order, ignoring the order every device shares.
  it("draws a Network's Timelines in the order given, one not named taking its place in the fixed order", async () => {
    await arrangedWith({ "sidebar.order": [other, iirc] }, withPeer);
    await settled(() => names()[1] === "#other");

    expect(names()).toStrictEqual(["libera", "#other", "peer", "#iirc"]);
  });

  // Catches a pin drawn under its Network, or without saying which Network it is of.
  it("draws a pinned Timeline in a part of its own above the Networks, saying its Network", async () => {
    await arrangedWith({ "sidebar.pinned": [peer] }, withPeer);
    await settled(() => headings().includes("Pinned"));

    expect({
      headings: headings(),
      label: row("peer").getAttribute("aria-label"),
      names: names(),
      text: row("peer").textContent,
    }).toStrictEqual({
      headings: ["Pinned", "Networks"],
      label: "peer of libera",
      names: ["peer", "libera", "#iirc", "#other"],
      text: "peer· libera…↕",
    });
  });

  // Catches a menu's Pin that writes nothing, writes the wrong value, or is offered for a
  // Network's own row, which can never be pinned.
  it("pins a Timeline from its row's menu, from the sequence read, and offers no pin for a Network's own row", async () => {
    const { fake } = await arrangedWith({ "sidebar.pinned": [other] });

    await pressButton("More for libera");
    await settled(() => document.querySelector('[role="menu"]') !== null);

    const networkMenu = [...document.querySelectorAll('[role^="menuitem"]')].map(
      (one) => one.textContent
    );

    await press(document.activeElement ?? document.body, { key: "Escape" });
    await settled(() => document.querySelector('[role="menu"]') === null);
    await pressButton("More for #iirc");
    await chooseFromMenu("Pin");
    await settled(() => fake.daemon.uiChanges.length === 1);
    await settled(() => names()[1] === "#iirc");

    expect({
      changes: fake.daemon.uiChanges,
      names: names(),
      networkMenu: networkMenu.filter((text) => text === "Pin" || text === "Unpin"),
      pinned: fake.daemon.ui.options["sidebar.pinned"],
    }).toStrictEqual({
      changes: [{ ifSequence: "4", route: "PUT sidebar.pinned" }],
      names: ["#other", "#iirc", "libera"],
      networkMenu: [],
      pinned: [other, iirc],
    });
  });

  // Catches the keys the keymap shows for moving a Timeline doing nothing in the page.
  it("moves the open Timeline down with its keys, writing the order for every device", async () => {
    const { fake, registry } = await arrangedWith({}, withPeer);

    await doing(() => {
      registry.set(open, iirc);
    });
    await press(document.body, { altKey: true, ctrlKey: true, key: "ArrowDown" });
    await settled(() => fake.daemon.uiChanges.length === 1);
    await settled(() => names()[1] === "#other");

    expect({
      changes: fake.daemon.uiChanges,
      names: names(),
      order: fake.daemon.ui.options["sidebar.order"],
    }).toStrictEqual({
      changes: [{ ifSequence: "4", route: "PUT sidebar.order" }],
      names: ["libera", "#other", "#iirc", "peer"],
      order: [other, iirc, peer],
    });
  });

  // Catches the next Timeline's key stepping through the fixed order, not the one shown.
  it("goes to the next Timeline in the order shown, the pinned first", async () => {
    const { registry } = await arrangedWith({ "sidebar.pinned": [iirc] }, withPeer);

    await settled(() => names()[0] === "#iirc");
    await doing(() => {
      registry.set(open, own);
    });
    await press(document.body, { altKey: true, key: "ArrowDown" });

    expect(openNow(registry)).toBe(other);
  });

  // Catches a row dropped before or after another that moves nothing for every device.
  it("moves a row dropped after another of its Network there, with the keys React Aria drags with", async () => {
    const { fake } = await arrangedWith({}, withPeer);
    const handle = row("#iirc").querySelector<HTMLElement>('button[aria-label="Drag #iirc"]');

    if (handle === null) {
      throw new Error("no drag button");
    }

    await doing(() => {
      handle.focus();
    });
    await tap(handle, "Enter");
    await tap(document.activeElement ?? document.body, "ArrowDown");
    await tap(document.activeElement ?? document.body, "Enter");
    await settled(() => fake.daemon.uiChanges.length === 1);

    expect({
      changes: fake.daemon.uiChanges,
      order: fake.daemon.ui.options["sidebar.order"],
    }).toStrictEqual({
      changes: [{ ifSequence: "4", route: "PUT sidebar.order" }],
      order: [other, iirc, peer],
    });
  });
});

/**
 * A Direct Message with `peer` holding three unread Messages, some of them Highlights.
 * @param highlights - How many are Highlights.
 * @returns The Timeline to list.
 */
const withUnreadPeer = (highlights: number): More => ({
  listed: 1,
  timelines: [
    {
      ...describeTimeline(peer, "peer", "Direct"),
      unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights, messages: 3 },
    },
  ],
});

/**
 * A Direct Message with `peer` holding five unread Messages, two of them a bot's, and as
 * many Highlights as given, which are never a bot's.
 * @param highlights - How many Highlights.
 * @returns The Timeline to list.
 */
const withBotInPeer = (highlights: number): More => ({
  listed: 1,
  timelines: [
    {
      ...describeTimeline(peer, "peer", "Direct"),
      unread: { activity: 0, botDirect: 0, botMessages: 2, direct: 0, highlights, messages: 3 },
    },
  ],
});

describe("bots quieted in the Sidebar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  // Catches bots counted though the Owner quieted them, or left out while the option is off.
  it("counts what a bot said while bots are not quieted, and leaves it out once they are", async () => {
    await arrangedWith({}, withBotInPeer(0));

    const off = row("peer").getAttribute("aria-label");

    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    await arrangedWith({ quietBots: true }, withBotInPeer(0));

    expect({ off, on: row("peer").getAttribute("aria-label") }).toStrictEqual({
      off: "peer, 5 unread",
      on: "peer, 3 unread",
    });
  });

  // Catches a Highlight dropped with a bot's other Messages.
  it("still counts a Highlight, whoever it is from, beside what else is unread", async () => {
    await arrangedWith({ quietBots: true }, withBotInPeer(1));

    expect(row("peer").getAttribute("aria-label")).toBe("peer, 4 unread, 1 highlight");
  });
});

describe("muting a Timeline from the Sidebar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  // Catches a menu's Mute that writes nothing, or writes without the sequence read, and a
  // row that still counts what is unread or does not read as muted, as Unmute must undo.
  it("mutes a Timeline from its row's menu, which then counts nothing and reads as muted, and unmutes it again", async () => {
    const { fake } = await arrangedWith({}, withUnreadPeer(0));

    const before = {
      label: row("peer").getAttribute("aria-label"),
      text: row("peer").textContent,
    };

    await pressButton("More for peer");
    await chooseFromMenu("Mute");
    await settled(() => fake.daemon.uiChanges.length === 1);
    await settled(() => row("peer").getAttribute("aria-label")?.endsWith("muted") === true);

    const muted = {
      label: row("peer").getAttribute("aria-label"),
      list: fake.daemon.ui.options.muted,
      text: row("peer").textContent,
    };

    // Unmuting is made from the options in force once muted, not those it began from.
    const sequence = String(fake.daemon.ui.sequence);

    await pressButton("More for peer");
    await chooseFromMenu("Unmute");
    await settled(() => fake.daemon.uiChanges.length === 2);
    await settled(() => row("peer").getAttribute("aria-label") === before.label);

    expect({
      after: { list: fake.daemon.ui.options.muted, text: row("peer").textContent },
      before,
      changes: fake.daemon.uiChanges,
      muted,
    }).toStrictEqual({
      after: { list: [], text: before.text },
      before: { label: "peer, 3 unread", text: "peer3…↕" },
      changes: [
        { ifSequence: "4", route: "PUT muted" },
        { ifSequence: sequence, route: "PUT muted" },
      ],
      muted: { label: "peer, muted", list: [peer], text: "peer∅…↕" },
    });
  });

  // Catches a muted row that hides a Highlight, or marks it differently from an unmuted one.
  it("still marks a muted Timeline's Highlight, as an unmuted one's, and counts none of what else is unread", async () => {
    await arrangedWith({ muted: [peer] }, withUnreadPeer(1));
    await settled(() => row("peer").getAttribute("aria-label")?.endsWith("muted") === true);

    expect({
      label: row("peer").getAttribute("aria-label"),
      text: row("peer").textContent,
    }).toStrictEqual({ label: "peer, 1 unread, 1 highlight, muted", text: "peer∅1…↕" });
  });
});

/**
 * What the sidebar's foot holds, in order: each view's row by its name, and each button by
 * its label or its text.
 * @param footer - Where the foot is.
 * @returns Them.
 */
const footerControls = (footer: string) =>
  [...document.querySelectorAll<HTMLElement>(`${footer} [role="option"], ${footer} button`)].map(
    (one) => one.dataset.key ?? one.getAttribute("aria-label") ?? one.textContent
  );

/**
 * A view's row at the sidebar's foot.
 * @param name - The view.
 * @returns It.
 */
const viewRow = (name: "Search" | "Uploads" | "Options") => {
  const found = document.querySelector<HTMLElement>(`nav [role="option"][data-key="${name}"]`);

  if (found === null) {
    throw new Error(`no view row: ${name}`);
  }

  return found;
};

/**
 * What the focused Pane shows.
 * @param registry - The registry.
 * @returns Its tag.
 */
const shownNow = (registry: AtomRegistry.AtomRegistry) => mainOf(registry.get(timelinesState))._tag;

/**
 * How the views' rows are marked: each one's label, whether it is chosen, and the number
 * of the other Pane that shows it, if one does.
 * @returns Each.
 */
const viewMarks = () =>
  (["Search", "Uploads", "Options"] as const).map((name) => [
    viewRow(name).getAttribute("aria-label"),
    viewRow(name).getAttribute("aria-selected"),
    [...viewRow(name).querySelectorAll('[aria-hidden="true"]')]
      .map((mark) => mark.textContent)
      .find((text) => /^\d+$/u.test(text)) ?? null,
  ]);

/**
 * The options view's filter.
 * @returns It, while the options show.
 */
const filter = () =>
  document.querySelector<HTMLInputElement>('main section[aria-label="Options"] input');

describe("the views of iirc's own, from the sidebar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  it("opens each view in the focused Pane, as a Timeline's row does, marked as a Timeline's is", async () => {
    const registry = await signedIn();

    await doing(() => {
      registry.set(open, iirc);
      registry.set(paned, { _tag: "Split", axis: "Horizontal", timeline: other });
    });
    await settled(() => openNow(registry) === other);

    await doing(() => {
      viewRow("Uploads").click();
    });
    await settled(() => shownNow(registry) === "Uploads");

    const focused = {
      marks: viewMarks(),
      pane: registry.get(timelinesState).layout.focused,
    };

    await doing(() => {
      registry.set(paned, { _tag: "Focus", pane: "p0" });
    });
    await doing(() => {
      viewRow("Search").click();
    });
    await settled(() => shownNow(registry) === "Search");

    expect({ elsewhere: viewMarks(), focused }).toStrictEqual({
      elsewhere: [
        ["Search", "true", null],
        ["Uploads, in Pane 2", "false", "2"],
        ["Options", "false", null],
      ],
      focused: {
        marks: [
          ["Search", "false", null],
          ["Uploads", "true", null],
          ["Options", "false", null],
        ],
        pane: "p1",
      },
    });
  });

  it("gives no view a close button, and Escape in each shows what the Pane showed before", async () => {
    const registry = await signedIn();

    await doing(() => {
      registry.set(open, iirc);
    });

    // Opens a view from its row, then presses Escape in it.
    const escapedFrom = async (name: "Search" | "Uploads" | "Options") => {
      await doing(() => {
        viewRow(name).click();
      });
      await settled(() => shownNow(registry) === name);

      const view = document.querySelector<HTMLElement>(`main section[aria-label="${name}"]`);

      const closing = [...(view?.querySelectorAll("button") ?? [])].some((one) =>
        (one.getAttribute("aria-label") ?? "").startsWith("Close")
      );

      await press(view?.querySelector("input") ?? view ?? document.body, { key: "Escape" });
      await settled(() => shownNow(registry) === "Timeline");

      return [name, closing, shownNow(registry)];
    };

    const seen = [
      await escapedFrom("Search"),
      await escapedFrom("Uploads"),
      await escapedFrom("Options"),
    ];

    expect(seen).toStrictEqual([
      ["Search", false, "Timeline"],
      ["Uploads", false, "Timeline"],
      ["Options", false, "Timeline"],
    ]);
  });

  it("reaches the rows with the keys, which move between them and open one, each showing its keys", async () => {
    const registry = await signedIn();

    await doing(() => {
      viewRow("Search").focus();
    });
    await press(viewRow("Search"), { key: "ArrowDown" });
    const moved = document.activeElement === viewRow("Uploads");

    await press(viewRow("Uploads"), { key: "ArrowDown" });
    await press(viewRow("Options"), { key: "Enter" });
    await settled(() => shownNow(registry) === "Options");

    expect({
      keys: (["Search", "Uploads", "Options"] as const).map(
        (name) => viewRow(name).querySelector("kbd")?.textContent ?? null
      ),
      moved,
      opened: shownNow(registry),
    }).toStrictEqual({
      keys: ["Ctrl+Shift+F", null, "Ctrl+,"],
      moved: true,
      opened: "Options",
    });
  });

  it("opens the options again from their row while they show, clearing their filter, but not on Escape", async () => {
    const registry = await signedIn();

    await doing(() => {
      viewRow("Options").click();
    });
    await settled(() => shownNow(registry) === "Options");

    await doing(() => {
      const field = filter();

      if (field !== null) {
        Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          field,
          "nick"
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await settled(() => filter()?.value === "nick");

    // Escape on the row is no choice, so what it shows stays as it is.
    await doing(() => {
      viewRow("Options").focus();
    });
    await press(viewRow("Options"), { key: "Escape" });
    const escaped = filter()?.value;

    await doing(() => {
      viewRow("Options").click();
    });
    await settled(() => filter()?.value === "");

    expect({ escaped, filter: filter()?.value, shown: shownNow(registry) }).toStrictEqual({
      escaped: "nick",
      filter: "",
      shown: "Options",
    });
  });

  it("marks the row of a view opened by its keys", async () => {
    const registry = await signedIn();

    await press(composer(), { code: "KeyF", ctrlKey: true, key: "F", shiftKey: true });
    await settled(() => shownNow(registry) === "Search");

    expect(viewMarks()[0]).toStrictEqual(["Search", "true", null]);
  });

  it("on a phone, lists the rows in the drawer, which choosing one closes", async () => {
    const registry = await signedIn();

    await doing(() => {
      registry.set(pageState, { compact: true, focused: true, visible: true });
      registry.set(drawerState, "Sidebar");
    });
    await settled(() => document.querySelector('[role="dialog"] nav [role="option"]') !== null);

    await doing(() => {
      viewRow("Uploads").click();
    });
    await settled(() => shownNow(registry) === "Uploads");

    expect({
      drawer: registry.get(drawerState),
      shown: shownNow(registry),
    }).toStrictEqual({ drawer: "None", shown: "Uploads" });
  });
});

describe("the shell", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  it("has no bar on a wide screen, with the views' rows, signing out, and hiding it at the sidebar's foot", async () => {
    await signedIn();

    expect({
      bar: document.querySelector("body > div > div > header"),
      footer: footerControls("nav footer"),
    }).toStrictEqual({
      bar: null,
      footer: ["Search", "Uploads", "Options", "Sign out", "Hide the sidebar"],
    });
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

  it("gives the focus to the composer when the sidebar is hidden while the focus is in it", async () => {
    await signedIn();
    const row = document.querySelector<HTMLElement>('nav [role="row"]');

    await doing(() => {
      row?.focus();
    });
    const before = document.activeElement === row;

    await press(row ?? document.body, { altKey: true, code: "KeyN", key: "n" });

    expect({
      before,
      composer: document.activeElement === composer(),
      nav: document.querySelector("nav") === null,
    }).toStrictEqual({ before: true, composer: true, nav: true });
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
      footer: footerControls('[role="dialog"] footer'),
      kept: readChoice("iirc.sidebar"),
    }).toStrictEqual({
      bars: 1,
      compact: { edge: true, nav: true },
      drawer: "Sidebar",
      footer: ["Search", "Uploads", "Options", "Sign out"],
      kept: undefined,
    });
  });
});

/**
 * The sidebar's own Sign out, at its foot.
 * @returns It.
 */
const footerSignOut = () =>
  [...document.querySelectorAll<HTMLElement>("nav footer button")].find(
    (one) => one.textContent === "Sign out"
  );

/**
 * The question asked before signing out.
 * @returns It, while it is asked.
 */
const question = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

/**
 * Presses one of the question's answers.
 * @param answer - The answer's text.
 */
const answer = async (answer: string) => {
  const found = [...(question()?.querySelectorAll<HTMLElement>("button") ?? [])].find(
    (one) => one.textContent === answer
  );

  if (found === undefined) {
    throw new Error(`no answer: ${answer}`);
  }

  await doing(() => {
    found.click();
  });
};

/** Presses the sidebar's Sign out, as the keys do, and waits for the question. */
const ask = async () => {
  await doing(() => {
    footerSignOut()?.focus();
    footerSignOut()?.click();
  });
  await settled(() => question() !== null);
};

describe("signing out from the sidebar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    localStorage.clear();
  });

  it("asks before signing out, and signs out once the Owner says to", async () => {
    const fake = fakeDaemon();

    await signedIn(undefined, fake);
    await ask();

    const describedBy = question()?.getAttribute("aria-describedby") ?? "";

    const asked = {
      described: document
        .querySelector(`[id="${describedBy}"]`)
        ?.textContent?.includes("needs a key"),
      focused: question()?.contains(document.activeElement) ?? false,
      signedIn: fake.daemon.signedIn,
      text: question()?.querySelector("h2")?.textContent,
    };

    await answer("Sign out");
    await settled(() => !fake.daemon.signedIn);

    expect({ asked, question: question() }).toStrictEqual({
      asked: {
        described: true,
        focused: true,
        signedIn: true,
        text: "Sign out of this browser?",
      },
      question: null,
    });
  });

  it("leaves the Sign-in as it was on Cancel or Escape, giving the focus back", async () => {
    const fake = fakeDaemon();

    await signedIn(undefined, fake);
    await ask();
    await answer("Cancel");
    // React Aria gives the focus back a frame after the question goes.
    await settled(() => question() === null && document.activeElement === footerSignOut());

    await ask();
    await press(document.activeElement ?? document.body, { key: "Escape" });
    await settled(() => question() === null && document.activeElement === footerSignOut());

    expect({ signedIn: fake.daemon.signedIn }).toStrictEqual({ signedIn: true });
  });

  it("says why a sign-out the Owner confirmed failed", async () => {
    const fake = fakeDaemon();

    await signedIn(undefined, fake);
    fake.daemon.signInsFail = true;
    await ask();
    await answer("Sign out");
    await settled(() => document.querySelector('nav footer [role="alert"]') !== null);

    expect({
      failure: document.querySelector('nav footer [role="alert"]')?.textContent,
      signedIn: fake.daemon.signedIn,
    }).toStrictEqual({
      failure: "The Daemon could not save its sign-ins, so nothing changed. Try again.",
      signedIn: true,
    });
  });
});

/**
 * The text of every item the menu open offers.
 * @returns Their text, in order.
 */
const menuTexts = async () => {
  await settled(() => document.querySelector('[role="menu"]') !== null);

  return [...document.querySelectorAll('[role^="menuitem"]')].map((one) => one.textContent);
};

describe("exporting a Timeline from the sidebar", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    vi.restoreAllMocks();
    localStorage.clear();
  });

  // Catches a menu with no way to save a Timeline, or one that saves another, or only part.
  it("starts the download of a Timeline whole, by its id, from its row's menu, which every Timeline has", async () => {
    const downloads = watchDownloads();

    await signedIn();

    await pressButton("More for #other");
    const channel = await menuTexts();

    await chooseFromMenu("Export as text");

    await pressButton("More for libera");
    const network = await menuTexts();

    await chooseFromMenu("Export as text");

    expect({
      downloads,
      menus: [channel.includes("Export as text"), network.includes("Export as text")],
    }).toStrictEqual({
      downloads: [
        { href: `/api/timelines/${other}/export`, saves: true },
        { href: `/api/timelines/${own}/export`, saves: true },
      ],
      menus: [true, true],
    });
  });
});
