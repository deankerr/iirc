// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId, uiDefaults } from "@iirc/api";
import type { PreviewItem, Timeline, TimelineItem, UiOptions } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/app.tsx";
import { deviceUi } from "../options/device.ts";
import { optionsState } from "../options/state.ts";
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
 * A Message in `#iirc`, as the wire carries it.
 * @param sequence - Its step.
 * @param text - What it says.
 * @returns The item.
 */
const message = (sequence: number, text: string): typeof TimelineItem.Encoded => ({
  answered: null,
  changed: sequence,
  content: {
    _tag: "Message",
    answers: null,
    at: { _tag: "Unknown" },
    bot: false,
    context: null,
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
    player: null,
    site: "example.com",
    stream: null,
    title: "Cats",
    type: null,
  },
} as const;

const hash = "cd".repeat(32);

/** An image's width and height in pixels, as the Daemon read them from its bytes. */
interface Dimensions {
  readonly height: number;
  readonly width: number;
}

/**
 * A ready Preview of the link, with an image the Daemon kept.
 * @param kind - A page, or a link that is itself an image.
 * @param animated - Whether the image moves.
 * @param dimensions - The image's size in pixels, if the Daemon read it.
 * @returns Its state.
 */
const readyWithImage = (
  kind: "page" | "image",
  animated = false,
  dimensions: Dimensions | null = null
) => {
  const imageType = animated ? "image/gif" : "image/png";

  return {
    _tag: "Ready",
    preview: {
      ...ready.preview,
      // The Daemon gives a link that is itself an image no words.
      description: kind === "image" ? null : ready.preview.description,
      image: { animated, dimensions, hash, size: 1234, type: imageType },
      kind,
      title: kind === "image" ? null : ready.preview.title,
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
      description: null,
      kind,
      stream: ready.preview.link,
      title: null,
      type: kind === "video" ? "video/mp4" : "audio/ogg",
    },
  }) as const;

/** Where the page's video file is, which no page of ours may ever draw or load. */
const videoFile = "https://media.example.com/cat.mp4";

/**
 * A ready Preview of the link, which is a page that names a video file, with its poster.
 * @param poster - Whether the Daemon kept the poster.
 * @param animated - Whether the poster moves.
 * @param dimensions - The poster's size in pixels, if the Daemon read it.
 * @returns Its state.
 */
const readyVideoPage = (poster = true, animated = false, dimensions: Dimensions | null = null) =>
  ({
    _tag: "Ready",
    preview: {
      ...ready.preview,
      description: null,
      image: poster
        ? {
            animated,
            dimensions,
            hash,
            size: 1234,
            type: animated ? ("image/gif" as const) : ("image/jpeg" as const),
          }
        : null,
      kind: "video",
      stream: videoFile,
      title: "A cat",
      type: "video/mp4",
    },
  }) as const;

/** Where the page's player plays from, which no page of ours may ever draw or load. */
const playerAddress = "https://www.youtube-nocookie.com/embed/abc123";
const playerHost = "www.youtube-nocookie.com";

/**
 * A ready Preview of the link, which is a player from a listed host.
 * @param poster - Whether the Daemon kept the poster.
 * @param animated - Whether the poster moves.
 * @param dimensions - The poster's size in pixels, if the Daemon read it.
 * @returns Its state.
 */
const readyPlayer = (poster: boolean, animated = false, dimensions: Dimensions | null = null) =>
  ({
    _tag: "Ready",
    preview: {
      ...ready.preview,
      description: null,
      image: poster
        ? {
            animated,
            dimensions,
            hash,
            size: 1234,
            type: animated ? ("image/gif" as const) : ("image/jpeg" as const),
          }
        : null,
      kind: "player",
      link: "https://www.youtube.com/watch?v=abc123",
      player: { link: playerAddress, size: { height: 360, width: 640 } },
      stream: null,
      title: "A song",
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

/** How cards start, how tall their media is, and how a line is laid out. */
type Look = Partial<Pick<UiOptions, "previews.start" | "previews.mediaHeight" | "timeline.layout">>;

/**
 * The Frontend signed in, with `ui.previews` as given and `#iirc` open, or a Direct Message
 * with `peer` where `also.direct` is set, holding a Message with a link to a page, which the Daemon answers for with the item given.
 * @param previews - `ui.previews`.
 * @param answer - What the Daemon answers for the Message, as it stands then.
 * @param timelines - `ui.previews.timelines`, none unless given.
 * @param animate - `ui.previews.animate`, shared, off unless given.
 * @param also - How cards start and are sized, shared, `open` unless given so each is drawn
 *   whole, a second link's answer, which the Message then holds after the first, and
 *   whether the Timeline is a Direct Message.
 * @returns The fake, the registry, and the page.
 */
const opened = async (
  previews: "off" | "text" | "on",
  answer: typeof PreviewItem.Encoded = catsItem({ _tag: "Pending" }),
  timelines: { readonly [timeline: string]: "off" | "text" | "on" } = {},
  animate = false,
  also: {
    readonly look?: Look;
    readonly dogs?: typeof PreviewItem.Encoded | undefined;
    readonly direct?: boolean;
  } = {}
) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.ui = {
    options: {
      ...uiDefaults,
      previews,
      "previews.animate": animate,
      "previews.start": "open",
      "previews.timelines": timelines,
      ...also.look,
    },
    sequence: 1,
  };
  fake.daemon.through = 2;
  fake.daemon.previews.set(cursor(2), also.dogs === undefined ? [answer] : [answer, also.dogs]);
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    {
      gaps: [],
      items: [
        message(1, "no link here"),
        message(
          2,
          also.dogs === undefined
            ? "look https://example.com/cats"
            : "look https://example.com/cats and https://example.com/dogs"
        ),
      ],
      timeline:
        also.direct === true ? listed(iirc, "peer", "Direct") : listed(iirc, "#iirc", "Channel"),
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

  // The shared options read, so a window read knows whether its Timeline's Previews are.
  await settled(
    () => fake.daemon.followers.length === 1 && registry.get(optionsState).ui !== undefined
  );

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
 * How tall the Message's Previews draw their media at most.
 * @returns The height, as the list's custom property holds it.
 */
const mediaHeight = () => list()?.style.getPropertyValue("--preview-media-height");

/**
 * One of the Message's Previews, as drawn.
 * @param index - Which, the first unless given.
 * @returns It, or none.
 */
const card = (index = 0) => list()?.querySelectorAll<HTMLElement>("[data-preview]")[index];

/**
 * The toggle after a link, as drawn.
 * @param index - Which, the first unless given.
 * @returns It, or none.
 */
const toggle = (index = 0) =>
  document.querySelectorAll<HTMLButtonElement>("[data-preview-toggle]")[index] ?? null;

/**
 * The press of a card's description that was cut, if it was.
 * @returns It, or none.
 */
const more = () =>
  card()?.firstElementChild?.querySelector<HTMLButtonElement>("[aria-expanded]") ?? null;

/**
 * The press of a card's description that says it is about cats, never the control that
 * opens a poster large.
 * @returns It, or none.
 */
const catsDescription = () =>
  [...(list()?.querySelectorAll<HTMLButtonElement>("[aria-expanded]") ?? [])].find(
    (one) => one.textContent === "A page about cats."
  ) ?? null;

/**
 * What a card says, its words and its media's together.
 * @returns Its text.
 */
const cardText = () => card()?.textContent;

/**
 * A card's words, each part as its text, in the order drawn.
 * @returns Them, none when it has no words.
 */
const words = () => {
  const first = card()?.firstElementChild;
  const parts = first?.querySelector("[data-loaded], video, audio") === null ? first : undefined;

  return [...(parts?.children ?? [])].map((part) => part.textContent);
};

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

/**
 * Opens the Message with the player's Preview ready, and its poster, if any, in view.
 * @param poster - Whether the Daemon kept a poster.
 * @param mode - `ui.previews`, on unless given.
 * @param dimensions - The poster's size in pixels, if the Daemon read it.
 * @returns The fake Daemon, to send the stream more.
 */
const withPlayer = async (
  poster: boolean,
  mode: "on" | "text" = "on",
  dimensions: Dimensions | null = null
) => {
  const fake = await opened(mode, catsItem(readyPlayer(poster, false, dimensions)));
  const { daemon } = fake;

  await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
  await scrolledIntoView();
  await settled(() => drawn()[0]?.state === "ready");

  if (poster && mode === "on") {
    await imageSeen();
    await settled(() => list()?.querySelector("img") !== null);
  }

  return fake;
};

const playButton = () => imageButton(`Play from ${playerHost}`);

/**
 * Every attribute in the page that holds the player's address.
 * @returns Each, as its element and name.
 */
const holdingAddress = () =>
  [...document.body.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes].flatMap((attribute) =>
      /embed\/abc123|youtube-nocookie\.com\//u.test(attribute.value)
        ? [`${element.localName}[${attribute.name}]`]
        : []
    )
  );

/**
 * What the player's frame is, as drawn.
 * @returns Every frame's attributes, with how it is styled only as present, and whether a
 * poster or the play button is left.
 */
const framed = () => ({
  frames: [...document.body.querySelectorAll("iframe")].map((frame) =>
    Object.fromEntries(
      [...frame.attributes].map(({ name, value }) => [
        name,
        name === "class" || name === "style" ? "drawn" : value,
      ])
    )
  ),
  poster: list()?.querySelector("img, canvas") !== null,
  press: playButton() !== null,
  text: list()?.textContent,
});

const frame = {
  allow: "autoplay; fullscreen; encrypted-media; picture-in-picture",
  class: "drawn",
  referrerpolicy: "strict-origin",
  sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups",
  src: `${playerAddress}?autoplay=1`,
  style: "drawn",
  title: `Player from ${playerHost}`,
};

/**
 * Opens the Message with the page's video ready, and its poster, if any, in view.
 * @param mode - `ui.previews`, on unless given.
 * @param poster - Whether the Daemon kept a poster.
 * @param animatedPoster - Whether the poster moves.
 * @param dimensions - The poster's size in pixels, if the Daemon read it.
 * @returns The fake Daemon.
 */
const withVideo = async (
  mode: "on" | "text" = "on",
  poster = true,
  animatedPoster = false,
  dimensions: Dimensions | null = null
) => {
  const fake = await opened(mode, catsItem(readyVideoPage(poster, animatedPoster, dimensions)));

  await settled(() => fake.daemon.previewFollowers.length === 1 && list() !== null);
  await scrolledIntoView();
  await settled(() => drawn()[0]?.state === "ready");

  if (poster && mode === "on") {
    await imageSeen();
    await settled(() => list()?.querySelector("img, canvas") !== null);
  }

  return fake;
};

/**
 * What gives a box its shape and its limit, as the page sets it, for a holder, a video's
 * box, or a frame. jsdom does no layout, so this is what the stylesheet is given.
 * @param element - The box.
 * @returns Its proportions, and how wide it is at most, as set.
 */
const boxOf = (element: Element | null | undefined) => {
  const style = element instanceof HTMLElement ? element.style : undefined;

  return {
    atMost: style?.getPropertyValue("--box-at-most"),
    height: style?.getPropertyValue("--box-height"),
    width: style?.getPropertyValue("--box-width"),
  };
};

/**
 * Says the Message's first image has loaded, as a browser would.
 */
const imageLoaded = async () => {
  await act(async () => {
    list()?.querySelector("img")?.dispatchEvent(new Event("load"));
    await Promise.resolve();
  });
};

/**
 * The box the Message's image stands in, and whether it has loaded.
 * @returns Its shape and width, and its `data-loaded`.
 */
const holder = () => {
  const element = list()?.querySelector<HTMLElement>("[data-loaded]");

  return { ...boxOf(element), loaded: element?.dataset.loaded };
};

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
    const { daemon } = await opened("text");

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

  it("draws a pending Preview as a placeholder, and its card once the stream says so, under text its words alone", async () => {
    const { daemon, sendPreview } = await opened("text");

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => daemon.previewAsks.length === 1);

    const pending = drawn();

    await act(async () => {
      sendPreview(catsItem(readyWithImage("page")));
      await Promise.resolve();
    });
    await settled(() => drawn()[0]?.state === "ready");
    await scrolledIntoView();

    expect({
      media: list()?.querySelectorAll("[data-loaded], img, canvas, video, audio").length,
      pending,
      words: words(),
    }).toStrictEqual({
      media: 0,
      pending: [{ state: "pending", text: "Previewing https://example.com/cats" }],
      words: ["Cats", "A page about cats."],
    });
  });

  it("draws a failure as one line of why, and never the link again", async () => {
    const { daemon } = await opened("text", catsItem({ _tag: "Failed", reason: "Unreachable" }));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "failed");

    expect({
      drawn: drawn(),
      links: list()?.querySelectorAll("a").length,
    }).toStrictEqual({
      drawn: [{ state: "failed", text: "No preview: the Daemon could not reach this link." }],
      links: 0,
    });
  });

  it("draws a page as its title, its description, and its image under them, from the images route, and never its site's name", async () => {
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
      last: card()?.lastElementChild?.contains(image ?? null),
      loading: image?.getAttribute("loading"),
      // A description that fits is no press.
      pressable: card()?.firstElementChild?.querySelector("[aria-expanded]"),
      referrerPolicy: image?.getAttribute("referrerpolicy"),
      src: image?.getAttribute("src"),
      text: cardText(),
      words: words(),
    }).toStrictEqual({
      alt: "Cats",
      decoding: "async",
      drawn: "whole",
      last: true,
      loading: "lazy",
      pressable: null,
      referrerPolicy: "no-referrer",
      src: `/api/previews/images/${hash}`,
      text: "CatsA page about cats.",
      words: ["Cats", "A page about cats."],
    });
  });

  it("names the host a page was read from above its title, when another than its link's", async () => {
    const { daemon } = await opened(
      "text",
      catsItem({ ...ready, preview: { ...ready.preview, link: "https://www.cats.example.org/c" } })
    );

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");

    expect(words()).toStrictEqual(["cats.example.org", "Cats", "A page about cats."]);
  });

  it("shows all of a description that was cut on a press, and cuts it again on another", async () => {
    // Laid out, the description runs past the lines it is cut to.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.localName === "bdi" ? 60 : 0;
      },
    });
    restores.push(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    });

    const { daemon } = await opened("text", catsItem(ready));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => more() !== null);

    const cut = { expanded: more()?.getAttribute("aria-expanded"), text: more()?.textContent };

    await pressed(more());

    const open = more()?.getAttribute("aria-expanded");

    await pressed(more());

    expect({ again: more()?.getAttribute("aria-expanded"), cut, open }).toStrictEqual({
      again: "false",
      cut: { expanded: "false", text: "A page about cats." },
      open: "true",
    });
  });

  it("keeps a description shown whole once play swaps its poster for the video", async () => {
    // Laid out, the description runs past the lines it is cut to.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.localName === "bdi" ? 60 : 0;
      },
    });
    restores.push(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    });

    const video = readyVideoPage();

    const described = {
      ...video,
      preview: { ...video.preview, description: "A page about cats." },
    };

    const { daemon } = await opened("on", catsItem(described));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await imageSeen();
    await settled(() => catsDescription() !== null && imageButton("Play A cat") !== null);
    await pressed(catsDescription());
    await pressed(imageButton("Play A cat"));
    await settled(() => list()?.querySelector("video") !== null);

    expect(catsDescription()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("draws a link that is itself an image as the image alone, with no words", async () => {
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
      text: cardText(),
    }).toStrictEqual({
      alt: "https://example.com/cats",
      drawn: "whole",
      src: `/api/previews/images/${hash}`,
      text: "",
    });
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
      words: card()?.querySelectorAll("bdi").length,
    }).toStrictEqual({
      audio: null,
      autoplay: false,
      controls: true,
      kind: "video",
      label: "Play https://example.com/cats",
      preload: "none",
      src: streamOfCats,
      words: 0,
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
      text: cardText(),
      video: list()?.querySelector("video"),
    }).toStrictEqual({
      controls: true,
      kind: "audio",
      preload: "none",
      src: streamOfCats,
      text: "",
      video: null,
    });
  });

  it("draws nothing of a link that is itself a video once it fails to play", async () => {
    const { daemon } = await opened("on", catsItem(readyMedia("video")));

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => list()?.querySelector("video") !== null);

    await act(async () => {
      list()?.querySelector("video")?.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });

    expect({ drawn: drawn(), video: list()?.querySelector("video") }).toStrictEqual({
      drawn: [{ state: "ready", text: "" }],
      video: null,
    });
  });

  describe("a page's video", () => {
    const name = "A cat";

    const play = () => imageButton(`Play ${name}`);
    const enlarge = () => imageButton(`Open ${name} large`);

    it("draws its poster from the images route with a play button, and no video, and asks the stream for nothing", async () => {
      const media = stubMedia();

      await withVideo();

      expect({
        fetches: media.fetches(),
        holding: [...document.body.querySelectorAll("*")].flatMap((element) =>
          [...element.attributes].flatMap((attribute) =>
            /stream|cat\.mp4/u.test(attribute.value)
              ? [`${element.localName}[${attribute.name}]`]
              : []
          )
        ),
        // The poster is under the title.
        order: [...(card()?.querySelectorAll("bdi, img") ?? [])].map((one) => one.localName),
        poster: list()?.querySelector("img")?.getAttribute("src"),
        press: play()?.disabled,
        title: play()?.closest("[title]"),
        video: list()?.querySelector("video"),
      }).toStrictEqual({
        fetches: [],
        holding: [],
        order: ["bdi", "img"],
        poster: `/api/previews/images/${hash}`,
        press: false,
        title: null,
        video: null,
      });
    });

    it("plays through the stream route in place when its play button is pressed", async () => {
      await withVideo();
      await pressed(play());

      const video = list()?.querySelector("video");

      expect({
        autoplay: video?.autoplay,
        controls: video?.controls,
        poster: video?.getAttribute("poster"),
        press: play(),
        src: video?.getAttribute("src"),
        still: list()?.querySelector("img"),
        text: list()?.querySelector("bdi")?.textContent,
      }).toStrictEqual({
        autoplay: true,
        controls: true,
        poster: `/api/previews/images/${hash}`,
        press: null,
        src: streamOfCats,
        still: null,
        text: name,
      });
    });

    it("opens a video large from its control, with the stream as its source, which Escape closes", async () => {
      await withVideo();

      const button = enlarge();

      await pressed(button);
      await settled(() => larger() !== null);

      const video = larger()?.querySelector("video");
      const link = larger()?.querySelector("a");

      const open = {
        autoplay: video?.autoplay,
        controls: video?.controls,
        href: link?.getAttribute("href"),
        name: larger()?.getAttribute("aria-label"),
        poster: video?.getAttribute("poster"),
        src: video?.getAttribute("src"),
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
        autoplay: true,
        controls: true,
        href: "https://example.com/cats",
        name,
        poster: `/api/previews/images/${hash}`,
        src: streamOfCats,
      });
    });

    it("pauses the video playing in place when its larger view opens", async () => {
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

      restores.push(() => {
        vi.restoreAllMocks();
      });

      await withVideo();
      await pressed(play());
      await pressed(enlarge());
      await settled(() => larger() !== null);

      expect(pause).toHaveBeenCalledOnce();
    });

    it("draws an animated poster as its first frame, not the GIF, and plays without a poster attribute", async () => {
      const media = stubMedia();

      await withVideo("on", true, true);

      expect({
        button: play() !== null,
        fetches: media.fetches(),
        image: list()?.querySelector("img"),
      }).toStrictEqual({
        button: true,
        fetches: [`/api/previews/images/${hash}`],
        image: null,
      });

      await pressed(play());

      expect({
        poster: list()?.querySelector("video")?.getAttribute("poster"),
        src: list()?.querySelector("video")?.getAttribute("src"),
      }).toStrictEqual({ poster: null, src: streamOfCats });
    });

    it("draws the video as it is, with the control to open it large, when the Daemon kept no poster", async () => {
      await withVideo("on", false);

      const video = list()?.querySelector("video");

      expect({
        enlarge: imageButton(`Open ${name} large`) !== null,
        preload: video?.getAttribute("preload"),
        src: video?.getAttribute("src"),
      }).toStrictEqual({ enlarge: true, preload: "none", src: streamOfCats });
    });

    it("draws the video as it is, with the control to open it large, when its poster fails to load", async () => {
      await withVideo();

      await act(async () => {
        list()?.querySelector("img")?.dispatchEvent(new Event("error"));
        await Promise.resolve();
      });

      const video = list()?.querySelector("video");

      expect({
        enlarge: imageButton(`Open ${name} large`) !== null,
        image: list()?.querySelector("img"),
        poster: video?.getAttribute("poster") ?? null,
        preload: video?.getAttribute("preload"),
        src: video?.getAttribute("src"),
      }).toStrictEqual({
        enlarge: true,
        image: null,
        poster: null,
        preload: "none",
        src: streamOfCats,
      });
    });

    it("leaves the text alone when it fails to play", async () => {
      await withVideo();
      await pressed(play());

      await act(async () => {
        list()?.querySelector("video")?.dispatchEvent(new Event("error"));
        await Promise.resolve();
      });

      expect({
        state: drawn()[0]?.state,
        text: list()?.querySelector("bdi")?.textContent,
        video: list()?.querySelector("video"),
      }).toStrictEqual({ state: "ready", text: name, video: null });
    });
  });

  describe("a link that is itself a video", () => {
    it("has the control to open it large, with the stream as its source", async () => {
      const { daemon } = await opened("on", catsItem(readyMedia("video")));

      await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
      await scrolledIntoView();
      await settled(() => list()?.querySelector("video") !== null);

      const label = "Open https://example.com/cats large";

      await pressed(imageButton(label));
      await settled(() => larger() !== null);

      const video = larger()?.querySelector("video");

      expect({
        poster: video?.getAttribute("poster"),
        src: video?.getAttribute("src"),
      }).toStrictEqual({ poster: null, src: streamOfCats });
    });

    it("has no such control for a sound", async () => {
      const { daemon } = await opened("on", catsItem(readyMedia("audio")));

      await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
      await scrolledIntoView();
      await settled(() => list()?.querySelector("audio") !== null);

      expect(list()?.querySelectorAll("button[aria-label^='Open']").length).toBe(0);
    });
  });

  describe("a player", () => {
    it("draws its poster from the images route, with a play button that says where it plays from", async () => {
      await withPlayer(true);

      const image = list()?.querySelector("img");
      const button = playButton();

      expect({
        alt: image?.getAttribute("alt"),
        disabled: button?.disabled,
        drawn: image?.dataset.drawn,
        hover: button?.closest("[title]")?.getAttribute("title"),
        src: image?.getAttribute("src"),
        text: list()?.textContent,
      }).toStrictEqual({
        alt: "A song",
        disabled: false,
        drawn: "poster",
        hover: `plays from ${playerHost}`,
        src: `/api/previews/images/${hash}`,
        text: "youtube.comA song▶",
      });
    });

    it("draws no frame, and holds the player's address in no attribute, with or without a poster", async () => {
      await withPlayer(true);

      const withPoster = {
        address: holdingAddress(),
        frames: document.body.querySelectorAll("iframe, frame, embed, object").length,
      };

      for (const unmount of mounted.splice(0)) {
        act(unmount);
      }

      await withPlayer(false);

      expect({
        withPoster,
        without: {
          address: holdingAddress(),
          frames: document.body.querySelectorAll("iframe, frame, embed, object").length,
        },
      }).toStrictEqual({
        withPoster: { address: [], frames: 0 },
        without: { address: [], frames: 0 },
      });
    });

    it("swaps its poster for the player, already playing, when its play button is pressed", async () => {
      await withPlayer(true);
      await pressed(playButton());

      expect(framed()).toStrictEqual({
        frames: [frame],
        poster: false,
        press: false,
        text: "youtube.comA song",
      });
    });

    it("asks for a press again when the player's address changes after one", async () => {
      const { sendPreview } = await withPlayer(false);

      await pressed(playButton());

      const before = framed().frames.length;
      const moved = readyPlayer(false);

      await act(async () => {
        sendPreview(
          catsItem({
            ...moved,
            preview: {
              ...moved.preview,
              player: { link: "https://player.vimeo.com/video/7", size: null },
            },
          })
        );
        await Promise.resolve();
      });
      await settled(() => imageButton("Play from player.vimeo.com") !== null);

      expect({ after: framed().frames.length, before }).toStrictEqual({ after: 0, before: 1 });
    });

    it("does not open the larger view when its poster is pressed", async () => {
      await withPlayer(true);

      await act(async () => {
        list()?.querySelector("img")?.click();
        await Promise.resolve();
      });

      expect({
        dialog: larger(),
        pressable: list()?.querySelector("img")?.closest("button"),
      }).toStrictEqual({ dialog: null, pressable: null });
    });

    it("draws the text row with the same play button when the Daemon kept no poster", async () => {
      await withPlayer(false);

      expect({
        button: playButton()?.closest("[title]")?.getAttribute("title"),
        image: list()?.querySelector("img"),
        text: list()?.textContent?.includes("A song"),
      }).toStrictEqual({ button: `plays from ${playerHost}`, image: null, text: true });
    });

    it("falls back to the text row with the play button when its poster fails to load", async () => {
      await withPlayer(true);

      await act(async () => {
        list()?.querySelector("img")?.dispatchEvent(new Event("error"));
        await Promise.resolve();
      });

      expect({
        button: playButton()?.closest("[title]")?.getAttribute("title"),
        image: list()?.querySelector("img"),
        text: list()?.textContent?.includes("A song"),
      }).toStrictEqual({ button: `plays from ${playerHost}`, image: null, text: true });
    });

    it("draws an animated poster as its first frame, still, with the play button over it", async () => {
      const media = stubMedia();
      const { daemon } = await opened("on", catsItem(readyPlayer(true, true)));

      await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
      await scrolledIntoView();
      await settled(() => drawn()[0]?.state === "ready");
      await imageSeen();
      await settled(() => list()?.querySelector("canvas") !== null);

      expect({
        button: playButton()?.disabled,
        fetches: media.fetches(),
        image: list()?.querySelector("img"),
        pressable: list()?.querySelector("canvas")?.closest("button"),
      }).toStrictEqual({
        button: false,
        fetches: [`/api/previews/images/${hash}`],
        image: null,
        pressable: null,
      });
    });
  });

  it("draws nothing of a link that is itself an image once it fails to load", async () => {
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

    expect({ drawn: drawn(), image: list()?.querySelector("img") }).toStrictEqual({
      drawn: [{ state: "ready", text: "" }],
      image: null,
    });
  });

  it("leaves a page's words when its image fails to load", async () => {
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

    expect({ image: list()?.querySelector("img"), text: cardText() }).toStrictEqual({
      image: null,
      text: "CatsA page about cats.",
    });
  });

  describe("the toggle after a link", () => {
    it("under start closed, asks for nothing as the Message scrolls into view and draws nothing, until its toggle is pressed, which asks once and draws a placeholder, then the card", async () => {
      const { daemon, sendPreview } = await opened("on", catsItem({ _tag: "Pending" }), {}, false, {
        look: { "previews.start": "closed" },
      });

      await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
      await scrolledIntoView();

      const closed = {
        asks: daemon.previewAsks.length,
        expanded: toggle()?.getAttribute("aria-expanded"),
        list: list(),
      };

      await pressed(toggle());
      await settled(() => daemon.previewAsks.length === 1 && drawn()[0]?.state === "pending");

      const pending = drawn();

      await act(async () => {
        sendPreview(catsItem(ready));
        await Promise.resolve();
      });
      await settled(() => drawn()[0]?.state === "ready");

      expect({
        asks: daemon.previewAsks,
        closed,
        expanded: toggle()?.getAttribute("aria-expanded"),
        pending,
        text: cardText(),
      }).toStrictEqual({
        asks: [{ position: cursor(2), timeline: iirc }],
        closed: { asks: 0, expanded: "false", list: null },
        expanded: "true",
        pending: [{ state: "pending", text: "Previewing https://example.com/cats" }],
        text: "CatsA page about cats.",
      });
    });

    it("under start open, closes the card on its toggle and opens it again on another press, asking only once", async () => {
      const { daemon } = await opened("on", catsItem(ready));

      await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
      await scrolledIntoView();
      await settled(() => drawn()[0]?.state === "ready");

      const open = { expanded: toggle()?.getAttribute("aria-expanded"), shown: drawn().length };

      await pressed(toggle());
      await settled(() => list() === null);

      const closed = { expanded: toggle()?.getAttribute("aria-expanded"), list: list() };

      await pressed(toggle());
      await settled(() => drawn()[0]?.state === "ready");

      expect({
        asks: daemon.previewAsks.length,
        closed,
        open,
        reopened: toggle()?.getAttribute("aria-expanded"),
      }).toStrictEqual({
        asks: 1,
        closed: { expanded: "false", list: null },
        open: { expanded: "true", shown: 1 },
        reopened: "true",
      });
    });

    it("keeps what was toggled when the Message's row is drawn again", async () => {
      const { daemon, registry } = await opened("on", catsItem(ready), {}, false, {
        look: { "previews.start": "closed" },
      });

      await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
      await scrolledIntoView();
      await pressed(toggle());
      await settled(() => drawn()[0]?.state === "ready");

      const before = toggle();

      const switchTo = async (timeline: string) => {
        await act(async () => {
          registry.set(open, Schema.decodeSync(TimelineId)(timeline));
          await Promise.resolve();
        });
      };

      await switchTo(own);
      await switchTo(iirc);

      await settled(() => toggle() !== null);
      await scrolledIntoView();

      expect({
        asks: daemon.previewAsks.length,
        drawnAgain: toggle() !== before,
        expanded: toggle()?.getAttribute("aria-expanded"),
        shown: drawn().length,
      }).toStrictEqual({ asks: 1, drawnAgain: true, expanded: "true", shown: 1 });
    });

    it.each(["columns", "inline", "stacked"] as const)(
      "stands right after its link, as a button the keyboard reaches, under layout %s",
      async (layout) => {
        const { daemon } = await opened("on", catsItem(ready), {}, false, {
          look: { "timeline.layout": layout },
        });

        await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);

        const link = document.querySelector('a[href="https://example.com/cats"]');
        const button = toggle();

        button?.focus();

        expect({
          after: link?.nextElementSibling === button,
          button: button?.tagName,
          focused: document.activeElement === button,
          label: button?.getAttribute("aria-label"),
          toggles: document.querySelectorAll("[data-preview-toggle]").length,
        }).toStrictEqual({
          after: true,
          button: "BUTTON",
          focused: true,
          label: "Preview of https://example.com/cats",
          toggles: 1,
        });
      }
    );

    it("draws no toggle under off", async () => {
      await opened("off");
      await settled(() => document.querySelector('[role="log"]')?.querySelector("a") !== null);

      expect(toggle()).toBeNull();
    });
  });

  describe("in a Direct Message with no mode of its own", () => {
    const direct = { direct: true } as const;

    it("asks for the Message on view and draws nothing, presses nothing until its toggle is pressed, which presses that link alone, and its Preview arrives", async () => {
      const { daemon, sendPreview } = await opened(
        "on",
        catsItem({ _tag: "WaitingForPress" }),
        {},
        false,
        direct
      );

      await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
      await scrolledIntoView();
      await settled(() => daemon.previewAsks.length === 1);

      const waiting = {
        expanded: toggle()?.getAttribute("aria-expanded"),
        list: list(),
        presses: [...daemon.presses],
      };

      await pressed(toggle());
      await settled(() => drawn()[0]?.state === "pending");
      await act(async () => {
        sendPreview(catsItem(ready));
        await Promise.resolve();
      });
      await settled(() => drawn()[0]?.state === "ready");

      expect({
        asks: daemon.previewAsks.length,
        presses: daemon.presses,
        showPreview: document.body.textContent?.includes("show preview"),
        text: cardText(),
        waiting,
      }).toStrictEqual({
        asks: 1,
        presses: [{ link: 0, position: cursor(2), timeline: iirc }],
        showPreview: false,
        text: "CatsA page about cats.",
        waiting: { expanded: "false", list: null, presses: [] },
      });
    });

    it("opens a link the Daemon already holds on its toggle, with no press", async () => {
      const { daemon } = await opened("on", catsItem(ready), {}, false, direct);

      await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
      await scrolledIntoView();
      await settled(() => daemon.previewAsks.length === 1);

      const before = list();

      await pressed(toggle());
      await settled(() => drawn()[0]?.state === "ready");

      expect({ before, presses: daemon.presses, text: cardText() }).toStrictEqual({
        before: null,
        presses: [],
        text: "CatsA page about cats.",
      });
    });
  });

  it("starts a Direct Message set to on as start says, drawing its Preview open with no press", async () => {
    const { daemon } = await opened("on", catsItem(ready), { [iirc]: "on" }, false, {
      direct: true,
    });

    await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
    await scrolledIntoView();
    await settled(() => drawn()[0]?.state === "ready");

    expect({
      expanded: toggle()?.getAttribute("aria-expanded"),
      presses: daemon.presses,
    }).toStrictEqual({ expanded: "true", presses: [] });
  });

  it("follows a Timeline's own choice over ui.previews", async () => {
    const { daemon } = await opened("off", catsItem({ _tag: "Pending" }), { [iirc]: "text" });

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);
    await scrolledIntoView();
    await settled(() => daemon.previewAsks.length === 1);

    expect(daemon.previewAsks).toStrictEqual([{ position: cursor(2), timeline: iirc }]);
  });

  describe("an image's box", () => {
    it("is reserved from the image's size before it loads, and is the same box once it has", async () => {
      await opened("on", catsItem(readyWithImage("image", false, { height: 48, width: 64 })));
      await settled(() => list() !== null);
      await scrolledIntoView();
      await settled(() => drawn()[0]?.state === "ready");
      await imageSeen();
      await settled(() => list()?.querySelector("img") !== null);

      const before = holder();

      await imageLoaded();

      const after = holder();

      expect({ after, before }).toStrictEqual({
        after: { ...before, loaded: "true" },
        before: {
          atMost: "64px",
          height: "48",
          loaded: "false",
          width: "64",
        },
      });
    });

    it("keeps its placeholder where the Daemon read no size, until the image has loaded, not until it is seen", async () => {
      await opened("on", catsItem(readyWithImage("image")));
      await settled(() => list() !== null);
      await scrolledIntoView();
      await settled(() => drawn()[0]?.state === "ready");
      await imageSeen();
      await settled(() => list()?.querySelector("img") !== null);

      const before = holder();

      await imageLoaded();

      expect({ after: holder().loaded, before: before.loaded }).toStrictEqual({
        after: "true",
        before: "false",
      });
    });

    it("is the box a page's video plays in, before play and after it", async () => {
      await withVideo("on", true, false, { height: 3, width: 4 });

      const poster = boxOf(list()?.querySelector("[data-loaded]"));

      await pressed(imageButton("Play A cat"));

      expect({ poster, video: boxOf(list()?.querySelector("video")?.parentElement) }).toStrictEqual(
        {
          poster: { atMost: "", height: "3", width: "4" },
          video: { atMost: "", height: "3", width: "4" },
        }
      );
    });

    it("is the box a page's video is left in where its poster fails to load", async () => {
      await withVideo("on", true, false, { height: 3, width: 4 });

      const poster = boxOf(list()?.querySelector("[data-loaded]"));

      await act(async () => {
        list()?.querySelector("img")?.dispatchEvent(new Event("error"));
        await Promise.resolve();
      });

      expect({ poster, video: boxOf(list()?.querySelector("video")?.parentElement) }).toStrictEqual(
        {
          poster: { atMost: "", height: "3", width: "4" },
          video: { atMost: "", height: "3", width: "4" },
        }
      );
    });

    it("is the box a player plays in, the shape its page gave, whatever its poster's", async () => {
      await withPlayer(true, "on", { height: 3, width: 4 });

      const poster = boxOf(list()?.querySelector("[data-loaded]"));

      await pressed(playButton());

      expect({ frame: boxOf(document.body.querySelector("iframe")), poster }).toStrictEqual({
        frame: { atMost: "", height: "360", width: "640" },
        poster: { atMost: "", height: "360", width: "640" },
      });
    });
  });

  it("draws a held Preview the first time its Message is drawn, with no placeholder and no ask", async () => {
    const states = new Set<string | undefined>();

    const watcher = new MutationObserver(() => {
      for (const one of document.querySelectorAll<HTMLElement>("[data-preview]")) {
        states.add(one.dataset.preview);
      }
    });

    watcher.observe(document.body, { attributes: true, childList: true, subtree: true });

    const { daemon } = await opened("on", catsItem(ready));
    const first = drawn();

    watcher.disconnect();

    expect({
      asks: daemon.previewAsks,
      first,
      held: daemon.heldReads,
      states: [...states],
    }).toStrictEqual({
      asks: [],
      first: [{ state: "ready", text: "CatsA page about cats." }],
      held: [{ positions: [cursor(2)], timeline: iirc }],
      states: ["ready"],
    });
  });

  it("draws no image, and gives none a source, until it scrolls into view", async () => {
    const { daemon } = await opened("on", catsItem(readyWithImage("page")));

    // Held, the card is drawn before the Message is ever seen.
    await settled(() => daemon.previewFollowers.length === 1 && drawn()[0]?.state === "ready");

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
    await settled(() => imageButton("Open https://example.com/cats large") !== null);

    const button = imageButton("Open https://example.com/cats large");

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
      image: `/api/previews/images/${hash}`,
      name: "https://example.com/cats",
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

    expect(larger()).toBeNull();
  });

  it("draws an animated image as its first frame under a play badge, fetched once it is in view, and plays it on a press", async () => {
    const { fetches, draws, revoked } = stubMedia();
    const { daemon } = await opened("on", catsItem(readyWithImage("image", true)));

    // Held, the card is drawn before the Message is ever seen.
    await settled(() => daemon.previewFollowers.length === 1 && drawn()[0]?.state === "ready");

    const unseen = { fetches: fetches(), image: list()?.querySelectorAll("img, canvas").length };

    await imageSeen();
    await settled(() => list()?.querySelector("canvas") !== null);

    const still = { ...animated(), draws: [...draws], fetches: fetches() };
    const canvas = list()?.querySelector("canvas");

    await pressed(imageButton("Play https://example.com/cats"));
    await settled(() => list()?.querySelector("img") !== null);

    const playing = {
      ...animated(),
      fetches: fetches(),
      stop: imageButton("Stop https://example.com/cats") !== null,
    };

    await pressed(imageButton("Stop https://example.com/cats"));
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
        fetches: [`/api/previews/images/${hash}`],
        playing: "blob:media-1",
        stop: true,
      },
      size: ["64", "48"],
      still: {
        badge: true,
        canvas: true,
        draws: [[64, 48]],
        fetches: [`/api/previews/images/${hash}`],
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

    await pressed(imageButton("Play https://example.com/cats"));
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

    // Held, the card is drawn before the Message is ever seen.
    await settled(() => daemon.previewFollowers.length === 1 && drawn()[0]?.state === "ready");
    await imageSeen();
    await settled(() => list()?.querySelector("[data-loaded]") === null);

    expect({
      image: list()?.querySelectorAll("img, canvas").length,
      state: drawn()[0]?.state,
      text: cardText(),
    }).toStrictEqual({ image: 0, state: "ready", text: "CatsA page about cats." });
  });

  describe("how cards are stacked and sized", () => {
    /**
     * The Frontend with the Message's Preview answered as given and seen, sized as given.
     * @param answer - The Preview's state.
     * @param look - How cards start and are sized, shared.
     * @param dogs - A second link's answer, if the Message holds one.
     * @returns The fake.
     */
    const seenWith = async (
      answer: (typeof PreviewItem.Encoded)["state"],
      look: Look,
      dogs?: typeof PreviewItem.Encoded
    ) => {
      const fake = await opened("on", catsItem(answer), {}, false, { dogs, look });

      await settled(() => fake.daemon.previewFollowers.length === 1 && list() !== null);
      await scrolledIntoView();
      await settled(() => fake.daemon.previewAsks.length === 1);

      return fake;
    };

    const dogsItem = {
      ...catsItem(readyWithImage("image")),
      id: "fedcba9876543210fedcba9876543210",
      link: "https://example.com/dogs",
    } as const;

    it("stacks a Message's cards in its order under one list", async () => {
      await seenWith(ready, {}, dogsItem);
      await settled(() => drawn().length === 2 && drawn().every((one) => one.state === "ready"));
      await imageSeen();
      await settled(() => list()?.querySelector("img") !== null);

      expect({
        alt: card(1)?.querySelector("img")?.getAttribute("alt"),
        lists: document.querySelectorAll('ul[aria-label="Previews"]').length,
        rows: list()?.querySelectorAll(":scope > li").length,
        texts: drawn().map((one) => one.text),
      }).toStrictEqual({
        alt: "https://example.com/cats",
        lists: 1,
        rows: 2,
        texts: ["CatsA page about cats.", ""],
      });
    });

    it("sets the media's height from ui.previews.mediaHeight, which a device may override", async () => {
      const { registry } = await seenWith(readyWithImage("page"), {
        "previews.mediaHeight": "large",
      });

      const shared = mediaHeight();

      await act(async () => {
        registry.set(deviceUi, { "previews.mediaHeight": "small" });
        await Promise.resolve();
      });

      expect({ device: mediaHeight(), shared }).toStrictEqual({ device: "160px", shared: "400px" });
    });
  });
});
