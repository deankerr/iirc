// @vitest-environment happy-dom
import type { PlayerShown } from "@iirc/frontend/previews";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Media } from "./media.tsx";
import { drawn, framesGoNowhere, pressed, restored } from "./testing/browser.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const link = { href: "https://example.com/song", text: "https://example.com/song" };

/**
 * A player with no poster, from a host.
 * @param host - Where it plays from.
 * @returns It.
 */
const playerFrom = (host: string): PlayerShown => ({
  _tag: "Player",
  box: { height: 9, width: 16 },
  host,
  poster: undefined,
  src: `https://${host}/embed/1`,
  words: `Plays from ${host}`,
});

/**
 * Draws a player as a card's media.
 * @param player - The player.
 * @returns The element.
 */
const asMedia = (player: PlayerShown) => (
  <Media
    link={link}
    media={player}
    name="A song"
    onFail={() => {
      // A player never says it failed.
    }}
    playing={false}
  />
);

describe("a Preview's media", () => {
  beforeEach(() => {
    framesGoNowhere();
  });

  afterEach(() => {
    restored();
  });

  // Catches another site's player loaded because a different one was pressed before it.
  it("plays nothing anew when the Daemon answers with other media after a press", async () => {
    const first = playerFrom("www.youtube-nocookie.com");
    const page = await drawn(asMedia(first));

    await pressed(
      document.body.querySelector("button[aria-label='play from www.youtube-nocookie.com']")
    );

    const before = document.body.querySelectorAll("iframe").length;

    await page.draw(asMedia(playerFrom("player.vimeo.com")));

    expect({
      after: document.body.querySelectorAll("iframe").length,
      before,
      play: document.body.querySelector("button[aria-label='play from player.vimeo.com']") !== null,
    }).toStrictEqual({ after: 0, before: 1, play: true });
  });
});
