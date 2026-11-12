// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId } from "@iirc/api";
import type { Timeline, TimelineItem } from "@iirc/api";
import { mainOf } from "@iirc/frontend/timelines";
import { Effect, Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { deviceUi } from "../options/device.ts";
import { pageState } from "../page/atoms.ts";
import { marking } from "../reading/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { open, openTimeline, sync, timelinesState } from "../timelines/atoms.ts";
import { searchState, selectResult } from "./atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);

// Text a hostile User could send: an override that would reverse what follows, markup, a
// control, and the word in mIRC's bold.
const override = String.fromCodePoint(0x20_2e);
const bell = String.fromCodePoint(0x07);
const bold = String.fromCodePoint(0x02);
const hostile = `${override}<img src=x onerror=alert(1)> ${bold}WoRd${bold}${bell} ten`;

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel",
  messages = 0
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: { activity: 0, direct: 0, highlights: 0, messages },
});

const message = (sequence: number): typeof TimelineItem.Encoded => ({
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
    target: "#iirc",
    text: sequence === 10 ? hostile : `a word ${sequence}`,
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: iirc,
});

const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

const pause = async (millis: number) => {
  await act(async () => {
    await Effect.runPromise(Effect.sleep(`${millis} millis`));
  });
};

/** How tall the view of the log and of the results is, and each row in them. */
const viewHeight = 400;

/** How tall the log's view is now, which a test changes as a Pane resized would. */
const view = { height: viewHeight };

const heightOf = (element: HTMLElement) =>
  element.getAttribute("role") === "log" ? view.height : viewHeight;

const rowHeight = 20;

const scrolls = (element: HTMLElement) =>
  element.getAttribute("role") === "log" || element.getAttribute("role") === "listbox";

const tops = new WeakMap<HTMLElement, number>();

/**
 * How tall what a log or the results hold is: the height the virtualizer set on its rows.
 * @param element - The log or the results.
 * @returns The height.
 */
const content = (element: HTMLElement) => {
  const { firstElementChild: rows } = element;

  return rows instanceof HTMLElement ? Number(rows.style.height.replace("px", "")) : 0;
};

/**
 * Lays out the log and the results as a browser would and happy-dom does not: each a view
 * 400 pixels tall, holding as much as its rows' total, which the virtualizer sets on its
 * first child, and each row 20 pixels tall.
 */
const layOut = () => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return scrolls(this) ? heightOf(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return scrolls(this) ? Math.max(heightOf(this), content(this)) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Object.hasOwn(this.dataset, "index") ? rowHeight : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrolls(this)
        ? Math.min(tops.get(this) ?? 0, Math.max(0, content(this) - heightOf(this)))
        : 0;
    },
    set(this: HTMLElement, top: number) {
      // Kept as the browser keeps it: clamped to what can be scrolled when it is set.
      tops.set(this, Math.min(top, Math.max(0, content(this) - heightOf(this))));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (scrolls(this)) {
        return new DOMRect(0, 0, 800, heightOf(this));
      }

      return new DOMRect(0, 0, 0, Object.hasOwn(this.dataset, "index") ? rowHeight : 0);
    },
  });
};

/**
 * The Frontend signed in, its page seen, marking read, with `#iirc` holding sixty
 * Messages, the tenth hostile, open.
 * @param unread - How many of them the Daemon counts unread.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async (unread = 0) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.through = 60;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    {
      gaps: [],
      items: Array.from({ length: 60 }, (_, index) => message(index + 1)),
      timeline: listed(iirc, "#iirc", "Channel", unread),
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

  await act(async () => {
    registry.set(open, Schema.decodeSync(TimelineId)(iirc));
    await Promise.resolve();
  });

  return { ...fake, container, registry };
};

/**
 * Presses a key on an element, as the browser dispatches it.
 * @param target - Where it is pressed.
 * @param init - The key and the modifiers held.
 */
const press = async (target: EventTarget, init: KeyboardEventInit) => {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    );
    await Promise.resolve();
  });
};

const searchField = () => document.querySelector<HTMLInputElement>("search input");

/**
 * Shows the search from the composer with Mod+Shift+F, and searches a query, as typed and
 * Entered.
 * @param container - The page.
 * @param registry - The registry.
 * @param query - The query.
 * @param count - How many it finds.
 */
const searchFor = async (
  container: HTMLElement,
  registry: ReturnType<typeof registryFor>,
  query: string,
  count: number
) => {
  await settled(() => container.querySelector('[role="log"]') !== null);
  const composer = container.querySelector("textarea");

  if (composer === null) {
    throw new Error("no composer");
  }

  await act(async () => {
    composer.focus();
    await Promise.resolve();
  });
  await press(composer, { ctrlKey: true, key: "F", shiftKey: true });
  await settled(() => searchField() !== null);
  const field = searchField();

  await act(async () => {
    if (field !== null) {
      Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        query
      );
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: query }));
      field.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    await Promise.resolve();
  });
  await settled(() => registry.get(searchState).results.length === count);
  await settled(() => container.querySelectorAll('[role="option"]').length > 0);
};

/**
 * The results' listbox.
 * @param container - The page.
 * @returns It.
 */
const resultsOf = (container: HTMLElement) => {
  const list = container.querySelector<HTMLElement>('[role="listbox"]');

  if (list === null) {
    throw new Error("no results");
  }

  return list;
};

/**
 * Jumps to the newest result of `word` from the composer, whose window holds the latest,
 * and sends the scroll a browser reports for where the view put the log.
 * @param container - The page.
 * @param registry - The registry.
 * @returns The log.
 */
const jumpToNewest = async (container: HTMLElement, registry: ReturnType<typeof registryFor>) => {
  await searchFor(container, registry, "word", 60);
  const list = resultsOf(container);

  await act(async () => {
    list.focus();
    await Promise.resolve();
  });
  await press(list, { key: "Enter" });
  await settled(() => container.querySelector('[role="log"] [data-index]') !== null);

  const log = container.querySelector<HTMLElement>('[role="log"]');

  if (log === null) {
    throw new Error("no log");
  }

  // The view brought the result into view, at the bottom, which a browser reports as a
  // scroll the Owner did not make.
  await act(async () => {
    log.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
  });
  await settled(() => container.querySelector("[data-target]") !== null);

  return log;
};

/**
 * The Owner wheels the log to a position, which a browser reports as a scroll.
 * @param log - The log.
 * @param top - Where it ends.
 */
const ownerScrolls = async (log: HTMLElement, top: number) => {
  await act(async () => {
    log.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: top - log.scrollTop }));
    log.scrollTop = top;
    log.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
  });
};

/**
 * The log's view resizes, and the view lays out again, as hiding Activity has it, putting
 * the log back where it stood itself, which a browser reports as a scroll.
 * @param log - The log.
 * @param registry - The registry.
 * @param height - The view's new height.
 */
const viewRestores = async (
  log: HTMLElement,
  registry: ReturnType<typeof registryFor>,
  height: number
) => {
  view.height = height;

  await act(async () => {
    registry.set(deviceUi, { activity: "quiet" });
    await Promise.resolve();
  });
  await act(async () => {
    log.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
  });
};

describe("the search view", () => {
  beforeEach(() => {
    view.height = viewHeight;
    layOut();
  });

  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }
  });

  it("searches from Mod+Shift+F, marks what it found as text, and jumps to it, centred and marked", async () => {
    const { container, daemon, registry } = await signedIn();

    await settled(() => container.querySelector('[role="log"]') !== null);
    const composer = container.querySelector("textarea");

    if (composer === null) {
      throw new Error("no composer");
    }

    composer.focus();
    await press(composer, { ctrlKey: true, key: "F", shiftKey: true });
    await settled(() => searchField() !== null);
    const field = searchField();

    if (field === null) {
      throw new Error("no search field");
    }

    const focusedField = document.activeElement === field;

    await act(async () => {
      Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        "word"
      );
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: "word" }));
      await Promise.resolve();
    });
    await act(async () => {
      field.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    await settled(() => registry.get(searchState).results.length === 60);
    await settled(() => container.querySelectorAll('[role="option"]').length > 0);

    const status = container.querySelector("output")?.textContent;
    const first = container.querySelector('[role="option"]');

    const list = container.querySelector<HTMLElement>('[role="listbox"]');

    if (list === null) {
      throw new Error("no results");
    }

    // The hostile one, tenth from the oldest, is drawn once the results are scrolled to it.
    await act(async () => {
      registry.set(selectResult, 50);
      list.scrollTop = 50 * rowHeight - 100;
      list.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    await settled(() =>
      [...container.querySelectorAll('[role="option"]')].some((row) =>
        row.textContent?.includes("ten")
      )
    );

    const hostileRow = [...container.querySelectorAll('[role="option"]')].find((row) =>
      row.textContent?.includes("ten")
    );

    const shown = {
      first: first?.querySelector("mark")?.textContent,
      hostile: {
        images: container.querySelectorAll("img").length,
        mark: hostileRow?.querySelector("mark")?.textContent,
        override: hostileRow?.textContent?.includes(override),
        text: hostileRow?.querySelector("mark")?.parentElement?.textContent,
      },
    };

    list.focus();
    await press(list, { key: "Enter" });

    await settled(() => {
      const one = registry.get(openTimeline);

      return one._tag === "Shown" && one.window.items.length > 0;
    });
    await settled(() => container.querySelector("[data-target]") !== null);

    const log = container.querySelector<HTMLElement>('[role="log"]');
    const target = container.querySelector("[data-target]");

    const jump = [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Jump to latest"
    );

    // Past the wait marking read takes, nothing was marked: the view is not at the latest.
    await pause(150);
    const marked = daemon.reads.length;

    if (log === null) {
      throw new Error("no log");
    }

    await act(async () => {
      log.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
      await Promise.resolve();
    });

    expect({
      around: daemon.windowsRead.some((one) => one.includes("around=")),
      focusedField,
      jump,
      left: container.querySelector("[data-target]"),
      marked,
      shown,
      status,
      target: [target?.textContent?.includes("ten"), log.scrollTop],
    }).toStrictEqual({
      around: true,
      focusedField: true,
      jump: true,
      left: null,
      marked: 0,
      shown: {
        first: "word",
        hostile: {
          images: 0,
          mark: "WoRd",
          override: false,
          text: "<img src=x onerror=alert(1)> WoRd ten",
        },
      },
      status: "60 found, newest first.",
      // The start, then items 1 to 10: the tenth's middle, 210, in the middle of 400.
      target: [true, 10],
    });
  });

  it("closes with Escape, showing the Timeline again, and shows what it found when opened again", async () => {
    const { container, registry } = await signedIn();

    await settled(() => container.querySelector('[role="log"]') !== null);
    const composer = container.querySelector("textarea");

    if (composer === null) {
      throw new Error("no composer");
    }

    await act(async () => {
      composer.focus();
      await Promise.resolve();
    });
    await press(composer, { ctrlKey: true, key: "F", shiftKey: true });
    await settled(() => searchField() !== null);

    await act(async () => {
      const field = searchField();

      if (field !== null) {
        Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          field,
          "word 5"
        );
        field.dispatchEvent(new InputEvent("input", { bubbles: true, data: "word 5" }));
        field.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }

      await Promise.resolve();
    });
    await settled(() => registry.get(searchState).results.length > 0);

    const field = searchField();

    if (field === null) {
      throw new Error("no search field");
    }

    await press(field, { key: "Escape" });
    const closed = mainOf(registry.get(timelinesState))._tag;
    const composerFocused = document.activeElement === composer;

    await press(composer, { ctrlKey: true, key: "F", shiftKey: true });
    await settled(() => searchField() !== null);

    expect({
      again: [searchField()?.value, registry.get(searchState).results.map((item) => item.sequence)],
      closed,
      composerFocused,
    }).toStrictEqual({
      again: ["word 5", [59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 5]],
      closed: "Timeline",
      composerFocused: true,
    });
  });

  it("marks nothing read after a jump to the newest result, until the Owner scrolls to the latest", async () => {
    const { container, daemon, registry } = await signedIn(60);
    const log = await jumpToNewest(container, registry);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= 8;

    // Past the wait marking read takes, and a layout or two, nothing was marked.
    await pause(200);
    const afterJump = daemon.reads.length;

    // The Owner scrolls up, away from the latest, and then back down to it themselves.
    await ownerScrolls(log, 100);
    await pause(200);
    const away = daemon.reads.length;

    await ownerScrolls(log, log.scrollHeight);
    await settled(() => daemon.reads.length > 0);

    expect({ afterJump, atBottom, away, read: daemon.reads[0]?.read }).toStrictEqual({
      afterJump: 0,
      atBottom: true,
      away: 0,
      read: 60_000,
    });
  });

  it("marks nothing read when a press that moved nothing is followed by the view's own scroll", async () => {
    const { container, daemon, registry } = await signedIn(60);
    const log = await jumpToNewest(container, registry);

    // A click in the log, which moves nothing, lets the result go.
    await act(async () => {
      log.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    await settled(() => container.querySelector("[data-target]") === null);

    // The Pane shrinks, and the view puts the log back at the bottom itself.
    await viewRestores(log, registry, 300);
    await pause(200);

    expect(daemon.reads).toStrictEqual([]);
  });

  it("marks nothing read when a wheel that moved nothing is followed by the view's own scroll", async () => {
    const { container, daemon, registry } = await signedIn(60);
    const log = await jumpToNewest(container, registry);

    // A wheel at the bottom, which moves nothing.
    await act(async () => {
      log.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
      await Promise.resolve();
    });

    await viewRestores(log, registry, 300);
    await pause(200);

    expect(daemon.reads).toStrictEqual([]);
  });

  it("keeps the selected result in the page wherever the results are scrolled", async () => {
    const { container, registry } = await signedIn();

    await searchFor(container, registry, "word", 60);
    const list = resultsOf(container);

    // Far from the first, which is selected, past every row drawn around the view.
    await act(async () => {
      list.scrollTop = 40 * rowHeight;
      list.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    await settled(() =>
      [...container.querySelectorAll('[role="option"]')].some((row) =>
        row.textContent?.includes("word 1")
      )
    );

    const active = list.getAttribute("aria-activedescendant") ?? "";

    const drawn = [...container.querySelectorAll<HTMLElement>('[role="option"]')].map(
      (row) => row.dataset.index ?? ""
    );

    expect({
      active: container.querySelector(`[id="${active}"]`)?.getAttribute("aria-selected"),
      far: drawn.includes("40"),
      first: drawn[0],
    }).toStrictEqual({ active: "true", far: true, first: "0" });
  });
});
