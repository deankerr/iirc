// @vitest-environment happy-dom
import type { PictureShown, VideoShown } from "@iirc/frontend/previews";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  drawn,
  happened,
  observing,
  pressed,
  restored,
  scrolledNear,
  settled,
  stubMedia,
} from "./testing/browser.tsx";
import { Video } from "./video.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const stream = "/api/previews/cats/stream?timeline=t&position=p";
const posterSrc = "/api/previews/images/cats";
const link = { href: "https://example.com/cats", text: "https://example.com/cats" };

/**
 * A video as a card is given it, in a 4 by 3 box.
 * @param poster - Its poster: still, animated, or none.
 * @returns It.
 */
const videoOf = (poster: "still" | "animated" | "none"): VideoShown => {
  const picture: PictureShown = {
    _tag: "Picture",
    alt: "A cat",
    animated: poster === "animated",
    dimensions: undefined,
    src: posterSrc,
  };

  return {
    _tag: "Video",
    box: { height: 3, width: 4 },
    poster: poster === "none" ? undefined : picture,
    src: stream,
    type: "video/mp4",
  };
};

/**
 * Draws a video, and counts what it says of failing.
 * @param video - The video.
 * @param playing - Whether it plays at once.
 * @returns The page, and how often it said it failed.
 */
const drawVideo = async (video: VideoShown, playing = false) => {
  const onFail = vi.fn<() => void>();

  const page = await drawn(
    <Video link={link} name="A cat" onFail={onFail} playing={playing} video={video} />
  );

  return { ...page, failures: () => onFail.mock.calls.length };
};

/**
 * A button by its accessible name.
 * @param name - Its name.
 * @returns It, or none.
 */
const button = (name: string) =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

/**
 * The lightbox, if it is open.
 * @returns It, or none.
 */
const lightbox = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

/**
 * The video as drawn in its place.
 * @param container - Where it is drawn.
 * @returns What it plays and how, or none.
 */
const videoIn = (container: HTMLElement) => {
  const video = container.querySelector("video");

  return video === null
    ? null
    : {
        autoplay: video.autoplay,
        controls: video.controls,
        poster: video.getAttribute("poster"),
        preload: video.getAttribute("preload"),
        src: video.getAttribute("src"),
      };
};

/**
 * The shape the box at the top of what is drawn is given.
 * @param container - Where it is drawn.
 * @returns Its proportions.
 */
const boxIn = (container: HTMLElement) => {
  const box = container.firstElementChild;

  return box instanceof HTMLElement
    ? [box.style.getPropertyValue("--box-width"), box.style.getPropertyValue("--box-height")]
    : [];
};

/**
 * Every attribute on the page that holds the stream's address.
 * @returns Each, as its element and name.
 */
const holdingStream = () =>
  [...document.body.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes].flatMap((attribute) =>
      attribute.value.includes("/stream") ? [`${element.localName}[${attribute.name}]`] : []
    )
  );

describe("a video", () => {
  beforeEach(() => {
    observing();
  });

  afterEach(() => {
    restored();
  });

  describe("with a poster", () => {
    // Catches the Daemon streaming a video nobody pressed.
    it("rests as its poster under a play button, holding the stream nowhere and fetching nothing", async () => {
      const media = stubMedia();
      const { container } = await drawVideo(videoOf("still"));

      await scrolledNear();

      expect({
        fetches: media.fetches(),
        holding: holdingStream(),
        play: button("play A cat") !== null,
        poster: container.querySelector("img")?.getAttribute("src"),
        video: videoIn(container),
      }).toStrictEqual({
        fetches: [],
        holding: [],
        play: true,
        poster: posterSrc,
        video: null,
      });
    });

    // Catches play moving what is below, leaving the Owner to press play twice, or dropping
    // the focus of one who pressed it from the keyboard.
    it("swaps in the video on play, already playing under its poster, in the same box, the focus going with it", async () => {
      const { container } = await drawVideo(videoOf("still"));

      await scrolledNear();

      const before = boxIn(container);

      await pressed(button("play A cat"));

      expect({
        after: boxIn(container),
        before,
        focused: document.activeElement === container.querySelector("video"),
        still: container.querySelector("img"),
        video: videoIn(container),
      }).toStrictEqual({
        after: ["4", "3"],
        before: ["4", "3"],
        focused: true,
        still: null,
        video: { autoplay: true, controls: true, poster: posterSrc, preload: null, src: stream },
      });
    });

    it("mounts as the video already playing when told to play at once", async () => {
      const { container } = await drawVideo(videoOf("still"), true);

      expect(videoIn(container)).toStrictEqual({
        autoplay: true,
        controls: true,
        poster: posterSrc,
        preload: null,
        src: stream,
      });
    });

    // Catches a GIF poster drawn moving, or given to the video as its still.
    it("draws an animated poster as its first frame, and plays with no poster", async () => {
      const media = stubMedia();
      const { container } = await drawVideo(videoOf("animated"));

      await scrolledNear();
      await settled(() => container.querySelector("canvas") !== null);

      const resting = { fetches: media.fetches(), image: container.querySelector("img") };

      await pressed(button("play A cat"));

      expect({ poster: videoIn(container)?.poster, resting }).toStrictEqual({
        poster: null,
        resting: { fetches: [posterSrc], image: null },
      });
    });

    // Catches a broken poster hiding a video that would play, or taking its play button.
    it("keeps its play button alone in its box once its poster fails, which is no failure of the video and still plays", async () => {
      const { container, failures } = await drawVideo(videoOf("still"));

      await scrolledNear();
      await happened(container.querySelector("img"), "error");

      const failed = {
        box: boxIn(container),
        failures: failures(),
        holding: holdingStream(),
        image: container.querySelector("img"),
      };

      await pressed(button("play A cat"));

      expect({ failed, video: videoIn(container) }).toStrictEqual({
        failed: { box: ["4", "3"], failures: 0, holding: [], image: null },
        video: { autoplay: true, controls: true, poster: null, preload: null, src: stream },
      });
    });
  });

  describe("with no poster", () => {
    it("is the browser's player, which fetches nothing until play, or plays at once when told", async () => {
      const first = await drawVideo(videoOf("none"));
      const resting = videoIn(first.container);

      restored();
      observing();

      const second = await drawVideo(videoOf("none"), true);
      const playing = videoIn(second.container);

      expect({ playing, resting }).toStrictEqual({
        playing: { autoplay: true, controls: true, poster: null, preload: null, src: stream },
        resting: { autoplay: false, controls: true, poster: null, preload: "none", src: stream },
      });
    });
  });

  it("opens the lightbox from its corner with the stream, pausing it where it plays", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
      // happy-dom plays nothing, so there is nothing to pause.
    });

    await drawVideo(videoOf("still"), true);
    await pressed(button("enlarge A cat"));
    await settled(() => lightbox() !== null);

    const video = lightbox()?.querySelector("video");

    expect({
      autoplay: video?.autoplay,
      paused: pause.mock.calls.length,
      poster: video?.getAttribute("poster"),
      src: video?.getAttribute("src"),
    }).toStrictEqual({ autoplay: true, paused: 1, poster: posterSrc, src: stream });
  });

  it("draws nothing once it fails to play, and says so once", async () => {
    const { container, failures } = await drawVideo(videoOf("none"), true);

    await happened(container.querySelector("video"), "error");

    expect({ failures: failures(), html: container.innerHTML }).toStrictEqual({
      failures: 1,
      html: "",
    });
  });
});
