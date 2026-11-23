// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { back, left, pageEntered } from "../testing/history.ts";
import { useBackCloses } from "./back.ts";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The overlays open, by name. */
const shown = new Set<string>();

const roots: Root[] = [];

/**
 * An overlay, open while `shown` holds its name, which Back closes.
 * @param props - Its name, and what draws the overlays again.
 * @returns Nothing drawn.
 */
const Overlay = ({ name, redraw }: { readonly name: string; readonly redraw: () => void }) => {
  useBackCloses(shown.has(name), () => {
    shown.delete(name);
    redraw();
  });

  return null;
};

/** Draws two overlays, each open while `shown` holds its name, as React's strict mode does. */
const draw = () => {
  for (const root of roots) {
    root.render(
      <StrictMode>
        <Overlay name="lower" redraw={draw} />
        <Overlay name="upper" redraw={draw} />
      </StrictMode>
    );
  }
};

/**
 * Opens or closes an overlay as Escape, a press, or a choice does, not by Back.
 * @param name - The overlay.
 * @param open - Whether it opens.
 */
const toggle = async (name: string, open: boolean) => {
  await act(async () => {
    if (open) {
      shown.add(name);
    } else {
      shown.delete(name);
    }

    draw();
    await Promise.resolve();
  });
};

/** Puts the page on an entry of its own, and draws its overlays closed. */
const page = async () => {
  pageEntered();
  roots.push(createRoot(document.createElement("div")));
  await toggle("lower", false);
};

describe("Back", () => {
  afterEach(() => {
    shown.clear();

    for (const root of roots.splice(0)) {
      act(() => {
        root.unmount();
      });
    }
  });

  // Catches Back closing more than the topmost overlay, or leaving the page while one is open.
  it("closes the topmost overlay, then the next, then leaves the page", async () => {
    await page();
    await toggle("lower", true);
    await toggle("upper", true);

    await back();
    const first = [...shown];

    await back();
    const second = { left: left(), shown: [...shown] };

    await back();

    expect({ first, left: left(), second }).toStrictEqual({
      first: ["lower"],
      left: true,
      second: { left: false, shown: [] },
    });
  });

  // Catches an entry left behind by an overlay closed some other way, under another or not,
  // which would make a later Back seem to do nothing.
  it("gives back the entry of an overlay closed any other way", async () => {
    await page();
    await toggle("lower", true);
    await toggle("upper", true);
    await toggle("lower", false);

    await back();
    const first = { left: left(), shown: [...shown] };

    await back();

    expect({ first, left: left() }).toStrictEqual({
      first: { left: false, shown: [] },
      left: true,
    });
  });

  // Catches Forward reaching an entry of an overlay that has closed, which Back would then
  // spend doing nothing.
  it("goes back over an entry Forward reaches with nothing open for it", async () => {
    await page();
    await toggle("lower", true);
    await back();
    await act(async () => {
      history.forward();
      await Promise.resolve();
    });

    const after = { page: history.state === null, shown: [...shown] };

    await back();

    expect({ after, left: left() }).toStrictEqual({
      after: { page: true, shown: [] },
      left: true,
    });
  });

  // Catches a reload on an overlay's entry, which nothing is open to close.
  it("goes back over an overlay's entry the page is reloaded on", async () => {
    pageEntered();
    history.pushState({ iircOverlays: 1 }, "");
    vi.resetModules();

    const { watchBack } = await import("./back.ts");

    await act(async () => {
      watchBack();
      await Promise.resolve();
    });

    const after = history.state === null;

    await back();

    expect({ after, left: left() }).toStrictEqual({ after: true, left: true });
  });
});
