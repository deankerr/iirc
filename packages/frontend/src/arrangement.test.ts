import { NetworkId, Timeline, TimelineId } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { arranged, arrangementOf, arranging, shownOrder, unarranged } from "./arrangement.ts";
import type { ArrangeEdit, Arrangement } from "./arrangement.ts";
import { sidebarOrder } from "./timelines.ts";
import type { SidebarNetwork } from "./timelines.ts";

const hex = (value: number) => value.toString(16).padStart(14, "0");
const id = (number: number) => Schema.decodeSync(TimelineId)(`${hex(number)}-00000000-00000000`);
const network = Schema.decodeSync(NetworkId);
const decodeTimeline = Schema.decodeSync(Timeline);

/**
 * A Timeline as the sidebar holds it.
 * @param number - Its id's number.
 * @param of - Its Network.
 * @param kind - What it is of.
 * @param name - Its name.
 * @returns The Timeline.
 */
const timeline = (
  number: number,
  of: string,
  kind: "Network" | "Channel" | "Direct",
  name: string
) =>
  decodeTimeline({
    changed: 1,
    closed: false,
    detached: false,
    head: null,
    id: id(number),
    key: kind === "Network" ? null : name.toLowerCase(),
    kind,
    latest: null,
    life: 1,
    name,
    network: of,
    read: null,
    removed: false,
    unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
  });

/**
 * A Network as `sidebar` gives it: its Timelines in the fixed order, and those closed.
 * @param name - Its id.
 * @param first - The number its Timelines' ids start from, its own first.
 * @param listed - Its Channels and Direct Messages listed, by name.
 * @param options - Those closed, and whether it was removed.
 * @returns The Network.
 */
const net = (
  name: string,
  first: number,
  listed: readonly string[],
  options: { readonly closed?: readonly string[]; readonly removed?: boolean } = {}
): SidebarNetwork => {
  const make = (names: readonly string[], from: number) =>
    names.map((one, index) =>
      timeline(from + index, name, one.startsWith("@") ? "Direct" : "Channel", one.replace("@", ""))
    );

  const closed = make(options.closed ?? [], first + 1 + listed.length);

  return {
    away: { _tag: "Unknown" },
    closed: closed.toSorted(sidebarOrder),
    complete: true,
    connection: { _tag: "Unknown" },
    listed: true,
    network: network(name),
    removed: options.removed ?? false,
    running: undefined,
    timelines: [timeline(first, name, "Network", name), ...make(listed, first + 1)].toSorted(
      sidebarOrder
    ),
  };
};

/**
 * What the sidebar shows, as ids' numbers: the pinned, then each Network's Timelines.
 * @param shown - The sidebar as shown.
 * @returns The numbers.
 */
const numbers = (shown: ReturnType<typeof arranged>) => ({
  networks: shown.networks.map((one) =>
    one.timelines.map((each) => Number.parseInt(each.id.slice(0, 14), 16))
  ),
  pinned: shown.pinned.map((one) => [
    Number.parseInt(one.timeline.id.slice(0, 14), 16),
    one.network.network,
  ]),
});

// libera: 10 its own, #a 11, #b 12, #c 13, then @peer 14. oftc: 20 its own, #x 21, #y 22.
const libera = net("libera", 10, ["#a", "#b", "#c", "@peer"]);
const oftc = net("oftc", 20, ["#x", "#y"]);
const gone = net("gone", 30, ["#z"], { removed: true });
const fixed = [libera, oftc, gone];

const named = (...names: readonly string[]) => names.map((one) => network(one));

const arrange = (arrangement: Partial<Arrangement>) => ({ ...unarranged, ...arrangement });

/**
 * What Libera lists in the order the Owner gave its Timelines, as ids' numbers.
 * @param order - The order.
 * @returns The numbers.
 */
const listing = (order: readonly TimelineId[]) =>
  numbers(arranged([libera], arrange({ order }))).networks[0];

describe("the Sidebar in the Owner's order", () => {
  it("is exactly the fixed order when nothing is set, and keeps the removed Networks last", () => {
    const shown = arranged([libera, oftc, gone], unarranged);

    expect({
      networks: shown.networks,
      order: shownOrder(shown),
      shown: numbers(shown),
    }).toStrictEqual({
      networks: fixed,
      order: fixed.flatMap((one) => one.timelines.map((each) => each.id)),
      shown: {
        networks: [
          [10, 11, 12, 13, 14],
          [20, 21, 22],
          [30, 31],
        ],
        pinned: [],
      },
    });
  });

  it("puts the Networks and a Network's Timelines in the order given, its own Timeline first", () => {
    const shown = arranged(fixed, {
      ...unarranged,
      networks: [network("oftc"), network("libera")],
      order: [id(13), id(11), id(10)],
    });

    expect(numbers(shown).networks).toStrictEqual([
      [20, 21, 22],
      [10, 13, 14, 11, 12],
      [30, 31],
    ]);
  });

  it("keeps the removed Networks after the others, whatever the order says", () => {
    const shown = arranged(
      fixed,
      arrange({ networks: [network("gone"), network("oftc"), network("libera")] })
    );

    expect(shown.networks.map((one) => one.network)).toStrictEqual(["oftc", "libera", "gone"]);
  });

  it("gives a Timeline with no place the place the fixed order gives it, after the one before it", () => {
    expect({
      // The Direct Message goes where #c goes.
      direct: listing([id(13), id(12), id(11)]),
      // Nothing comes before #a, so with #b and #c named, it leads.
      first: listing([id(12), id(13)]),
      // #b has no place, and follows #a, which comes before it by name, and the Direct
      // Message follows #c.
      late: listing([id(13), id(11)]),
    }).toStrictEqual({
      direct: [10, 13, 14, 12, 11],
      first: [10, 11, 12, 13, 14],
      late: [10, 13, 14, 11, 12],
    });
  });

  it("ignores an id that names nothing held, and counts one named twice at its first place", () => {
    expect({
      gone: listing([id(99), id(12), id(98), id(11)]),
      twice: listing([id(13), id(11), id(13), id(12)]),
    }).toStrictEqual({ gone: [10, 12, 13, 14, 11], twice: [10, 13, 14, 11, 12] });
  });

  it("takes a pinned Timeline out of its Network into the pinned part, in the order pinned, saying its Network", () => {
    const shown = arranged(fixed, arrange({ pinned: [id(21), id(12)] }));

    expect({
      held: shown.pinned.every((one) => shown.networks.includes(one.network)),
      order: shownOrder(shown),
      pinned: shown.pinned.map((one) => [one.timeline.id, one.network.network]),
      shown: numbers(shown),
    }).toStrictEqual({
      held: true,
      order: [id(21), id(12), id(10), id(11), id(13), id(14), id(20), id(22), id(30), id(31)],
      pinned: [
        [id(21), "oftc"],
        [id(12), "libera"],
      ],
      shown: {
        networks: [
          [10, 11, 13, 14],
          [20, 22],
          [30, 31],
        ],
        pinned: [
          [21, "oftc"],
          [12, "libera"],
        ],
      },
    });
  });

  it("shows nothing for a pin that is closed, gone, unknown, or a Network's own, and names a Timeline once", () => {
    const withClosed = net("libera", 10, ["#a"], { closed: ["#b"] });

    const shown = arranged(
      [withClosed],
      arrange({ pinned: [id(12), id(10), id(77), id(11), id(11)] })
    );

    expect(numbers(shown)).toStrictEqual({
      networks: [[10]],
      pinned: [[11, "libera"]],
    });
  });

  it("leaves what is closed as it was", () => {
    const withClosed = net("libera", 10, ["#a"], { closed: ["#b", "#c"] });

    expect(
      arranged([withClosed], arrange({ order: [id(13), id(12)], pinned: [id(11)] })).networks[0]
        ?.closed
    ).toStrictEqual(withClosed.closed);
  });

  it("reads the arrangement from the ui options", () => {
    expect(
      arrangementOf({
        "sidebar.networks": [network("oftc")],
        "sidebar.order": [id(1)],
        "sidebar.pinned": [id(2)],
      })
    ).toStrictEqual({ networks: [network("oftc")], order: [id(1)], pinned: [id(2)] });
  });
});

const edit = (
  arrangement: Partial<Arrangement>,
  change: ArrangeEdit,
  held: readonly SidebarNetwork[] = fixed
) => arranging(held, arrange(arrangement), change);

const pin = (timeline: number, pinned?: boolean): ArrangeEdit =>
  pinned === undefined
    ? { _tag: "Pin", timeline: id(timeline) }
    : { _tag: "Pin", pinned, timeline: id(timeline) };

const move = (timeline: number, direction: "Up" | "Down"): ArrangeEdit => ({
  _tag: "Move",
  direction,
  timeline: id(timeline),
});

const place = (timeline: number, target: number, side: "Before" | "After"): ArrangeEdit => ({
  _tag: "Place",
  side,
  target: id(target),
  timeline: id(timeline),
});

describe("arranging the Sidebar", () => {
  it("moves a Timeline among its Network's, writing the whole order and keeping other Networks' places", () => {
    const other = [id(21), id(22)];

    expect({
      down: edit({ order: other }, move(11, "Down")),
      place: edit({}, place(14, 11, "Before")),
      up: edit({ order: [id(13), ...other] }, move(12, "Up")),
    }).toStrictEqual({
      down: { option: "sidebar.order", value: [...other, id(12), id(11), id(13), id(14)] },
      place: { option: "sidebar.order", value: [id(14), id(11), id(12), id(13)] },
      up: { option: "sidebar.order", value: [...other, id(12), id(11), id(13), id(14)] },
    });
  });

  it("keeps a closed Timeline, and a pinned one, in its own place while another moves", () => {
    // #b, closed, sits between #a, listed first, and #c.
    const held = [net("libera", 10, ["#a", "#c"], { closed: ["#b"] })];

    expect({
      closed: arranging(held, unarranged, move(12, "Up")),
      // With #a pinned, #c is the first of those listed under the Network.
      pinned: arranging(held, arrange({ pinned: [id(11)] }), move(12, "Up")),
    }).toStrictEqual({
      closed: { option: "sidebar.order", value: [id(12), id(13), id(11)] },
      pinned: undefined,
    });
  });

  it("drops what has gone from what it writes once every Network is read, and keeps it while one is read", () => {
    // oftc's first page is held, and later pages are still read.
    const reading: SidebarNetwork = { ...oftc, complete: false };
    const given = { order: [id(99), id(11), id(21)], pinned: [id(98), id(13)] };

    expect({
      orderRead: edit(given, move(11, "Down"), [libera, oftc]),
      orderReading: edit(given, move(11, "Down"), [libera, reading]),
      pinnedRead: edit(given, pin(12), [libera, oftc]),
      pinnedReading: edit(given, pin(12), [libera, reading]),
    }).toStrictEqual({
      orderRead: { option: "sidebar.order", value: [id(21), id(12), id(11), id(13), id(14)] },
      orderReading: {
        option: "sidebar.order",
        value: [id(99), id(21), id(12), id(11), id(13), id(14)],
      },
      pinnedRead: { option: "sidebar.pinned", value: [id(13), id(12)] },
      pinnedReading: { option: "sidebar.pinned", value: [id(98), id(13), id(12)] },
    });
  });

  it("changes nothing at an edge, for an unknown Timeline, or when a Timeline is placed where it is", () => {
    expect({
      bottom: edit({}, move(14, "Down")),
      first: edit({}, move(11, "Up")),
      self: edit({}, place(12, 12, "Before")),
      unknown: edit({}, move(99, "Up")),
      where: edit({}, place(12, 11, "After")),
    }).toStrictEqual({
      bottom: undefined,
      first: undefined,
      self: undefined,
      unknown: undefined,
      where: undefined,
    });
  });

  it("moves a Network among the Networks as removed as it is, by its own Timeline", () => {
    const four = [
      libera,
      oftc,
      net("freenode", 40, []),
      gone,
      net("old", 50, [], { removed: true }),
    ];

    expect({
      down: edit({}, move(10, "Down"), four),
      past: edit({}, move(40, "Down"), four),
      place: edit({}, place(40, 10, "Before"), four),
      removed: edit({ networks: [network("gone")] }, move(30, "Down"), four),
      up: edit({}, move(20, "Up"), four),
    }).toStrictEqual({
      down: {
        option: "sidebar.networks",
        value: named("oftc", "libera", "freenode", "gone", "old"),
      },
      past: undefined,
      place: {
        option: "sidebar.networks",
        value: named("freenode", "libera", "oftc", "gone", "old"),
      },
      removed: {
        option: "sidebar.networks",
        value: named("libera", "oftc", "freenode", "old", "gone"),
      },
      up: {
        option: "sidebar.networks",
        value: named("oftc", "libera", "freenode", "gone", "old"),
      },
    });
  });

  it("will not move a Network past a removed one", () => {
    expect(edit({}, place(20, 30, "After"))).toBeUndefined();
  });

  it("moves a pinned Timeline within the pinned part, and writes the pinned part", () => {
    const pinned = [id(21), id(12), id(11)];

    expect({
      down: edit({ pinned }, move(21, "Down")),
      first: edit({ pinned }, move(21, "Up")),
      place: edit({ pinned }, place(11, 21, "Before")),
    }).toStrictEqual({
      down: { option: "sidebar.pinned", value: [id(12), id(21), id(11)] },
      first: undefined,
      place: { option: "sidebar.pinned", value: [id(11), id(21), id(12)] },
    });
  });

  it("refuses to place a Timeline across parts or Networks, which only reorders within one", () => {
    const pinned = [id(21)];

    expect({
      channelOntoNetwork: edit({}, place(11, 10, "After")),
      channelOntoOther: edit({}, place(11, 21, "After")),
      intoPinned: edit({ pinned }, place(11, 21, "Before")),
      networkOntoChannel: edit({}, place(10, 11, "After")),
      outOfPinned: edit({ pinned: [id(21), id(11)] }, place(21, 12, "After")),
    }).toStrictEqual({
      channelOntoNetwork: undefined,
      channelOntoOther: undefined,
      intoPinned: undefined,
      networkOntoChannel: undefined,
      outOfPinned: undefined,
    });
  });

  it("pins a Timeline by appending it, and unpins by removing it, changing nothing when it already is so", () => {
    expect({
      already: edit({ pinned: [id(12)] }, pin(12, true)),
      append: edit({ pinned: [id(12), id(99)] }, pin(11, true)),
      closed: arranging([net("libera", 10, ["#a"], { closed: ["#b"] })], unarranged, pin(12, true)),
      notPinned: edit({ pinned: [id(12)] }, pin(11, false)),
      own: edit({}, pin(10, true)),
      toggleOff: edit({ pinned: [id(12), id(11)] }, pin(12)),
      toggleOn: edit({ pinned: [id(12)] }, pin(11)),
      unknown: edit({}, pin(99, true)),
      unpin: edit({ pinned: [id(12), id(11)] }, pin(12, false)),
    }).toStrictEqual({
      already: undefined,
      append: { option: "sidebar.pinned", value: [id(12), id(11)] },
      closed: undefined,
      notPinned: undefined,
      own: undefined,
      toggleOff: { option: "sidebar.pinned", value: [id(11)] },
      toggleOn: { option: "sidebar.pinned", value: [id(12), id(11)] },
      unknown: undefined,
      unpin: { option: "sidebar.pinned", value: [id(11)] },
    });
  });
});
