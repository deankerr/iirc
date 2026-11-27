// @vitest-environment happy-dom
import type { PictureShown } from "@iirc/frontend/previews";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deviceUi } from "../../options/device.ts";
import { Picture } from "./picture.tsx";
import {
  drawn,
  happened,
  observing,
  pressed,
  reducingMotion,
  restored,
  scrolledNear,
  settled,
  stubMedia,
} from "./testing/browser.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const src = "/api/previews/images/cats";
const link = { href: "https://example.com/cats", text: "https://example.com/cats" };

/**
 * A picture as a card is given it.
 * @param animated - Whether it moves.
 * @param dimensions - Its size in pixels, if the Daemon read it.
 * @returns It.
 */
const pictureOf = (animated = false, dimensions?: PictureShown["dimensions"]): PictureShown => ({
  _tag: "Picture",
  alt: "Cats",
  animated,
  dimensions,
  src,
});

/**
 * Draws a picture, and counts what it says of failing.
 * @param picture - The picture.
 * @param animate - `ui.previews.animate` on this device, off unless given.
 * @returns The page, and how often it said it failed.
 */
const drawPicture = async (picture: PictureShown, animate = false) => {
  const onFail = vi.fn<() => void>();
  const page = await drawn(<span />);

  act(() => {
    page.registry.set(deviceUi, { "previews.animate": animate });
  });
  await page.draw(<Picture link={link} onFail={onFail} picture={picture} />);

  return { ...page, failures: () => onFail.mock.calls.length };
};

/**
 * The lightbox, if it is open.
 * @returns It, or none.
 */
const lightbox = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

/**
 * A button by its accessible name.
 * @param name - Its name.
 * @returns It, or none.
 */
const button = (name: string) =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

/**
 * The box a picture stands in, as the page sizes it.
 * @param container - Where it is drawn.
 * @returns Its shape, its limit, and whether what it holds has loaded.
 */
const boxOf = (container: HTMLElement) => {
  const box = container.querySelector<HTMLElement>("[data-loaded]");

  return {
    atMost: box?.style.getPropertyValue("--box-at-most"),
    height: box?.style.getPropertyValue("--box-height"),
    loaded: box?.dataset.loaded,
    width: box?.style.getPropertyValue("--box-width"),
  };
};

/**
 * What is drawn of an animated picture.
 * @param container - Where it is drawn.
 * @returns Whether its badge and first frame show, and what plays, if anything.
 */
const animatedIn = (container: HTMLElement) => ({
  badge: container.querySelector('[data-badge="play"]') !== null,
  canvas: container.querySelector("canvas") !== null,
  playing: container.querySelector("img")?.getAttribute("src") ?? null,
});

describe("a picture", () => {
  beforeEach(() => {
    observing();
  });

  afterEach(() => {
    restored();
  });

  describe("that does not move", () => {
    // Catches an image loading before it is near, as every image in history would.
    it("gives no image a source until it is near the view, then the Daemon's own, sending no referrer", async () => {
      const { container } = await drawPicture(pictureOf());

      const before = container.querySelectorAll("img").length;

      await scrolledNear();

      const image = container.querySelector("img");

      expect({
        before,
        referrer: image?.getAttribute("referrerpolicy"),
        src: image?.getAttribute("src"),
      }).toStrictEqual({ before: 0, referrer: "no-referrer", src });
    });

    // Catches the page jumping as an image loads.
    it("reserves its box from its size before it loads, the same box once it has, never wider than itself", async () => {
      const { container } = await drawPicture(pictureOf(false, { height: 48, width: 64 }));

      await scrolledNear();

      const before = boxOf(container);

      await happened(container.querySelector("img"), "load");

      expect({ after: boxOf(container), before }).toStrictEqual({
        after: { ...before, loaded: "true" },
        before: { atMost: "64px", height: "48", loaded: "false", width: "64" },
      });
    });

    // Catches a placeholder dropped when the image is seen rather than once it has loaded.
    it("keeps its placeholder where its size is not known, until it has loaded", async () => {
      const { container } = await drawPicture(pictureOf());

      await scrolledNear();

      const before = boxOf(container).loaded;

      await happened(container.querySelector("img"), "load");

      expect({ after: boxOf(container).loaded, before }).toStrictEqual({
        after: "true",
        before: "false",
      });
    });

    it("opens the lightbox on a press, with the image and a link to its page", async () => {
      await drawPicture(pictureOf());
      await scrolledNear();
      await pressed(button("enlarge Cats"));
      await settled(() => lightbox() !== null);

      expect({
        href: lightbox()?.querySelector("a")?.getAttribute("href"),
        image: lightbox()?.querySelector("img")?.getAttribute("src"),
      }).toStrictEqual({ href: link.href, image: src });
    });

    it("draws nothing once it fails to load, and says so once", async () => {
      const { container, failures } = await drawPicture(pictureOf());

      await scrolledNear();
      await happened(container.querySelector("img"), "error");

      expect({ failures: failures(), html: container.innerHTML }).toStrictEqual({
        failures: 1,
        html: "",
      });
    });
  });

  describe("that is animated", () => {
    // Catches the GIF fetched before it is near, or drawn moving where it should rest.
    it("fetches nothing until near, then rests as its first frame under a play badge, which a press plays and another stops", async () => {
      const { draws, fetches, revoked } = stubMedia();
      const { container } = await drawPicture(pictureOf(true));

      const far = { fetches: fetches(), image: container.querySelectorAll("img, canvas").length };

      await scrolledNear();
      await settled(() => container.querySelector("canvas") !== null);

      const canvas = container.querySelector("canvas");
      const still = { ...animatedIn(container), draws: [...draws], fetches: fetches() };

      await pressed(button("play Cats"));
      await settled(() => container.querySelector("img") !== null);

      const moving = { ...animatedIn(container), fetches: fetches() };

      await pressed(button("stop Cats"));
      await settled(() => container.querySelector("canvas") !== null);

      expect({
        back: animatedIn(container),
        far,
        moving,
        revoked,
        size: [canvas?.getAttribute("width"), canvas?.getAttribute("height")],
        still,
      }).toStrictEqual({
        back: { badge: true, canvas: true, playing: null },
        far: { fetches: [], image: 0 },
        moving: { badge: false, canvas: false, fetches: [src], playing: "blob:media-1" },
        revoked: [],
        size: ["64", "48"],
        still: { badge: true, canvas: true, draws: [[64, 48]], fetches: [src], playing: null },
      });
    });

    // Catches the lightbox fetching the GIF again, or offered while it rests.
    it("opens the lightbox from its corner only while it moves, with the bytes it plays", async () => {
      stubMedia();
      const { container } = await drawPicture(pictureOf(true));

      await scrolledNear();
      await settled(() => container.querySelector("canvas") !== null);

      const resting = button("enlarge Cats");

      await pressed(button("play Cats"));
      await pressed(button("enlarge Cats"));
      await settled(() => lightbox() !== null);

      expect({
        image: lightbox()?.querySelector("img")?.getAttribute("src"),
        resting,
      }).toStrictEqual({ image: "blob:media-1", resting: null });
    });

    it("moves on its own where animate is on", async () => {
      stubMedia();
      const { container } = await drawPicture(pictureOf(true), true);

      await scrolledNear();
      await settled(() => container.querySelector("img") !== null);

      expect(animatedIn(container)).toStrictEqual({
        badge: false,
        canvas: false,
        playing: "blob:media-1",
      });
    });

    it("rests under reduced motion with animate on, and plays on a press", async () => {
      stubMedia();
      reducingMotion(true);
      const { container } = await drawPicture(pictureOf(true), true);

      await scrolledNear();
      await settled(() => container.querySelector("canvas") !== null);

      const still = animatedIn(container);

      await pressed(button("play Cats"));
      await settled(() => container.querySelector("img") !== null);

      expect({ moving: animatedIn(container), still }).toStrictEqual({
        moving: { badge: false, canvas: false, playing: "blob:media-1" },
        still: { badge: true, canvas: true, playing: null },
      });
    });

    it("draws nothing once its bytes cannot be fetched, and says so once", async () => {
      stubMedia(404);
      const { container, failures } = await drawPicture(pictureOf(true));

      await scrolledNear();
      await settled(() => failures() > 0);

      expect({ failures: failures(), html: container.innerHTML }).toStrictEqual({
        failures: 1,
        html: "",
      });
    });
  });
});
