// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import type { Timeline, TimelineItem, WindowGap } from "@iirc/api";
import { Effect } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { deviceUi } from "../options/device.ts";
import { pageState } from "../page/atoms.ts";
import { movedEvent } from "../panes/atoms.ts";
import { marking } from "../reading/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { openTimeline, sync } from "./atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel",
  more: Partial<typeof Timeline.Encoded> = {}
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
  ...more,
});

const message = (
  sequence: number,
  ours: {
    readonly delivery: { readonly _tag: "Unconfirmed" | "Unsent" };
    readonly intent: string;
  } | null = null
): typeof TimelineItem.Encoded => ({
  changed: sequence,
  content: {
    _tag: "Message",
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours,
    sender: "peer",
    tags: [],
    target: "#iirc",
    text: `line ${sequence}`,
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: iirc,
});

const joined = (sequence: number): typeof TimelineItem.Encoded => ({
  changed: sequence,
  content: {
    _tag: "Activity",
    activity: { _tag: "Joined", channel: "#iirc", nick: `user${sequence}` },
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    live: true,
  },
  level: "Activity",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: iirc,
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
 * Waits a while, past the moment marking read waits, letting React render meanwhile.
 * @param millis - How long.
 */
const pause = async (millis: number) => {
  await act(async () => {
    await Effect.runPromise(Effect.sleep(`${millis} millis`));
  });
};

/**
 * The Frontend signed in, its page seen, marking read, with `#iirc` holding two unread
 * Messages, or the items given, and nothing open.
 * @param gaps - The Gaps `#iirc` holds.
 * @param items - What `#iirc` holds, two Messages unless given.
 * @param more - How `#iirc` is listed, beyond two unread Messages.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async (
  gaps: readonly (typeof WindowGap.Encoded)[] = [],
  items: readonly (typeof TimelineItem.Encoded)[] = [message(1), message(2)],
  more: Partial<typeof Timeline.Encoded> = {}
) => {
  const fake = fakeDaemon();
  const last = items.at(-1)?.sequence ?? 2;

  fake.daemon.signedIn = true;
  fake.daemon.through = last;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    {
      gaps: [...gaps],
      items: [...items],
      timeline: listed(iirc, "#iirc", "Channel", {
        latest: cursor(last * 1000, last),
        unread: { activity: 0, direct: 0, highlights: 0, messages: 2 },
        ...more,
      }),
    },
  ]);

  const registry = registryFor(fake.fetch);

  registry.set(pageState, { compact: false, focused: true, visible: true });
  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(marking);

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

  return { ...fake, container, registry };
};

/**
 * The open Timeline's log.
 * @returns It.
 */
const logOf = () => {
  const found = document.querySelector<HTMLDivElement>('[role="log"]');

  if (found === null) {
    throw new Error("no log");
  }

  return found;
};

/**
 * How the log is laid out, as a browser would and happy-dom does not: how tall its view is,
 * and how tall what it holds is, which a test changes to scroll back, how tall each row is,
 * and how wide the view is, which a test changes to wrap the rows again.
 */
const layout = { content: 0, row: 20, top: 0, view: 0, width: 800 };

const isLog = (element: Element) => element.getAttribute("role") === "log";

/**
 * Gives the log its size: the virtualizer reads its view from its box, and the view reads
 * where it stands from its heights. Every other element lays out at nothing, as in happy-dom.
 */
const layOut = () => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? layout.view : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? layout.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? layout.content : 0;
    },
  });
  // The virtualizer measures each row by its offset height.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Object.hasOwn(this.dataset, "index") ? layout.row : 0;
    },
  });
  // Scrolled no further than what it holds allows, as a browser clamps it.
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? Math.min(layout.top, Math.max(0, layout.content - layout.view)) : 0;
    },
    set(this: HTMLElement, top: number) {
      if (isLog(this)) {
        layout.top = top;
      }
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (isLog(this)) {
        return new DOMRect(0, 0, layout.width, layout.view);
      }

      return new DOMRect(0, 0, 0, Object.hasOwn(this.dataset, "index") ? layout.row : 0);
    },
  });
};

/**
 * Scrolls the log, with what it holds that tall.
 * @param top - Where it is scrolled to.
 * @param content - How tall what it holds is.
 */
const scrollTo = async (top: number, content: number) => {
  const log = logOf();

  layout.content = content;

  await act(async () => {
    log.scrollTop = top;
    log.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
  });
};

/**
 * Opens `#iirc` through the palette, as the Owner would: Mod+K, its name, and Enter.
 */
const openFromPalette = async () => {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "k" })
    );
    await Promise.resolve();
  });

  await settled(() => document.querySelector('[role="dialog"] input') !== null);
  const search = document.querySelector<HTMLInputElement>('[role="dialog"] input');

  if (search === null) {
    throw new Error("no search field");
  }

  await act(async () => {
    search.focus();
    search.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, data: "#iirc", inputType: "insertText" })
    );
    Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      search,
      "#iirc"
    );
    search.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: "#iirc", inputType: "insertText" })
    );
    await Promise.resolve();
  });

  await act(async () => {
    search.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await Promise.resolve();
  });

  await settled(() => document.querySelector('[role="dialog"]') === null);
};

/**
 * The Daemon folds a step into `#iirc`: it holds what the step changed, and the changes
 * stream gives it.
 * @param fake - The fake Daemon.
 * @param sequence - The step.
 * @param items - The items it added.
 * @param timeline - `#iirc` after it.
 */
const fold = (
  fake: Pick<ReturnType<typeof fakeDaemon>, "daemon" | "send">,
  sequence: number,
  items: readonly (typeof TimelineItem.Encoded)[],
  timeline: typeof Timeline.Encoded
) => {
  const held = fake.daemon.timelines.get("libera")?.find((one) => one.timeline.id === iirc);

  fake.daemon.through = sequence;
  fake.daemon.timelines.set("libera", [
    ...(fake.daemon.timelines.get("libera") ?? []).filter((one) => one !== held),
    { gaps: [], items: [...(held?.items ?? []), ...items], timeline },
  ]);
  fake.send({
    data: JSON.stringify({ gaps: [], items, merged: [], sequence, timelines: [timeline] }),
    event: "changed",
    id: `1.${sequence}`,
  });
};

/**
 * Presses the button with a name, as a click does.
 * @param name - Its name.
 */
const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find((one) => one.textContent === name);

  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
};

describe("what the view says it shows", () => {
  beforeEach(() => {
    layout.content = 0;
    layout.row = 20;
    layout.top = 0;
    layout.view = 500;
    layout.width = 800;
    layOut();
  });

  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("marks nothing for a Timeline just opened until the view shows its latest", async () => {
    const { container, daemon, registry } = await signedIn();

    const choose = async (name: string) => {
      // A Timeline's row, by the name it shows, apart from its Network's row.
      const row = [...container.querySelectorAll('[role="row"]')].find(
        (one) => one.querySelector("bdi")?.textContent === name
      );

      await act(async () => {
        row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      await settled(() => {
        const shown = registry.get(openTimeline);

        return shown._tag === "Shown" && shown.description?.name === name;
      });
    };

    // Opened, but with nothing laid out yet, so no item is in view.
    layout.view = 0;
    await choose("#iirc");
    await pause(200);
    const unshown = daemon.reads.length;

    // Opened again from another, laid out with its bottom in view: the last item is seen.
    layout.view = 500;
    layout.content = 500;
    await choose("libera");
    await choose("#iirc");
    await settled(() => daemon.reads.length === 1);

    expect({ reads: daemon.reads, unshown }).toStrictEqual({
      reads: [{ read: 2000, target: "#iirc" }],
      unshown: 0,
    });
  });

  it("marks nothing when the open Timeline is opened again while scrolled back", async () => {
    const fake = await signedIn();
    const { daemon, registry } = fake;

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await scrollTo(0, 500);
    await settled(() => daemon.reads.length === 1);

    // The Daemon's marker comes back, and the Owner scrolls back from the latest.
    fold(
      fake,
      3,
      [],
      listed(iirc, "#iirc", "Channel", { changed: 3, latest: cursor(2000, 2), read: 2000 })
    );
    await scrollTo(0, 2000);

    // Something new arrives below, unseen.
    fold(
      fake,
      4,
      [message(4)],
      listed(iirc, "#iirc", "Channel", {
        changed: 4,
        latest: cursor(4000, 4),
        read: 2000,
        unread: { activity: 0, direct: 0, highlights: 0, messages: 1 },
      })
    );

    // Opened again from the palette, it stays where the Owner left it.
    await openFromPalette();
    await pause(250);

    expect({ open: registry.get(openTimeline)._tag, reads: daemon.reads }).toStrictEqual({
      open: "Shown",
      reads: [{ read: 2000, target: "#iirc" }],
    });
  });

  it("marks nothing when only a Gap after the last item is in view", async () => {
    const { daemon, registry } = await signedIn([{ count: 1, from: cursor(2500, 3), to: null }]);

    // The start, the "new" divider, two items, and the Gap, each a row of 20: the view
    // shows the Gap alone.
    layout.view = 15;
    layout.content = 100;
    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await scrollTo(85, 100);
    await pause(200);
    const gapOnly = daemon.reads.length;

    // Taller, the view shows the last item above the Gap too.
    layout.view = 40;
    await scrollTo(60, 100);
    await settled(() => daemon.reads.length === 1);

    expect({ gapOnly, reads: daemon.reads }).toStrictEqual({
      gapOnly: 0,
      reads: [{ read: 2000, target: "#iirc" }],
    });
  });

  it("reads older pages without scrolling while ui.activity hides every row of the latest, and marks nothing hidden", async () => {
    // One Message, then 250 joins: the latest two pages hold only joins.
    const items = [message(1), ...Array.from({ length: 250 }, (_, index) => joined(index + 2))];
    const { daemon, registry } = await signedIn([], items);

    registry.set(deviceUi, { activity: "quiet" });
    await openFromPalette();
    await settled(() => logOf().textContent?.includes("line 1"));
    await settled(() => daemon.reads.length > 0);
    await pause(200);

    expect({
      reads: daemon.reads,
      windows: daemon.windowsRead.map((query) => new URLSearchParams(query).has("before")),
    }).toStrictEqual({
      // Marked no further than the Message drawn, never a hidden join after it.
      reads: [{ read: 1000, target: "#iirc" }],
      windows: [false, true, true],
    });
  });

  it("keeps the line read where it was when ui.activity hides or shows rows above it", async () => {
    // Messages at odd steps, joins at even ones, 60 in all: the start of the Timeline is
    // the first row, so step `n` is row `n`.
    const items = Array.from({ length: 60 }, (_, index) =>
      index % 2 === 0 ? message(index + 1) : joined(index + 1)
    );

    const { registry } = await signedIn([], items);

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");

    // Scrolled back, with the join at step 20 at the top of the view, and line 21 below it,
    // past the "new" divider above the first unread row.
    await scrollTo(420, 100_000);

    const offsetOf = (text: string) => {
      const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
        one.textContent?.includes(text)
      );

      const start = Number(
        /translateY\((?<y>[\d.]+)px\)/u.exec(row?.style.transform ?? "")?.groups?.y
      );

      return start - logOf().scrollTop;
    };

    const before = offsetOf("line 21");

    await act(async () => {
      registry.set(deviceUi, { activity: "quiet" });
      await Promise.resolve();
    });

    const quiet = { offset: offsetOf("line 21"), top: logOf().scrollTop };

    await act(async () => {
      registry.set(deviceUi, {});
      await Promise.resolve();
    });

    expect({ again: offsetOf("line 21"), before, quiet }).toStrictEqual({
      again: 20,
      before: 20,
      // The join at the top hidden, line 19 before it takes its place, so line 21 stays
      // where it was, and the view stands ten rows higher with the joins above hidden.
      quiet: { offset: 20, top: 220 },
    });
  });

  it("never reads past the cap without asking, offers to on purpose, and jumps back to the latest, which it follows", async () => {
    // One Message, then 1,100 joins: past the cap, all hidden.
    const items = [message(1), ...Array.from({ length: 1100 }, (_, index) => joined(index + 2))];
    const fake = await signedIn([], items);
    const { daemon, registry } = fake;

    registry.set(deviceUi, { activity: "quiet" });
    await openFromPalette();

    // Read without asking up to the cap, with the latest kept, then held.
    await settled(() => logOf().textContent?.includes("Older history here is hidden activity"));
    const unasked = daemon.windowsRead.length;

    // Read on purpose: the newest go past the cap, and the Message is reached without
    // scrolling, with a way back to the latest.
    await press("Load older");
    await settled(() => logOf().textContent?.includes("line 1"));

    const reached = {
      jump: document.body.textContent?.includes("Jump to latest"),
      reads: [...daemon.reads],
    };

    // Something new arrives past the window, then the Owner jumps to the latest.
    const live = (sequence: number) => {
      fold(
        fake,
        sequence,
        [message(sequence)],
        listed(iirc, "#iirc", "Channel", {
          changed: sequence,
          latest: cursor(sequence * 1000, sequence),
          unread: { activity: 0, direct: 0, highlights: 0, messages: 1 },
        })
      );
    };

    live(1102);
    await press("Jump to latest");
    await settled(() => logOf().textContent?.includes("line 1102"));
    await settled(() => daemon.reads.length === 1);

    // Following, a live Message after it is drawn and marked read too.
    live(1103);
    await settled(() => logOf().textContent?.includes("line 1103"));
    await settled(() => daemon.reads.length === 2);

    expect({
      jumpAfter: document.body.textContent?.includes("Jump to latest"),
      reached,
      reads: daemon.reads,
      unasked,
    }).toStrictEqual({
      jumpAfter: false,
      reached: { jump: true, reads: [] },
      reads: [
        { read: 1_102_000, target: "#iirc" },
        { read: 1_103_000, target: "#iirc" },
      ],
      // The latest, and nine pages before it: a thousand items.
      unasked: 10,
    });
  });

  it("keeps a row in view when ui.activity hides every row before it, anchoring to the next that shows", async () => {
    // A Message long ago, joins 2 to 60, then Messages 61 to 120: the latest page begins
    // with 40 joins, with more before it, read up to its latest so no divider shows.
    const items = Array.from({ length: 120 }, (_, index) =>
      index === 0 || index >= 60 ? message(index + 1) : joined(index + 1)
    );

    const { registry } = await signedIn([], items, {
      read: 120_000,
      unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
    });

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");

    // Join 59, row 38, at the top of the view, and line 61 two rows below it.
    await scrollTo(760, 100_000);

    const offsetOf = (text: string) => {
      const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
        one.textContent?.includes(text)
      );

      const begins = Number(
        /translateY\((?<y>[\d.]+)px\)/u.exec(row?.style.transform ?? "")?.groups?.y
      );

      return begins - logOf().scrollTop;
    };

    const before = offsetOf("line 61");

    await act(async () => {
      registry.set(deviceUi, { activity: "quiet" });
      await Promise.resolve();
    });

    const clamped = logOf().scrollTop;

    // As a browser does once scrolled, the virtualizer draws where the view now stands, and
    // near the top, the page before is asked for and kept above without moving line 61.
    await act(async () => {
      logOf().dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });

    // Every row before it hidden, line 61 is the first row, scrolled no higher than the top.
    expect({ before, clamped, quiet: offsetOf("line 61") }).toStrictEqual({
      before: 40,
      clamped: 0,
      quiet: 0,
    });
  });

  it("reads nothing without asking in a Pane that cannot be seen, until it is shown", async () => {
    const items = [message(1), ...Array.from({ length: 250 }, (_, index) => joined(index + 2))];
    const { daemon, registry } = await signedIn([], items);

    registry.set(deviceUi, { activity: "quiet" });
    layout.view = 0;
    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await pause(200);
    const hidden = daemon.windowsRead.length;

    // Shown again, as a Pane moved back into the page is: it lays out and reads on.
    layout.view = 500;
    await act(async () => {
      logOf().closest("[data-pane-host]")?.dispatchEvent(new Event(movedEvent));
      await Promise.resolve();
    });
    // Both pages before are read, until the Message: the page before them holds it.
    await settled(() => daemon.windowsRead.length === 3);
    await pause(200);

    expect({ hidden, shown: daemon.windowsRead.length }).toStrictEqual({ hidden: 1, shown: 3 });
  });

  it("never drops the latest for a scroll to the top once the window holds as much as it can", async () => {
    // 1,200 joins, then a Message, the latest.
    const items = [...Array.from({ length: 1200 }, (_, index) => joined(index + 1)), message(1201)];
    const { daemon, registry } = await signedIn([], items);

    // The window as the core holds it: its first and last items, and whether more lie after.
    const held = () => {
      const shown = registry.get(openTimeline);

      return shown._tag === "Shown"
        ? {
            first: shown.window.items[0]?.sequence,
            last: shown.window.items.at(-1)?.sequence,
            later: shown.window.later,
          }
        : undefined;
    };

    await openFromPalette();
    await settled(() => held()?.last === 1201);

    // Scrolled to the top again and again: read on its own, up to as much as a window holds.
    for (let pages = 2; pages <= 10; pages += 1) {
      // oxlint-disable-next-line no-await-in-loop -- scrolled once each page is in
      await scrollTo(0, 100_000);
      // oxlint-disable-next-line no-await-in-loop -- scrolled once each page is in
      await settled(() => daemon.windowsRead.length === pages);
    }

    const full = held();

    // Every join hidden, then scrolled to the top by a script, as a browser fires it.
    await act(async () => {
      registry.set(deviceUi, { activity: "quiet" });
      await Promise.resolve();
    });
    await scrollTo(0, 100_000);
    await pause(200);

    expect({
      after: held(),
      full,
      jump: document.body.textContent?.includes("Jump to latest"),
      reads: daemon.windowsRead.length,
    }).toStrictEqual({
      after: { first: 202, last: 1201, later: false },
      full: { first: 202, last: 1201, later: false },
      jump: false,
      reads: 10,
    });
  });

  it("reads on without asking once the view is resized to be seen, with no move", async () => {
    // A ResizeObserver that reports only when told, for the log alone.
    const told: (() => void)[] = [];

    // oxlint-disable-next-line typescript/no-extraneous-class -- it stands in for the browser's class.
    class Observer {
      readonly #report: () => void;

      constructor(report: () => void) {
        this.#report = report;
      }

      observe(element: Element) {
        if (isLog(element)) {
          told.push(this.#report);
        }
      }

      unobserve() {
        return this;
      }

      disconnect() {
        return this;
      }
    }

    Reflect.set(globalThis, "ResizeObserver", Observer);

    try {
      const items = [message(1), ...Array.from({ length: 250 }, (_, index) => joined(index + 2))];
      const { daemon, registry } = await signedIn([], items);

      registry.set(deviceUi, { activity: "quiet" });
      layout.view = 0;
      await openFromPalette();
      await settled(() => registry.get(openTimeline)._tag === "Shown");
      await pause(200);
      const hidden = daemon.windowsRead.length;

      // Only its size changes: the observer reports it, and it reads on.
      layout.view = 500;
      await act(async () => {
        for (const report of told) {
          report();
        }

        await Promise.resolve();
      });
      await settled(() => daemon.windowsRead.length === 3);

      expect({ hidden, observed: told.length > 0 }).toStrictEqual({ hidden: 1, observed: true });
    } finally {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("draws no Gap before the first item of a Timeline read to its start, and one still open stays", async () => {
    const closed = await signedIn([{ count: 1, from: cursor(500, 1), to: cursor(800, 1) }]);

    await openFromPalette();
    await settled(() => closed.registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const withClosed = logOf().textContent;

    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    const open = await signedIn([{ count: 1, from: cursor(500, 1), to: null }]);

    await openFromPalette();
    await settled(() => open.registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    expect({
      closed: withClosed?.includes("not connected"),
      open: logOf().textContent?.includes("not connected since"),
      start: withClosed?.includes("The start of this Timeline"),
    }).toStrictEqual({ closed: false, open: true, start: true });
  });

  it("says nothing of a Message of ours the Ircd cannot confirm, and says one not sent", async () => {
    const { registry } = await signedIn(
      [],
      [
        message(1, { delivery: { _tag: "Unconfirmed" }, intent: "web-1" }),
        message(2, { delivery: { _tag: "Unsent" }, intent: "web-2" }),
      ]
    );

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const text = logOf().textContent ?? "";

    expect({
      notSent: text.includes("not sent"),
      unconfirmed: text.includes("unconfirmed"),
    }).toStrictEqual({ notSent: true, unconfirmed: false });
  });

  it("keeps a space between the parts of a row, so it reads as one run when the columns go", async () => {
    const { registry } = await signedIn();

    await openFromPalette();
    await settled(() => registry.get(openTimeline)._tag === "Shown");
    await settled(() => logOf().textContent?.includes("line 2"));

    const row = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].find((one) =>
      one.textContent?.includes("line 2")
    );

    expect(row?.textContent).toMatch(/^\S+ <\S+> line 2$/u);
  });
});

/** What a ResizeObserver reports of a box, as much of it as the page reads. */
interface Observed {
  readonly borderBoxSize: readonly { readonly blockSize: number; readonly inlineSize: number }[];
  readonly contentRect: DOMRect;
  readonly target: Element;
}

/** How a ResizeObserver reports. */
type Report = (entries: readonly Observed[]) => void;

/** What each ResizeObserver the page made watches, and how it reports. */
const observers = new Set<{ readonly report: Report; readonly watched: Set<Element> }>();

/** A ResizeObserver that reports only when told, as the browser's does after a layout. */
// oxlint-disable-next-line typescript/no-extraneous-class -- it stands in for the browser's class.
class Observer {
  readonly #own: { readonly report: Report; readonly watched: Set<Element> };

  constructor(report: Report) {
    this.#own = { report, watched: new Set() };
    observers.add(this.#own);
  }

  observe(element: Element) {
    this.#own.watched.add(element);
  }

  unobserve(element: Element) {
    this.#own.watched.delete(element);
  }

  disconnect() {
    this.#own.watched.clear();
  }
}

/**
 * Lays the log out again, as a browser does once its width or text size changed: every row
 * at a new height, what it holds as tall as they are, and each observer of the log or its
 * rows told of their boxes.
 * @param row - How tall each row is now.
 */
const wrapAgain = async (row: number) => {
  const rows = logOf().querySelector<HTMLElement>(":scope > div");
  const count = Number(rows?.style.height.replace("px", "") ?? "0") / layout.row;

  layout.row = row;
  layout.content = count * row;

  await act(async () => {
    for (const { report, watched } of observers) {
      const entries = [...watched].flatMap((target) => {
        const isRow = target instanceof HTMLElement && Object.hasOwn(target.dataset, "index");
        const height = isLog(target) ? layout.view : row;

        return target.isConnected && (isLog(target) || isRow)
          ? [
              {
                borderBoxSize: [{ blockSize: height, inlineSize: layout.width }],
                contentRect: new DOMRect(0, 0, layout.width, height),
                target,
              },
            ]
          : [];
      });

      if (entries.length > 0) {
        report(entries);
      }
    }

    await Promise.resolve();
  });
};

/**
 * The first row whose top is in view, by what it says, and how far below the top it starts.
 * @returns It.
 */
const firstInView = () => {
  const rows = [...logOf().querySelectorAll<HTMLElement>("[data-index]")].map((row) => ({
    offset:
      Number(/translateY\((?<y>[\d.]+)px\)/u.exec(row.style.transform)?.groups?.y) -
      logOf().scrollTop,
    text: /line \d+/u.exec(row.textContent ?? "")?.[0],
  }));

  return rows.toSorted((one, other) => one.offset - other.offset).find((row) => row.offset >= 0);
};

/**
 * `#iirc` with sixty Messages, open and laid out at its latest.
 * @returns The fake, and the registry.
 */
const opened = async () => {
  const fake = await signedIn(
    [],
    Array.from({ length: 60 }, (_, index) => message(index + 1))
  );

  await openFromPalette();
  await settled(() => fake.registry.get(openTimeline)._tag === "Shown");
  // Laid out as tall as its rows, and at the bottom, where it opens.
  await wrapAgain(20);
  await scrollTo(layout.content, layout.content);
  await settled(() => logOf().textContent?.includes("line 60"));

  return fake;
};

/**
 * Whether the core holds the open Timeline as following its latest.
 * @param registry - The registry.
 * @returns Whether it does.
 */
const following = (registry: Awaited<ReturnType<typeof opened>>["registry"]) => {
  const shown = registry.get(openTimeline);

  return shown._tag === "Shown" && shown.window.following;
};

/**
 * How far the log is from its end, as the Owner sees it.
 * @returns The distance.
 */
const fromEnd = () => layout.content - logOf().scrollTop - layout.view;

/**
 * The Owner gives input to the log that may scroll it: the wheel, a key that scrolls, or a
 * press, as on its scrollbar.
 * @param kind - Which.
 */
const give = async (kind: "wheel" | "key" | "pointer") => {
  const events = {
    key: () => new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }),
    pointer: () => new PointerEvent("pointerdown", { bubbles: true }),
    wheel: () => new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
  };

  await act(async () => {
    logOf().dispatchEvent(events[kind]());
    await Promise.resolve();
  });
};

/**
 * A Message said in `#iirc` as it is followed.
 * @param fake - The fake Daemon.
 * @param sequence - Its step.
 */
const live = (fake: Awaited<ReturnType<typeof opened>>, sequence: number) => {
  fold(
    fake,
    sequence,
    [message(sequence)],
    listed(iirc, "#iirc", "Channel", {
      changed: sequence,
      latest: cursor(sequence * 1000, sequence),
      unread: { activity: 0, direct: 0, highlights: 0, messages: 1 },
    })
  );
};

describe("where the view stands as its rows wrap again", () => {
  beforeEach(() => {
    layout.content = 0;
    layout.row = 20;
    layout.top = 0;
    layout.view = 400;
    layout.width = 800;
    layOut();
    observers.clear();
    Reflect.set(globalThis, "ResizeObserver", Observer);
    Reflect.set(window, "ResizeObserver", Observer);
  });

  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    Reflect.deleteProperty(globalThis, "ResizeObserver");
    Reflect.deleteProperty(window, "ResizeObserver");
  });

  it("keeps the first row in view where it was, just after the Owner scrolled up, and tells the core nothing new", async () => {
    const { daemon, registry } = await opened();

    // The Owner scrolls up, and the rows wrap again before the scroll has settled.
    await act(async () => {
      logOf().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
      await Promise.resolve();
    });
    await scrollTo(410, layout.content);

    const before = {
      first: firstInView(),
      following: following(registry),
      reads: daemon.reads.length,
    };

    await wrapAgain(40);

    const taller = {
      first: firstInView(),
      following: following(registry),
      reads: daemon.reads.length,
    };

    await wrapAgain(20);

    const back = {
      first: firstInView(),
      following: following(registry),
      reads: daemon.reads.length,
    };

    expect({ back, taller }).toStrictEqual({ back: before, taller: before });
    expect(before.first?.offset).toBe(10);
  });

  it("stays at the latest as its rows wrap again, though the browser moved the log as its box changed", async () => {
    const { registry } = await opened();
    const bottom = () => layout.content - layout.view;
    const atLatest = { following: following(registry), top: logOf().scrollTop === bottom() };

    // The Owner's wheel just now did nothing, at the bottom. Narrowed, the rows overflow
    // before they are measured, and the browser moves the log by a pixel.
    await act(async () => {
      logOf().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 800 }));
      await Promise.resolve();
    });
    const top = logOf().scrollTop;

    layout.width = 400;
    layout.content += 80;
    await scrollTo(top - 1, layout.content);
    await wrapAgain(40);

    expect({ following: following(registry), top: logOf().scrollTop === bottom() }).toStrictEqual(
      atLatest
    );
    expect(atLatest).toStrictEqual({ following: true, top: true });
  });

  it.each([
    ["just before the log's box changed", "before"],
    ["just after the log's box changed, before the view stood in it again", "after"],
  ] as const)(
    "lets the Owner leave the latest by the wheel %s, and keeps them there as a Message arrives",
    async (_, order) => {
      const fake = await opened();
      const { daemon, registry } = fake;

      // Every row measured, as tall as it is laid out.
      await wrapAgain(20);
      await wrapAgain(20);

      // The composer grows a line, so the log is shorter, as the Owner wheels up by 200.
      const from = logOf().scrollTop;

      if (order === "before") {
        await give("wheel");
        layout.view = 340;
      } else {
        layout.view = 340;
        await give("wheel");
      }

      await scrollTo(from - 200, layout.content);
      // The frame after: the log's observer reports its new box.
      await wrapAgain(20);

      const left = { following: following(registry), fromEnd: fromEnd() };
      const reads = daemon.reads.length;
      const top = logOf().scrollTop;

      // Away, the core leaves it beyond what the view draws, to be read on the way down.
      live(fake, 61);
      await settled(() => {
        const shown = registry.get(openTimeline);

        return shown._tag === "Shown" && shown.window.later;
      });
      await wrapAgain(20);
      await pause(250);

      expect({
        after: {
          following: following(registry),
          reads: daemon.reads.length,
          top: logOf().scrollTop,
        },
        left,
      }).toStrictEqual({
        after: { following: false, reads, top },
        // At the new end, then 200 up, as they wheeled.
        left: { following: false, fromEnd: 200 },
      });
    }
  );

  it.each(["wheel", "key", "pointer"] as const)(
    "lets a continuing gesture by the %s stand as the log's box changes on every frame",
    async (kind) => {
      const { registry } = await opened();

      // Every row measured, and the end, once the log is 40 pixels shorter.
      await wrapAgain(20);
      await wrapAgain(20);
      const end = layout.content - 360;
      const tops: number[] = [];

      // A trackpad's momentum wheels on, a held Page Up repeats, a dragged scrollbar stays
      // pressed, while the log is 40 pixels shorter, then taller, then shorter again.
      for (const view of [360, 400, 360, 400]) {
        if (kind !== "pointer" || tops.length === 0) {
          // oxlint-disable-next-line no-await-in-loop -- one frame after another
          await give(kind);
        }

        const from = logOf().scrollTop;

        layout.view = view;
        // oxlint-disable-next-line no-await-in-loop -- one frame after another
        await scrollTo(from - 100, layout.content);
        // oxlint-disable-next-line no-await-in-loop -- one frame after another
        await wrapAgain(20);
        tops.push(logOf().scrollTop);
      }

      await act(async () => {
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        await Promise.resolve();
      });

      // From the new end, a hundred up on each frame.
      expect({ following: following(registry), tops }).toStrictEqual({
        following: false,
        tops: [end - 100, end - 200, end - 300, end - 400],
      });
    }
  );

  it("takes a scroll in a changed box as the browser's, once the view stood itself again since the Owner's input", async () => {
    const { registry } = await opened();

    // The Owner wheels up, and the scroll it makes is theirs.
    await give("wheel");
    await scrollTo(logOf().scrollTop - 200, layout.content);

    const reading = {
      first: firstInView(),
      following: following(registry),
      top: logOf().scrollTop,
    };

    // Within the second their wheel lets a scroll be theirs, the log is shorter, and the view
    // stands itself in it. Then it is taller, and the browser moves the log as it changes.
    layout.view = 360;
    await wrapAgain(20);
    const from = logOf().scrollTop;

    layout.view = 400;
    await scrollTo(from - 30, layout.content);

    expect({
      first: firstInView(),
      following: following(registry),
      top: logOf().scrollTop,
    }).toStrictEqual(reading);
    expect({ following: reading.following }).toStrictEqual({ following: false });
  });
});
