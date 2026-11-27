// @vitest-environment happy-dom
import type { PictureShown, PlayerShown } from "@iirc/frontend/previews";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EmbeddedPlayer } from "./embedded-player.tsx";
import {
  drawn,
  framesGoNowhere,
  happened,
  observing,
  pressed,
  restored,
  scrolledNear,
  settled,
  stubMedia,
} from "./testing/browser.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const host = "www.youtube-nocookie.com";
const address = `https://${host}/embed/abc123?autoplay=1`;
const posterSrc = "/api/previews/images/song";

/**
 * A player as a card is given it, in a 640 by 360 box.
 * @param poster - Its poster: still, animated, or none.
 * @returns It.
 */
const playerOf = (poster: "still" | "animated" | "none"): PlayerShown => {
  const picture: PictureShown = {
    _tag: "Picture",
    alt: "A song",
    animated: poster === "animated",
    dimensions: { height: 3, width: 4 },
    src: posterSrc,
  };

  return {
    _tag: "Player",
    box: { height: 360, width: 640 },
    host,
    poster: poster === "none" ? undefined : picture,
    src: address,
    words: `Plays from ${host}`,
  };
};

/**
 * The play button, named for where it plays from.
 * @returns It, or none.
 */
const play = () =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="play from ${host}"]`);

/**
 * Every attribute on the page that holds anything of the player's host.
 * @returns Each, as its element and name.
 */
const holdingHost = () =>
  [...document.body.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes].flatMap((attribute) =>
      attribute.value.includes(`${host}/`) ? [`${element.localName}[${attribute.name}]`] : []
    )
  );

/**
 * Each frame on the page, as its attributes, with how it is styled only as present.
 * @returns Them.
 */
const frames = () =>
  [...document.body.querySelectorAll("iframe")].map((frame) =>
    Object.fromEntries(
      [...frame.attributes].map(({ name, value }) => [name, name === "class" ? "drawn" : value])
    )
  );

const frame = {
  allow: "autoplay; fullscreen; encrypted-media; picture-in-picture",
  class: "drawn",
  referrerpolicy: "strict-origin",
  sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups",
  src: address,
  title: `player from ${host}`,
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

describe("an embedded player", () => {
  beforeEach(() => {
    observing();
    framesGoNowhere();
  });

  afterEach(() => {
    restored();
  });

  // Catches another site learning of the Owner before they asked it to play.
  it("loads nothing from its host until play, with a poster or without", async () => {
    await drawn(<EmbeddedPlayer player={playerOf("still")} playing={false} />);
    await scrolledNear();

    const poster = {
      frames: document.body.querySelectorAll("iframe, frame, embed, object").length,
      holding: holdingHost(),
      play: play()?.parentElement?.title,
    };

    restored();
    observing();
    framesGoNowhere();
    await drawn(<EmbeddedPlayer player={playerOf("none")} playing={false} />);

    expect({
      alone: {
        frames: document.body.querySelectorAll("iframe, frame, embed, object").length,
        holding: holdingHost(),
        play: play()?.parentElement?.title,
      },
      poster,
    }).toStrictEqual({
      alone: { frames: 0, holding: [], play: `Plays from ${host}` },
      poster: { frames: 0, holding: [], play: `Plays from ${host}` },
    });
  });

  // Catches the frame losing its sandbox, a referrer saying where it was embedded, or play
  // dropping the focus of one who pressed it from the keyboard.
  it("swaps in the sandboxed frame on play, in the box its page gave whatever its poster's, the focus going with it", async () => {
    const { container } = await drawn(
      <EmbeddedPlayer player={playerOf("still")} playing={false} />
    );

    await scrolledNear();
    await pressed(play());

    expect({
      box: boxIn(container),
      focused: document.activeElement === container.querySelector("iframe"),
      frames: frames(),
      poster: container.querySelector("img"),
    }).toStrictEqual({ box: ["640", "360"], focused: true, frames: [frame], poster: null });
  });

  // Catches a click on play taking the focus into another site's frame, where a key typed
  // next no longer reaches the Composer.
  it("leaves the focus out of the frame on play pressed with a pointer", async () => {
    const { container } = await drawn(<EmbeddedPlayer player={playerOf("none")} playing={false} />);

    const button = play();
    const mouse = { bubbles: true, button: 0, cancelable: true, pointerType: "mouse" };

    await act(async () => {
      button?.dispatchEvent(new PointerEvent("pointerdown", mouse));
      button?.dispatchEvent(new PointerEvent("pointerup", mouse));
      button?.dispatchEvent(new MouseEvent("click", { ...mouse, detail: 1 }));
      await Promise.resolve();
    });

    expect({
      focused: document.activeElement === container.querySelector("iframe"),
      frames: frames().length,
    }).toStrictEqual({ focused: false, frames: 1 });
  });

  it("mounts as its frame when told to play at once", async () => {
    await drawn(<EmbeddedPlayer player={playerOf("still")} playing />);

    expect(frames()).toStrictEqual([frame]);
  });

  // Catches a broken poster taking the play button with it.
  it("keeps its play button alone in its box once its poster fails, which still plays", async () => {
    const { container } = await drawn(
      <EmbeddedPlayer player={playerOf("still")} playing={false} />
    );

    await scrolledNear();
    await happened(container.querySelector("img"), "error");

    const failed = { box: boxIn(container), image: container.querySelector("img") };

    await pressed(play());

    expect({ failed, frames: frames().length }).toStrictEqual({
      failed: { box: ["640", "360"], image: null },
      frames: 1,
    });
  });

  it("draws an animated poster as its first frame, still", async () => {
    stubMedia();

    const { container } = await drawn(
      <EmbeddedPlayer player={playerOf("animated")} playing={false} />
    );

    await scrolledNear();
    await settled(() => container.querySelector("canvas") !== null);

    expect({ image: container.querySelector("img"), play: play() !== null }).toStrictEqual({
      image: null,
      play: true,
    });
  });
});
