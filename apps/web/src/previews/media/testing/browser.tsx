/**
 * What a media test stands in for the browser: an intersection observer that sees only what
 * a test says came near, the Daemon's bytes and their decoding, the device's setting to
 * reduce motion, a press as a person makes one, and a place on the page to draw in.
 *
 * @packageDocumentation
 */
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";

import { eventually } from "../../../testing/fake-daemon.ts";

/** What the page reads of an entry. */
interface Seen {
  readonly isIntersecting: boolean;
  readonly target: Element;
}

/** What the page does with its observer when told. */
interface Told {
  readonly disconnect: () => void;
}

/** How an intersection observer tells what it saw. */
type Tell = (entries: readonly Seen[], observer: Told) => void;

/** Each intersection observer made. */
const observers = new Set<Observer>();

/** An intersection observer that sees only what a test says came near the view. */
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

  /** Tells that everything it observes came near. */
  seen() {
    const entries = [...this.#elements].map((target) => ({ isIntersecting: true, target }));

    if (entries.length > 0) {
      this.#tell(entries, this);
    }
  }
}

/** Each thing a test set up, to be put back after it. */
const restores: (() => void)[] = [];

/** Stands in the intersection observer for what mounts after. */
export const observing = () => {
  observers.clear();
  Reflect.set(globalThis, "IntersectionObserver", Observer);
  restores.push(() => {
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
  });
};

/**
 * Where each observer made observes against, and how far beyond it.
 * @returns Each one's root and margin.
 */
export const observedWith = () =>
  [...observers].map(({ options }) => ({ margin: options?.rootMargin, root: options?.root }));

/** Says everything observed came near the view, as a browser would as the Owner scrolls. */
export const scrolledNear = async () => {
  await act(async () => {
    for (const observer of observers) {
      observer.seen();
    }

    await Promise.resolve();
  });
};

/**
 * The Daemon's bytes of an image, a fresh response each time, as a browser fetches anew, so
 * each fetch has a body of its own to read.
 * @returns The response.
 */
const gif = async (): Promise<Response> => {
  const bytes = await Promise.resolve(new Uint8Array([71, 73, 70]));

  return new Response(bytes, { status: 200 });
};

/**
 * Stands in the browser's media: the Daemon's bytes fetched, or refused where `status` says,
 * decoded to a frame of 64 by 48, drawn on a canvas, and held by an object URL.
 * @param status - What the Daemon answers, 200 unless given.
 * @returns What it was asked.
 */
export const stubMedia = (status = 200) => {
  const revoked: string[] = [];
  const draws: [number, number][] = [];
  let made = 0;

  const fetching = vi.fn<(input: string) => Promise<Response>>(async () =>
    status === 200 ? await gif() : new Response(null, { status })
  );

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

/** What of happy-dom's settings a frame's loading reads. */
interface FrameSettings {
  enableIframePageLoading: boolean;
  navigation: { disableChildFrameNavigation: boolean };
}

/**
 * Whether happy-dom's own part of its window holds the settings a frame's loading reads.
 * @param happy - It.
 * @returns Whether it does.
 */
const holdsSettings = (happy: unknown): happy is { readonly settings: FrameSettings } =>
  typeof happy === "object" && happy !== null && "settings" in happy;

/**
 * Lets a frame load as a browser's does, for what mounts after, while it navigates nowhere,
 * so nothing is fetched from its host. Otherwise happy-dom refuses it, and prints so.
 */
export const framesGoNowhere = () => {
  if (!("happyDOM" in window && holdsSettings(window.happyDOM))) {
    throw new Error("a frame's loading is set only in happy-dom");
  }

  const { settings } = window.happyDOM;
  const { enableIframePageLoading } = settings;
  const { disableChildFrameNavigation } = settings.navigation;

  settings.enableIframePageLoading = true;
  settings.navigation.disableChildFrameNavigation = true;
  restores.push(() => {
    settings.enableIframePageLoading = enableIframePageLoading;
    settings.navigation.disableChildFrameNavigation = disableChildFrameNavigation;
  });
};

/**
 * Sets the device to reduce motion, or not, for what mounts after.
 * @param reduce - Whether it does.
 */
export const reducingMotion = (reduce: boolean) => {
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
 * Presses an element as a person does: it takes focus, and then it is pressed.
 * @param element - The element.
 */
export const pressed = async (element: Element | null | undefined) => {
  await act(async () => {
    if (element instanceof HTMLElement) {
      element.focus();
      element.click();
    }

    await Promise.resolve();
  });
};

/**
 * Tells an element an event happened to it, as a browser does when media loads or fails.
 * @param element - The element.
 * @param type - What happened, such as `load` or `error`.
 */
export const happened = async (element: Element | null | undefined, type: string) => {
  await act(async () => {
    element?.dispatchEvent(new Event(type));
    await Promise.resolve();
  });
};

/**
 * Waits until something on the page holds.
 * @param holds - What must hold.
 */
export const settled = async (holds: () => boolean) => {
  await act(async () => {
    await eventually(holds);
  });
};

/**
 * Draws an element on the page, in a registry of its own, for the rest of the test.
 * @param element - What to draw.
 * @returns The container it is drawn in, the registry, and how to draw it anew.
 */
export const drawn = async (element: ReactElement) => {
  const registry = AtomRegistry.make();
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);

  const draw = async (next: ReactElement) => {
    await act(async () => {
      root.render(<RegistryContext.Provider value={registry}>{next}</RegistryContext.Provider>);
      await Promise.resolve();
    });
  };

  restores.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  await draw(element);

  return { container, draw, registry };
};

/** Puts back everything a test set up, the last first. */
export const restored = () => {
  for (const restore of restores.splice(0).toReversed()) {
    restore();
  }
};
