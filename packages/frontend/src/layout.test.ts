import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  deepestSplits,
  focusedPane,
  keeping,
  layoutFrom,
  leastShare,
  mostPanes,
  neighbour,
  panesOf,
  rectsOf,
  reduceLayout,
  shownPanes,
  single,
  splitsOf,
} from "./layout.ts";
import type { Direction, Layout, LayoutChange, Node, Rect } from "./layout.ts";

/** A view in these tests: a number, so each Pane's can be told apart. */
type View = number;

const directions: readonly Direction[] = ["Left", "Right", "Up", "Down"];

/** A change, with what it names picked by index from what the layout holds when it is made. */
type Step =
  | { readonly _tag: "Split"; readonly vertical: boolean }
  | { readonly _tag: "Close" }
  | { readonly _tag: "Focus"; readonly pick: number }
  | { readonly _tag: "Move"; readonly direction: Direction }
  | { readonly _tag: "Swap"; readonly direction: Direction }
  | { readonly _tag: "Equalize" }
  | { readonly _tag: "Grow" }
  | { readonly _tag: "Shrink" }
  | { readonly _tag: "Resize"; readonly pick: number; readonly ratios: readonly number[] }
  | { readonly _tag: "Zoom" };

const direction = fc.constantFrom(...directions);

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({ _tag: fc.constant("Split" as const), vertical: fc.boolean() }),
    weight: 4,
  },
  { arbitrary: fc.constant({ _tag: "Close" as const }), weight: 2 },
  { arbitrary: fc.record({ _tag: fc.constant("Focus" as const), pick: fc.nat() }), weight: 2 },
  { arbitrary: fc.record({ _tag: fc.constant("Move" as const), direction }), weight: 3 },
  { arbitrary: fc.record({ _tag: fc.constant("Swap" as const), direction }), weight: 2 },
  fc.constant({ _tag: "Equalize" as const }),
  fc.constant({ _tag: "Grow" as const }),
  fc.constant({ _tag: "Shrink" as const }),
  {
    arbitrary: fc.record({
      _tag: fc.constant("Resize" as const),
      pick: fc.nat(),
      ratios: fc.array(fc.double({ max: 100, min: 0, noNaN: true }), { maxLength: 6 }),
    }),
    weight: 2,
  },
  fc.constant({ _tag: "Zoom" as const })
);

/**
 * The change a step makes to a layout, with the view a split opens being one never seen.
 * @param layout - The layout.
 * @param one - The step.
 * @param view - The view a split opens.
 * @returns The change.
 */
const changeOf = (layout: Layout<View>, one: Step, view: View): LayoutChange<View> => {
  switch (one._tag) {
    case "Split": {
      return { _tag: "Split", axis: one.vertical ? "Vertical" : "Horizontal", view };
    }

    case "Focus": {
      const panes = panesOf(layout.root);

      return { _tag: "Focus", pane: panes[one.pick % panes.length]?.id ?? "p0" };
    }

    case "Resize": {
      const splits = splitsOf(layout.root);
      const split = splits[one.pick % Math.max(1, splits.length)];

      return {
        _tag: "Resize",
        ratios:
          split === undefined || one.ratios.length < split.children.length
            ? one.ratios
            : one.ratios.slice(0, split.children.length),
        split: split?.id ?? "s0",
      };
    }

    case "Close":
    case "Equalize":
    case "Grow":
    case "Move":
    case "Shrink":
    case "Swap":
    case "Zoom": {
      return one;
    }

    default: {
      return one satisfies never;
    }
  }
};

/**
 * Every way a layout must be well formed, as a list of what is wrong.
 * @param layout - The layout.
 * @returns What is wrong, none when it is well formed.
 */
const faults = (layout: Layout<View>): readonly string[] => {
  const wrong: string[] = [];
  const ids = new Set<string>();

  const visit = (node: Node<View>, parentAxis: string | undefined) => {
    if (ids.has(node.id)) {
      wrong.push(`${node.id} twice`);
    }

    ids.add(node.id);

    if (Number(node.id.slice(1)) >= layout.next) {
      wrong.push(`${node.id} not below the counter ${layout.next}`);
    }

    if (node._tag === "Pane") {
      return;
    }

    if (node.children.length < 2) {
      wrong.push(`${node.id} has ${node.children.length} children`);
    }

    if (node.axis === parentAxis) {
      wrong.push(`${node.id} along its parent's axis`);
    }

    const sum = node.children.reduce((total, child) => total + child.ratio, 0);

    if (Math.abs(sum - 1) > 1e-9) {
      wrong.push(`${node.id}'s ratios sum to ${sum}`);
    }

    for (const child of node.children) {
      if (!(child.ratio > 0)) {
        wrong.push(`${node.id} has a ratio of ${child.ratio}`);
      }

      visit(child.node, node.axis);
    }
  };

  visit(layout.root, undefined);

  if (!panesOf(layout.root).some((pane) => pane.id === layout.focused)) {
    wrong.push(`the focus is on ${layout.focused}, no Pane`);
  }

  if (layout.zoomed && layout.root._tag === "Pane") {
    wrong.push("zoomed with one Pane");
  }

  return wrong;
};

/**
 * Runs steps from one Pane, checking each step as it goes.
 * @param steps - The steps.
 * @param check - What must hold of each step.
 */
const play = (
  steps: readonly Step[],
  check: (before: Layout<View>, change: LayoutChange<View>, after: Layout<View>) => void
) => {
  let layout = single(0);

  for (const [index, one] of steps.entries()) {
    const change = changeOf(layout, one, index + 1);
    const after = reduceLayout(layout, change);

    check(layout, change, after);
    layout = after;
  }
};

/**
 * Whether a Pane's place lies at the edge of the layout in a direction.
 * @param rect - Its place.
 * @param towards - The direction.
 * @returns Whether it does.
 */
const atEdge = (rect: Rect, towards: Direction) => {
  const near = 1e-9;

  switch (towards) {
    case "Left": {
      return rect.left < near;
    }

    case "Right": {
      return rect.right > 1 - near;
    }

    case "Up": {
      return rect.top < near;
    }

    case "Down": {
      return rect.bottom > 1 - near;
    }

    default: {
      return towards satisfies never;
    }
  }
};

/**
 * A layout with its ratios rounded, as JSON may write them a bit apart.
 * @param layout - The layout.
 * @returns The layout, rounded.
 */
const rounded = (layout: Layout<View>): Layout<View> => {
  const round = (node: Node<View>): Node<View> =>
    node._tag === "Pane"
      ? node
      : {
          ...node,
          children: node.children.map((child) => ({
            node: round(child.node),
            ratio: Math.round(child.ratio * 1e9) / 1e9,
          })),
        };

  return { ...layout, root: round(layout.root) };
};

/**
 * A view kept, taken back as it was.
 * @param view - The view.
 * @returns It.
 */
const same = (view: View): View => view;

/**
 * How many Panes a change adds: one for a split, none taken for a close of the last.
 * @param change - The change.
 * @param closes - Whether it closes a Pane.
 * @returns How many more Panes there are after it.
 */
const paneDelta = (change: LayoutChange<View>, closes: boolean): number => {
  if (change._tag === "Split") {
    return 1;
  }

  return closes ? -1 : 0;
};

/**
 * The focused Pane's share of the Split it is in, or all of it for one Pane.
 * @param layout - The layout.
 * @returns The share.
 */
const ownShare = (layout: Layout<View>): number =>
  splitsOf(layout.root)
    .flatMap((split) => split.children)
    .find((child) => child.node.id === layout.focused)?.ratio ?? 1;

/**
 * One Pane split side by side, the new Pane each time, a number of times.
 * @param times - How many times.
 * @returns The layout.
 */
const splitTimes = (times: number) => {
  let layout = single(0);

  for (let view = 1; view <= times; view += 1) {
    layout = reduceLayout(layout, { _tag: "Split", axis: "Horizontal", view });
  }

  return layout;
};

/** A place no Pane has, outside the layout. */
const nowhere: Rect = { bottom: -1, left: -1, right: -1, top: -1 };

/**
 * A Split's ratios, the root's.
 * @param layout - The layout.
 * @returns Its root's ratios, none for one Pane.
 */
const rootRatios = (layout: Layout<View>): readonly number[] =>
  layout.root._tag === "Split" ? layout.root.children.map((child) => child.ratio) : [];

/**
 * Ratios rounded, as floating point leaves them a bit apart.
 * @param ratios - The ratios.
 * @returns Them, rounded.
 */
const roundedRatios = (ratios: readonly number[]) =>
  ratios.map((ratio) => Math.round(ratio * 1e9) / 1e9);

/**
 * How deep a layout nests its Splits.
 * @param layout - The layout.
 * @returns The depth.
 */
const splitsDeep = (layout: Layout<View>): number => {
  let deepest = 0;
  let level: readonly Node<View>[] = [layout.root];

  while (level.some((node) => node._tag === "Split")) {
    deepest += 1;
    level = level.flatMap((node) =>
      node._tag === "Split" ? node.children.map((child) => child.node) : []
    );
  }

  return deepest;
};

const viewsOf = (layout: Layout<View>) =>
  panesOf(layout.root)
    .map((pane) => pane.view)
    .toSorted((left, right) => left - right);

describe("the pane layout", () => {
  it("stays well formed, and keeps the focus on a Pane, whatever is done", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        play(steps, (_, change, after) => {
          expect({ change, faults: faults(after) }).toStrictEqual({ change, faults: [] });
        });
      }),
      { numRuns: 300 }
    );
  });

  it("never closes the last Pane, and closes one otherwise, keeping every other view", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        play(steps, (before, change, after) => {
          const panes = panesOf(before.root).length;
          const closed = focusedPane(before).view;
          const closes = change._tag === "Close" && panes > 1;

          expect({
            panes: panesOf(after.root).length - panes,
            views: viewsOf(after),
          }).toStrictEqual({
            panes: paneDelta(change, closes),
            views:
              change._tag === "Split"
                ? [...viewsOf(before), change.view].toSorted((left, right) => left - right)
                : viewsOf(before).filter((one) => !closes || one !== closed),
          });
        });
      })
    );
  });

  it("gives the focus to the Pane a split makes", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        play(steps, (_, change, after) => {
          expect(change._tag === "Split" ? focusedPane(after).view : "not split").toBe(
            change._tag === "Split" ? change.view : "not split"
          );
        });
      })
    );
  });

  it("moves the focus to the Pane beside it on the screen, or nowhere at an edge", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), direction, (steps, towards) => {
        play(steps, (_, __, after) => {
          const rects = rectsOf(after);
          const from = rects.get(after.focused) ?? nowhere;
          const to = neighbour(after, towards);
          const moved = reduceLayout(after, { _tag: "Move", direction: towards });
          const rect = rects.get(to ?? "") ?? nowhere;
          const across = towards === "Left" || towards === "Right";
          const middle = across ? (from.top + from.bottom) / 2 : (from.left + from.right) / 2;
          const near = 1e-9;

          const touches = {
            Down: Math.abs(rect.top - from.bottom) < near,
            Left: Math.abs(rect.right - from.left) < near,
            Right: Math.abs(rect.left - from.right) < near,
            Up: Math.abs(rect.bottom - from.top) < near,
          }[towards];

          const spans = across
            ? rect.top <= middle + near && rect.bottom >= middle - near
            : rect.left <= middle + near && rect.right >= middle - near;

          // At an edge, nowhere; otherwise a Pane whose edge touches and spans the middle.
          expect({ focused: moved.focused, found: to !== undefined, spans, touches }).toStrictEqual(
            atEdge(from, towards)
              ? { focused: after.focused, found: false, spans: false, touches: false }
              : { focused: to, found: true, spans: true, touches: true }
          );
        });
      }),
      { numRuns: 300 }
    );
  });

  it("finds the Pane beside it in a known layout", () => {
    // p0 | (p1 / (p2 | p3)): p0 on the left, p1 at the top right, p2 and p3 below it.
    let layout = single(0);

    layout = reduceLayout(layout, { _tag: "Split", axis: "Horizontal", view: 1 });
    layout = reduceLayout(layout, { _tag: "Split", axis: "Vertical", view: 2 });
    layout = reduceLayout(layout, { _tag: "Split", axis: "Horizontal", view: 3 });

    const at = (pane: string, towards: Direction) =>
      neighbour({ ...layout, focused: pane }, towards);

    expect({
      p0right: at("p0", "Right"),
      p1down: at("p1", "Down"),
      p1left: at("p1", "Left"),
      p2left: at("p2", "Left"),
      p2right: at("p2", "Right"),
      p2up: at("p2", "Up"),
      p3left: at("p3", "Left"),
      p3up: at("p3", "Up"),
    }).toStrictEqual({
      // The middle of p0 falls on the line between p1 and p2: the first along it, p1.
      p0right: "p1",
      // p1's middle is over the line between p2 and p3, so p2.
      p1down: "p2",
      p1left: "p0",
      p2left: "p0",
      p2right: "p3",
      p2up: "p1",
      p3left: "p2",
      p3up: "p1",
    });
  });

  it("zooms and back to the very layout it was", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        play(steps, (_, __, after) => {
          const zoomed = reduceLayout(after, { _tag: "Zoom" });
          const back = reduceLayout(zoomed, { _tag: "Zoom" });

          expect(back).toStrictEqual(after);
          expect(shownPanes(zoomed, false)).toStrictEqual(
            zoomed.zoomed ? [focusedPane(after)] : panesOf(after.root)
          );
        });
      })
    );
  });

  it("grows and shrinks the focused Pane by a step, within the least share", () => {
    let layout = reduceLayout(single(0), { _tag: "Split", axis: "Horizontal", view: 1 });

    layout = reduceLayout(layout, { _tag: "Grow" });
    const grown = roundedRatios(rootRatios(layout));

    for (let times = 0; times < 30; times += 1) {
      layout = reduceLayout(layout, { _tag: "Shrink" });
    }

    const least = roundedRatios(rootRatios(layout));

    layout = reduceLayout(layout, { _tag: "Equalize" });

    expect({ equal: rootRatios(layout), grown, least }).toStrictEqual({
      equal: [0.5, 0.5],
      grown: [0.45, 0.55],
      least: roundedRatios([1 - leastShare, leastShare]),
    });
  });

  it("takes a resize from the view only when it fits the Split", () => {
    const layout = reduceLayout(single(0), { _tag: "Split", axis: "Horizontal", view: 1 });

    const ratios = rootRatios;

    expect({
      fits: ratios(reduceLayout(layout, { _tag: "Resize", ratios: [30, 70], split: "s1" })),
      negative: ratios(reduceLayout(layout, { _tag: "Resize", ratios: [-1, 2], split: "s1" })),
      other: ratios(reduceLayout(layout, { _tag: "Resize", ratios: [30, 70], split: "s9" })),
      short: ratios(reduceLayout(layout, { _tag: "Resize", ratios: [1], split: "s1" })),
      tiny: ratios(reduceLayout(layout, { _tag: "Resize", ratios: [1e-6, 1], split: "s1" })),
      zero: ratios(reduceLayout(layout, { _tag: "Resize", ratios: [0, 1], split: "s1" })),
    }).toStrictEqual({
      fits: [0.3, 0.7],
      negative: [0.5, 0.5],
      other: [0.5, 0.5],
      short: [0.5, 0.5],
      tiny: [0.5, 0.5],
      zero: [0.5, 0.5],
    });
  });

  it("joins a split along its parent's axis into its parent, sharing its share", () => {
    let layout = reduceLayout(single(0), { _tag: "Split", axis: "Horizontal", view: 1 });

    layout = reduceLayout(layout, { _tag: "Split", axis: "Horizontal", view: 2 });

    expect(
      layout.root._tag === "Split"
        ? layout.root.children.map((child) => [child.node.id, child.ratio])
        : []
    ).toStrictEqual([
      ["p0", 0.5],
      ["p1", 0.25],
      ["p2", 0.25],
    ]);
  });

  it("closes into the Pane nearest where the closed one was", () => {
    let layout = reduceLayout(single(0), { _tag: "Split", axis: "Horizontal", view: 1 });

    layout = reduceLayout(layout, { _tag: "Split", axis: "Vertical", view: 2 });
    // p0 | (p1 / p2): closing p2 focuses p1, and closing p1 then focuses p0.
    layout = reduceLayout(layout, { _tag: "Close" });
    const first = layout.focused;

    layout = reduceLayout(layout, { _tag: "Close" });

    expect({ first, root: layout.root, second: layout.focused }).toStrictEqual({
      first: "p1",
      root: { _tag: "Pane", id: "p0", view: 0 },
      second: "p0",
    });
  });

  it("takes back a layout kept, and refuses one that is not well formed", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        play(steps, (_, __, after) => {
          const read = layoutFrom(structuredClone(after), same);

          expect(read === undefined ? ["none"] : faults(read)).toStrictEqual([]);
          expect(read && rounded({ ...read, next: after.next })).toStrictEqual(rounded(after));
        });
      })
    );

    const kept = reduceLayout(single(0), { _tag: "Split", axis: "Horizontal", view: 1 });
    const { root } = kept;
    const [first] = root._tag === "Split" ? root.children : [];
    const twice = first === undefined ? root : { ...root, children: [first, first] };

    expect({
      badId: layoutFrom({ ...kept, root: { ...root, id: "x1" } }, same),
      badView: layoutFrom(kept, () => {}),
      paneAsSplit: layoutFrom({ ...kept, root: { ...root, id: "p9" } }, same),
      twice: layoutFrom({ ...kept, root: twice }, same),
      unfocused: layoutFrom({ ...kept, focused: "p7" }, same)?.focused,
    }).toStrictEqual({
      badId: undefined,
      badView: undefined,
      paneAsSplit: undefined,
      twice: undefined,
      unfocused: "p0",
    });
  });

  it("drops Panes, their siblings taking their places, and keeps none of none", () => {
    let layout = reduceLayout(single(0), { _tag: "Split", axis: "Horizontal", view: 1 });

    layout = reduceLayout(layout, { _tag: "Split", axis: "Vertical", view: 2 });

    const dropped = keeping(layout, (pane) => pane.view !== 2);

    expect({
      dropped:
        dropped === undefined ? undefined : [faults(dropped), dropped.focused, viewsOf(dropped)],
      none: keeping(layout, () => false),
    }).toStrictEqual({ dropped: [[], "p0", [0, 1]], none: undefined });
  });

  it("splits no further than the most Panes, nor deeper than the deepest Splits", () => {
    let wide = single(0);

    for (let view = 1; view < 100; view += 1) {
      wide = reduceLayout(wide, {
        _tag: "Split",
        axis: view % 2 === 0 ? "Vertical" : "Horizontal",
        view,
      });
    }

    expect({
      deep: splitsDeep(wide) <= deepestSplits,
      panes: panesOf(wide.root).length <= mostPanes,
      takenBack: layoutFrom(wide, same) !== undefined,
      tooMany: layoutFrom(
        {
          ...wide,
          root: {
            _tag: "Split",
            axis: "Horizontal",
            children: Array.from({ length: mostPanes + 1 }, (_, index) => ({
              node: { _tag: "Pane", id: `p${index}`, view: index },
              ratio: 1,
            })),
            id: "s0",
          },
        },
        same
      ),
    }).toStrictEqual({ deep: true, panes: true, takenBack: true, tooMany: undefined });
  });

  it("never shrinks the focused Pane by growing it, nor grows it by shrinking it", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        play(steps, (before, change, after) => {
          const was = ownShare(before);
          const now = ownShare(after);

          expect({
            grown: change._tag === "Grow" ? now >= was : true,
            shrunk: change._tag === "Shrink" ? now <= was : true,
          }).toStrictEqual({ grown: true, shrunk: true });
        });
      }),
      { numRuns: 300 }
    );
  });

  it("splits no Pane below the least share, so it still shrinks no larger and grows", () => {
    const five = splitTimes(5);
    const eleven = splitTimes(11);

    // The fifth split leaves the focused Pane at 1/32, which a shrink never raises. Halving
    // stops at 1/64: a seventh split would leave 1/128, below the least share.
    expect({
      elevenGrown: ownShare(reduceLayout(eleven, { _tag: "Grow" })) > ownShare(eleven),
      elevenPanes: panesOf(eleven.root).length,
      elevenShare: ownShare(eleven),
      fiveShare: ownShare(five),
      fiveShrunk: ownShare(reduceLayout(five, { _tag: "Shrink" })) <= ownShare(five),
    }).toStrictEqual({
      elevenGrown: true,
      elevenPanes: 7,
      elevenShare: 1 / 64,
      fiveShare: 1 / 32,
      fiveShrunk: true,
    });
  });
});
