// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import type { Timeline, TimelineItem, WindowGap } from "@iirc/api";
import { Effect } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { pageState } from "../page/atoms.ts";
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
    text: `line ${sequence}`,
  },
  level: "Message",
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
 * Messages, and nothing open.
 * @param gaps - The Gaps `#iirc` holds.
 * @returns The fake, the registry, and the page.
 */
const signedIn = async (gaps: readonly (typeof WindowGap.Encoded)[] = []) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.through = 2;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    {
      gaps: [...gaps],
      items: [message(1), message(2)],
      timeline: listed(iirc, "#iirc", "Channel", {
        latest: cursor(2000, 2),
        unread: { activity: 0, direct: 0, highlights: 0, messages: 2 },
      }),
    },
  ]);

  const registry = registryFor(fake.fetch);

  registry.set(pageState, { focused: true, visible: true });
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
 * and how tall what it holds is, which a test changes to scroll back.
 */
const layout = { content: 0, top: 0, view: 0 };

/** How tall each row is, as a browser would measure it. */
const rowHeight = 20;

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
      return Object.hasOwn(this.dataset, "index") ? rowHeight : 0;
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
        return new DOMRect(0, 0, 800, layout.view);
      }

      return new DOMRect(0, 0, 0, Object.hasOwn(this.dataset, "index") ? rowHeight : 0);
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

describe("what the view says it shows", () => {
  beforeEach(() => {
    layout.content = 0;
    layout.top = 0;
    layout.view = 500;
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
});
