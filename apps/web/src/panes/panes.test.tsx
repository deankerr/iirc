// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { NetworkId, TimelineId } from "@iirc/api";
import type { Timeline, TimelineItem } from "@iirc/api";
import { panesOf } from "@iirc/frontend/layout";
import type { Layout } from "@iirc/frontend/layout";
import type { PaneView } from "@iirc/frontend/timelines";
import { mainOf, openOf } from "@iirc/frontend/timelines";
import { Effect, Schema } from "effect";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { membersPanes, membersShown } from "../channel/state.ts";
import { edit } from "../composer/atoms.ts";
import { openOptions, optionsState, optionsSync } from "../options/atoms.ts";
import { pageState } from "../page/atoms.ts";
import { readChoice, writeChoice } from "../page/device.ts";
import { drawerState, pageSeen } from "../page/drawer.ts";
import { marking } from "../reading/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { layoutKey, open, paned, showDraft, sync, timelinesState } from "../timelines/atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const idOf = (sequence: number) => `${sequence.toString(16).padStart(14, "0")}-00000000-00000000`;

const timelineId = Schema.decodeSync(TimelineId);
const own = timelineId(idOf(1));
const iirc = timelineId(idOf(2));
const other = timelineId(idOf(3));

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

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

/**
 * A position as the wire writes it.
 * @param at - Its time.
 * @param sequence - Its step.
 * @returns Its cursor.
 */
const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

/**
 * A Message said in `#other` at a step, at that many seconds.
 * @param sequence - The step.
 * @returns The item, as the wire writes it.
 */
const said = (sequence: number): typeof TimelineItem.Encoded => ({
  changed: sequence,
  content: {
    _tag: "Message",
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours: null,
    sender: "peer",
    tags: [],
    target: "#other",
    text: `line ${sequence}`,
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: other,
});

/**
 * Whether the library measures an element: a Group or a Panel.
 * @param element - The element.
 * @returns Whether it does.
 */
const sized = (element: HTMLElement) =>
  Object.hasOwn(element.dataset, "group") || Object.hasOwn(element.dataset, "panel");

/**
 * Whether an element is a Timeline's log.
 * @param element - The element.
 * @returns Whether it is.
 */
const isLog = (element: HTMLElement) => element.getAttribute("role") === "log";

/** Where each log was scrolled, until it is moved. */
const scrolledTo = new WeakMap<HTMLElement, number>();

/** How tall a log's view is, and a row in it. */
const viewHeight = 200;
const rowHeight = 20;

/**
 * How tall what a log holds is: its rows' box, as the virtualizer sizes it, or its view.
 * @param log - The log.
 * @returns The height.
 */
const contentOf = (log: HTMLElement) => {
  const rows = log.firstElementChild;
  const height = rows instanceof HTMLElement ? Number(rows.style.height.replace("px", "")) : 0;

  return Math.max(viewHeight, Number.isFinite(height) ? height : 0);
};

/**
 * A node moved: every log in it scrolls back to its top, as a browser's does.
 * @param node - The node, inserted.
 */
const moved = (node: Node) => {
  if (node instanceof HTMLElement && node.isConnected) {
    for (const log of [node, ...node.querySelectorAll<HTMLElement>('[role="log"]')]) {
      scrolledTo.delete(log);
    }
  }
};

/**
 * Lays out what the library and the Timeline view measure, as a browser would and
 * happy-dom does not: every Group and Panel is 1000 by 600 pixels, a log's view 200 tall
 * with rows of 20, and a log scrolled where it was set, until it, or a node holding it, is
 * moved, which, as a browser does, scrolls it back to its top.
 */
const layOut = () => {
  for (const [property, size] of [
    ["offsetWidth", 1000],
    ["offsetHeight", 600],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        if (property === "offsetHeight" && Object.hasOwn(this.dataset, "index")) {
          return rowHeight;
        }

        return sized(this) ? size : 0;
      },
    });
  }

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? viewHeight : 0;
    },
  });

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? contentOf(this) : 0;
    },
  });

  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrolledTo.get(this) ?? 0;
    },
    set(this: HTMLElement, top: number) {
      const most = isLog(this) ? contentOf(this) - viewHeight : 0;

      scrolledTo.set(this, Math.max(0, Math.min(top, most)));
    },
  });

  // A node already in the page, inserted again anywhere, its own parent included, is moved,
  // and every log in it scrolls back to its top.
  // oxlint-disable-next-line typescript/unbound-method -- called with the Node it was on, below.
  const { appendChild: append, insertBefore: insert } = Node.prototype;

  Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, node: T): T {
    moved(node);

    append.call(this, node);

    return node;
  };

  Node.prototype.insertBefore = function insertBefore<T extends Node>(
    this: Node,
    node: T,
    child: Node | null
  ): T {
    moved(node);

    insert.call(this, node, child);

    return node;
  };

  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (isLog(this)) {
        return new DOMRect(0, 0, 1000, viewHeight);
      }

      if (Object.hasOwn(this.dataset, "index")) {
        return new DOMRect(0, 0, 1000, rowHeight);
      }

      return sized(this) ? new DOMRect(0, 0, 1000, 600) : new DOMRect(0, 0, 0, 0);
    },
  });
};

layOut();

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
 * Lets React and the library render and report what they will.
 * @param millis - How long.
 */
const pause = async (millis: number) => {
  await act(async () => {
    await Effect.runPromise(Effect.sleep(`${millis} millis`));
  });
};

/**
 * A Timeline's log, by its name.
 * @param name - The name.
 * @returns The log, or none while it is not drawn.
 */
const logNamed = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="log"]')].find(
    (one) => one.getAttribute("aria-label") === name
  ) ?? null;

/**
 * The Frontend signed in to a Daemon with one Network, its own Timeline, `#iirc`, and
 * `#other`, with `#iirc` open.
 * @param options - Whether React renders in StrictMode, as the page does, the layout this
 * device kept, as text, if any, whether `#other` holds 40 Messages, 30 of them unread, and
 * whether the page is visible.
 * @returns The registry, the page, and every layout the core held, in turn.
 */
const signedIn = async ({
  history = false,
  kept,
  opening = true,
  strict = false,
  visible = true,
}: {
  readonly strict?: boolean;
  readonly kept?: string;
  readonly history?: boolean;
  readonly visible?: boolean;
  readonly opening?: boolean;
} = {}) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(own, "libera", "Network") },
    { gaps: [], items: [], timeline: describeTimeline(iirc, "#iirc", "Channel") },
    {
      gaps: [],
      items: history ? Array.from({ length: 40 }, (_, index) => said(index + 1)) : [],
      timeline: history
        ? {
            ...describeTimeline(other, "#other", "Channel"),
            latest: cursor(40_000, 40),
            read: 10_000,
            unread: { activity: 0, direct: 0, highlights: 0, messages: 30 },
          }
        : describeTimeline(other, "#other", "Channel"),
    },
  ]);

  fake.daemon.through = history ? 40 : 1;

  const registry = registryFor(fake.fetch);
  const layouts: Layout<PaneView>[] = [];

  if (kept !== undefined) {
    writeChoice(layoutKey, kept);
  }

  registry.set(pageState, { compact: false, focused: true, visible });
  registry.subscribe(timelinesState, (state) => {
    if (layouts.at(-1) !== state.layout) {
      layouts.push(state.layout);
    }
  });

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(marking);
  registry.mount(optionsSync);

  const container = document.createElement("div");

  document.body.append(container);
  const root = createRoot(container);

  const app = (
    <RegistryContext.Provider value={registry}>
      <App />
    </RegistryContext.Provider>
  );

  await act(async () => {
    root.render(strict ? <StrictMode>{app}</StrictMode> : app);
    await Promise.resolve();
  });

  mounted.push(() => {
    root.unmount();
    container.remove();
  });

  await settled(
    () =>
      [...registry.get(timelinesState).networks.values()].some(
        (network) => network.timelines.size === 3
      ) && fake.daemon.followers.length === 1
  );

  if (opening) {
    await act(async () => {
      registry.set(open, iirc);
      await Promise.resolve();
    });

    await settled(() => logNamed("#iirc") !== null);
  }

  return { container, daemon: fake.daemon, layouts, registry };
};

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
 * Presses a key on an element, as the browser dispatches it.
 * @param target - Where it is pressed.
 * @param init - The key and the modifiers held.
 */
const press = async (target: EventTarget, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

  // happy-dom says AltGraph is held whenever Alt is, which a browser does not.
  Object.defineProperty(event, "getModifierState", { value: () => false });

  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
};

/**
 * Alt+Shift and a letter, as a key event says it.
 * @param letter - The letter.
 * @returns The key event's init.
 */
const altShift = (letter: string): KeyboardEventInit => ({
  altKey: true,
  code: `Key${letter.toUpperCase()}`,
  key: letter.toUpperCase(),
  shiftKey: true,
});

/**
 * The share of its Group the library draws a Panel at, in percent, from the `flex` it sets.
 * @param pane - The Pane's id.
 * @returns The share, or none while it is not drawn.
 */
const drawnOf = (pane: string) => {
  const panel = [...document.querySelectorAll<HTMLElement>("[data-panel]")].find(
    (one) => one.id === `panel:${pane}`
  );

  const flex = [panel?.style.flex, panel?.parentElement?.style.flex].find(
    (one) => one !== undefined && one !== ""
  );

  return flex === undefined ? undefined : Math.round(Number(flex.split(" ")[0]));
};

/**
 * The bar's button that opens the sidebar's drawer on a compact screen.
 * @returns It, or none.
 */
const button = () => document.querySelector<HTMLElement>('header button[aria-label^="Networks"]');

/**
 * How many dialogs the page shows.
 * @returns The count.
 */
const dialogs = () => document.querySelectorAll('[role="dialog"]').length;

/**
 * A Pane's members' toggle, in its status bar.
 * @param pane - The Pane's id.
 * @returns It, or none.
 */
const toggle = (pane = "p0") =>
  document.querySelector<HTMLElement>(`[data-pane="${pane}"] header [data-members-toggle]`) ??
  undefined;

/**
 * The logs shown, by name.
 * @returns Their names.
 */
const shown = () =>
  [...document.querySelectorAll<HTMLElement>('[role="log"]')].flatMap((one) =>
    one.isConnected ? [one.getAttribute("aria-label")] : []
  );

/**
 * The root Split's ratios.
 * @param layout - The layout.
 * @returns The ratios, none for one Pane.
 */
const ratiosOf = (layout: Layout<PaneView>) =>
  layout.root._tag === "Split"
    ? layout.root.children.map((child) => Math.round(child.ratio * 1000) / 1000)
    : [];

/**
 * A Pane as a device keeps it, as JSON text, with nothing open.
 * @param index - Its number.
 * @returns The JSON of the Pane, as a child of a Split.
 */
const keptPane = (index: number) =>
  `{"node":{"_tag":"Pane","id":"p${index}","view":{"open":null,"options":null}},"ratio":1}`;

describe("the Panes", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(() => {
        unmount();
      });
    }
  });

  it("splits and closes by keys, never drawing a Pane's content again", async () => {
    const { registry } = await signedIn();
    const log = logNamed("#iirc");

    // Alt+Shift+S splits side by side, and the new Pane takes the focus and the composer.
    await press(composer(), altShift("s"));
    await settled(() => document.querySelectorAll("[data-separator]").length === 1);
    const split = registry.get(timelinesState).layout;

    // `#other` opens in the new Pane, then the first Pane is split itself, one above another.
    await act(async () => {
      registry.set(open, other);
      await Promise.resolve();
    });
    await settled(() => logNamed("#other") !== null);
    await press(composer(), { altKey: true, code: "ArrowLeft", key: "ArrowLeft", shiftKey: true });
    await press(composer(), altShift("d"));
    await settled(() => document.querySelectorAll("[data-separator]").length === 2);
    const nested = registry.get(timelinesState).layout;

    // Alt+Shift+W closes the empty Pane, and the one above takes its place.
    await press(composer(), altShift("w"));
    await settled(() => document.querySelectorAll("[data-separator]").length === 1);

    expect({
      after: panesOf(registry.get(timelinesState).layout.root).map((pane) => pane.view.open),
      kept: logNamed("#iirc") === log && log?.isConnected === true,
      nested: panesOf(nested.root).map((pane) => [pane.id, pane.view.open]),
      split: [split.focused, panesOf(split.root).length],
    }).toStrictEqual({
      after: [iirc, other],
      kept: true,
      nested: [
        ["p0", iirc],
        ["p2", undefined],
        ["p1", other],
      ],
      split: ["p1", 2],
    });
  });

  it("moves the focus by keys, marks the focused Pane, dims the other's name, and the composer writes to the focused Pane's Timeline", async () => {
    const { registry } = await signedIn();

    await press(composer(), altShift("s"));
    await act(async () => {
      registry.set(open, other);
      await Promise.resolve();
    });
    await settled(() => composer().getAttribute("aria-label") === "Pane 2: #other");

    await press(composer(), { altKey: true, code: "ArrowLeft", key: "ArrowLeft", shiftKey: true });
    await settled(() => composer().getAttribute("aria-label") === "Pane 1: #iirc");

    const marked = document.querySelector<HTMLElement>('[data-marked="true"]')?.dataset.pane;

    // Each bar says whether its name is dimmed: only the one without the focus.
    const dimmed = ["p0", "p1"].map(
      (pane) => document.querySelector<HTMLElement>(`[data-pane="${pane}"] header`)?.dataset.dim
    );

    expect({ dimmed, marked, open: openOf(registry.get(timelinesState)) }).toStrictEqual({
      dimmed: ["false", "true"],
      marked: "p0",
      open: iirc,
    });
  });

  it("takes the core's ratios without echoing them back, in StrictMode", async () => {
    const { layouts, registry } = await signedIn({ strict: true });

    await press(composer(), altShift("s"));
    await settled(() => document.querySelectorAll("[data-separator]").length === 1);
    await pause(50);
    const before = layouts.length;

    // Ratios from the core, as a resize by keys and equalizing are, each taken once.
    await act(async () => {
      registry.set(paned, { _tag: "Grow" });
      await Promise.resolve();
    });
    await pause(50);
    const grown = drawnOf("p1");

    await act(async () => {
      registry.set(paned, { _tag: "Equalize" });
      await Promise.resolve();
    });
    await pause(100);

    expect({
      drawn: drawnOf("p0"),
      group: document.querySelector("[data-group]")?.id,
      grown,
      layouts: layouts.slice(before).map(ratiosOf),
    }).toStrictEqual({
      drawn: 50,
      group: "group:s1",
      grown: 55,
      layouts: [
        [0.45, 0.55],
        [0.5, 0.5],
      ],
    });
  });

  it("goes back to an earlier set of Panes at the core's ratios, not the library's memory", async () => {
    const { registry } = await signedIn({ strict: true });

    await press(composer(), altShift("s"));
    await settled(() => document.querySelectorAll("[data-separator]").length === 1);

    await act(async () => {
      registry.set(paned, { _tag: "Resize", ratios: [30, 70], split: "s1" });
      await Promise.resolve();
    });

    // Split again and close: the root Group has the same Panels as before, which the library
    // remembers at 30 to 70.
    await press(composer(), altShift("d"));
    await settled(() => document.querySelectorAll("[data-separator]").length === 2);
    await press(composer(), altShift("w"));
    await settled(() => document.querySelectorAll("[data-separator]").length === 1);

    await act(async () => {
      registry.set(paned, { _tag: "Equalize" });
      await Promise.resolve();
    });
    await pause(100);

    expect({
      core: ratiosOf(registry.get(timelinesState).layout),
      drawn: drawnOf("p0"),
    }).toStrictEqual({ core: [0.5, 0.5], drawn: 50 });
  });

  it("shows only the focused Pane on a compact screen, with a switcher, and keeps the layout", async () => {
    const { registry } = await signedIn();

    await press(composer(), altShift("s"));
    await act(async () => {
      registry.set(open, other);
      await Promise.resolve();
    });
    await settled(() => logNamed("#other") !== null);

    await act(async () => {
      registry.set(pageState, { compact: true, focused: true, visible: true });
      await Promise.resolve();
    });

    const compact = {
      separators: document.querySelectorAll("[data-separator]").length,
      shown: shown(),
      switcher: [...document.querySelectorAll('[aria-label="Panes"] button')].map(
        (one) => one.textContent
      ),
    };

    const first = document.querySelector<HTMLElement>('[aria-label="Panes"] button');

    await act(async () => {
      first?.click();
      await Promise.resolve();
    });
    await settled(() => shown().join(",") === "#iirc");

    expect({
      compact,
      kept: panesOf(registry.get(timelinesState).layout.root).length,
      stored: readChoice(layoutKey)?.includes(iirc),
    }).toStrictEqual({
      compact: { separators: 0, shown: ["#other"], switcher: ["1 #iirc", "2 #other"] },
      kept: 2,
      stored: true,
    });
  });

  it("swaps a Timeline scrolled back, putting back the row it showed and the focus, and marking nothing read", async () => {
    // Hidden at first, so nothing is marked while `#other` opens at its latest. `#other` is
    // in the first Pane, whose Panel React moves as the two change places, which scrolls
    // its log to the top.
    const { daemon, registry } = await signedIn({ history: true, visible: false });

    await act(async () => {
      registry.set(open, other);
      await Promise.resolve();
    });
    await press(composer(), altShift("s"));
    await act(async () => {
      registry.set(open, iirc);
      registry.set(paned, { _tag: "Focus", pane: "p0" });
      await Promise.resolve();
    });
    await settled(
      () =>
        registry.get(timelinesState).windows.get(other)?.items.length === 40 &&
        logNamed("#other") !== null
    );

    // The Owner scrolls `#other` back, to the row at 120 pixels, and focuses its log.
    const log = logNamed("#other");

    await act(async () => {
      if (log !== null) {
        log.scrollTop = 120;
        log.dispatchEvent(new Event("scroll"));
        log.focus();
      }

      await Promise.resolve();
    });

    const rowAtTop = () =>
      [...(log?.querySelectorAll<HTMLElement>("[data-index]") ?? [])].find(
        (row) => row.style.transform === `translateY(${log?.scrollTop ?? -1}px)`
      )?.textContent;

    const before = {
      following: registry.get(timelinesState).windows.get(other)?.following,
      row: rowAtTop()?.includes("line 6"),
    };

    // Seen now, and swapped: the log's node moves, which scrolls it to its top.
    await act(async () => {
      registry.set(pageState, { compact: false, focused: true, visible: true });
      registry.set(paned, { _tag: "Swap", direction: "Right" });
      await Promise.resolve();
    });
    await pause(200);

    const state = registry.get(timelinesState);

    expect({
      before,
      focus: document.activeElement === log,
      focused: state.layout.focused,
      following: state.windows.get(other)?.following,
      order: panesOf(state.layout.root).map((pane) => pane.id),
      reads: daemon.reads,
      row: rowAtTop()?.includes("line 6"),
      same: logNamed("#other") === log,
      scrolled: log?.scrollTop,
    }).toStrictEqual({
      before: { following: false, row: true },
      focus: true,
      focused: "p0",
      following: false,
      order: ["p1", "p0"],
      reads: [],
      row: true,
      same: true,
      scrolled: 120,
    });
  });

  it("starts and follows whatever layout was kept: too deep, too many Panes, too long, or no JSON", async () => {
    const many = `{"focused":"p0","next":99,"zoomed":false,"root":{"_tag":"Split","axis":"Horizontal","id":"s0","children":[${Array.from({ length: 65 }, (_, index) => keptPane(index)).join(",")}]}}`;

    const started: string[] = [];

    for (const kept of [
      `${'{"root":'.repeat(5000)}1${"}".repeat(5000)}`,
      many,
      " ".repeat(70_000),
      "{not json",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      const { registry } = await signedIn({ kept });

      started.push(
        `${panesOf(registry.get(timelinesState).layout.root).length} ${openOf(registry.get(timelinesState)) === iirc}`
      );

      for (const unmount of mounted.splice(0)) {
        act(() => {
          unmount();
        });
      }
    }

    expect(started).toStrictEqual(["1 true", "1 true", "1 true", "1 true"]);
  });
});

/**
 * The button named so.
 * @param label - Its accessible name.
 * @returns It.
 */
const buttonNamed = (label: string) => {
  const found = [...document.querySelectorAll<HTMLElement>("button")].find(
    (one) => one.getAttribute("aria-label") === label || one.textContent === label
  );

  if (found === undefined) {
    throw new Error(`no button ${label}`);
  }

  return found;
};

/**
 * The sidebar's row of a Timeline, by its name.
 * @param name - Its name.
 * @returns The row.
 */
const rowNamed = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('nav [role="row"]')].find(
    (one) => one.dataset.key !== undefined && one.textContent.startsWith(name)
  );

/**
 * What the focused Pane shows, by its tag.
 * @param registry - The registry.
 * @returns The tag.
 */
const mainTag = (registry: Awaited<ReturnType<typeof signedIn>>["registry"]) =>
  mainOf(registry.get(timelinesState))._tag;

describe("what stands in front of a Timeline", () => {
  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(() => {
        unmount();
      });
    }
  });

  it("closes the options by Escape or their close button, back to the Timeline behind them", async () => {
    const { registry } = await signedIn();

    await run(registry, openOptions, "");
    await settled(() => document.querySelector('section[aria-label="Options"]') !== null);

    const grid = document.querySelector<HTMLElement>('section[aria-label="Options"] [role="grid"]');

    await press(grid ?? composer(), { key: "Escape" });
    await settled(() => logNamed("#iirc") !== null);
    const escaped = mainTag(registry);

    await run(registry, openOptions, "");
    await settled(() => document.querySelector('section[aria-label="Options"]') !== null);

    await act(async () => {
      buttonNamed("Close the options").click();
      await Promise.resolve();
    });
    await settled(() => logNamed("#iirc") !== null);

    expect({ closed: mainTag(registry), escaped }).toStrictEqual({
      closed: "Timeline",
      escaped: "Timeline",
    });
  });

  it("marks only what the focused Pane shows, and shows the Timeline behind the options when it is chosen", async () => {
    const { registry } = await signedIn();

    await run(registry, openOptions, "");
    await settled(() => document.querySelector('section[aria-label="Options"]') !== null);

    const marked = {
      iirc: rowNamed("#iirc")?.getAttribute("aria-selected"),
      options: buttonNamed("Options").getAttribute("aria-current"),
    };

    await act(async () => {
      rowNamed("#iirc")?.click();
      await Promise.resolve();
    });
    await settled(() => logNamed("#iirc") !== null);

    expect({
      after: {
        iirc: rowNamed("#iirc")?.getAttribute("aria-selected"),
        main: mainTag(registry),
        options: buttonNamed("Options").getAttribute("aria-current"),
      },
      marked,
    }).toStrictEqual({
      after: { iirc: "true", main: "Timeline", options: "false" },
      marked: { iirc: "false", options: "page" },
    });
  });

  it("reads what the options show when a layout kept with them showing comes back", async () => {
    const kept = JSON.stringify({
      focused: "p0",
      next: 1,
      root: { _tag: "Pane", id: "p0", view: { open: iirc, options: "" } },
      zoomed: false,
    });

    const { registry } = await signedIn({ kept, opening: false });

    await settled(
      () =>
        registry.get(optionsState).networks.get(Schema.decodeSync(NetworkId)("libera"))?._tag ===
        "Read"
    );

    expect(mainTag(registry)).toBe("Options");
  });

  it("shows a Direct Message not yet begun, with the composer under it, and Escape closes it", async () => {
    const { registry } = await signedIn();

    await act(async () => {
      registry.set(showDraft, {
        declared: null,
        network: Schema.decodeSync(NetworkId)("libera"),
        nick: "bob",
      });
      await Promise.resolve();
    });
    await settled(
      () => document.querySelector('section[aria-label="Direct Message with bob"]') !== null
    );

    const drawn = {
      log: document.querySelector('section[aria-label="Direct Message with bob"] p')?.textContent,
      prompt: document.querySelector("label")?.textContent,
    };

    await press(composer(), { key: "Escape" });
    await settled(() => logNamed("#iirc") !== null);

    expect({ drawn, main: mainTag(registry) }).toStrictEqual({
      drawn: {
        log: "No Messages with bob yet. What you say below starts the conversation.",
        prompt: "bob>",
      },
      main: "Timeline",
    });
  });

  it("closes the options /set opened by Escape in the composer, which keeps the focus", async () => {
    const { registry } = await signedIn();
    const input = composer();

    await act(async () => {
      input.focus();
      await Promise.resolve();
    });
    // `/set` typed into `#iirc`'s composer, which keeps the focus throughout.
    await act(async () => {
      registry.set(edit, { text: "/set", timeline: iirc });
      await Promise.resolve();
    });
    await press(input, { key: "Enter" });
    await settled(() => document.querySelector('section[aria-label="Options"]') !== null);
    const shown = mainTag(registry);

    await press(composer(), { key: "Escape" });
    await settled(() => logNamed("#iirc") !== null);

    expect({
      closed: mainTag(registry),
      focused: document.activeElement === composer(),
      shown,
    }).toStrictEqual({
      closed: "Timeline",
      focused: true,
      shown: "Options",
    });
  });

  it("names Panes by their drafts on a compact screen, in the switcher and the composer", async () => {
    const { registry } = await signedIn();
    const libera = Schema.decodeSync(NetworkId)("libera");

    await act(async () => {
      registry.set(showDraft, { declared: null, network: libera, nick: "alice" });
      registry.set(paned, { _tag: "Split", axis: "Horizontal", timeline: undefined });
      registry.set(showDraft, { declared: null, network: libera, nick: "bob" });
      registry.set(pageState, { compact: true, focused: true, visible: true });
      await Promise.resolve();
    });
    await settled(() => document.querySelectorAll('[aria-label="Panes"] button').length === 2);

    expect({
      composer: composer().getAttribute("aria-label"),
      shown: document
        .querySelector('section[aria-label^="Direct Message with"]')
        ?.getAttribute("aria-label"),
      switcher: [...document.querySelectorAll('[aria-label="Panes"] button')].map(
        (one) => one.textContent
      ),
    }).toStrictEqual({
      composer: "Pane 2: bob",
      shown: "Direct Message with bob",
      switcher: ["1 alice", "2 bob"],
    });
  });

  it("draws the sidebar as a drawer on a compact screen, from a button marked by what is unread, closed by a choice", async () => {
    const { registry } = await signedIn({ history: true });

    await act(async () => {
      pageSeen(registry, { compact: true, focused: true, visible: true });
      await Promise.resolve();
    });

    await settled(() => button() !== null);

    const before = {
      expanded: button()?.getAttribute("aria-expanded"),
      label: button()?.getAttribute("aria-label"),
      sidebar: document.querySelectorAll('nav[aria-label="Networks"]').length,
    };

    await act(async () => {
      button()?.click();
      await Promise.resolve();
    });
    await settled(() => document.querySelector('[role="dialog"][aria-label="Networks"]') !== null);

    const row = [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="row"]')].find(
      (one) => one.getAttribute("aria-label")?.startsWith("#other") === true
    );

    const opened = {
      expanded: button()?.getAttribute("aria-expanded"),
      sidebar: document.querySelectorAll('[role="dialog"] nav[aria-label="Networks"]').length,
    };

    await act(async () => {
      row?.click();
      await Promise.resolve();
    });
    await settled(() => logNamed("#other") !== null);

    expect({
      after: {
        dialog: document.querySelectorAll('[role="dialog"]').length,
        drawer: registry.get(drawerState),
        shown: shown(),
      },
      before,
      opened,
    }).toStrictEqual({
      after: { dialog: 0, drawer: "None", shown: ["#other"] },
      before: { expanded: "false", label: "Networks, Messages unread", sidebar: 0 },
      opened: { expanded: "true", sidebar: 1 },
    });
  });

  it("shows the members as a sheet on a compact screen, never kept, and the column again when wide", async () => {
    const { registry } = await signedIn();

    await act(async () => {
      pageSeen(registry, { compact: true, focused: true, visible: true });
      await Promise.resolve();
    });

    await settled(() => toggle() !== undefined);
    await act(async () => {
      toggle()?.click();
      await Promise.resolve();
    });
    await settled(() => document.querySelector('[role="dialog"] h2')?.textContent === "members");

    const sheet = {
      column: registry.get(membersShown),
      kept: readChoice("iirc.members"),
      visible: registry.get(membersPanes).length > 0,
    };

    await act(async () => {
      document
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await Promise.resolve();
    });
    await settled(() => document.querySelector('[role="dialog"]') === null);

    const closed = registry.get(drawerState);

    // On a wide screen, the toggle shows the column beside the Channel, kept on this device.
    await act(async () => {
      pageSeen(registry, { compact: false, focused: true, visible: true });
      await Promise.resolve();
    });
    await act(async () => {
      toggle()?.click();
      await Promise.resolve();
    });
    await settled(() => document.querySelector('section[aria-label="Members"]') !== null);

    const kept = readChoice("iirc.members");

    writeChoice("iirc.members", undefined);

    expect({
      closed,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      kept,
      sheet,
    }).toStrictEqual({
      closed: "None",
      dialogs: 0,
      kept: "on",
      sheet: { column: false, kept: undefined, visible: true },
    });
  });

  it("ends a drawer or a sheet left open when the screen widens, so narrowing it again opens neither", async () => {
    const { registry } = await signedIn();

    const resize = async (compact: boolean) => {
      await act(async () => {
        pageSeen(registry, { compact, focused: true, visible: true });
        await Promise.resolve();
      });
    };

    await resize(true);
    await settled(() => button() !== null);
    await act(async () => {
      button()?.click();
      await Promise.resolve();
    });
    await settled(() => dialogs() === 1);
    await resize(false);
    await resize(true);
    await settled(() => button() !== null);

    const sidebar = { dialogs: dialogs(), drawer: registry.get(drawerState) };

    await act(async () => {
      toggle()?.click();
      await Promise.resolve();
    });
    await settled(() => dialogs() === 1);
    await resize(false);

    const wide = {
      column: document.querySelectorAll('section[aria-label="Members"]').length,
      kept: registry.get(membersShown),
    };

    await resize(true);

    expect({
      members: { dialogs: dialogs(), drawer: registry.get(drawerState) },
      sidebar,
      wide,
    }).toStrictEqual({
      members: { dialogs: 0, drawer: "None" },
      sidebar: { dialogs: 0, drawer: "None" },
      wide: { column: 0, kept: false },
    });
  });
});
