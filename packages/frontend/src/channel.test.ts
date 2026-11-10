import type { TimelineItem, Timeline } from "@iirc/api";
import {
  ChannelHeader,
  MemberPage,
  NetworkEntry,
  NetworkId,
  SessionKnowledge,
  TimelineChange,
  TimelineId,
  TimelineList,
  TimelineOverflow,
  TimelineWindow,
} from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  channelReads,
  headerOf,
  initialChannel,
  memberRow,
  openChannel,
  queried,
  reduceChannel,
  refreshDelay,
  rosterOf,
  touches,
} from "./channel.ts";
import type { Channel, ChannelEvent, ChannelRead, OpenChannel } from "./channel.ts";
import { formatted } from "./render.ts";
import { initialTimelines, reduceTimelines } from "./timelines.ts";
import type { Timelines, TimelinesEvent } from "./timelines.ts";

// Wire forms, parsed as the API parses them.

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const timelineId = Schema.decodeSync(TimelineId);
const network = Schema.decodeSync(NetworkId)("libera");
const decodeChange = Schema.decodeSync(TimelineChange);
const decodeHeader = Schema.decodeSync(ChannelHeader);
const decodePage = Schema.decodeSync(MemberPage);
const decodeOverflow = Schema.decodeSync(TimelineOverflow);

const overflow = (timelines: readonly string[] | null) =>
  decodeOverflow({ sequence: 11, timelines: timelines === null ? null : [...timelines] });

const own = idOf(1);
const iirc = idOf(2);
const other = idOf(3);
const peer = idOf(4);
const bob = idOf(5);

const nothing = { activity: 0, direct: 0, highlights: 0, messages: 0 };

const described = (
  id: string,
  name: string,
  kind: "Network" | "Channel" | "Direct" = "Channel",
  key: string | null = kind === "Network" ? null : name.toLowerCase(),
  detached = false
): typeof Timeline.Encoded => ({
  changed: 1,
  detached,
  id,
  key,
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: nothing,
});

const timelines = [
  described(own, "libera", "Network"),
  described(iirc, "#iirc"),
  described(other, "#other"),
  described(peer, "peer", "Direct"),
  described(bob, "{bob}", "Direct", "{bob}"),
];

const said = (sequence: number, sender: string, ours = false): typeof TimelineItem.Encoded => ({
  changed: sequence,
  content: {
    _tag: "Message",
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours: ours ? { delivery: { _tag: "Unconfirmed" }, intent: "web-1" } : null,
    sender,
    tags: [],
    target: "#iirc",
    text: "hi",
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: iirc,
});

const joined = (sequence: number, timeline = iirc): typeof TimelineItem.Encoded => ({
  changed: sequence,
  content: {
    _tag: "Activity",
    activity: { _tag: "Joined", channel: "#iirc", nick: "newcomer" },
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    live: true,
  },
  level: "Activity",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline,
});

/**
 * Timelines following the stream from step 10, with libera's Timelines listed, connected
 * as `iirc`, and `open` opened and read with `items`.
 * @param open - The Timeline opened, if any.
 * @param items - Its items.
 * @returns The state.
 */
const world = (
  open: string | undefined,
  items: readonly (typeof TimelineItem.Encoded)[] = []
): Timelines => {
  const libera = Schema.decodeSync(NetworkEntry)({
    network: "libera",
    status: { _tag: "Running" },
  });

  const list = { _tag: "List", after: undefined, attempt: 0, network } as const;
  const status = { _tag: "Status", attempt: 0, network } as const;

  const events: TimelinesEvent[] = [
    { _tag: "ReadStarted", read: { _tag: "Networks", attempt: 0 } },
    { _tag: "NetworksRead", entries: [libera] },
    { _tag: "ReadStarted", read: list },
    {
      _tag: "ListRead",
      after: undefined,
      network,
      page: Schema.decodeSync(TimelineList)({
        more: false,
        projection: { _tag: "Running" },
        through: 10,
        timelines: [...timelines],
        version: 1,
      }),
    },
    { _tag: "ReadStarted", read: status },
    { _tag: "Requesting", read: status },
    {
      _tag: "StatusRead",
      network,
      session: Schema.decodeSync(SessionKnowledge)({
        _tag: "Registered",
        ircd: "ircd.test",
        since: 1,
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

  return state;
};

const header = (
  standing: (typeof ChannelHeader.Encoded)["standing"],
  topic?: (typeof ChannelHeader.Encoded)["topic"]
) =>
  decodeHeader({
    members: 3,
    modes: {
      _tag: "Known",
      at: 1,
      from: "ircd",
      value: [
        { mode: "n", param: null },
        { mode: "t", param: null },
        { mode: "l", param: "50" },
      ],
    },
    name: "#iirc",
    network: "libera",
    ranks: [
      { mode: "o", symbol: "@" },
      { mode: "v", symbol: "+" },
    ],
    standing,
    timeline: iirc,
    topic: topic ?? { _tag: "Unknown" },
  });

const member = (
  nick: string,
  prefixes: readonly string[],
  away = false
): (typeof MemberPage.Encoded)["members"][number] => ({
  away: { _tag: "Known", at: 1, from: "ircd", value: away ? { message: "lunch" } : null },
  nick,
  prefixes: { _tag: "Known", at: 1, from: "ircd", value: [...prefixes] },
});

const page = (
  members: readonly (typeof MemberPage.Encoded)["members"][number][],
  next: string | null = null
) =>
  decodePage({
    members: [...members],
    more: next !== null,
    network: "libera",
    next,
    timeline: iirc,
  });

const channelOf = (events: readonly ChannelEvent[], from: Channel = initialChannel): Channel => {
  let state = from;

  for (const event of events) {
    state = reduceChannel(state, event);
  }

  return state;
};

const inIirc: OpenChannel = { network, timeline: timelineId(iirc) };

/**
 * Takes on every read wanted, as the runtime does.
 * @param state - The state.
 * @param members - Whether the members show.
 * @returns The reads, and the state with them taken on.
 */
const takeOn = (state: Channel, members = true) => {
  const reads = channelReads(state, inIirc, members);

  return {
    reads,
    state: channelOf(
      reads.map((read): ChannelEvent => ({ _tag: "ReadStarted", at: 0, read })),
      state
    ),
  };
};

const head = (
  read: ChannelRead | undefined,
  standing: Parameters<typeof header>[0] = "Joined",
  generation = 0
) =>
  read === undefined
    ? []
    : [{ _tag: "HeadRead", generation, header: header(standing), read } satisfies ChannelEvent];

/**
 * The open Channel read: its head, and its first page of members.
 * @returns The state, and the read of the members.
 */
const settled = () => {
  const first = takeOn(initialChannel);
  const [headRead, membersRead] = first.reads;

  return {
    membersRead,
    state: channelOf(
      [
        ...head(headRead),
        ...(membersRead === undefined
          ? []
          : [
              {
                _tag: "MembersRead",
                generation: 0,
                page: page([member("op", ["o"]), member("peer", [])], "1.cGVlcg"),
                read: membersRead,
              } satisfies ChannelEvent,
            ]),
      ],
      first.state
    ),
  };
};

const changed = (change: Partial<typeof TimelineChange.Encoded>): ChannelEvent => ({
  _tag: "Changed",
  change: decodeChange({ gaps: [], items: [], merged: [], sequence: 11, timelines: [], ...change }),
});

const tags = (reads: readonly ChannelRead[]) =>
  reads.map((read) => ({
    after: read._tag === "Members" ? read.after : undefined,
    tag: read._tag,
    wait: read.wait,
  }));

describe("the open Channel", () => {
  it("is the open Timeline when its Network lists it as a Channel's, and the options are not shown", () => {
    const options = reduceTimelines(world(iirc), { _tag: "OptionsShown", filter: "" });

    expect({
      channel: openChannel(world(iirc)),
      direct: openChannel(world(peer)),
      network: openChannel(world(own)),
      none: openChannel(world(undefined)),
      options: openChannel(options),
    }).toStrictEqual({
      channel: inIirc,
      direct: undefined,
      network: undefined,
      none: undefined,
      options: undefined,
    });
  });

  it("reads its head, and its members while they show, each once", () => {
    const hidden = takeOn(initialChannel, false);
    const shown = takeOn(initialChannel);

    expect({
      again: channelReads(shown.state, inIirc, true),
      hidden: tags(hidden.reads),
      none: channelReads(initialChannel, undefined, true),
      shown: tags(shown.reads),
    }).toStrictEqual({
      again: [],
      hidden: [{ after: undefined, tag: "Head", wait: false }],
      none: [],
      shown: [
        { after: undefined, tag: "Head", wait: false },
        { after: undefined, tag: "Members", wait: false },
      ],
    });
  });

  it("reads both again, after a moment, when a change may have changed the Channel", () => {
    const { state } = settled();
    const item = (one: typeof TimelineItem.Encoded) => changed({ items: [one] });

    const gap = changed({
      gaps: [{ changed: 11, from: cursor(11_000, 11), network: "libera", to: null }],
    });

    const again = (event: ChannelEvent) =>
      tags(channelReads(reduceChannel(state, event), inIirc, true)).map((read) => read.tag);

    expect({
      elsewhere: again(item(joined(11, other))),
      gap: again(gap),
      joined: again(item(joined(11))),
      message: again(item(said(11, "peer"))),
      overflow: again({
        _tag: "Overflowed",
        overflow: overflow([iirc]),
      }),
      overflowElsewhere: again({
        _tag: "Overflowed",
        overflow: overflow([other]),
      }),
      overflowEverything: again({
        _tag: "Overflowed",
        overflow: overflow(null),
      }),
      reset: again({ _tag: "Reset" }),
      waits: tags(channelReads(reduceChannel(state, item(joined(11))), inIirc, true)).map(
        (read) => read.wait
      ),
    }).toStrictEqual({
      elsewhere: [],
      gap: ["Head", "Members"],
      joined: ["Head", "Members"],
      message: [],
      overflow: ["Head", "Members"],
      overflowElsewhere: [],
      overflowEverything: ["Head", "Members"],
      reset: ["Head", "Members"],
      waits: [true, true],
    });
  });

  it("never supersedes a read in flight: a change meanwhile leaves it dirty, and the next read follows it", () => {
    const { state } = settled();
    const touched = reduceChannel(state, changed({ items: [joined(11)] }));
    const first = takeOn(touched);
    const [headRead] = first.reads;
    const later = reduceChannel(first.state, changed({ items: [joined(12)] }));
    const taken = channelOf(head(headRead, "Kicked", 1), later);
    const older = channelOf(head(headRead, "Wanted", 0), taken);

    expect({
      during: channelReads(later, inIirc, true),
      older: older.head.header?.standing,
      taken: taken.head.header?.standing,
      wanted: tags(channelReads(taken, inIirc, false)),
    }).toStrictEqual({
      during: [],
      // An answer asked before what is held is not taken over it.
      older: "Kicked",
      taken: "Kicked",
      wanted: [{ after: undefined, tag: "Head", wait: true }],
    });
  });

  it("waits the debounce after quiet, and no sooner than an interval after the last read while changes keep coming", () => {
    const { state } = settled();
    const timing = { debounce: 250, interval: 1000 };

    const at = (startedAt: number | undefined) => ({
      ...state,
      head: { ...state.head, startedAt },
    });

    const again: ChannelRead = { _tag: "Head", network, timeline: timelineId(iirc), wait: true };

    expect({
      busy: refreshDelay(at(1000), again, 1100, timing),
      first: refreshDelay(at(1000), { ...again, wait: false }, 1100, timing),
      never: refreshDelay(at(undefined), again, 1100, timing),
      quiet: refreshDelay(at(1000), again, 5000, timing),
    }).toStrictEqual({ busy: 900, first: 0, never: 250, quiet: 250 });
  });

  it("asks for the members after those held as the Owner scrolls, and joins the page to them", () => {
    const { state } = settled();
    const wanting = reduceChannel(state, { _tag: "MoreWanted", timeline: timelineId(iirc) });
    const more = takeOn(wanting);
    const [read] = more.reads;

    const joinedPage = channelOf(
      read === undefined
        ? []
        : [{ _tag: "MembersRead", generation: 0, page: page([member("zed", [])]), read }],
      more.state
    );

    // A page after a place the list no longer ends at merges nothing, and is asked again.
    const misplaced = channelOf(
      read?._tag === "Members"
        ? [
            {
              _tag: "MembersRead",
              generation: 0,
              page: page([member("zed", [])]),
              read: {
                ...read,
                after: Schema.decodeSync(MemberPage.fields.next)("0.b3A") ?? undefined,
              },
            },
          ]
        : [],
      more.state
    );

    expect({
      joined: joinedPage.roster.members.map((one) => one.nick),
      misplaced: misplaced.roster.members.map((one) => one.nick),
      more: joinedPage.roster.more,
      reads: tags(more.reads).map((one) => [one.tag, one.after?.key]),
      untouched: channelReads(state, inIirc, true),
    }).toStrictEqual({
      joined: ["op", "peer", "zed"],
      misplaced: ["op", "peer"],
      more: false,
      reads: [["Members", "peer"]],
      untouched: [],
    });
  });

  it("reads again as many members as it held, up to a page's most", () => {
    const { state } = settled();

    const many = {
      ...state,
      roster: {
        ...state.roster,
        members: Array.from({ length: 350 }, () => state.roster.members).flat(),
      },
    };

    const [, members] = channelReads(reduceChannel(many, { _tag: "Reset" }), inIirc, true);

    expect(members?._tag === "Members" ? members.limit : undefined).toBe(500);
  });

  it("starts afresh for another Channel opened", () => {
    const { state } = settled();
    const inOther: OpenChannel = { network, timeline: timelineId(other) };
    const [read] = channelReads(state, inOther, false);

    const after = channelOf(
      read === undefined ? [] : [{ _tag: "ReadStarted", at: 0, read }],
      state
    );

    expect({
      held: after.timeline,
      members: after.roster.members,
      read: read === undefined ? undefined : [read._tag, read.timeline, read.wait],
    }).toStrictEqual({
      held: other,
      members: [],
      read: ["Head", other, false],
    });
  });
});

/**
 * The open Channel with its head read, as given.
 * @param standing - Where Self stands.
 * @param topic - Its topic.
 * @returns The state.
 */
const withHead = (standing: Parameters<typeof header>[0], topic?: Parameters<typeof header>[1]) => {
  const first = takeOn(initialChannel, false);
  const [read] = first.reads;

  return channelOf(
    read === undefined
      ? []
      : [{ _tag: "HeadRead", generation: 0, header: header(standing, topic), read }],
    first.state
  );
};

/**
 * The header of `#iirc` with its head read, as Self stands with it.
 * @param standing - Where Self stands.
 * @returns Its note, members, and topic.
 */
const standingShown = (standing: Parameters<typeof header>[0]) => {
  const one = headerOf(world(iirc), withHead(standing));

  return one?._tag === "Channel" ? [one.note, one.members, one.topic._tag] : one;
};

/**
 * Whether a change touches `#iirc`.
 * @param change - The change.
 * @returns Whether it does.
 */
const touchesIirc = (change: Partial<typeof TimelineChange.Encoded>) =>
  touches(
    decodeChange({ gaps: [], items: [], merged: [], sequence: 11, timelines: [], ...change }),
    timelineId(iirc),
    network
  );

describe("the header", () => {
  it("shows a Channel's topic, formatted, who set it and when, its modes, and how many are in it", () => {
    const topic = {
      _tag: "Known",
      at: 1,
      from: "ircd",
      value: { setAt: 5000, setBy: "op", text: "\u0002welcome\u0002 https://iirc.test" },
    } as const;

    expect(headerOf(world(iirc), withHead("Joined", topic))).toStrictEqual({
      _tag: "Channel",
      members: 3,
      modes: "+ntl 50",
      name: "#iirc",
      note: undefined,
      timeline: iirc,
      topic: {
        _tag: "Set",
        at: 5000,
        by: "op",
        inlines: formatted("\u0002welcome\u0002 https://iirc.test"),
        stale: false,
      },
    });
  });

  it("says where Self stands when not in the Channel, and shows no members or topic then", () => {
    expect({
      gone: standingShown(null),
      joining: standingShown("Joining"),
      kicked: standingShown("Kicked"),
      refused: standingShown("Refused"),
      wanted: standingShown("Wanted"),
    }).toStrictEqual({
      gone: ["not in this Channel — /join to rejoin", undefined, "Unknown"],
      joining: ["joining…", undefined, "Unknown"],
      kicked: ["kicked from this Channel, which is joined again", undefined, "Unknown"],
      refused: [
        "not in this Channel: the Ircd refused the join, which is tried again",
        undefined,
        "Unknown",
      ],
      wanted: [
        "not in this Channel yet: it is joined once the Network is connected",
        undefined,
        "Unknown",
      ],
    });
  });

  it("shows a topic none set, and a topic as last known", () => {
    const none = headerOf(
      world(iirc),
      withHead("Joined", { _tag: "Known", at: 1, from: "ircd", value: null })
    );

    const stale = headerOf(
      world(iirc),
      withHead("Joined", {
        _tag: "Stale",
        since: 1,
        was: { setAt: null, setBy: null, text: "old" },
      })
    );

    expect({
      none: none?._tag === "Channel" ? none.topic : undefined,
      stale: stale?._tag === "Channel" ? stale.topic : undefined,
    }).toStrictEqual({
      none: { _tag: "None" },
      stale: { _tag: "Set", at: undefined, by: undefined, inlines: formatted("old"), stale: true },
    });
  });

  it("shows the Channel's name alone before its head is read, and a simpler header elsewhere", () => {
    expect({
      direct: headerOf(world(peer), initialChannel),
      network: headerOf(world(own), initialChannel),
      unread: headerOf(world(iirc), initialChannel),
    }).toStrictEqual({
      direct: { _tag: "Direct", name: "peer", note: undefined, timeline: peer },
      network: { _tag: "Network", name: "libera", status: "connected", timeline: own },
      unread: {
        _tag: "Channel",
        members: undefined,
        modes: undefined,
        name: "#iirc",
        note: undefined,
        timeline: iirc,
        topic: { _tag: "Unknown" },
      },
    });
  });
});

describe("the members", () => {
  it("shows each with the symbol of their highest rank, away dimmed, and says both in words", () => {
    const { ranks } = header("Joined");

    const decoded = page([
      member("op", ["o", "v"]),
      member("voiced", ["v"], true),
      member("plain", []),
    ]).members;

    expect(
      decoded.map((one) => {
        const row = memberRow(one, ranks);

        return [row.symbol, row.away, row.label];
      })
    ).toStrictEqual([
      ["@", false, "op, operator"],
      ["+", true, "voiced, voice, away"],
      [undefined, false, "plain"],
    ]);
  });

  it("lists them in the order read, with how many in all, and nothing while none is open", () => {
    const { state } = settled();
    const listed = rosterOf(world(iirc), state);

    expect({
      listed:
        listed._tag === "Listed"
          ? [listed.count, listed.more, listed.rows.map((row) => row.nick)]
          : listed,
      none: rosterOf(world(peer), state),
      reading: rosterOf(world(iirc), initialChannel)._tag,
    }).toStrictEqual({
      listed: [3, true, ["op", "peer"]],
      none: { _tag: "None" },
      reading: "Reading",
    });
  });

  it("says Self is not in the Channel when the members route says so", () => {
    const first = takeOn(initialChannel);
    const [, read] = first.reads;

    const out = channelOf(
      read === undefined ? [] : [{ _tag: "NotInChannel", generation: 0, read, standing: "Kicked" }],
      first.state
    );

    expect(rosterOf(world(iirc), out)).toStrictEqual({
      _tag: "Out",
      note: "kicked from this Channel, which is joined again",
      timeline: iirc,
    });
  });
});

describe("touching", () => {
  it("is an Activity in the Channel's Timeline, or a Gap of its Network", () => {
    expect({
      activity: touchesIirc({ items: [joined(11)] }),
      elsewhere: touchesIirc({ items: [joined(11, other)] }),
      gap: touchesIirc({
        gaps: [{ changed: 11, from: cursor(1, 11), network: "libera", to: null }],
      }),
      message: touchesIirc({ items: [said(11, "peer")] }),
      otherGap: touchesIirc({
        gaps: [{ changed: 11, from: cursor(1, 11), network: "oftc", to: null }],
      }),
    }).toStrictEqual({
      activity: true,
      elsewhere: false,
      gap: true,
      message: false,
      otherGap: false,
    });
  });
});

describe("/query", () => {
  it("opens the Timeline the name keys, as the Network folds names, or starts /msg to say the first Message", () => {
    const state = world(undefined);

    expect({
      ascii: queried(state, network, "[BOB]", "ascii"),
      folded: queried(state, network, "[BOB]", undefined),
      found: queried(state, network, "PEER", undefined),
      missing: queried(state, network, "stranger", undefined),
    }).toStrictEqual({
      ascii: [{ _tag: "FocusComposer", text: "/msg [BOB] " }],
      folded: [{ _tag: "Open", timeline: bob }],
      found: [{ _tag: "Open", timeline: peer }],
      missing: [{ _tag: "FocusComposer", text: "/msg stranger " }],
    });
  });
});
