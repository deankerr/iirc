/**
 * The Sidebar in the Owner's order: the order the Owner gave the Networks and each
 * Network's Timelines, and the Timelines pinned into a part above the Networks. It is pure.
 * `arranged` applies an arrangement to the sidebar's fixed order, `shownOrder` says what
 * `/next` and `/previous` step through, and `arranging` says what to write for one edit.
 *
 * @packageDocumentation
 */
import type { NetworkId, Timeline, TimelineId } from "@iirc/api";
import type { UiOptions } from "@iirc/api/ui";

import { sidebarOrder } from "./timelines.ts";
import type { SidebarNetwork } from "./timelines.ts";

/**
 * The Owner's order, as the `ui` options keep it. Each list may name what has gone or is
 * not read yet, which does nothing.
 */
export interface Arrangement {
  /** The Networks in the Owner's order. */
  readonly networks: readonly NetworkId[];
  /** The Timelines in the Owner's order, of which only the order within one Network matters. */
  readonly order: readonly TimelineId[];
  /** The Timelines pinned above the Networks, in order. */
  readonly pinned: readonly TimelineId[];
}

/** No order given: the sidebar's fixed order, with nothing pinned. */
export const unarranged: Arrangement = { networks: [], order: [], pinned: [] };

/**
 * The arrangement the `ui` options hold.
 * @param options - The options in effect.
 * @returns The arrangement.
 */
export const arrangementOf = (
  options: Pick<UiOptions, "sidebar.networks" | "sidebar.order" | "sidebar.pinned">
): Arrangement => ({
  networks: options["sidebar.networks"],
  order: options["sidebar.order"],
  pinned: options["sidebar.pinned"],
});

/** A pinned Timeline, with the Network it is of, as the Sidebar's tree draws it. */
export interface Pin {
  readonly timeline: Timeline;
  readonly network: SidebarNetwork;
}

/**
 * The Sidebar as shown: the pinned Timelines above, then the Networks, each with its own
 * Timeline first and the Timelines not pinned under it.
 */
export interface Arranged {
  readonly pinned: readonly Pin[];
  readonly networks: readonly SidebarNetwork[];
}

/**
 * The items in the order given, by the one rule for every list here: those the list names
 * come in its order, and one it does not name goes right after the item before it in the
 * fixed order, or first when none comes before it. So with nothing named, the result is the
 * fixed order. A name that matches no item is ignored, and one named twice counts at its
 * first place.
 * @param fixed - The items in the fixed order.
 * @param keyOf - An item's name in the list.
 * @param named - The list.
 * @returns The items in order.
 */
const placed = <A>(
  fixed: readonly A[],
  keyOf: (item: A) => string,
  named: readonly string[]
): readonly A[] => {
  const rank = new Map<string, number>();

  for (const [index, name] of named.entries()) {
    if (!rank.has(name)) {
      rank.set(name, index);
    }
  }

  const lead: A[] = [];
  const anchors: { readonly item: A; readonly rank: number; readonly followers: A[] }[] = [];

  for (const item of fixed) {
    const at = rank.get(keyOf(item));
    const last = anchors.at(-1);

    if (at !== undefined) {
      anchors.push({ followers: [], item, rank: at });
    } else if (last === undefined) {
      lead.push(item);
    } else {
      last.followers.push(item);
    }
  }

  return [
    ...lead,
    ...anchors
      .toSorted((left, right) => left.rank - right.rank)
      .flatMap((one) => [one.item, ...one.followers]),
  ];
};

const isOwn = (timeline: Timeline) => timeline.kind === "Network";

/**
 * Every Network in the Owner's order: those not removed, then those removed, each by the
 * Owner's order.
 * @param networks - The Networks, in the fixed order.
 * @param order - The Owner's order of Networks.
 * @returns The Networks.
 */
const networksOrdered = (
  networks: readonly SidebarNetwork[],
  order: readonly NetworkId[]
): readonly SidebarNetwork[] =>
  [false, true].flatMap((removed) =>
    placed(
      networks.filter((network) => network.removed === removed),
      (network) => network.network,
      order
    )
  );

/**
 * A Network's Timelines in the Owner's order: its own first, as its row, then the others.
 * @param timelines - Its Timelines, in the fixed order.
 * @param order - The Owner's order of Timelines.
 * @returns The Timelines.
 */
const timelinesOrdered = (
  timelines: readonly Timeline[],
  order: readonly TimelineId[]
): readonly Timeline[] => [
  ...timelines.filter(isOwn),
  ...placed(
    timelines.filter((timeline) => !isOwn(timeline)),
    (timeline) => timeline.id,
    order
  ),
];

/**
 * The names once each, in the order they first come.
 * @param names - The names.
 * @returns Them without a repeat.
 */
const once = <A>(names: readonly A[]): readonly A[] => [...new Set(names)];

/**
 * The Owner's order without the ids of Timelines that have gone, so a write does not carry
 * them on for ever. Only once every page of every Network's Timelines is read, since an id
 * of one not yet read may name a Timeline still there.
 * @param networks - The sidebar, in its fixed order.
 * @param arrangement - The Owner's order.
 * @returns The order, with what has gone dropped when that can be told.
 */
const lasting = (networks: readonly SidebarNetwork[], arrangement: Arrangement): Arrangement => {
  if (!networks.every((network) => network.complete)) {
    return arrangement;
  }

  const held = new Set(
    networks.flatMap((network) => [...network.timelines, ...network.closed].map((one) => one.id))
  );

  return {
    ...arrangement,
    order: arrangement.order.filter((id) => held.has(id)),
    pinned: arrangement.pinned.filter((id) => held.has(id)),
  };
};

/**
 * The sidebar with the Owner's order applied. The Networks are those not removed, then
 * those removed, each in the Owner's order. A Network's Timelines are in the Owner's order
 * with its own first. A pinned Timeline leaves its Network for `pinned`, in the order
 * pinned; only one the sidebar lists can be pinned, so a pinned id that is closed, gone, or
 * unknown shows nothing, and a Network's own Timeline is never pinned. What is closed is
 * left as it was.
 * @param networks - The sidebar, in its fixed order.
 * @param arrangement - The Owner's order.
 * @returns The sidebar as shown.
 */
export const arranged = (
  networks: readonly SidebarNetwork[],
  arrangement: Arrangement
): Arranged => {
  const pinnable = new Set(
    networks.flatMap((network) =>
      network.timelines.filter((timeline) => !isOwn(timeline)).map((timeline) => timeline.id)
    )
  );

  const pinnedIds = once(arrangement.pinned).filter((id) => pinnable.has(id));
  const pinnedSet = new Set(pinnedIds);

  const shown = networksOrdered(networks, arrangement.networks).map((network): SidebarNetwork => ({
    ...network,
    timelines: timelinesOrdered(network.timelines, arrangement.order).filter(
      (timeline) => !pinnedSet.has(timeline.id)
    ),
  }));

  const pins = new Map(
    networks.flatMap((network) =>
      network.timelines
        .filter((timeline) => pinnedSet.has(timeline.id))
        .map((timeline) => [timeline.id, { network, timeline }] as const)
    )
  );

  // A pin names the Network as shown, which holds its Timelines without the pinned.
  const pinned = pinnedIds.flatMap((id) => {
    const pin = pins.get(id);
    const network = shown.find((one) => one.network === pin?.network.network);

    return pin === undefined || network === undefined ? [] : [{ network, timeline: pin.timeline }];
  });

  return { networks: shown, pinned };
};

/**
 * Every Timeline in the order shown, which `/next` and `/previous` step through: the
 * pinned, then each Network's own Timeline and the others under it.
 * @param shown - The sidebar as shown.
 * @returns The Timelines' ids.
 */
export const shownOrder = (shown: Arranged): readonly TimelineId[] => [
  ...shown.pinned.map((pin) => pin.timeline.id),
  ...shown.networks.flatMap((network) => network.timelines.map((timeline) => timeline.id)),
];

/**
 * What the Owner did to the order.
 *
 * - `Move`: a Timeline one place up or down in the part it is in: the pinned part; among the
 *   Networks, for a Network's own Timeline; or among its Network's Timelines.
 * - `Place`: a Timeline before or after another in the same part, as dragging does.
 * - `Pin`: a Timeline pinned above the Networks, or no longer; with neither said, whichever
 *   it is not now, as the options read when it is carried out say.
 */
export type ArrangeEdit =
  | { readonly _tag: "Move"; readonly timeline: TimelineId; readonly direction: "Up" | "Down" }
  | {
      readonly _tag: "Place";
      readonly timeline: TimelineId;
      readonly target: TimelineId;
      readonly side: "Before" | "After";
    }
  | { readonly _tag: "Pin"; readonly timeline: TimelineId; readonly pinned?: boolean };

/** The new whole value of one `ui` option, by its name. */
export type ArrangeChange =
  | { readonly option: "sidebar.networks"; readonly value: readonly NetworkId[] }
  | { readonly option: "sidebar.order"; readonly value: readonly TimelineId[] }
  | { readonly option: "sidebar.pinned"; readonly value: readonly TimelineId[] };

/** Where an item goes within its group: a place up or down, or beside another item. */
type Way<A extends string> =
  | { readonly direction: "Up" | "Down" }
  | { readonly target: A; readonly side: "Before" | "After" };

/**
 * A group with one item moved.
 * @param group - The items in order.
 * @param item - The item to move.
 * @param way - Where it goes.
 * @returns The group moved, or none when the item is not in it, the target is not, or
 * nothing would change, as at an edge.
 */
const reordered = <A extends string>(
  group: readonly A[],
  item: A,
  way: Way<A>
): readonly A[] | undefined => {
  const at = group.indexOf(item);

  if (at === -1) {
    return undefined;
  }

  if ("direction" in way) {
    const to = at + (way.direction === "Up" ? -1 : 1);
    const other = group[to];

    return other === undefined
      ? undefined
      : group.map((one, index) => {
          if (index === at) {
            return other;
          }

          return index === to ? item : one;
        });
  }

  const rest = group.filter((one) => one !== item);
  const target = rest.indexOf(way.target);

  if (target === -1) {
    return undefined;
  }

  const moved = rest.toSpliced(way.side === "Before" ? target : target + 1, 0, item);

  return moved.every((one, index) => one === group[index]) ? undefined : moved;
};

/**
 * A list with the places of a group's items refilled, in another order, so everything else
 * keeps its place.
 * @param whole - The list, which holds every item of the group.
 * @param group - The items in the order they are in `whole`.
 * @param moved - The same items in their new order.
 * @returns The list.
 */
const refilled = <A extends string>(
  whole: readonly A[],
  group: readonly A[],
  moved: readonly A[]
): readonly A[] => {
  const members = new Set(group);
  let next = 0;

  return whole.map((one) => {
    if (!members.has(one)) {
      return one;
    }

    const [to] = moved.slice(next, next + 1);
    next += 1;

    return to ?? one;
  });
};

/**
 * The Network a Network's own Timeline is the row of.
 * @param networks - The Networks as shown.
 * @param timeline - A Timeline.
 * @returns The Network, or none when it is not one's own.
 */
const rowOf = (networks: readonly SidebarNetwork[], timeline: TimelineId) =>
  networks.find((network) => network.timelines.some((one) => one.id === timeline && isOwn(one)));

/**
 * How an edit moves a Timeline, with the target of a `Place` named by what `idOf` makes of it.
 * @param edit - The edit.
 * @param idOf - What a Timeline is called within the group it moves in, or none when it is
 * not of the group.
 * @returns The way, or none for a `Pin`, or a target outside the group.
 */
const wayOf = <A extends string>(
  edit: ArrangeEdit,
  idOf: (timeline: TimelineId) => A | undefined
): Way<A> | undefined => {
  if (edit._tag === "Move") {
    return { direction: edit.direction };
  }

  if (edit._tag === "Pin") {
    return undefined;
  }

  const target = idOf(edit.target);

  return target === undefined ? undefined : { side: edit.side, target };
};

/**
 * A Network's own Timeline moved, which moves its Network among those as removed as it is.
 * @param shown - The sidebar as shown.
 * @param own - The Network of the Timeline moved.
 * @param edit - The edit, a `Move` or a `Place`.
 * @returns The Networks' new order, or none when nothing changes.
 */
const networkMoved = (
  shown: Arranged,
  own: SidebarNetwork,
  edit: ArrangeEdit
): ArrangeChange | undefined => {
  const group = shown.networks
    .filter((network) => network.removed === own.removed)
    .map((network) => network.network);

  const way = wayOf(edit, (target) => rowOf(shown.networks, target)?.network);
  const moved = way === undefined ? undefined : reordered(group, own.network, way);

  return moved === undefined
    ? undefined
    : {
        option: "sidebar.networks",
        value: refilled(
          shown.networks.map((network) => network.network),
          group,
          moved
        ),
      };
};

/**
 * A Timeline that is pinned moved within the pinned part.
 * @param shown - The sidebar as shown.
 * @param arrangement - The Owner's order.
 * @param edit - The edit, a `Move` or a `Place`.
 * @returns The pinned Timelines' new order, or none when nothing changes.
 */
const pinMoved = (
  shown: Arranged,
  arrangement: Arrangement,
  edit: ArrangeEdit
): ArrangeChange | undefined => {
  const group = shown.pinned.map((pin) => pin.timeline.id);
  const way = wayOf(edit, (target) => (group.includes(target) ? target : undefined));
  const moved = way === undefined ? undefined : reordered(group, edit.timeline, way);

  return moved === undefined
    ? undefined
    : {
        option: "sidebar.pinned",
        value: refilled(once(arrangement.pinned), group, moved),
      };
};

/**
 * A Timeline moved among the others of its Network that are not pinned. The value keeps the
 * order of every Timeline of other Networks, and of this Network's closed ones, in place.
 * @param networks - The sidebar, in its fixed order.
 * @param arrangement - The Owner's order.
 * @param edit - The edit, a `Move` or a `Place`.
 * @param network - The Network of the Timeline moved, as shown.
 * @returns The Timelines' new order, or none when nothing changes.
 */
const timelineMoved = (
  networks: readonly SidebarNetwork[],
  arrangement: Arrangement,
  edit: ArrangeEdit,
  network: SidebarNetwork
): ArrangeChange | undefined => {
  const group = network.timelines.filter((timeline) => !isOwn(timeline)).map((one) => one.id);
  const way = wayOf(edit, (target) => (group.includes(target) ? target : undefined));
  const moved = way === undefined ? undefined : reordered(group, edit.timeline, way);
  const fixed = networks.find((one) => one.network === network.network);

  if (moved === undefined || fixed === undefined) {
    return undefined;
  }

  // Every Timeline held of the Network, closed and pinned too, in the Owner's order.
  const whole = placed(
    [...fixed.timelines, ...fixed.closed]
      .filter((timeline) => !isOwn(timeline))
      .toSorted(sidebarOrder),
    (timeline) => timeline.id,
    arrangement.order
  ).map((timeline) => timeline.id);

  const held = new Set(whole);

  return {
    option: "sidebar.order",
    value: [
      ...once(arrangement.order).filter((id) => !held.has(id)),
      ...refilled(whole, group, moved),
    ],
  };
};

/**
 * What to write for one edit of the order, computed from what is shown now.
 *
 * - `Move` or `Place` of a pinned Timeline reorders the pinned part, and writes
 *   `sidebar.pinned`.
 * - Of a Network's own Timeline, they move its Network among the Networks as removed as it
 *   is, and write `sidebar.networks`.
 * - Of any other, they move it among its Network's Timelines that are not pinned, and write
 *   `sidebar.order`, which keeps the place of every Timeline of other Networks and of those
 *   closed.
 * - `Place` onto a Timeline of another part or Network changes nothing, and neither does
 *   either at an edge.
 * - `Pin` appends to `sidebar.pinned`, or, unpinning, removes from it, and with neither
 *   said, does whichever the Timeline is not now. A Network's own
 *   Timeline cannot be pinned.
 * @param networks - The sidebar, in its fixed order.
 * @param given - The Owner's order. What it names that has gone is not written again, once
 * every Network's Timelines are known.
 * @param edit - What the Owner did.
 * @returns The option to set and its whole new value, or none when nothing changes.
 */
export const arranging = (
  networks: readonly SidebarNetwork[],
  given: Arrangement,
  edit: ArrangeEdit
): ArrangeChange | undefined => {
  const arrangement = lasting(networks, given);
  const shown = arranged(networks, arrangement);
  const isPinned = shown.pinned.some((pin) => pin.timeline.id === edit.timeline);

  if (edit._tag === "Pin") {
    const wanted = edit.pinned ?? !isPinned;

    if (wanted !== isPinned) {
      const rest = once(arrangement.pinned).filter((id) => id !== edit.timeline);

      if (!wanted) {
        return { option: "sidebar.pinned", value: rest };
      }

      const listed = shown.networks.some((network) =>
        network.timelines.some((timeline) => timeline.id === edit.timeline && !isOwn(timeline))
      );

      return listed ? { option: "sidebar.pinned", value: [...rest, edit.timeline] } : undefined;
    }

    return undefined;
  }

  if (isPinned) {
    return pinMoved(shown, arrangement, edit);
  }

  const own = rowOf(shown.networks, edit.timeline);

  if (own !== undefined) {
    return networkMoved(shown, own, edit);
  }

  const network = shown.networks.find((one) =>
    one.timelines.some((timeline) => timeline.id === edit.timeline)
  );

  return network === undefined ? undefined : timelineMoved(networks, arrangement, edit, network);
};
