/**
 * The Panes, drawn: the core's split tree rendered with `react-resizable-panels` (ADR
 * 0012), which only renders it and resizes it. The core holds the tree and every ratio
 * committed; the library holds only the sizes in the middle of a drag, and clamps to each
 * Panel's least size. Its `Group` has no controlled layout, and remembers sizes of its own
 * for each set of Panels, which win over `defaultLayout`, so each Split pushes the core's
 * ratios with `setLayout` after it renders and whenever the library reports a change the
 * Owner did not make. Only a change the Owner made, a drag let go or an arrow key on a
 * divider, goes back to the core, as one `Resize`, so the core's own changes never echo.
 * A double click on a divider gives its Panes equal shares, as a core command too.
 *
 * A Pane's content is drawn once, into a `<div>` of its own that lives as long as the Pane,
 * and moved into whichever Panel shows it, since React draws a Panel's children afresh when
 * their depth in the tree changes, as splitting a Pane does. Moving a node loses its scroll
 * position, which the Timeline puts back as it hears it moved, and the focus inside it,
 * which is put back here.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { focusedPane, panesOf } from "@iirc/frontend/layout";
import type { Node, Pane, Split } from "@iirc/frontend/layout";
import type { PaneView } from "@iirc/frontend/timelines";
import type { ComponentType, ReactNode } from "react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";

import { alone, focusedId, layoutState, movedEvent, resize } from "./atoms.ts";

import styles from "./pane-tree.module.css";

// Group, Panel, and Separator ids share the document's id space and the library's registry,
// so each kind is prefixed, and a Split's Group never shares an id with its Panel.
const panelId = (node: Node<PaneView>) => `panel:${node.id}`;
const groupId = (split: Split<PaneView>) => `group:${split.id}`;

/**
 * A Split's ratios as the library lays out its Panels: percentages, by Panel id.
 * @param split - The Split.
 * @returns The layout.
 */
const layoutOf = (split: Split<PaneView>): Layout =>
  Object.fromEntries(split.children.map((child) => [panelId(child.node), child.ratio * 100]));

const sameKeys = (left: Layout, right: Layout) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.keys(right).every((key) => key in left);

// A twentieth of a percent: closer than that is the same layout.
const sameLayout = (left: Layout, right: Layout) =>
  Object.keys(right).every((key) => Math.abs((left[key] ?? 0) - (right[key] ?? 0)) < 0.05);

/**
 * What has the focus inside each Pane's node, until the focus goes elsewhere on purpose:
 * a node taken out of the page loses the focus to nothing, which a move puts back.
 */
const focusWithin = new WeakMap<HTMLElement, HTMLElement>();

/** Each Pane's own node, which its content is drawn into once, by the Pane's id. */
type Hosts = (pane: string) => HTMLElement;

const HostsContext = createContext<Hosts>(() => {
  throw new Error("A Pane's slot is drawn outside the Panes.");
});

/**
 * After a Pane's node moved, as into another Panel, or with its Panel as React reorders
 * Panels when Panes swap: its content hears it moved, to put back where it was scrolled,
 * and the focus goes back where it was, if the Pane has the focus. Moving a node out of
 * the page takes the focus from what is in it, to the body, and it goes back only to the
 * focused Pane, never to one a split just took the focus from.
 * @param host - The Pane's node.
 * @param focused - Whether the Pane has the focus.
 */
const settle = (host: HTMLElement, focused: boolean) => {
  const had = focusWithin.get(host);

  host.dispatchEvent(new Event(movedEvent));

  if (
    focused &&
    had !== undefined &&
    host.contains(had) &&
    document.activeElement === document.body
  ) {
    had.focus({ preventScroll: true });
  }
};

/**
 * Where a Pane shows: its node, moved into this Panel, with the focus put back where it was
 * when the move took it away, if the Pane has the focus, and the content told it moved.
 * @param props - The Pane's id.
 * @returns The slot.
 */
const Slot = ({ pane }: { readonly pane: string }) => {
  const hosts = useContext(HostsContext);
  const focused = useAtomValue(focusedId) === pane;

  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      const host = hosts(pane);

      if (element === null || host.parentElement === element) {
        return;
      }

      element.append(host);
      settle(host, focused);
    },
    [focused, hosts, pane]
  );

  return <div className={styles.slot} ref={ref} />;
};

/** How a node of the tree is drawn, given to a Split for its children, as they recurse. */
const NodeContext = createContext<ComponentType<{ readonly node: Node<PaneView> }>>(() => null);

/** The least a Pane is drawn, whatever the ratios say. */
const leastSize = "6rem";

/**
 * The least a divider's hit area measures across, in pixels, whatever its line: a finger's
 * size on a touch screen, and the library's own for a mouse.
 */
const resizeTarget = { coarse: 44, fine: 10 };

/**
 * One Split: a Group of its children, with a divider between each two.
 * @param props - The Split.
 * @returns The Group.
 */
const SplitView = ({ split }: { readonly split: Split<PaneView> }) => {
  const NodeView = useContext(NodeContext);
  const resizeTo = useAtomSet(resize);
  const groupRef = useGroupRef();
  const layout = useMemo(() => layoutOf(split), [split]);
  // The core's ratios, as the library's callbacks read them between renders.
  const want = useRef(layout);

  // The core's ratios, pushed whenever the library holds others. Only once the library has
  // taken the same Panels: `setLayout` throws on another set, and after the Panels change
  // the Group takes them in a later render of its own, then reports a change the Owner did
  // not make, which brings this back.
  const reconcile = useCallback(() => {
    const group = groupRef.current;

    if (group === null) {
      return;
    }

    try {
      const held = group.getLayout();

      if (sameKeys(held, want.current) && !sameLayout(held, want.current)) {
        group.setLayout(want.current);
      }
    } catch {
      // The library has not taken these Panels yet: it reports when it has.
    }
  }, [groupRef]);

  useLayoutEffect(() => {
    want.current = layout;
    reconcile();
  });

  return (
    <Group
      className={styles.group}
      defaultLayout={layout}
      groupRef={groupRef}
      id={groupId(split)}
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) {
          reconcile();

          return;
        }

        const given = meta.requestedLayout ?? layout;

        resizeTo({
          ratios: split.children.map((child) => given[panelId(child.node)] ?? 0),
          split: split.id,
        });
      }}
      orientation={split.axis === "Horizontal" ? "horizontal" : "vertical"}
      resizeTargetMinimumSize={resizeTarget}
    >
      {split.children.flatMap((child, index) => [
        index === 0 ? null : (
          <Separator
            className={styles.separator}
            disableDoubleClick
            id={`separator:${child.node.id}`}
            key={`separator:${child.node.id}`}
            onDoubleClick={() => {
              resizeTo({ ratios: split.children.map(() => 1), split: split.id });
            }}
          />
        ),
        <Panel
          className={styles.panel}
          id={panelId(child.node)}
          key={child.node.id}
          minSize={leastSize}
        >
          <NodeView node={child.node} />
        </Panel>,
      ])}
    </Group>
  );
};

/**
 * A node of the tree: a Split's Group, or a Pane's slot.
 * @param props - The node.
 * @returns The node, drawn.
 */
const NodeView = ({ node }: { readonly node: Node<PaneView> }): ReactNode =>
  node._tag === "Split" ? <SplitView split={node} /> : <Slot pane={node.id} />;

/**
 * Each Pane's own node, made as a Pane is first drawn and kept while it lasts, outside
 * React's state, as a store the tree reads.
 */
class PaneHosts {
  readonly #held = new Map<string, HTMLElement>();

  /**
   * A Pane's node, made the first time it is asked for.
   * @param pane - The Pane's id.
   * @returns Its node.
   */
  readonly host = (pane: string): HTMLElement => {
    const held = this.#held.get(pane);

    if (held !== undefined) {
      return held;
    }

    const made = document.createElement("div");

    made.className = styles.host;
    made.dataset.paneHost = pane;
    made.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLElement) {
        focusWithin.set(made, event.target);
      }
    });
    made.addEventListener("focusout", (event) => {
      // Focus given to something else, not lost as the node was moved.
      if (event.relatedTarget !== null) {
        focusWithin.delete(made);
      }
    });
    this.#held.set(pane, made);

    return made;
  };

  /**
   * Lets go of the nodes of Panes closed.
   * @param panes - The Panes there are now.
   */
  readonly keep = (panes: readonly string[]) => {
    for (const pane of this.#held.keys()) {
      if (!panes.includes(pane)) {
        this.#held.delete(pane);
      }
    }
  };
}

/**
 * The Panes: the tree drawn, or the focused Pane alone while zoomed or on a compact screen,
 * each Pane's content drawn once into its own node.
 * @param props - What a Pane shows, drawn.
 * @returns The Panes.
 */
export const PaneTree = ({ render }: { readonly render: (pane: Pane<PaneView>) => ReactNode }) => {
  const layout = useAtomValue(layoutState);
  const one = useAtomValue(alone);
  const panes = panesOf(layout.root);
  const store = useMemo(() => new PaneHosts(), []);
  const focused = focusedPane(layout);

  // A change of the tree may move a Pane's node without moving it out of its slot, as a
  // swap does when React reorders the Panels holding them, which loses its scroll too.
  useLayoutEffect(() => {
    for (const pane of panesOf(layout.root)) {
      const host = store.host(pane.id);

      if (host.isConnected) {
        settle(host, pane.id === layout.focused);
      }
    }
  }, [layout.root, layout.focused, store]);

  store.keep(panes.map((pane) => pane.id));

  return (
    <HostsContext.Provider value={store.host}>
      <NodeContext.Provider value={NodeView}>
        <div className={styles.tree}>
          {one ? (
            <Slot key={`alone:${focused.id}`} pane={focused.id} />
          ) : (
            <NodeView node={layout.root} />
          )}
        </div>
        {/* Each Pane's content, at a place that never moves, drawn into its own node. */}
        {panes.map((pane) => createPortal(render(pane), store.host(pane.id), pane.id))}
      </NodeContext.Provider>
    </HostsContext.Provider>
  );
};
