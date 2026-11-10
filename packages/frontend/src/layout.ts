/**
 * The pane layout, as a split tree in a pure reducer (ADR 0012). A layout is a tree of
 * Splits, each laying its children side by side or one above another with a ratio each,
 * and Panes, each showing a view. One Pane has the focus, and a layout may be zoomed, to
 * show the focused Pane alone. It knows nothing of what a view is, nor of the screen: a
 * view renders the tree and sends back the ratios the Owner dragged.
 *
 * @packageDocumentation
 */

/** How a Split lays out its children: `Horizontal` side by side, `Vertical` one above another. */
export type Axis = "Horizontal" | "Vertical";

/** Where a Pane lies from another. */
export type Direction = "Left" | "Right" | "Up" | "Down";

/** One Pane, showing a view. Its id is `p` and a number, from the layout's counter. */
export interface Pane<V> {
  readonly _tag: "Pane";
  readonly id: string;
  readonly view: V;
}

/** One child of a Split, with the share of the Split it takes. */
export interface Child<V> {
  readonly node: Node<V>;
  readonly ratio: number;
}

/**
 * A Split of two or more children along one axis, whose ratios are positive and sum to 1.
 * No child is a Split along the same axis, which is one Split. Its id is `s` and a number.
 */
export interface Split<V> {
  readonly _tag: "Split";
  readonly id: string;
  readonly axis: Axis;
  readonly children: readonly Child<V>[];
}

/** A node of the tree: a Pane, or a Split of more. */
export type Node<V> = Pane<V> | Split<V>;

/**
 * A layout: its tree, the Pane with the focus, whether the focused Pane alone is shown,
 * and the number the next id takes.
 */
export interface Layout<V> {
  readonly root: Node<V>;
  readonly focused: string;
  readonly zoomed: boolean;
  readonly next: number;
}

/** A Pane's place in the unit square the layout fills. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * What can be done to a layout.
 *
 * - `Split`: split the focused Pane along an axis, the new Pane after it showing `view`,
 *   and focus it.
 * - `Close`: close the focused Pane, its sibling taking its place. The last Pane stays.
 * - `Focus`: focus a Pane by its id. `Move`: focus the Pane next to the focused one.
 * - `Swap`: swap the focused Pane's view with the one next to it, the focus going with it.
 * - `Equalize`: every Split's children take equal shares.
 * - `Grow`, `Shrink`: the focused Pane takes a `step` more or less of its Split.
 * - `Resize`: a Split's ratios, as the Owner dragged them.
 * - `Zoom`: show the focused Pane alone, or every Pane again.
 */
export type LayoutChange<V> =
  | { readonly _tag: "Split"; readonly axis: Axis; readonly view: V }
  | { readonly _tag: "Close" }
  | { readonly _tag: "Focus"; readonly pane: string }
  | { readonly _tag: "Move"; readonly direction: Direction }
  | { readonly _tag: "Swap"; readonly direction: Direction }
  | { readonly _tag: "Equalize" }
  | { readonly _tag: "Grow" }
  | { readonly _tag: "Shrink" }
  | { readonly _tag: "Resize"; readonly split: string; readonly ratios: readonly number[] }
  | { readonly _tag: "Zoom" };

/** The most Panes a layout holds: a split past it changes nothing, and a layout kept with more is refused. */
export const mostPanes = 64;

/** The deepest a layout nests Splits: a split past it changes nothing, and a layout kept deeper is refused. */
export const deepestSplits = 16;

/** How much of its Split `Grow` and `Shrink` move the focused Pane by. */
export const resizeStep = 0.05;

/**
 * The least share of its Split a Pane is given: a split refuses to halve a Pane below it,
 * a drag cannot leave one below it, and growing and shrinking never move a share past it.
 * A share left below it, as joining a Split into its parent can leave one, stays as it is.
 */
export const leastShare = 0.01;

/**
 * A layout of one Pane showing a view.
 * @param view - The view.
 * @returns The layout.
 */
export const single = <V>(view: V): Layout<V> => ({
  focused: "p0",
  next: 1,
  root: { _tag: "Pane", id: "p0", view },
  zoomed: false,
});

/**
 * Every Pane of a tree, in reading order: each Split's children in turn.
 * @param node - The tree.
 * @returns The Panes.
 */
export const panesOf = <V>(node: Node<V>): readonly Pane<V>[] =>
  node._tag === "Pane" ? [node] : node.children.flatMap((child) => panesOf(child.node));

/**
 * How deep a tree nests Splits: none for a Pane.
 * @param node - The tree.
 * @returns Its depth.
 */
const depthOf = <V>(node: Node<V>): number =>
  node._tag === "Pane" ? 0 : 1 + Math.max(...node.children.map((child) => depthOf(child.node)));

/**
 * Whether a tree is within the bounds of a layout: at most `mostPanes` Panes, and Splits
 * nested at most `deepestSplits` deep.
 * @param node - The tree.
 * @returns Whether it is.
 */
const withinBounds = <V>(node: Node<V>): boolean =>
  panesOf(node).length <= mostPanes && depthOf(node) <= deepestSplits;

/**
 * Every Split of a tree, outermost first.
 * @param node - The tree.
 * @returns The Splits.
 */
export const splitsOf = <V>(node: Node<V>): readonly Split<V>[] =>
  node._tag === "Pane" ? [] : [node, ...node.children.flatMap((child) => splitsOf(child.node))];

/**
 * The focused Pane.
 * @param layout - The layout.
 * @returns The Pane.
 */
export const focusedPane = <V>(layout: Layout<V>): Pane<V> => {
  const panes = panesOf(layout.root);
  const found = panes.find((pane) => pane.id === layout.focused) ?? panes.at(0);

  // The focus is always on a Pane of the tree, and a tree has one at least.
  if (found === undefined) {
    throw new Error("A layout holds no Pane.");
  }

  return found;
};

/**
 * The Panes shown: the focused one alone while zoomed or on a compact screen, and every
 * Pane otherwise.
 * @param layout - The layout.
 * @param compact - Whether the screen shows one Pane at a time, as a phone's does.
 * @returns The Panes shown, in reading order.
 */
export const shownPanes = <V>(layout: Layout<V>, compact: boolean): readonly Pane<V>[] =>
  layout.zoomed || compact ? [focusedPane(layout)] : panesOf(layout.root);

/**
 * A copy of a tree with each Pane's view changed.
 * @param node - The tree.
 * @param change - What becomes of each Pane's view.
 * @returns The copy.
 */
const mapNode = <V, W>(node: Node<V>, change: (pane: Pane<V>) => W): Node<W> =>
  node._tag === "Pane"
    ? { ...node, view: change(node) }
    : {
        ...node,
        children: node.children.map((child) => ({ ...child, node: mapNode(child.node, change) })),
      };

/**
 * A layout with each Pane's view changed.
 * @param layout - The layout.
 * @param change - What becomes of each Pane's view.
 * @returns The layout.
 */
export const mapViews = <V, W>(layout: Layout<V>, change: (pane: Pane<V>) => W): Layout<W> => ({
  ...layout,
  root: mapNode(layout.root, change),
});

/**
 * A layout with one Pane's view set.
 * @param layout - The layout.
 * @param pane - The Pane's id.
 * @param view - Its view.
 * @returns The layout.
 */
export const withView = <V>(layout: Layout<V>, pane: string, view: V): Layout<V> =>
  mapViews(layout, (one) => (one.id === pane ? view : one.view));

/**
 * Ratios scaled to sum to 1, each positive, or equal shares when they cannot be.
 * @param ratios - The ratios.
 * @returns The ratios, summing to 1.
 */
const normalized = (ratios: readonly number[]): readonly number[] => {
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);

  if (!(sum > 0) || !Number.isFinite(sum) || ratios.some((ratio) => !(ratio > 0))) {
    return ratios.map(() => 1 / ratios.length);
  }

  return ratios.map((ratio) => ratio / sum);
};

/**
 * A tree rebuilt so it is well formed: a Split of one child is that child, a Split of none
 * is nothing, a child Split along its parent's axis joins its parent, its shares scaled by
 * its own, and every Split's ratios sum to 1.
 * @param node - The tree.
 * @returns The tree, or none when no Pane is left.
 */
const settled = <V>(node: Node<V>): Node<V> | undefined => {
  if (node._tag === "Pane") {
    return node;
  }

  const children: Child<V>[] = [];

  for (const child of node.children) {
    const kept = settled(child.node);

    if (kept?._tag === "Split" && kept.axis === node.axis) {
      for (const inner of kept.children) {
        children.push({ node: inner.node, ratio: child.ratio * inner.ratio });
      }
    } else if (kept !== undefined) {
      children.push({ node: kept, ratio: child.ratio });
    }
  }

  const [only] = children;

  if (children.length <= 1) {
    return only?.node;
  }

  const ratios = normalized(children.map((child) => child.ratio));

  return {
    ...node,
    children: children.map((child, index) => ({ ...child, ratio: ratios[index] ?? 0 })),
  };
};

/**
 * A copy of a tree with one node replaced, then settled.
 * @param node - The tree.
 * @param id - The id of the node to replace.
 * @param by - What replaces it, or `null` to remove it.
 * @returns The tree, or none when no Pane is left.
 */
const replaced = <V>(
  node: Node<V>,
  id: string,
  by: ((found: Node<V>) => Node<V>) | null
): Node<V> | undefined => {
  if (node.id === id) {
    return by === null ? undefined : by(node);
  }

  if (node._tag === "Pane") {
    return node;
  }

  const children: Child<V>[] = [];

  for (const child of node.children) {
    const kept = replaced(child.node, id, by);

    if (kept !== undefined) {
      children.push({ node: kept, ratio: child.ratio });
    }
  }

  return settled({ ...node, children });
};

/**
 * The Split a node is a child of.
 * @param node - The tree.
 * @param id - The node's id.
 * @returns The Split, or none for the root.
 */
const parentOf = <V>(node: Node<V>, id: string): Split<V> | undefined => {
  if (node._tag === "Pane") {
    return undefined;
  }

  if (node.children.some((child) => child.node.id === id)) {
    return node;
  }

  for (const child of node.children) {
    const found = parentOf(child.node, id);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};

/**
 * Where each Pane lies in the unit square, by the ratios.
 * @param layout - The layout.
 * @returns Each Pane's place, by its id.
 */
export const rectsOf = <V>(layout: Layout<V>): ReadonlyMap<string, Rect> => {
  const rects = new Map<string, Rect>();

  const place = (node: Node<V>, rect: Rect) => {
    if (node._tag === "Pane") {
      rects.set(node.id, rect);

      return;
    }

    const horizontal = node.axis === "Horizontal";
    const length = horizontal ? rect.right - rect.left : rect.bottom - rect.top;
    let from = horizontal ? rect.left : rect.top;

    for (const [index, child] of node.children.entries()) {
      // The last child ends where its parent does, whatever the rounding.
      const last = index === node.children.length - 1;
      const edge = horizontal ? rect.right : rect.bottom;
      const end = last ? edge : from + child.ratio * length;

      place(
        child.node,
        horizontal ? { ...rect, left: from, right: end } : { ...rect, bottom: end, top: from }
      );
      from = end;
    }
  };

  place(layout.root, { bottom: 1, left: 0, right: 1, top: 0 });

  return rects;
};

/** How near two edges must be to touch, against the rounding of the ratios. */
const touching = 1e-9;

/**
 * Whether one place's edge touches another's on a side.
 * @param from - The place looked from.
 * @param rect - The place looked at.
 * @param direction - The side.
 * @returns Whether it does.
 */
const touches = (from: Rect, rect: Rect, direction: Direction): boolean => {
  switch (direction) {
    case "Left": {
      return Math.abs(rect.right - from.left) < touching;
    }

    case "Right": {
      return Math.abs(rect.left - from.right) < touching;
    }

    case "Up": {
      return Math.abs(rect.bottom - from.top) < touching;
    }

    case "Down": {
      return Math.abs(rect.top - from.bottom) < touching;
    }

    default: {
      return direction satisfies never;
    }
  }
};

/**
 * Where a place lies along an edge: its top and bottom across a side edge, or its left and
 * right along a top or bottom edge.
 * @param rect - The place.
 * @param direction - The direction looked in.
 * @returns Its span.
 */
const spanOf = (
  rect: Rect,
  direction: Direction
): { readonly start: number; readonly end: number } =>
  direction === "Left" || direction === "Right"
    ? { end: rect.bottom, start: rect.top }
    : { end: rect.right, start: rect.left };

/**
 * The Pane next to the focused one in a direction, as on the screen: of the Panes whose
 * edge touches the focused Pane's on that side, the one across from the middle of the
 * focused Pane, or the first along it when the middle falls on an edge between two. None
 * at the edge of the layout.
 * @param layout - The layout.
 * @param direction - The direction.
 * @returns The Pane's id, or none.
 */
export const neighbour = <V>(layout: Layout<V>, direction: Direction): string | undefined => {
  const rects = rectsOf(layout);
  const from = rects.get(layout.focused);

  if (from === undefined) {
    return undefined;
  }

  const own = spanOf(from, direction);
  const middle = (own.start + own.end) / 2;
  let best: { readonly id: string; readonly start: number } | undefined;

  for (const [id, rect] of rects) {
    const { end, start } = spanOf(rect, direction);
    const holdsMiddle = start < middle + touching && end > middle - touching;

    if (
      touches(from, rect, direction) &&
      holdsMiddle &&
      (best === undefined || start < best.start)
    ) {
      best = { id, start };
    }
  }

  return best?.id;
};

/**
 * A Split's ratios set, scaled to sum to 1, unless of another length, or not positive and
 * finite.
 * @param layout - The layout.
 * @param split - The Split's id.
 * @param ratios - The ratios.
 * @returns The layout.
 */
const withRatios = <V>(layout: Layout<V>, split: string, ratios: readonly number[]): Layout<V> => {
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);

  if (!Number.isFinite(sum) || ratios.some((ratio) => !Number.isFinite(ratio) || !(ratio > 0))) {
    return layout;
  }

  const root = replaced(layout.root, split, (found) =>
    found._tag === "Split" && found.children.length === ratios.length
      ? {
          ...found,
          children: found.children.map((child, index) => ({
            ...child,
            ratio: (ratios[index] ?? 0) / sum,
          })),
        }
      : found
  );

  return root === undefined ? layout : { ...layout, root };
};

/**
 * A Split's ratios as the Owner dragged them, scaled to sum to 1. Ratios that would leave
 * a child less than `leastShare`, which the view's least size keeps a drag from anyway,
 * change nothing, as do ratios of another length or not finite.
 * @param layout - The layout.
 * @param split - The Split's id.
 * @param ratios - The ratios.
 * @returns The layout.
 */
const resized = <V>(layout: Layout<V>, split: string, ratios: readonly number[]): Layout<V> => {
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);

  return ratios.every((ratio) => ratio / sum >= leastShare)
    ? withRatios(layout, split, ratios)
    : layout;
};

/**
 * The focused Pane's share of its Split moved by up to a step, never past `leastShare` for
 * any share it moves. Growing takes from each other child as much as it has above the least
 * share, in proportion, so a child already below it gives nothing; shrinking gives to each
 * in proportion, and a share already below the least does not shrink. So growing never
 * shrinks the focused Pane and shrinking never grows it.
 * @param layout - The layout.
 * @param by - The step: positive to grow, negative to shrink.
 * @returns The layout.
 */
const regrown = <V>(layout: Layout<V>, by: number): Layout<V> => {
  const parent = parentOf(layout.root, layout.focused);

  if (parent === undefined) {
    return layout;
  }

  const index = parent.children.findIndex((child) => child.node.id === layout.focused);
  const own = parent.children[index]?.ratio ?? 0;
  const others = parent.children.filter((_, at) => at !== index);
  const spare = others.reduce((total, child) => total + Math.max(0, child.ratio - leastShare), 0);
  const othersTotal = 1 - own;

  const moved = by > 0 ? Math.min(by, spare) : -Math.min(-by, Math.max(0, own - leastShare));

  if (moved === 0 || othersTotal <= 0) {
    return layout;
  }

  const ratios = parent.children.map((child, at) => {
    if (at === index) {
      return own + moved;
    }

    // Grown: each gives in proportion to what it has above the least share.
    // Shrunk: each takes in proportion to its share.
    return moved > 0
      ? child.ratio - (moved * Math.max(0, child.ratio - leastShare)) / spare
      : child.ratio - (moved * child.ratio) / othersTotal;
  });

  return withRatios(layout, parent.id, ratios);
};

/**
 * Every Split's children given equal shares.
 * @param node - The tree.
 * @returns The tree.
 */
const equalized = <V>(node: Node<V>): Node<V> =>
  node._tag === "Pane"
    ? node
    : {
        ...node,
        children: node.children.map((child) => ({
          node: equalized(child.node),
          ratio: 1 / node.children.length,
        })),
      };

/**
 * Splits the focused Pane: the new Pane goes after it, showing a view, and takes the focus.
 * A split that would leave either half below `leastShare` of its Split changes nothing.
 * @param layout - The layout.
 * @param axis - The axis.
 * @param view - The new Pane's view.
 * @returns The layout.
 */
const splitting = <V>(layout: Layout<V>, axis: Axis, view: V): Layout<V> => {
  const fresh: Pane<V> = { _tag: "Pane", id: `p${layout.next}`, view };

  const root = replaced(layout.root, layout.focused, (found): Node<V> => ({
    _tag: "Split",
    axis,
    children: [
      { node: found, ratio: 0.5 },
      { node: fresh, ratio: 0.5 },
    ],
    id: `s${layout.next}`,
  }));

  // The new Pane has half the share the split one had, which keeps the other half.
  const halved =
    root === undefined
      ? 0
      : (parentOf(root, fresh.id)?.children.find((child) => child.node.id === fresh.id)?.ratio ??
        0);

  return root === undefined || !withinBounds(root) || halved < leastShare
    ? layout
    : { focused: fresh.id, next: layout.next + 1, root, zoomed: false };
};

/**
 * Closes the focused Pane, its sibling taking its place, and focuses the Pane of that
 * sibling nearest where it was: the last of the one before it, or the first of the one
 * after. The last Pane is never closed.
 * @param layout - The layout.
 * @returns The layout.
 */
const closing = <V>(layout: Layout<V>): Layout<V> => {
  const parent = parentOf(layout.root, layout.focused);

  if (parent === undefined) {
    return layout;
  }

  const index = parent.children.findIndex((child) => child.node.id === layout.focused);
  const before = parent.children[index - 1]?.node;
  const after = parent.children[index + 1]?.node;
  const heir = before === undefined ? panesOf(after ?? parent).at(0) : panesOf(before).at(-1);
  const root = replaced(layout.root, layout.focused, null);

  return root === undefined || heir === undefined
    ? layout
    : { ...layout, focused: heir.id, root, zoomed: false };
};

/**
 * A tree with two Panes changing places, each whole, its id with it.
 * @param node - The tree.
 * @param one - One Pane.
 * @param other - The other.
 * @returns The tree.
 */
const exchanged = <V>(node: Node<V>, one: Pane<V>, other: Pane<V>): Node<V> => {
  if (node._tag === "Pane") {
    if (node.id === one.id) {
      return other;
    }

    return node.id === other.id ? one : node;
  }

  return {
    ...node,
    children: node.children.map((child) => ({ ...child, node: exchanged(child.node, one, other) })),
  };
};

/**
 * Swaps the focused Pane with the Pane next to it: the two change places, each whole, so
 * the focused Pane, the view the Owner was in, moves and keeps the focus, and each Pane's
 * content moves with it rather than being drawn again. Each place keeps its share.
 * @param layout - The layout.
 * @param direction - Where the other Pane lies.
 * @returns The layout.
 */
const swapping = <V>(layout: Layout<V>, direction: Direction): Layout<V> => {
  const other = neighbour(layout, direction);
  const panes = panesOf(layout.root);
  const mine = panes.find((pane) => pane.id === layout.focused);
  const theirs = panes.find((pane) => pane.id === other);

  if (mine === undefined || theirs === undefined) {
    return layout;
  }

  return { ...layout, root: exchanged(layout.root, mine, theirs) };
};

/**
 * The layout after a change.
 * @param layout - The layout before.
 * @param change - The change.
 * @returns The layout after.
 */
export const reduceLayout = <V>(layout: Layout<V>, change: LayoutChange<V>): Layout<V> => {
  switch (change._tag) {
    case "Split": {
      return splitting(layout, change.axis, change.view);
    }

    case "Close": {
      return closing(layout);
    }

    case "Focus": {
      return change.pane !== layout.focused &&
        panesOf(layout.root).some((pane) => pane.id === change.pane)
        ? { ...layout, focused: change.pane }
        : layout;
    }

    case "Move": {
      const to = neighbour(layout, change.direction);

      return to === undefined ? layout : { ...layout, focused: to };
    }

    case "Swap": {
      return swapping(layout, change.direction);
    }

    case "Equalize": {
      return { ...layout, root: equalized(layout.root) };
    }

    case "Grow": {
      return regrown(layout, resizeStep);
    }

    case "Shrink": {
      return regrown(layout, -resizeStep);
    }

    case "Resize": {
      return resized(layout, change.split, change.ratios);
    }

    case "Zoom": {
      return { ...layout, zoomed: !layout.zoomed && layout.root._tag === "Split" };
    }

    default: {
      return change satisfies never;
    }
  }
};

// A layout kept, taken back.

/** An id of a kind and its number. */
const idPattern = /^(?<kind>[ps])(?<n>0|[1-9]\d{0,8})$/u;

/**
 * A tree as it was kept, made well formed again, each view read by `view`.
 * @param node - The tree as kept.
 * @param view - Reads a view, or says none.
 * @param ids - The ids seen so far, which no two nodes share.
 * @param depth - How many Splits it lies in.
 * @returns The tree, settled, or none when it is not one.
 */
const nodeFrom = <K, V>(
  node: Node<K>,
  view: (kept: K) => V | undefined,
  ids: Set<string>,
  depth: number
): Node<V> | undefined => {
  const kind = idPattern.exec(node.id)?.groups?.kind;

  if (ids.has(node.id) || depth > deepestSplits || ids.size > 2 * mostPanes) {
    return undefined;
  }

  ids.add(node.id);

  if (node._tag === "Pane") {
    const read = kind === "p" ? view(node.view) : undefined;

    return read === undefined ? undefined : { _tag: "Pane", id: node.id, view: read };
  }

  const children: Child<V>[] = [];

  for (const child of node.children) {
    const read = kind === "s" ? nodeFrom(child.node, view, ids, depth + 1) : undefined;

    if (read === undefined) {
      return undefined;
    }

    children.push({ node: read, ratio: child.ratio });
  }

  return settled({ ...node, children });
};

/**
 * A layout as it was kept, taken back: a tree of well-formed ids, each once, and Panes whose
 * views `view` reads. What is not one is none, so a layout kept by an older or tampered page
 * is never taken in part. A Split left with one child is that child, ratios are scaled to
 * sum to 1, the focus falls back to the first Pane, and the counter is past every id.
 * @param kept - The layout as kept.
 * @param view - Reads a view, or says none.
 * @returns The layout, or none.
 */
export const layoutFrom = <K, V>(
  kept: Layout<K>,
  view: (kept: K) => V | undefined
): Layout<V> | undefined => {
  const ids = new Set<string>();
  const root = nodeFrom(kept.root, view, ids, 0);

  if (root === undefined || !withinBounds(root)) {
    return undefined;
  }

  const panes = panesOf(root);
  const [first] = panes;

  return {
    focused: panes.some((pane) => pane.id === kept.focused) ? kept.focused : (first?.id ?? ""),
    next: Math.max(...[...ids].map((id) => Number(id.slice(1)))) + 1,
    root,
    zoomed: kept.zoomed && root._tag === "Split",
  };
};

/**
 * The layout without the Panes `keep` says to drop, their siblings taking their places.
 * The focus stays where it was, or goes to the first Pane left. With none left, none.
 * @param layout - The layout.
 * @param keep - Whether a Pane stays.
 * @returns The layout, or none.
 */
export const keeping = <V>(
  layout: Layout<V>,
  keep: (pane: Pane<V>) => boolean
): Layout<V> | undefined => {
  let root: Node<V> | undefined = layout.root;

  for (const pane of panesOf(layout.root)) {
    if (!keep(pane) && root !== undefined) {
      root = replaced(root, pane.id, null);
    }
  }

  if (root === undefined) {
    return undefined;
  }

  const panes = panesOf(root);
  const [first] = panes;

  return {
    ...layout,
    focused: panes.some((pane) => pane.id === layout.focused)
      ? layout.focused
      : (first?.id ?? layout.focused),
    root,
    zoomed: layout.zoomed && root._tag === "Split",
  };
};
