import type { TimelineItem } from "@iirc/api";
import {
  NetworkEntry,
  Timeline,
  TimelineChange,
  TimelineId,
  TimelineList,
  TimelineReset,
  TimelineWindow,
} from "@iirc/api";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  activityOf,
  countText,
  labelOf,
  levelOf,
  markDue,
  markLatest,
  networkActivity,
  saidLevel,
  titleOf,
} from "./activity.ts";
import type { Page } from "./activity.ts";
import { notificationsOf } from "./notifications.ts";
import {
  followFrom,
  initialTimelines,
  opened,
  reduceTimelines,
  rowsOf,
  sidebar,
} from "./timelines.ts";
import type { Timelines, TimelinesEvent } from "./timelines.ts";

// Wire forms, parsed as the API parses them.

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const decodeTimeline = Schema.decodeSync(Timeline);
const decodeChange = Schema.decodeSync(TimelineChange);
const timelineId = Schema.decodeSync(TimelineId);

const own = idOf(1);
const iirc = idOf(2);
const other = idOf(3);
const peer = idOf(4);

type Counts = (typeof Timeline.Encoded)["unread"];

const nothing: Counts = { activity: 0, direct: 0, highlights: 0, messages: 0 };

interface Described {
  readonly id: string;
  readonly kind?: "Network" | "Channel" | "Direct";
  readonly name: string;
  readonly read?: number | null;
  readonly unread?: Partial<Counts>;
  readonly latest?: number | null;
  readonly detached?: boolean;
  readonly changed?: number;
  readonly removed?: boolean;
}

const described = ({
  changed = 1,
  detached = false,
  id,
  kind = "Channel",
  latest = null,
  name,
  read = null,
  removed = false,
  unread = {},
}: Described): typeof Timeline.Encoded => ({
  changed,
  detached,
  head: null,
  id,
  key: kind === "Network" || detached ? null : name,
  kind,
  latest: latest === null ? null : cursor(latest, 1),
  life: 1,
  name,
  network: "libera",
  read,
  removed,
  unread: { ...nothing, ...unread },
});

interface Said {
  readonly timeline?: string;
  readonly at: number;
  readonly sequence: number;
  readonly level?: (typeof TimelineItem.Encoded)["level"];
  readonly live?: boolean;
  readonly ours?: boolean;
  readonly kind?: "Privmsg" | "Notice" | "Action";
  readonly text?: string;
  readonly sender?: string;
  readonly changed?: number;
}

const said = ({
  at,
  changed,
  kind = "Privmsg",
  level = "Message",
  live = true,
  ours = false,
  sender = "peer",
  sequence,
  text = `m${sequence}`,
  timeline = iirc,
}: Said): typeof TimelineItem.Encoded => ({
  changed: changed ?? sequence,
  content: {
    _tag: "Message",
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    kind,
    live,
    ours: ours ? { delivery: { _tag: "Unconfirmed" }, intent: "web-1" } : null,
    sender,
    tags: [],
    target: "#iirc",
    text,
  },
  level,
  network: "libera",
  position: cursor(at, sequence),
  sequence,
  timeline,
});

/**
 * The view saying it shows the open Timeline at its latest, with its last item in view.
 * @param state - The state.
 * @returns The state.
 */
const shownToLatest = (state: Timelines): Timelines => {
  const shown = opened(state);
  const last = shown._tag === "Shown" ? shown.window.items.at(-1) : undefined;

  return shown._tag === "Shown" && last !== undefined
    ? reduceTimelines(state, {
        _tag: "Following",
        following: true,
        seen: last.position,
        timeline: shown.timeline,
      })
    : state;
};

/**
 * A state following the stream from step 10, with libera's own Timeline, `#iirc`, `#other`,
 * and a Direct Message with `peer`, as given, `open` opened and read with `items`.
 * @param timelines - The Timelines, as the list gives them.
 * @param open - The Timeline opened, if any.
 * @param items - Its items.
 * @param viewed - Whether the view said it shows the open Timeline at its latest.
 * @returns The state.
 */
const world = (
  timelines: readonly (typeof Timeline.Encoded)[],
  open: string | undefined,
  items: readonly (typeof TimelineItem.Encoded)[] = [],
  viewed = true
): Timelines => {
  const libera = Schema.decodeSync(NetworkEntry)({
    _tag: "Live",
    life: 1,
    network: "libera",
    status: { _tag: "Running" },
  });

  const list = { _tag: "List", after: undefined, attempt: 0, network: libera.network } as const;

  const events: TimelinesEvent[] = [
    { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
    { _tag: "NetworksRead", entries: [libera] },
    { _tag: "ReadStarted", read: list },
    {
      _tag: "ListRead",
      after: undefined,
      network: libera.network,
      page: Schema.decodeSync(TimelineList)({
        more: false,
        projection: { _tag: "Running" },
        through: 10,
        timelines: [...timelines],
        version: 1,
      }),
    },
  ];

  if (open !== undefined) {
    const read = {
      _tag: "Latest",
      attempt: 0,
      generation: 0,
      limit: 1000,
      timeline: timelineId(open),
    } as const;

    events.push(
      { _tag: "Opened", timeline: timelineId(open) },
      { _tag: "ReadStarted", read },
      {
        _tag: "WindowRead",
        read,
        window: Schema.decodeSync(TimelineWindow)({
          earlier: false,
          gaps: [],
          items: [...items],
          later: false,
          network: "libera",
          through: 10,
          timeline: open,
          version: 1,
        }),
      }
    );
  }

  let state = initialTimelines;

  for (const event of events) {
    state = reduceTimelines(state, event);
  }

  return viewed ? shownToLatest(state) : state;
};

const titled = (...timelines: readonly (typeof Timeline.Encoded)[]) =>
  titleOf(sidebar(world(timelines, undefined)));

const leveled = (...timelines: readonly (typeof Timeline.Encoded)[]) =>
  saidLevel(sidebar(world(timelines, undefined)));

const changed = (
  sequence: number,
  change: Partial<typeof TimelineChange.Encoded>
): Extract<TimelinesEvent, { readonly _tag: "Changed" }> => ({
  _tag: "Changed",
  change: decodeChange({
    dropped: [],
    gaps: [],
    items: [],
    merged: [],
    removals: [],
    sequence,
    timelines: [],
    ...change,
  }),
  place: { sequence, version: 1 },
});

const seeing: Page = { compact: false, focused: true, visible: true };

const dividerOf = (state: Timelines) => {
  const shown = opened(state);

  return shown._tag === "Shown" ? shown.divider : undefined;
};

const rowsShown = (state: Timelines) => {
  const shown = opened(state);

  return shown._tag === "Shown"
    ? rowsOf(shown.window, shown.divider).map((row) =>
        row._tag === "Item" ? row.item.sequence : row._tag
      )
    : [];
};

describe("what is unread", () => {
  it("ranks a Timeline by its highest level, and sums a Network's, kept at the cap", () => {
    const timelines = [
      described({ id: own, kind: "Network", name: "libera", unread: { activity: 4 } }),
      described({ id: iirc, name: "#iirc", unread: { highlights: 1, messages: 998 } }),
      described({ id: other, name: "#other", unread: { messages: 1000 } }),
      described({ id: peer, kind: "Direct", name: "peer", unread: { direct: 2 } }),
    ].map((one) => decodeTimeline(one));

    const [network] = sidebar(
      world(
        timelines.map((one) => Schema.encodeSync(Timeline)(one)),
        undefined
      )
    );

    expect({
      levels: timelines.map((one) => activityOf(one).level),
      network: network === undefined ? undefined : networkActivity(network),
      none: levelOf(nothing),
    }).toStrictEqual({
      levels: ["Activity", "Highlight", "Message", "Direct"],
      network: {
        level: "Highlight",
        unread: { activity: 4, direct: 2, highlights: 1, messages: 1000 },
      },
      none: undefined,
    });
  });

  it("writes counts past the cap as 999+, and says them in a row's label", () => {
    expect({
      capped: countText(1000),
      exact: countText(999),
      label: labelOf("#iirc", {
        level: "Highlight",
        unread: { ...nothing, highlights: 1, messages: 2 },
      }),
      many: labelOf("#iirc", { level: "Highlight", unread: { ...nothing, highlights: 1000 } }),
      only: labelOf("#iirc", { level: "Activity", unread: { ...nothing, activity: 3 } }),
      plural: labelOf("libera", {
        level: "Highlight",
        unread: { ...nothing, direct: 1, highlights: 2 },
      }),
    }).toStrictEqual({
      capped: "999+",
      exact: "999",
      label: "#iirc, 3 unread, 1 highlight",
      many: "#iirc, 999+ unread, 999+ highlights",
      only: "#iirc",
      plural: "libera, 3 unread, 2 highlights",
    });
  });

  it("titles the page by the Highlights and Direct Messages unread everywhere", () => {
    expect({
      calling: titled(
        described({ id: iirc, name: "#iirc", unread: { highlights: 2, messages: 9 } }),
        described({ id: peer, kind: "Direct", name: "peer", unread: { direct: 1 } })
      ),
      calm: titled(described({ id: iirc, name: "#iirc", unread: { activity: 5, messages: 9 } })),
      capped: titled(
        described({ id: iirc, name: "#iirc", unread: { highlights: 1000 } }),
        described({ id: peer, kind: "Direct", name: "peer", unread: { direct: 1 } })
      ),
      removed: titled(
        described({ id: iirc, name: "#iirc", removed: true, unread: { highlights: 2 } })
      ),
    }).toStrictEqual({
      calling: "(3) iirc",
      calm: "iirc",
      capped: "(999+) iirc",
      // A removed Network's Timelines are never marked read, so they call for nothing.
      removed: "iirc",
    });
  });

  it("gives the highest level said and unread anywhere, and none for Activity alone", () => {
    expect({
      activity: leveled(described({ id: iirc, name: "#iirc", unread: { activity: 5 } })),
      direct: leveled(
        described({ id: iirc, name: "#iirc", unread: { messages: 9 } }),
        described({ id: peer, kind: "Direct", name: "peer", unread: { direct: 1 } })
      ),
      highlight: leveled(
        described({ id: iirc, name: "#iirc", unread: { highlights: 1 } }),
        described({ id: peer, kind: "Direct", name: "peer", unread: { direct: 1 } })
      ),
      message: leveled(
        described({ id: own, kind: "Network", name: "libera", unread: { activity: 2 } }),
        described({ id: iirc, name: "#iirc", unread: { activity: 5, messages: 1 } })
      ),
      none: leveled(described({ id: iirc, name: "#iirc" })),
    }).toStrictEqual({
      activity: undefined,
      direct: "Direct",
      highlight: "Highlight",
      message: "Message",
      none: undefined,
    });
  });

  it("marks a Timeline read up to its latest, as the Daemon names its Target", () => {
    const marks = [
      described({ id: own, kind: "Network", latest: 50, name: "libera", unread: { activity: 1 } }),
      described({ id: iirc, latest: 50, name: "#iirc", read: 10, unread: { messages: 1 } }),
      described({ id: iirc, latest: 50, name: "#iirc", read: 50, unread: { messages: 1 } }),
      described({ id: iirc, latest: 50, name: "#iirc" }),
      described({ id: iirc, latest: null, name: "#iirc", unread: { messages: 1 } }),
      described({
        detached: true,
        id: peer,
        kind: "Direct",
        latest: 50,
        name: "peer",
        unread: { direct: 1 },
      }),
      described({ id: iirc, latest: 50, name: "#iirc", removed: true, unread: { messages: 1 } }),
    ].map((one) => markLatest(decodeTimeline(one)));

    expect(marks.map((mark) => mark && { read: mark.read, target: mark.target })).toStrictEqual([
      { read: 50, target: null },
      { read: 50, target: "#iirc" },
      // Already read that far, nothing unread, no item, a detached Direct Message, or a
      // removed Network's, which no Client marks.
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("marking the open Timeline read", () => {
  const unreadIirc = described({
    id: iirc,
    latest: 40,
    name: "#iirc",
    read: 10,
    unread: { messages: 2 },
  });

  const items = [
    said({ at: 10, sequence: 1 }),
    said({ at: 30, sequence: 2 }),
    said({ at: 40, sequence: 3 }),
  ];

  it("is due when the Owner sees the latest, up to the last item held", () => {
    const state = world([unreadIirc], iirc, items);
    const due = markDue(state, seeing, "latest");

    expect(due).toStrictEqual({
      _tag: "MarkRead",
      network: "libera",
      read: 40,
      target: "#iirc",
      timeline: iirc,
    });
  });

  it("is not due while the page is hidden or unfocused, scrolled back, or the options show", () => {
    const state = world([unreadIirc], iirc, items);

    expect({
      back: markDue(
        reduceTimelines(state, {
          _tag: "Following",
          following: false,
          seen: undefined,
          timeline: timelineId(iirc),
        }),
        seeing,
        "latest"
      ),
      hidden: markDue(state, { compact: false, focused: true, visible: false }, "latest"),
      options: markDue(
        reduceTimelines(state, { _tag: "OptionsShown", filter: "" }),
        seeing,
        "latest"
      ),
      unfocused: markDue(state, { compact: false, focused: false, visible: true }, "latest"),
    }).toStrictEqual({
      back: undefined,
      hidden: undefined,
      options: undefined,
      unfocused: undefined,
    });
  });

  it("is never past the last item held, never back, and not due once read", () => {
    // The Daemon lists a later item than the window holds yet.
    const ahead = described({
      id: iirc,
      latest: 90,
      name: "#iirc",
      read: 10,
      unread: { messages: 3 },
    });

    const marked = described({ changed: 11, id: iirc, latest: 40, name: "#iirc", read: 40 });

    const later = described({
      id: iirc,
      latest: 40,
      name: "#iirc",
      read: 60,
      unread: { messages: 1 },
    });

    expect({
      ahead: markDue(world([ahead], iirc, items), seeing, "latest")?.read,
      later: markDue(world([later], iirc, items), seeing, "latest"),
      read: markDue(
        reduceTimelines(world([unreadIirc], iirc, items), changed(11, { timelines: [marked] })),
        seeing,
        "latest"
      ),
    }).toStrictEqual({ ahead: 40, later: undefined, read: undefined });
  });

  it("marks only forward, and only up to the last item held, for any marker and items", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ max: 1000, min: 1 }), { maxLength: 6, minLength: 1 }),
        fc.option(fc.integer({ max: 1000, min: 0 }), { nil: null }),
        fc.nat({ max: 3 }),
        fc.boolean(),
        fc.boolean(),
        (ats, read, messages, visible, back) => {
          const sorted = ats.toSorted((left, right) => left - right);
          const held = sorted.map((at, index) => said({ at, sequence: index + 1 }));

          const last = sorted.at(-1) ?? 0;

          const timeline = described({
            id: iirc,
            latest: 2000,
            name: "#iirc",
            read,
            unread: { messages },
          });

          let state = world([timeline], iirc, held);

          if (back) {
            state = reduceTimelines(state, {
              _tag: "Following",
              following: false,
              seen: undefined,
              timeline: timelineId(iirc),
            });
          }

          const due = markDue(state, { compact: false, focused: true, visible }, "latest");
          const expected = visible && !back && messages > 0 && (read === null || last > read);

          expect(due?.read).toBe(expected ? last : undefined);
        }
      )
    );
  });
});

describe("what the view saw", () => {
  const unreadIirc = described({
    id: iirc,
    latest: 40,
    name: "#iirc",
    read: 10,
    unread: { messages: 2 },
  });

  const items = [
    said({ at: 10, sequence: 1 }),
    said({ at: 30, sequence: 2 }),
    said({ at: 40, sequence: 3 }),
  ];

  const iircId = timelineId(iirc);

  it("marks nothing until the view says it shows the latest, and no further than it showed", () => {
    const unconfirmed = world(
      [unreadIirc, described({ id: other, name: "#other" })],
      iirc,
      items,
      false
    );

    const shown = opened(unconfirmed);
    const second = shown._tag === "Shown" ? shown.window.items[1]?.position : undefined;

    const partly = reduceTimelines(unconfirmed, {
      _tag: "Following",
      following: true,
      seen: second,
      timeline: iircId,
    });

    expect({
      partly: markDue(partly, seeing, "latest")?.read,
      unconfirmed: markDue(unconfirmed, seeing, "latest"),
    }).toStrictEqual({
      partly: 30,
      unconfirmed: undefined,
    });
  });

  it("changes nothing when the open Timeline is opened again, scrolled back", () => {
    const back = reduceTimelines(world([unreadIirc], iirc, items), {
      _tag: "Following",
      following: false,
      seen: undefined,
      timeline: iircId,
    });

    const again = reduceTimelines(back, { _tag: "Opened", timeline: iircId });
    const shown = opened(again);

    expect({
      due: markDue(again, seeing, "latest"),
      following: shown._tag === "Shown" ? shown.window.following : undefined,
      same: again.windows === back.windows && again.layout === back.layout,
    }).toStrictEqual({ due: undefined, following: false, same: true });
  });

  it("forgets what was seen when another Timeline opens, until the view says so again", () => {
    const state = world([unreadIirc, described({ id: other, name: "#other" })], iirc, items);
    const away = reduceTimelines(state, { _tag: "Opened", timeline: timelineId(other) });
    const back = reduceTimelines(away, { _tag: "Opened", timeline: iircId });

    expect({
      back: markDue(back, seeing, "latest"),
      before: markDue(state, seeing, "latest")?.read,
      shown: markDue(shownToLatest(back), seeing, "latest")?.read,
    }).toStrictEqual({
      back: undefined,
      before: 40,
      shown: 40,
    });
  });
});

/**
 * The view saying the open Timeline is scrolled up from its latest, with one item the
 * last in view.
 * @param state - The state.
 * @param index - The item's index among those held.
 * @returns The state.
 */
const scrolledTo = (state: Timelines, index: number): Timelines => {
  const shown = opened(state);

  return shown._tag === "Shown"
    ? reduceTimelines(state, {
        _tag: "Following",
        following: false,
        seen: shown.window.items[index]?.position,
        timeline: shown.timeline,
      })
    : state;
};

describe("when a Timeline is marked read, as ui.read says", () => {
  const unreadIirc = described({
    id: iirc,
    latest: 40,
    name: "#iirc",
    read: 10,
    unread: { messages: 2 },
  });

  const items = [
    said({ at: 10, sequence: 1 }),
    said({ at: 30, sequence: 2 }),
    said({ at: 40, sequence: 3 }),
  ];

  const back = scrolledTo(world([unreadIirc], iirc, items), 1);

  it("under latest, marks nothing while the Pane is scrolled up from the latest", () => {
    expect({
      back: markDue(back, seeing, "latest"),
      latest: markDue(world([unreadIirc], iirc, items), seeing, "latest")?.read,
    }).toStrictEqual({ back: undefined, latest: 40 });
  });

  it("under shown, marks up to the last item in view while scrolled up, and never past it", () => {
    expect({
      back: markDue(back, seeing, "shown"),
      latest: markDue(world([unreadIirc], iirc, items), seeing, "shown")?.read,
    }).toStrictEqual({
      back: { _tag: "MarkRead", network: "libera", read: 30, target: "#iirc", timeline: iirc },
      latest: 40,
    });
  });

  it("under shown, never marks back, nor while the page is hidden or unfocused, or the options show", () => {
    const read = described({
      id: iirc,
      latest: 50,
      name: "#iirc",
      read: 40,
      unread: { messages: 1 },
    });

    expect({
      backwards: markDue(scrolledTo(world([read], iirc, items), 1), seeing, "shown"),
      hidden: markDue(back, { compact: false, focused: true, visible: false }, "shown"),
      options: markDue(
        reduceTimelines(back, { _tag: "OptionsShown", filter: "" }),
        seeing,
        "shown"
      ),
      unfocused: markDue(back, { compact: false, focused: false, visible: true }, "shown"),
      unsaid: markDue(world([unreadIirc], iirc, items, false), seeing, "shown"),
    }).toStrictEqual({
      backwards: undefined,
      hidden: undefined,
      options: undefined,
      unfocused: undefined,
      unsaid: undefined,
    });
  });

  it("under shown, marks up to the last item in view wherever it stands, for any marker and items", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ max: 1000, min: 1 }), { maxLength: 6, minLength: 1 }),
        fc.option(fc.integer({ max: 1000, min: 0 }), { nil: null }),
        fc.nat({ max: 3 }),
        fc.nat({ max: 5 }),
        (ats, read, messages, index) => {
          const sorted = ats.toSorted((left, right) => left - right);
          const held = sorted.map((at, one) => said({ at, sequence: one + 1 }));
          const shown = Math.min(index, sorted.length - 1);
          const at = sorted[shown] ?? 0;

          const timeline = described({
            id: iirc,
            latest: 2000,
            name: "#iirc",
            read,
            unread: { messages },
          });

          const due = markDue(scrolledTo(world([timeline], iirc, held), shown), seeing, "shown");
          const expected = messages > 0 && (read === null || at > read);

          expect(due?.read).toBe(expected ? at : undefined);
        }
      )
    );
  });

  it("under asked, marks nothing, even at the latest in a visible, focused page", () => {
    const state = world([unreadIirc], iirc, items);

    expect({
      asked: markDue(state, seeing, "asked"),
      back: markDue(back, seeing, "asked"),
      latest: markDue(state, seeing, "latest")?.read,
    }).toStrictEqual({ asked: undefined, back: undefined, latest: 40 });
  });
});

describe("the new divider", () => {
  const items = [
    said({ at: 10, sequence: 1 }),
    said({ at: 30, sequence: 2 }),
    said({ at: 40, sequence: 3 }),
  ];

  it("goes before the first item after the Read Marker the Timeline opened with", () => {
    const state = world(
      [described({ id: iirc, name: "#iirc", read: 20, unread: { highlights: 1, messages: 1 } })],
      iirc,
      items
    );

    expect(rowsShown(state)).toStrictEqual([1, "New", 2, 3]);
  });

  it("stays put as the Daemon's Read Marker moves, and goes once another Timeline opens", () => {
    const opening = world(
      [
        described({ id: iirc, name: "#iirc", read: 20, unread: { messages: 2 } }),
        described({ id: other, name: "#other" }),
      ],
      iirc,
      items
    );

    // The Daemon marks it read, and a new item arrives after.
    const marked = reduceTimelines(
      opening,
      changed(11, {
        items: [said({ at: 50, sequence: 11 })],
        timelines: [
          described({ changed: 11, id: iirc, name: "#iirc", read: 40, unread: { messages: 1 } }),
        ],
      })
    );

    const away = reduceTimelines(marked, { _tag: "Opened", timeline: timelineId(other) });
    const back = reduceTimelines(away, { _tag: "Opened", timeline: timelineId(iirc) });
    const again = reduceTimelines(marked, { _tag: "Opened", timeline: timelineId(iirc) });

    expect({
      again: rowsShown(again),
      away: rowsShown(away),
      back: dividerOf(back),
      marked: rowsShown(marked),
    }).toStrictEqual({
      // Opened again while open, it keeps its place.
      again: [1, "New", 2, 3, 11],
      away: [],
      // Opened again later, it is read as far as `#iirc`'s marker now, 40, so 11 is new.
      back: { read: 40, timeline: iirc },
      marked: [1, "New", 2, 3, 11],
    });
  });

  it("is not there when nothing said was unread, and goes first when nothing was ever read", () => {
    expect({
      activity: rowsShown(
        world(
          [described({ id: iirc, name: "#iirc", read: 20, unread: { activity: 3 } })],
          iirc,
          items
        )
      ),
      never: rowsShown(
        world([described({ id: iirc, name: "#iirc", unread: { messages: 3 } })], iirc, items)
      ),
      read: rowsShown(world([described({ id: iirc, name: "#iirc", read: 40 })], iirc, items)),
    }).toStrictEqual({ activity: [1, 2, 3], never: ["New", 1, 2, 3], read: [1, 2, 3] });
  });
});

describe("notifications", () => {
  const timelines = [
    described({ id: iirc, name: "#iirc", read: 20 }),
    described({ id: other, name: "#other", read: 20 }),
    described({ id: peer, kind: "Direct", name: "peer", read: 20 }),
  ];

  const state = world(timelines, iirc, [said({ at: 10, sequence: 1 })]);

  const notified = (item: typeof TimelineItem.Encoded, page: Page = seeing, before = state) => {
    const event = changed(11, { items: [item] });

    return notificationsOf(before, reduceTimelines(before, event), event.change, page).map(
      (one) => one.timeline
    );
  };

  const highlight = (timeline: string, more: Partial<Said> = {}) =>
    said({ at: 50, level: "Highlight", sequence: 11, text: "iirc: hi", timeline, ...more });

  it("notifies of a Highlight or Direct Message the Owner is not looking at", () => {
    expect({
      direct: notified(said({ at: 50, level: "Direct", sequence: 11, timeline: peer })),
      elsewhere: notified(highlight(other)),
      hidden: notified(highlight(iirc), { compact: false, focused: true, visible: false }),
      unfocused: notified(highlight(iirc), { compact: false, focused: false, visible: true }),
    }).toStrictEqual({ direct: [peer], elsewhere: [other], hidden: [iirc], unfocused: [iirc] });
  });

  it("never notifies of what the Owner sees, a Message, history, ours, read, or given before", () => {
    const event = changed(11, { items: [highlight(other)] });
    const after = reduceTimelines(state, event);

    expect({
      again: notificationsOf(after, reduceTimelines(after, event), event.change, seeing),
      history: notified(highlight(other, { live: false })),
      looking: notified(highlight(iirc)),
      message: notified(said({ at: 50, sequence: 11, timeline: other })),
      older: notified(highlight(other, { changed: 11, sequence: 5 })),
      ours: notified(highlight(other, { ours: true })),
      read: notified(highlight(other, { at: 20 })),
    }).toStrictEqual({
      again: [],
      history: [],
      looking: [],
      message: [],
      older: [],
      ours: [],
      read: [],
    });
  });

  it("never notifies twice of a step a reset replays", () => {
    const event = changed(11, { items: [highlight(other)] });
    const first = reduceTimelines(state, event);

    const libera = Schema.decodeSync(NetworkEntry)({
      _tag: "Live",
      life: 1,
      network: "libera",
      status: { _tag: "Running" },
    });

    // A projection folded again resets the stream to 10, and everything is read again.
    const reloaded = [
      { _tag: "Reset", reset: Schema.decodeSync(TimelineReset)({ through: 10, version: 1 }) },
      { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
      { _tag: "NetworksRead", entries: [libera] },
      {
        _tag: "ReadStarted",
        read: { _tag: "List", after: undefined, attempt: 0, network: libera.network },
      },
      {
        _tag: "ListRead",
        after: undefined,
        network: libera.network,
        page: Schema.decodeSync(TimelineList)({
          more: false,
          projection: { _tag: "Running" },
          through: 10,
          timelines,
          version: 1,
        }),
      },
    ] satisfies TimelinesEvent[];

    let after = first;

    for (const one of reloaded) {
      after = reduceTimelines(after, one);
    }

    const replayed = reduceTimelines(after, event);

    expect({
      first: notificationsOf(state, first, event.change, seeing).length,
      replayed: notificationsOf(after, replayed, event.change, seeing).length,
      // The replay was taken, as the stream moved past it again.
      taken: followFrom(after)?.sequence === 10 && followFrom(replayed)?.sequence === 11,
    }).toStrictEqual({ first: 1, replayed: 0, taken: true });
  });

  it("says where and what, in plain isolated text, tagged by Timeline, the latest only", () => {
    const event = changed(11, {
      items: [
        highlight(other, { kind: "Action", sender: "‮evil", text: "\u0002waves\u0002\u0007" }),
        said({ at: 51, level: "Highlight", sequence: 11, text: "again", timeline: other }),
        said({ at: 52, level: "Direct", sequence: 11, timeline: peer }),
      ],
    });

    const [first, second] = notificationsOf(
      state,
      reduceTimelines(state, event),
      event.change,
      seeing
    );

    const action = changed(12, {
      items: [
        highlight(other, {
          kind: "Action",
          sender: "‮evil",
          sequence: 12,
          text: "\u0002waves\u0002\u0007",
        }),
      ],
    });

    const [acted] = notificationsOf(state, reduceTimelines(state, action), action.change, seeing);

    expect({ acted: acted?.body, first, second: second?.tag }).toStrictEqual({
      acted: "* ⁨evil⁩ ⁨waves⁩",
      first: {
        body: "<⁨peer⁩> ⁨again⁩",
        network: "libera",
        tag: `iirc:${other}`,
        timeline: other,
        title: "⁨#other⁩ · libera",
      },
      second: `iirc:${peer}`,
    });
  });
});

/**
 * A Channel with a Message unread, up to 40.
 * @param id - Its id.
 * @param name - Its name.
 * @returns It, as the list gives it.
 */
const unreadIn = (id: string, name: string) =>
  described({ id, latest: 40, name, read: 10, unread: { messages: 1 } });

/**
 * One Message, at 40.
 * @param timeline - Its Timeline.
 * @returns It.
 */
const saidAt40 = (timeline: string) => [said({ at: 40, sequence: 3, timeline })];

/**
 * The state, zoomed.
 * @param state - The state.
 * @returns It, zoomed.
 */
const zoomed = (state: Timelines) =>
  reduceTimelines(state, { _tag: "Pane", change: { _tag: "Zoom" } });

/**
 * Which Timelines a Highlight in `#iirc` notifies of.
 * @param before - The state.
 * @param page - The page.
 * @returns The Timelines.
 */
const notifiedOfIirc = (before: Timelines, page: Page) => {
  const event = changed(11, {
    items: [said({ at: 50, level: "Highlight", sequence: 11, text: "iirc: hi" })],
  });

  return notificationsOf(before, reduceTimelines(before, event), event.change, page).map(
    (one) => one.timeline
  );
};

/**
 * `#iirc` open in a first Pane, seen at its latest, and `#other` split beside it, focused,
 * read and seen at its latest too.
 * @returns The state.
 */
const twoPanes = (): Timelines => {
  const first = world([unreadIn(iirc, "#iirc"), unreadIn(other, "#other")], iirc, saidAt40(iirc));

  const split = reduceTimelines(first, {
    _tag: "Pane",
    change: { _tag: "Split", axis: "Horizontal", timeline: timelineId(other) },
  });

  const read = {
    _tag: "Latest",
    attempt: 0,
    generation: split.nextGeneration,
    limit: 1000,
    timeline: timelineId(other),
  } as const;

  const steps: TimelinesEvent[] = [
    { _tag: "ReadStarted", read },
    {
      _tag: "WindowRead",
      read,
      window: Schema.decodeSync(TimelineWindow)({
        earlier: false,
        gaps: [],
        items: saidAt40(other),
        later: false,
        network: "libera",
        through: 10,
        timeline: other,
        version: 1,
      }),
    },
  ];

  let state = split;

  for (const event of steps) {
    state = reduceTimelines(state, event);
  }

  return shownToLatest(state);
};

describe("several Panes", () => {
  it("marks the focused Pane's Timeline first, and the other Pane's once it is read", () => {
    const state = twoPanes();
    const first = markDue(state, seeing, "latest");

    // Once the Daemon's marker for `#other` comes back, the other Pane's is due.
    const marked = reduceTimelines(
      state,
      changed(11, {
        timelines: [{ ...unreadIn(other, "#other"), changed: 11, read: 40, unread: nothing }],
      })
    );

    expect({
      first: first?.timeline,
      next: markDue(marked, seeing, "latest")?.timeline,
    }).toStrictEqual({
      first: other,
      next: iirc,
    });
  });

  it("marks only the focused Pane's while zoomed or on a compact screen, where the other is not seen", () => {
    const marked = reduceTimelines(
      twoPanes(),
      changed(11, {
        timelines: [{ ...unreadIn(other, "#other"), changed: 11, read: 40, unread: nothing }],
      })
    );

    expect({
      compact: markDue(marked, { ...seeing, compact: true }, "latest"),
      zoomed: markDue(zoomed(marked), seeing, "latest"),
    }).toStrictEqual({ compact: undefined, zoomed: undefined });
  });

  it("notifies of neither Pane's Timeline while both are seen, and of the hidden one when zoomed", () => {
    const state = twoPanes();

    expect({
      compact: notifiedOfIirc(state, { ...seeing, compact: true }),
      seen: notifiedOfIirc(state, seeing),
      zoomed: notifiedOfIirc(zoomed(state), seeing),
    }).toStrictEqual({ compact: [iirc], seen: [], zoomed: [iirc] });
  });
});
