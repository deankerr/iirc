// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { TimelineId, uiDefaults } from "@iirc/api";
import type { PreviewItem, Timeline, TimelineItem, UiOptions } from "@iirc/api";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../app/app.tsx";
import { deviceUi } from "../options/device.ts";
import { optionsState } from "../options/state.ts";
import { uiSync } from "../options/ui.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run } from "../testing/fake-daemon.ts";
import { open, sync } from "../timelines/atoms.ts";
import type { WaitTimes } from "../timelines/atoms.ts";
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
    nicks: [],
    ours: null,
    prefix: null,
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
    size: null,
    stream: null,
    thumbnail: false,
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
  /** Where it observes against, and how far beyond it. */
  readonly options: IntersectionObserverInit | undefined;

  constructor(tell: Tell, options?: IntersectionObserverInit) {
    this.#tell = tell;
    this.options = options;
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
type Look = Partial<
  Pick<UiOptions, "previews.start" | "previews.mediaHeight" | "conversation.layout">
>;

/**
 * The Frontend signed in, with `ui.previews` as given and `#iirc` open, or a Direct Message
 * with `peer` where `also.direct` is set, holding a Message with a link to a page, which the Daemon answers for with the item given.
 * @param previews - `ui.previews`.
 * @param answer - What the Daemon answers for the Message, as it stands then.
 * @param timelines - `ui.previews.conversations`, none unless given.
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
    /** Each held read of Previews waits until released. */
    readonly held?: boolean;
    /** The shared options are read only once the test releases them, after the window. */
    readonly optionsLate?: boolean;
    /** Waits other than a test's defaults. */
    readonly waits?: Partial<WaitTimes>;
  } = {}
) => {
  const fake = fakeDaemon();

  fake.daemon.holdUiFollows = also.optionsLate === true;
  fake.daemon.holdHeldReads = also.held === true;

  fake.daemon.signedIn = true;
  fake.daemon.ui = {
    options: {
      ...uiDefaults,
      previews,
      "previews.animate": animate,
      "previews.conversations": timelines,
      "previews.start": "open",
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

  const registry = registryFor(fake.fetch, also.waits);

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
    () =>
      fake.daemon.followers.length === 1 &&
      (also.optionsLate === true || registry.get(optionsState).ui !== undefined)
  );

  await act(async () => {
    registry.set(open, Schema.decodeSync(TimelineId)(iirc));
    await Promise.resolve();
  });

  // The page draws a wait until the options are read, so no row is drawn before them.
  await settled(
    () =>
      also.optionsLate === true ||
      (container.querySelector('[role="log"]')?.textContent?.includes("look") ?? false)
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
 * The caret the first toggle shows, by its icon's name.
 * @returns Its name, or none.
 */
const caret = () => toggle()?.querySelector<HTMLElement>("[data-icon]")?.dataset.icon;

/**
 * A card's words, each part as its text, in the order drawn.
 * @returns Them.
 */
const words = () => [...(card()?.querySelectorAll("bdi") ?? [])].map((part) => part.textContent);

/**
 * What a card says, its words and its media's together.
 * @returns Its text.
 */
const cardText = () => card()?.textContent;

/**
 * The first card's expand button.
 * @returns It, or none.
 */
const expandButton = () =>
  card()?.querySelector<HTMLButtonElement>('button[aria-label^="full preview of"]') ?? null;

/**
 * Waits for the Message's image to be drawn, and says it came into view, as a browser
 * would as the Owner scrolls it there.
 */
const imageSeen = async () => {
  await settled(() => list()?.querySelector("[data-loaded]") !== null);
  await scrolledIntoView();
};

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

  it("asks for a Message once it is within a screen of the log's view, above or below, not only in it", async () => {
    const { container, daemon } = await opened("text");

    await settled(() => daemon.previewFollowers.length === 1 && list() !== null);

    const log = container.querySelector('[role="log"]');

    expect(
      [...observers].map((observer) => ({
        margin: observer.options?.rootMargin,
        rootIsLog: observer.options?.root === log,
      }))
    ).toStrictEqual([{ margin: "100% 0px", rootIsLog: true }]);
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

  it("draws no row for a failure, and never the link again, as its toggle says why", async () => {
    const { daemon } = await opened("text", catsItem({ _tag: "Failed", reason: "Unreachable" }));

    await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
    await scrolledIntoView();
    await settled(() => toggle()?.dataset.failed !== undefined);

    expect({ label: toggle()?.getAttribute("aria-label"), list: list() }).toStrictEqual({
      label:
        "preview of https://example.com/cats: No preview: the daemon could not reach this link.",
      list: null,
    });
  });

  it("draws a ready card under the Message, which stays expanded when its row is drawn again", async () => {
    const { daemon, registry } = await opened("on", catsItem(readyVideoPage(false)));

    await settled(() => daemon.previewFollowers.length === 1 && drawn()[0]?.state === "ready");
    await pressed(expandButton());

    const expanded = card()?.dataset.layout;

    const switchTo = async (timeline: string) => {
      await act(async () => {
        registry.set(open, Schema.decodeSync(TimelineId)(timeline));
        await Promise.resolve();
      });
    };

    await switchTo(own);
    await switchTo(iirc);
    await settled(() => drawn()[0]?.state === "ready");

    expect({ again: card()?.dataset.layout, expanded, text: cardText() }).toStrictEqual({
      again: "expanded",
      expanded: "expanded",
      text: "A cat",
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

      const open = {
        caret: caret(),
        expanded: toggle()?.getAttribute("aria-expanded"),
        shown: drawn().length,
      };

      await pressed(toggle());
      await settled(() => list() === null);

      const closed = {
        caret: caret(),
        expanded: toggle()?.getAttribute("aria-expanded"),
        list: list(),
      };

      await pressed(toggle());
      await settled(() => drawn()[0]?.state === "ready");

      expect({
        asks: daemon.previewAsks.length,
        closed,
        open,
        reopened: toggle()?.getAttribute("aria-expanded"),
      }).toStrictEqual({
        asks: 1,
        closed: { caret: "previewHidden", expanded: "false", list: null },
        open: { caret: "previewShown", expanded: "true", shown: 1 },
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
          look: { "conversation.layout": layout },
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
          label: "preview of https://example.com/cats",
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

    it("draws a failure as a button that presses its link again, and its Preview arrives", async () => {
      const { daemon, sendPreview } = await opened(
        "on",
        catsItem({ _tag: "Failed", reason: "Unreachable" }),
        {},
        false,
        direct
      );

      await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
      await scrolledIntoView();
      await settled(() => daemon.previewAsks.length === 1);
      await pressed(toggle());
      await settled(() => drawn()[0]?.state === "failed");

      const retry = list()?.querySelector<HTMLButtonElement>('button[data-preview="failed"]');
      const failed = { drawn: drawn(), presses: [...daemon.presses], tag: retry?.tagName };

      await pressed(retry ?? null);
      await settled(() => drawn()[0]?.state === "pending");
      await act(async () => {
        sendPreview(catsItem(ready));
        await Promise.resolve();
      });
      await settled(() => drawn()[0]?.state === "ready");

      expect({ failed, presses: daemon.presses, text: cardText() }).toStrictEqual({
        failed: {
          drawn: [
            {
              state: "failed",
              text: "No preview: the daemon could not reach this link.try again",
            },
          ],
          presses: [],
          tag: "BUTTON",
        },
        presses: [{ link: 0, position: cursor(2), timeline: iirc }],
        text: "CatsA page about cats.",
      });
    });

    it("presses a failure once when the press's answer is lost, and asks for its Message again instead", async () => {
      const { daemon } = await opened(
        "on",
        catsItem({ _tag: "Failed", reason: "Unreachable" }),
        {},
        false,
        direct
      );

      await settled(() => daemon.previewFollowers.length === 1 && toggle() !== null);
      await scrolledIntoView();
      await settled(() => daemon.previewAsks.length === 1);
      await pressed(toggle());
      await settled(() => drawn()[0]?.state === "failed");

      daemon.pressAnswersLost = true;
      await pressed(
        list()?.querySelector<HTMLButtonElement>('button[data-preview="failed"]') ?? null
      );
      await settled(() => daemon.previewAsks.length === 2);

      expect(daemon.presses).toStrictEqual([{ link: 0, position: cursor(2), timeline: iirc }]);
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

  it("reads held Previews with the window even when the shared options are read after it", async () => {
    const states = new Set<string | undefined>();

    const watcher = new MutationObserver(() => {
      for (const one of document.querySelectorAll<HTMLElement>("[data-preview]")) {
        states.add(one.dataset.preview);
      }
    });

    watcher.observe(document.body, { attributes: true, childList: true, subtree: true });

    const { daemon } = await opened("on", catsItem(ready), {}, false, { optionsLate: true });

    // The window is read first, as on a page loaded again, and only then the options.
    await settled(() => daemon.uiFollowsHeld.length > 0 && daemon.heldReads.length === 1);

    await act(async () => {
      daemon.holdUiFollows = false;

      for (const release of daemon.uiFollowsHeld) {
        release();
      }

      await Promise.resolve();
    });
    await settled(() => drawn()[0]?.state === "ready");

    watcher.disconnect();

    expect({
      asks: daemon.previewAsks,
      held: daemon.heldReads,
      states: [...states],
    }).toStrictEqual({
      asks: [],
      held: [{ positions: [cursor(2)], timeline: iirc }],
      states: ["ready"],
    });
  });

  it("draws the window though a held read stalls, with a placeholder for each link", async () => {
    const { daemon } = await opened("on", catsItem(ready), {}, false, {
      held: true,
      waits: { held: "30 millis" },
    });

    await settled(() => drawn().length > 0);

    expect({
      held: daemon.heldReads.length,
      shown: drawn().map((one) => one.state),
    }).toStrictEqual({ held: 1, shown: ["pending"] });
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
