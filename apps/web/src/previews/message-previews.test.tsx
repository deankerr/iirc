// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId, uiDefaults } from "@iirc/api";
import type { PreviewItem, Timeline, TimelineItem } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { uiSync } from "../options/ui.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { open, sync } from "../timelines/atoms.ts";
import { previewsSync } from "./atoms.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mounted: (() => void)[] = [];

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (sequence: number) =>
  `${hex(BigInt(sequence * 1000) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const iirc = idOf(2);

const listed = (
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
 * A Message in `#iirc`, as the wire carries it.
 * @param sequence - Its step.
 * @param text - What it says.
 * @returns The item.
 */
const message = (sequence: number, text: string): typeof TimelineItem.Encoded => ({
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
    text,
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence),
  sequence,
  timeline: iirc,
});

const cats = "0123456789abcdef0123456789abcdef";

/**
 * The Preview of `https://example.com/cats`, as the wire carries it.
 * @param state - Where it stands.
 * @returns The item.
 */
const catsItem = (state: (typeof PreviewItem.Encoded)["state"]): typeof PreviewItem.Encoded => ({
  id: cats,
  link: "https://example.com/cats",
  state,
});

const ready = {
  _tag: "Ready",
  preview: {
    description: "A page about cats.",
    kind: "page",
    link: "https://example.com/cats",
    site: "example.com",
    title: "Cats",
    type: null,
  },
} as const;

/** What the view reads of an entry. */
interface Seen {
  readonly isIntersecting: boolean;
  readonly target: Element;
}

/** What the view does with its observer when told. */
interface Told {
  readonly disconnect: () => void;
}

/** How an intersection observer tells what it saw. */
type Tell = (entries: readonly Seen[], observer: Told) => void;

/** Each intersection observer made: what it observes, and how it tells. */
const observers = new Set<Observer>();

/** An intersection observer that sees only what a test says came into view. */
class Observer {
  readonly #tell: Tell;
  readonly #elements = new Set<Element>();

  constructor(tell: Tell) {
    this.#tell = tell;
    observers.add(this);
  }

  observe(element: Element) {
    this.#elements.add(element);
  }

  disconnect() {
    this.#elements.clear();
  }

  /** Tells that everything it observes came into view. */
  seen() {
    const entries = [...this.#elements].map((target) => ({ isIntersecting: true, target }));

    if (entries.length > 0) {
      this.#tell(entries, this);
    }
  }
}

/**
 * Says each element observed came into view, as a browser would as the Owner scrolls.
 */
const scrolledIntoView = async () => {
  await act(async () => {
    for (const observer of observers) {
      observer.seen();
    }

    await Promise.resolve();
  });
};

const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

const isLog = (element: Element) => element.getAttribute("role") === "log";

/** Lays the log out as a browser would, so the virtualizer draws its rows. */
const layOut = () => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? 400 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Object.hasOwn(this.dataset, "index") ? 20 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return isLog(this) ? new DOMRect(0, 0, 800, 400) : new DOMRect(0, 0, 0, 20);
    },
  });
};

/**
 * The Frontend signed in, with `ui.previews` as given and `#iirc` open, holding a Message
 * with a link to a page, which the Daemon answers for with the item given.
 * @param previews - `ui.previews`.
 * @param answer - What the Daemon answers for the Message, as it stands then.
 * @returns The fake, and the page.
 */
const opened = async (
  previews: "off" | "links only" | "on",
  answer: typeof PreviewItem.Encoded = catsItem({ _tag: "Pending" })
) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.ui = { options: { ...uiDefaults, previews }, sequence: 1 };
  fake.daemon.through = 2;
  fake.daemon.previews.set(cursor(2), [answer]);
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    {
      gaps: [],
      items: [message(1, "no link here"), message(2, "look https://example.com/cats")],
      timeline: listed(iirc, "#iirc", "Channel"),
    },
  ]);

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(uiSync);
  registry.mount(previewsSync);

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

  await settled(() => fake.daemon.followers.length === 1 && fake.daemon.uiFollowers.length === 1);

  await act(async () => {
    registry.set(open, Schema.decodeSync(TimelineId)(iirc));
    await Promise.resolve();
  });
  await settled(
    () => container.querySelector('[role="log"]')?.textContent?.includes("look") ?? false
  );

  return { ...fake, container };
};

/**
 * The Message's Previews, as a list.
 * @returns It, or none.
 */
const list = () => document.querySelector<HTMLElement>('ul[aria-label="Previews"]');

/**
 * The Previews, each as its state and what it says.
 * @returns Them.
 */
const drawn = () =>
  [...(list()?.querySelectorAll<HTMLElement>("[data-preview]") ?? [])].map((one) => ({
    state: one.dataset.preview,
    text: one.textContent,
  }));

describe("a Message's Previews", () => {
  beforeEach(() => {
    layOut();
    observers.clear();
    Reflect.set(globalThis, "IntersectionObserver", Observer);
    Reflect.set(window, "IntersectionObserver", Observer);
  });

  afterEach(() => {
    for (const unmount of mounted.splice(0)) {
      act(unmount);
    }

    Reflect.deleteProperty(globalThis, "IntersectionObserver");
    Reflect.deleteProperty(window, "IntersectionObserver");
  });

  it("asks for nothing until the Message scrolls into view, then once, however often it comes back", async () => {
    const { daemon } = await opened("links only");

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);

    // Drawn, a placeholder for its link, and not asked for.
    expect({ asks: daemon.previewAsks, drawn: drawn() }).toStrictEqual({
      asks: [],
      drawn: [{ state: "pending", text: "Previewing https://example.com/cats" }],
    });

    await scrolledIntoView();
    await settled(() => daemon.previewAsks.length === 1);
    await scrolledIntoView();
    await scrolledIntoView();

    expect(daemon.previewAsks).toStrictEqual([{ position: cursor(2), timeline: iirc }]);
  });

  it("shows a pending Preview ready once the stream says so, and opens its description on a press", async () => {
    const { daemon, sendPreview } = await opened("links only");

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => daemon.previewAsks.length === 1);

    await act(async () => {
      sendPreview(catsItem(ready));
      await Promise.resolve();
    });
    await settled(() => drawn()[0]?.state === "ready");

    const summary = list()?.querySelector<HTMLButtonElement>("button");

    expect({
      expanded: summary?.getAttribute("aria-expanded"),
      text: summary?.textContent,
    }).toStrictEqual({ expanded: "false", text: "example.com · Cats" });

    await act(async () => {
      summary?.click();
      await Promise.resolve();
    });

    expect({
      description: list()?.textContent?.includes("A page about cats."),
      expanded: summary?.getAttribute("aria-expanded"),
    }).toStrictEqual({ description: true, expanded: "true" });
  });

  it("shows a failure as the plain link, saying why on hover", async () => {
    const { daemon } = await opened(
      "links only",
      catsItem({ _tag: "Failed", reason: "Unreachable" })
    );

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "failed");

    const link = list()?.querySelector<HTMLAnchorElement>("a");

    expect({
      href: link?.getAttribute("href"),
      rel: link?.getAttribute("rel"),
      text: link?.textContent,
      title: link?.getAttribute("title"),
    }).toStrictEqual({
      href: "https://example.com/cats",
      rel: "noopener noreferrer",
      text: "https://example.com/cats",
      title: "No preview: the Daemon could not reach this link.",
    });
  });

  it("under off, shows nothing, follows nothing, and asks nothing", async () => {
    const { container, daemon } = await opened("off");

    await scrolledIntoView();

    expect({
      asks: daemon.previewAsks,
      followers: daemon.previewFollowers.length,
      list: list(),
      shown: container.textContent?.includes("https://example.com/cats"),
    }).toStrictEqual({ asks: [], followers: 0, list: null, shown: true });
  });
});
