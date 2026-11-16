// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId, uiDefaults } from "@iirc/api";
import type { PreviewItem, Timeline, TimelineItem } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/app.tsx";
import { deviceUi } from "../options/device.ts";
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
    image: null,
    kind: "page",
    link: "https://example.com/cats",
    site: "example.com",
    title: "Cats",
    type: null,
  },
} as const;

const hash = "cd".repeat(32);

/**
 * A ready Preview of the link, with an image the Daemon kept.
 * @param kind - A page, or a link that is itself an image.
 * @param animated - Whether the image moves.
 * @returns Its state.
 */
const readyWithImage = (kind: "page" | "image", animated = false) => {
  const imageType = animated ? "image/gif" : "image/png";

  return {
    _tag: "Ready",
    preview: {
      ...ready.preview,
      image: { animated, hash, size: 1234, type: imageType },
      kind,
      type: kind === "image" ? imageType : null,
    },
  } as const;
};

/**
 * A ready Preview of the link, which is itself a video or a sound.
 * @param kind - Which.
 * @returns Its state.
 */
const readyMedia = (kind: "video" | "audio") =>
  ({
    _tag: "Ready",
    preview: {
      ...ready.preview,
      kind,
      title: null,
      type: kind === "video" ? "video/mp4" : "audio/ogg",
    },
  }) as const;

/** The route the Daemon streams `cats` from, for the Message at step 2 in `#iirc`. */
const streamOfCats = `/api/previews/${cats}/stream?timeline=${iirc}&position=${cursor(2)}`;

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
 * @param timelines - `ui.previews.timelines`, none unless given.
 * @param animate - `ui.previews.animate`, shared, off unless given.
 * @returns The fake, the registry, and the page.
 */
const opened = async (
  previews: "off" | "links only" | "on",
  answer: typeof PreviewItem.Encoded = catsItem({ _tag: "Pending" }),
  timelines: { readonly [timeline: string]: "off" | "links only" | "on" } = {},
  animate = false
) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.ui = {
    options: {
      ...uiDefaults,
      previews,
      "previews.animate": animate,
      "previews.timelines": timelines,
    },
    sequence: 1,
  };
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

  return { ...fake, container, registry };
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

/**
 * The summary line of the Message's first Preview, without the description under it.
 * @returns Its text.
 */
const summaryLine = () => list()?.querySelector("button")?.textContent;

/**
 * Waits for the Message's image to be drawn, and says it came into view, as a browser
 * would as the Owner scrolls it there.
 */
const imageSeen = async () => {
  await settled(() => list()?.querySelector("[data-loaded]") !== null);
  await scrolledIntoView();
};

/**
 * One of the Message's image's buttons, by what it says.
 * @param name - Its accessible name.
 * @returns It, or none.
 */
const imageButton = (name: string) =>
  list()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ?? null;

/**
 * The larger view, if it is open.
 * @returns It, or none.
 */
const larger = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

/**
 * Presses a button as a person does: it takes focus, and then it is pressed.
 * @param button - The button.
 */
const pressed = async (button: HTMLButtonElement | null) => {
  await act(async () => {
    button?.focus();
    button?.click();
    await Promise.resolve();
  });
};

/** Each stub a test made of the browser, to be put back. */
const restores: (() => void)[] = [];

/**
 * Stands in the browser's media: the Daemon's bytes fetched, decoded to a frame of a size,
 * drawn on a canvas, and held by an object URL.
 * @returns What it was asked.
 */
const stubMedia = () => {
  const revoked: string[] = [];
  const draws: [number, number][] = [];
  let made = 0;

  const fetching = vi
    .fn<(input: string) => Promise<Response>>()
    .mockResolvedValue(new Response(new Uint8Array([71, 73, 70]), { status: 200 }));

  vi.stubGlobal("fetch", fetching);
  vi.stubGlobal(
    "createImageBitmap",
    vi
      .fn<() => Promise<{ close: () => void; height: number; width: number }>>()
      .mockResolvedValue({ close: vi.fn<() => void>(), height: 48, width: 64 })
  );

  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    made += 1;

    return `blob:media-${made}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revoked.push(url);
  });

  // happy-dom draws nothing, so a stand-in takes the one call the page makes.
  const context = {
    drawImage: (frame: { width: number; height: number }) => {
      draws.push([frame.width, frame.height]);
    },
  };

  // SAFETY: the page only draws an image onto what it is given.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);

  restores.push(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  return { draws, fetches: () => fetching.mock.calls.map(([input]) => input), revoked };
};

/**
 * Sets the device to reduce motion, or not, for what mounts after.
 * @param reduce - Whether it does.
 */
const reducingMotion = (reduce: boolean) => {
  const original = window.matchMedia.bind(window);

  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const list = original(query);

    if (query.includes("prefers-reduced-motion")) {
      Object.defineProperty(list, "matches", { value: reduce });
    }

    return list;
  });
  restores.push(() => {
    vi.restoreAllMocks();
  });
};

/**
 * The Message's animated image, played or not, once it was fetched.
 * @returns What is drawn of it.
 */
const animated = () => ({
  badge: list()?.querySelector('[data-badge="play"]') !== null,
  canvas: list()?.querySelector("canvas") !== null,
  playing: list()?.querySelector("img")?.getAttribute("src") ?? null,
});

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

    for (const restore of restores.splice(0)) {
      restore();
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

  it("shows a page's image as a thumbnail from the media route, beside its summary", async () => {
    const { daemon } = await opened("on", catsItem(readyWithImage("page")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();

    const image = list()?.querySelector("img");

    expect({
      alt: image?.getAttribute("alt"),
      decoding: image?.getAttribute("decoding"),
      drawn: image?.dataset.drawn,
      loading: image?.getAttribute("loading"),
      referrerPolicy: image?.getAttribute("referrerpolicy"),
      src: image?.getAttribute("src"),
      text: summaryLine(),
    }).toStrictEqual({
      alt: "Cats",
      decoding: "async",
      drawn: "thumbnail",
      loading: "lazy",
      referrerPolicy: "no-referrer",
      src: `/api/previews/media/${hash}`,
      text: "example.com · Cats",
    });
  });

  it("shows a link that is itself an image as the image", async () => {
    const { daemon } = await opened("on", catsItem(readyWithImage("image")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("img") !== null);

    const image = list()?.querySelector("img");

    expect({
      alt: image?.getAttribute("alt"),
      drawn: image?.dataset.drawn,
      src: image?.getAttribute("src"),
    }).toStrictEqual({ alt: "Cats", drawn: "whole", src: `/api/previews/media/${hash}` });
  });

  it("draws a link that is itself a video as a player that fetches nothing until pressed", async () => {
    const { daemon } = await opened("on", catsItem(readyMedia("video")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => list()?.querySelector("video") !== null);

    const video = list()?.querySelector("video");

    expect({
      audio: list()?.querySelector("audio"),
      autoplay: video?.autoplay,
      controls: video?.controls,
      kind: video?.dataset.previewMedia,
      label: video?.getAttribute("aria-label"),
      preload: video?.getAttribute("preload"),
      src: video?.getAttribute("src"),
      text: summaryLine(),
    }).toStrictEqual({
      audio: null,
      autoplay: false,
      controls: true,
      kind: "video",
      label: "Play video · video/mp4 · example.com",
      preload: "none",
      src: streamOfCats,
      text: "video · video/mp4 · example.com",
    });
  });

  it("draws a link that is itself a sound as a player likewise", async () => {
    const { daemon } = await opened("on", catsItem(readyMedia("audio")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => list()?.querySelector("audio") !== null);

    const audio = list()?.querySelector("audio");

    expect({
      controls: audio?.controls,
      kind: audio?.dataset.previewMedia,
      preload: audio?.getAttribute("preload"),
      src: audio?.getAttribute("src"),
      video: list()?.querySelector("video"),
    }).toStrictEqual({
      controls: true,
      kind: "audio",
      preload: "none",
      src: streamOfCats,
      video: null,
    });
  });

  it("falls back to the text alone when a player fails to load", async () => {
    const { daemon } = await opened("on", catsItem(readyMedia("video")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => list()?.querySelector("video") !== null);

    await act(async () => {
      list()?.querySelector("video")?.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });

    expect({
      state: drawn()[0]?.state,
      text: summaryLine(),
      video: list()?.querySelector("video"),
    }).toStrictEqual({ state: "ready", text: "video · video/mp4 · example.com", video: null });
  });

  it("draws a video or sound link as its text alone under links only", async () => {
    const { daemon } = await opened("links only", catsItem(readyMedia("video")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");

    expect({
      media: list()?.querySelectorAll("video, audio").length,
      state: drawn()[0]?.state,
      text: summaryLine(),
    }).toStrictEqual({ media: 0, state: "ready", text: "video · video/mp4 · example.com" });
  });

  it("falls back to the text row when an image fails to load", async () => {
    const { daemon } = await opened("on", catsItem(readyWithImage("page")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("img") !== null);

    await act(async () => {
      list()?.querySelector("img")?.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });

    expect({
      image: list()?.querySelector("img"),
      state: drawn()[0]?.state,
      text: summaryLine(),
    }).toStrictEqual({ image: null, state: "ready", text: "example.com · Cats" });
  });

  it("falls back to the text row, summary and all, when a link that is an image fails to load", async () => {
    const { daemon } = await opened("on", catsItem(readyWithImage("image")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("img") !== null);

    await act(async () => {
      list()?.querySelector("img")?.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });

    expect({
      image: list()?.querySelector("img"),
      state: drawn()[0]?.state,
      text: summaryLine(),
    }).toStrictEqual({
      image: null,
      state: "ready",
      text: "image · image/png · Cats · example.com",
    });
  });

  it("draws a Preview with no image as the text row alone", async () => {
    const { daemon } = await opened("on", catsItem(ready));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");

    expect({
      image: list()?.querySelector("img"),
      state: drawn()[0]?.state,
      text: summaryLine(),
    }).toStrictEqual({ image: null, state: "ready", text: "example.com · Cats" });
  });

  it("shows a link waiting for a press with a press, which fetches it, and its Preview arrives", async () => {
    const { daemon, sendPreview } = await opened(
      "links only",
      catsItem({ _tag: "WaitingForPress" })
    );

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "waiting");

    const waiting = { drawn: drawn(), presses: [...daemon.presses] };
    const press = list()?.querySelector<HTMLButtonElement>("button");

    await act(async () => {
      press?.click();
      await Promise.resolve();
    });
    await settled(() => drawn()[0]?.state === "pending");
    await act(async () => {
      sendPreview(catsItem(ready));
      await Promise.resolve();
    });
    await settled(() => drawn()[0]?.state === "ready");

    expect({
      label: press?.getAttribute("aria-label"),
      presses: daemon.presses,
      text: summaryLine(),
      waiting,
    }).toStrictEqual({
      label: "Show a preview of https://example.com/cats",
      presses: [{ link: 0, position: cursor(2), timeline: iirc }],
      text: "example.com · Cats",
      waiting: {
        drawn: [{ state: "waiting", text: "https://example.com/catsshow preview" }],
        presses: [],
      },
    });
  });

  it("follows a Timeline's own choice over ui.previews", async () => {
    const { daemon } = await opened("off", catsItem({ _tag: "Pending" }), { [iirc]: "links only" });

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => daemon.previewAsks.length === 1);

    expect(daemon.previewAsks).toStrictEqual([{ position: cursor(2), timeline: iirc }]);
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

  it("draws no image, and gives none a source, until it scrolls into view", async () => {
    const { daemon } = await opened("on", catsItem(readyWithImage("page")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");

    const before = list()?.querySelectorAll("img, canvas").length;

    await imageSeen();

    expect({ after: list()?.querySelectorAll("img").length, before }).toStrictEqual({
      after: 1,
      before: 0,
    });
  });

  it("opens a still image large on a press, with a link to its page, which Escape closes, and focus returns", async () => {
    const { daemon } = await opened("on", catsItem(readyWithImage("image")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => imageButton("Open Cats large") !== null);

    const button = imageButton("Open Cats large");

    await pressed(button);
    await settled(() => larger() !== null);

    const link = larger()?.querySelector("a");

    const open = {
      href: link?.getAttribute("href"),
      image: larger()?.querySelector("img")?.getAttribute("src"),
      name: larger()?.getAttribute("aria-label"),
      // It lies over the page, outside the Pane that holds the Message.
      outside: list()?.contains(larger()) === false && document.body.contains(larger()),
      rel: link?.getAttribute("rel"),
      target: link?.getAttribute("target"),
      text: link?.textContent,
    };

    await act(async () => {
      larger()?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      );
      await Promise.resolve();
    });
    await settled(() => larger() === null);
    await settled(() => document.activeElement === button);

    expect(open).toStrictEqual({
      href: "https://example.com/cats",
      image: `/api/previews/media/${hash}`,
      name: "Cats",
      outside: true,
      rel: "noopener noreferrer",
      target: "_blank",
      text: "https://example.com/cats",
    });
  });

  it("closes the larger view on a press outside it", async () => {
    const { daemon } = await opened("on", catsItem(readyWithImage("page")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => imageButton("Open Cats large") !== null);

    const button = imageButton("Open Cats large");

    await pressed(button);
    await settled(() => larger() !== null);

    // The overlay, React Aria's dimmed layer around the dialog, is what a tap beside it lands on.
    const overlay = larger()?.closest('[style*="--visual-viewport"]');

    await act(async () => {
      overlay?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      overlay?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await settled(() => larger() === null);
    await settled(() => document.activeElement === button);

    expect(larger()).toBeNull();
  });

  it("draws an animated image as its first frame under a play badge, fetched once it is in view, and plays it on a press", async () => {
    const { fetches, draws, revoked } = stubMedia();
    const { daemon } = await opened("on", catsItem(readyWithImage("image", true)));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");

    const unseen = { fetches: fetches(), image: list()?.querySelectorAll("img, canvas").length };

    await imageSeen();
    await settled(() => list()?.querySelector("canvas") !== null);

    const still = { ...animated(), draws: [...draws], fetches: fetches() };
    const canvas = list()?.querySelector("canvas");

    await pressed(imageButton("Play Cats"));
    await settled(() => list()?.querySelector("img") !== null);

    const playing = {
      ...animated(),
      fetches: fetches(),
      stop: imageButton("Stop Cats") !== null,
    };

    await pressed(imageButton("Stop Cats"));
    await settled(() => list()?.querySelector("canvas") !== null);

    expect({
      back: animated(),
      playing,
      size: [canvas?.getAttribute("width"), canvas?.getAttribute("height")],
      still,
      unseen,
    }).toStrictEqual({
      back: { badge: true, canvas: true, playing: null },
      playing: {
        badge: false,
        canvas: false,
        fetches: [`/api/previews/media/${hash}`],
        playing: "blob:media-1",
        stop: true,
      },
      size: ["64", "48"],
      still: {
        badge: true,
        canvas: true,
        draws: [[64, 48]],
        fetches: [`/api/previews/media/${hash}`],
        playing: null,
      },
      unseen: { fetches: [], image: 0 },
    });
    expect(revoked).toStrictEqual([]);
  });

  it("opens a playing animated image large from its own control, playing there", async () => {
    stubMedia();
    const { daemon } = await opened("on", catsItem(readyWithImage("page", true)));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("canvas") !== null);

    const stillOnly = imageButton("Open Cats large");

    await pressed(imageButton("Play Cats"));
    await settled(() => imageButton("Open Cats large") !== null);

    const enlarge = imageButton("Open Cats large");

    await pressed(enlarge);
    await settled(() => larger() !== null);

    expect({
      href: larger()?.querySelector("a")?.getAttribute("href"),
      src: larger()?.querySelector("img")?.getAttribute("src"),
      stillOnly,
    }).toStrictEqual({
      href: "https://example.com/cats",
      src: "blob:media-1",
      stillOnly: null,
    });
  });

  it("plays an animated image on its own with animate on, shared or this device's own, and keeps it still where this device's is off", async () => {
    stubMedia();

    const shared = await opened("on", catsItem(readyWithImage("image", true)), {}, true);

    await settled(() => shared.daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("img") !== null);

    const playsShared = animated();

    await act(async () => {
      shared.registry.set(deviceUi, { "previews.animate": false });
      await Promise.resolve();
    });
    await settled(() => list()?.querySelector("canvas") !== null);

    const stillOverridden = animated();

    expect({ playsShared, stillOverridden }).toStrictEqual({
      playsShared: { badge: false, canvas: false, playing: "blob:media-1" },
      stillOverridden: { badge: true, canvas: true, playing: null },
    });
  });

  it("plays an animated image on its own where only this device turns animate on", async () => {
    stubMedia();

    const { daemon, registry } = await opened("on", catsItem(readyWithImage("image", true)));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("canvas") !== null);

    const before = animated();

    await act(async () => {
      registry.set(deviceUi, { "previews.animate": true });
      await Promise.resolve();
    });
    await settled(() => list()?.querySelector("img") !== null);

    expect({ after: animated(), before }).toStrictEqual({
      after: { badge: false, canvas: false, playing: "blob:media-1" },
      before: { badge: true, canvas: true, playing: null },
    });
  });

  it("keeps an animated image still under reduced motion with animate on, and plays it on a press", async () => {
    stubMedia();
    reducingMotion(true);

    const { daemon } = await opened("on", catsItem(readyWithImage("image", true)), {}, true);

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("canvas") !== null);

    const still = animated();

    await pressed(imageButton("Play Cats"));
    await settled(() => list()?.querySelector("img") !== null);

    expect({ playing: animated(), still }).toStrictEqual({
      playing: { badge: false, canvas: false, playing: "blob:media-1" },
      still: { badge: true, canvas: true, playing: null },
    });
  });

  it("falls back to the text row when an animated image cannot be fetched", async () => {
    stubMedia();
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>().mockResolvedValue(new Response(null, { status: 404 }))
    );

    const { daemon } = await opened("on", catsItem(readyWithImage("page", true)));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("[data-loaded]") === null);

    expect({
      image: list()?.querySelectorAll("img, canvas").length,
      state: drawn()[0]?.state,
      text: summaryLine(),
    }).toStrictEqual({ image: 0, state: "ready", text: "example.com · Cats" });
  });
});
