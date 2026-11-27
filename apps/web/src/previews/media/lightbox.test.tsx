// @vitest-environment happy-dom
import { act } from "react";
import { Button } from "react-aria-components";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { eventually } from "../../testing/fake-daemon.ts";
import { back, left, pageEntered } from "../../testing/history.ts";
import { Lightbox } from "./lightbox.tsx";
import type { LightboxMedia } from "./lightbox.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const unmounts: (() => void)[] = [];

const image: LightboxMedia = { _tag: "Image", src: "/api/previews/media/cats" };
const video: LightboxMedia = { _tag: "Video", poster: undefined, src: "/api/previews/stream/cats" };

/**
 * Presses an element as a person does: it takes focus, and then it is pressed.
 * @param element - The element.
 */
const pressed = async (element: HTMLElement | null | undefined) => {
  await act(async () => {
    element?.focus();
    element?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    element?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    element?.click();
    await Promise.resolve();
  });
};

/**
 * Draws the control that opens a lightbox, and opens it.
 * @param media - What it draws.
 * @returns The control that opened it.
 */
const opened = async (media: LightboxMedia) => {
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);

  unmounts.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  await act(async () => {
    root.render(
      <Lightbox
        alt="Cats"
        link={{ href: "https://example.com/cats", text: "https://example.com/cats" }}
        media={media}
      >
        <Button>enlarge Cats</Button>
      </Lightbox>
    );
    await Promise.resolve();
  });

  const control = container.querySelector("button");

  await pressed(control);

  return control;
};

/**
 * The lightbox, if it is open.
 * @returns It, or none.
 */
const lightbox = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

/**
 * Waits for the lightbox to close, and says where focus went.
 * @param control - The control that opened it.
 * @returns Whether the view is gone, and whether focus is back on the control.
 */
const closedTo = async (control: HTMLElement | null) => {
  await act(async () => {
    await eventually(() => lightbox() === null && document.activeElement === control);
  });

  return { focused: document.activeElement === control, gone: lightbox() === null };
};

/**
 * Presses Escape in the lightbox.
 */
const escaped = async () => {
  await act(async () => {
    lightbox()?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
    );
    await Promise.resolve();
  });
};

describe("the lightbox", () => {
  afterEach(() => {
    for (const unmount of unmounts.splice(0)) {
      unmount();
    }
  });

  describe("of an image", () => {
    it("closes on a press of the image, and focus returns to the control that opened it", async () => {
      const control = await opened(image);

      await pressed(lightbox()?.querySelector("img"));

      await expect(closedTo(control)).resolves.toStrictEqual({ focused: true, gone: true });
    });

    it("stays open on a press of the link to its page", async () => {
      await opened(image);

      const link = lightbox()?.querySelector("a");
      const href = link?.getAttribute("href");

      // The link opens its page in a new tab, which this test has no browser to do.
      link?.addEventListener("click", (event) => {
        event.preventDefault();
      });
      await pressed(link);

      expect({ href, open: lightbox() !== null }).toStrictEqual({
        href: "https://example.com/cats",
        open: true,
      });
    });
  });

  describe("of a video", () => {
    it("stays open on a press of the video, which is its player's", async () => {
      await opened(video);
      await pressed(lightbox()?.querySelector("video"));

      expect(lightbox()?.querySelector("video")).not.toBeNull();
    });

    it("closes on a press of the close control in its corner, and focus returns", async () => {
      const control = await opened(video);

      await pressed(lightbox()?.querySelector<HTMLButtonElement>('button[aria-label="close"]'));

      await expect(closedTo(control)).resolves.toStrictEqual({ focused: true, gone: true });
    });

    it("closes on Escape, and focus returns to the control that opened it", async () => {
      const control = await opened(video);

      await escaped();

      await expect(closedTo(control)).resolves.toStrictEqual({ focused: true, gone: true });
    });
  });

  it("closes on a press of the dimmed screen around it", async () => {
    const control = await opened(image);
    // The overlay, React Aria's dimmed layer around the dialog, is what a tap beside it lands on.
    const overlay = lightbox()?.closest('[style*="--visual-viewport"]');

    await act(async () => {
      overlay?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      overlay?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await expect(closedTo(control)).resolves.toStrictEqual({ focused: true, gone: true });
  });

  // Catches Back leaving the page while a Preview is in the lightbox.
  it("closes on Back, and the page stays", async () => {
    pageEntered();
    const control = await opened(image);

    await back();

    await expect(
      closedTo(control).then((closed) => ({ ...closed, left: left() }))
    ).resolves.toStrictEqual({ focused: true, gone: true, left: false });
  });
});
