// @vitest-environment happy-dom
import type { SoundShown } from "@iirc/frontend/previews";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sound } from "./sound.tsx";
import { drawn, happened, restored } from "./testing/browser.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const sound: SoundShown = {
  _tag: "Sound",
  src: "/api/previews/cats/stream?timeline=t&position=p",
  type: "audio/ogg",
};

/**
 * The sound's player as drawn.
 * @param container - Where it is drawn.
 * @returns How it plays.
 */
const audioIn = (container: HTMLElement) => {
  const audio = container.querySelector("audio");

  return {
    autoplay: audio?.autoplay,
    controls: audio?.controls,
    preload: audio?.getAttribute("preload"),
    src: audio?.getAttribute("src"),
  };
};

describe("a sound", () => {
  afterEach(() => {
    restored();
  });

  // Catches the Daemon streaming a sound nobody pressed.
  it("is the browser's player, which fetches nothing until play, or plays at once when told", async () => {
    const onFail = vi.fn<() => void>();

    const first = await drawn(<Sound name="Cats" onFail={onFail} playing={false} sound={sound} />);
    const second = await drawn(<Sound name="Cats" onFail={onFail} playing sound={sound} />);
    const resting = audioIn(first.container);
    const playing = audioIn(second.container);

    expect({ playing, resting }).toStrictEqual({
      playing: { autoplay: true, controls: true, preload: null, src: sound.src },
      resting: { autoplay: false, controls: true, preload: "none", src: sound.src },
    });
  });

  it("draws nothing once it fails to play, and says so once", async () => {
    const onFail = vi.fn<() => void>();

    const { container } = await drawn(
      <Sound name="Cats" onFail={onFail} playing={false} sound={sound} />
    );

    await happened(container.querySelector("audio"), "error");

    expect({ failures: onFail.mock.calls.length, html: container.innerHTML }).toStrictEqual({
      failures: 1,
      html: "",
    });
  });
});
