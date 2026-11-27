// @vitest-environment happy-dom
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PreviewScrollerProvider, useNearView } from "./near-view.ts";
import { drawn, observedWith, observing, restored, scrolledNear } from "./testing/browser.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/**
 * An element that tells each time it is near, with what it would tell.
 * @param props - What it tells, and where it is told.
 * @returns It.
 */
const Watched = ({ said, told }: { readonly said: number; readonly told: number[] }) => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);

  const onNear = useCallback(() => {
    told.push(said);
  }, [said, told]);

  const near = useNearView(element, onNear);

  return <span data-near={near} ref={setElement} />;
};

describe("near the view", () => {
  beforeEach(() => {
    observing();
  });

  afterEach(() => {
    restored();
  });

  // Catches a Message asked for, or an image loaded, only once in view rather than a screen ahead.
  it("watches against the Timeline's scroller, a screen's height beyond it", async () => {
    const scroller = document.createElement("div");

    await drawn(
      <PreviewScrollerProvider value={scroller}>
        <Watched said={1} told={[]} />
      </PreviewScrollerProvider>
    );

    expect(observedWith()).toStrictEqual([{ margin: "100% 0px", root: scroller }]);
  });

  // Catches a Message asked for each time it scrolls back, or never told what changed.
  it("tells nothing until near, then once, and again only when what it tells changes", async () => {
    const told: number[] = [];
    const page = await drawn(<Watched said={1} told={told} />);
    const far = [...told];

    await scrolledNear();
    await scrolledNear();
    await page.draw(<Watched said={1} told={told} />);

    const once = [...told];

    await page.draw(<Watched said={2} told={told} />);

    expect({
      far,
      near: page.container.querySelector("span")?.dataset.near,
      once,
      told,
    }).toStrictEqual({ far: [], near: "true", once: [1], told: [1, 2] });
  });
});
