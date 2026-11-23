import { NetworkId, TimelineId } from "@iirc/api";
import type { Member, Timeline, TimelineChangesEvent, TimelineItem } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { openOf } from "@iirc/frontend/timelines";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { edit, perform, send } from "../composer/atoms.ts";
import { chantypesState } from "../composer/chantypes-state.ts";
import { completionState } from "../composer/completion-state.ts";
import { chantypesSync, completer, tab, typed } from "../composer/completion.ts";
import { composerState } from "../composer/composer-state.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import type { FakeChannel } from "../testing/fake-daemon.ts";
import { open, openTimeline, sync, timelinesState } from "../timelines/atoms.ts";
import { channelSync, moreMembers, roster, timelineHeader } from "./atoms.ts";
import { membersShown } from "./state.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;
const timelineId = Schema.decodeSync(TimelineId);
const timelineNetwork = Schema.decodeSync(NetworkId)("libera");

const own = idOf(1);
const iirc = idOf(2);
const peer = idOf(4);
const squareBob = idOf(5);
const curlyBob = idOf(6);

const none = { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 };

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel" | "Direct"
): typeof Timeline.Encoded => ({
  changed: 1,
  closed: false,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name.toLowerCase(),
  kind,
  latest: null,
  life: 1,
  name,
  network: "libera",
  read: null,
  removed: false,
  unread: none,
});

const said = (sequence: number, sender: string): typeof TimelineItem.Encoded => ({
  answered: null,
  changed: sequence,
  content: {
    _tag: "Message",
    answers: null,
    at: { _tag: "Unknown" },
    bot: false,
    context: null,
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    nicks: [],
    ours: null,
    prefix: null,
    sender,
    tags: [],
    target: "#iirc",
    text: `line ${sequence}`,
  },
  level: "Message",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: iirc,
});

const activity = (
  sequence: number,
  what: Extract<(typeof TimelineItem.Encoded)["content"], { _tag: "Activity" }>["activity"]
): typeof TimelineItem.Encoded => ({
  answered: null,
  changed: sequence,
  content: {
    _tag: "Activity",
    activity: what,
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    live: true,
  },
  level: "Activity",
  network: "libera",
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline: iirc,
});

const changed = (
  sequence: number,
  items: readonly (typeof TimelineItem.Encoded)[]
): typeof TimelineChangesEvent.Encoded => ({
  data: JSON.stringify({
    dropped: [],
    gaps: [],
    items,
    merged: [],
    removals: [],
    sequence,
    timelines: [],
  }),
  event: "changed",
  id: `1.${sequence}`,
});

const member = (
  nick: string,
  prefixes: readonly string[] = [],
  away = false
): typeof Member.Encoded => ({
  account: { _tag: "Unknown" },
  away: { _tag: "Known", at: 1, from: "ircd", value: away ? { message: "out" } : null },
  bot: { _tag: "Unknown" },
  nick,
  prefixes: { _tag: "Known", at: 1, from: "ircd", value: [...prefixes] },
});

const topicSetTo = (text: string): FakeChannel["header"]["topic"] => ({
  _tag: "Known",
  at: 1,
  from: "ircd",
  value: { setAt: 2000, setBy: "op", text },
});

/**
 * A Daemon with libera's own Timeline, `#iirc` with its Channel, and a Direct Message with
 * `peer`, and a browser signed in to it, following the Timelines and reading the open
 * Channel, with `#iirc` open.
 * @param members - The Channel's members, in rank order.
 * @param more - Whether the head's reads are held, and more Timelines.
 * @returns The fake and the registry.
 */
const inChannel = async (
  members: readonly (typeof Member.Encoded)[],
  more: {
    readonly holdHead?: boolean;
    readonly timelines?: readonly (typeof Timeline.Encoded)[];
  } = {}
) => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.through = 2;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: listed(own, "libera", "Network") },
    {
      gaps: [],
      items: [said(1, "zed"), said(2, "pat")],
      timeline: listed(iirc, "#iirc", "Channel"),
    },
    { gaps: [], items: [], timeline: listed(peer, "peer", "Direct") },
    ...(more.timelines ?? []).map((timeline) => ({ gaps: [], items: [], timeline })),
  ]);

  fake.daemon.channels.set(iirc, {
    header: {
      accountBan: null,
      chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
      chantypes: "#&",
      held: null,
      lists: { bans: "b", exceptions: "e", invitations: "I" },
      members: members.length,
      modes: { _tag: "Known", at: 1, from: "ircd", value: [{ mode: "n", param: null }] },
      name: "#iirc",
      network: "libera",
      ranks: [
        { mode: "o", symbol: "@" },
        { mode: "v", symbol: "+" },
      ],
      standing: "Joined",
      timeline: iirc,
      topic: { _tag: "Known", at: 1, from: "ircd", value: null },
    },
    members: [...members],
  });

  const registry = registryFor(fake.fetch);

  // Held from the first, since the head is read as soon as the Sidebar lists it.
  fake.daemon.holdChannels = more.holdHead ?? false;
  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(channelSync);
  registry.mount(completer);
  await eventually(() => fake.daemon.followers.length === 1);
  registry.set(open, timelineId(iirc));
  await until(registry, openTimeline, (shown) => shown._tag === "Shown");

  return { ...fake, registry };
};

describe("the header", () => {
  it("reads the open Channel's head, and again when Activity there may change it", async () => {
    const { daemon, registry, send } = await inChannel([member("op", ["o"]), member("peer")]);

    const first = await until(
      registry,
      timelineHeader("p0"),
      (header) => header?._tag === "Channel" && header.members === 2
    );

    const reads = daemon.channelsRead.length;

    // The topic is set, then someone joins at once.
    const held = daemon.channels.get(iirc);

    if (held !== undefined) {
      held.header = { ...held.header, members: 3, topic: topicSetTo("hello \u0002world") };
      held.members = [...held.members, member("newcomer")];
    }

    send(
      changed(4, [
        activity(4, {
          _tag: "TopicChanged",
          by: "op",
          channel: "#iirc",
          topic: { setAt: 2000, setBy: "op", text: "hello \u0002world" },
        }),
      ])
    );
    send(changed(5, [activity(5, { _tag: "Joined", channel: "#iirc", nick: "newcomer" })]));

    const after = await until(
      registry,
      timelineHeader("p0"),
      (header) => header?._tag === "Channel" && header.topic._tag === "Set"
    );

    expect({
      after:
        after?._tag === "Channel" && after.topic._tag === "Set"
          ? [after.members, after.topic.by, after.topic.at, after.modes]
          : after,
      first: first?._tag === "Channel" ? first.topic._tag : first,
      reads,
    }).toStrictEqual({
      after: [3, "op", 2000, "+n"],
      first: "None",
      reads: 1,
    });
  });

  it("names a Direct Message's partner, and says the Network's connection for its own", async () => {
    const { registry } = await inChannel([]);

    await until(registry, timelineHeader("p0"), (header) => header?._tag === "Channel");
    registry.set(open, timelineId(peer));

    const direct = await until(
      registry,
      timelineHeader("p0"),
      (header) => header?._tag === "Direct"
    );

    registry.set(open, timelineId(own));

    const network = await until(
      registry,
      timelineHeader("p0"),
      (header) => header?._tag === "Network"
    );

    expect({ direct, network }).toStrictEqual({
      direct: {
        _tag: "Direct",
        name: "peer",
        note: undefined,
        presence: "Unknown",
        timeline: peer,
      },
      network: { _tag: "Network", name: "libera", status: "connected", timeline: own },
    });
  });
});

describe("the members", () => {
  it("are read a page at a time as the Owner scrolls, and again on Activity", async () => {
    const many = Array.from({ length: 130 }, (_, index) =>
      member(`user${String(index).padStart(3, "0")}`, index === 0 ? ["o"] : [], index === 1)
    );

    const { daemon, registry, send } = await inChannel(many);

    await until(registry, timelineHeader("p0"), (header) => header?._tag === "Channel");
    registry.set(perform, [{ _tag: "ShowMembers", shown: undefined }]);
    const first = await until(registry, roster("p0"), (shown) => shown._tag === "Listed");

    registry.set(moreMembers, timelineId(idOf(2)));

    const all = await until(
      registry,
      roster("p0"),
      (shown) => shown._tag === "Listed" && shown.rows.length === 130
    );

    // Someone parts: the members are read again from the start, as many as were held.
    send(
      changed(3, [activity(3, { _tag: "Parted", channel: "#iirc", nick: "user129", reason: null })])
    );
    await eventually(() => daemon.membersRead.length === 3);

    const rows = first._tag === "Listed" ? first.rows : [];

    expect({
      first: [rows.length, first._tag === "Listed" ? first.more : undefined],
      queries: daemon.membersRead.map((query) => new URLSearchParams(query).get("limit")),
      rows: rows.slice(0, 2).map((row) => [row.symbol, row.away, row.label]),
      second: new URLSearchParams(daemon.membersRead[1]).has("after"),
      shown: registry.get(membersShown),
      total: all._tag === "Listed" ? all.count : undefined,
    }).toStrictEqual({
      first: [100, true],
      queries: ["100", "100", "130"],
      rows: [
        ["@", false, "user000, operator"],
        [undefined, true, "user001, away"],
      ],
      second: true,
      shown: true,
      total: 130,
    });
  });

  it("says Self is not in the Channel when the Daemon says so", async () => {
    const { daemon, registry, send } = await inChannel([member("op", ["o"])]);

    registry.set(perform, [{ _tag: "ShowMembers", shown: true }]);
    await until(registry, roster("p0"), (shown) => shown._tag === "Listed");

    // Self is kicked, which comes as Activity in the Channel's Timeline.
    const held = daemon.channels.get(iirc);

    if (held !== undefined) {
      held.header = { ...held.header, members: 0, standing: "Kicked" };
    }

    send(
      changed(3, [
        activity(3, { _tag: "Kicked", by: "op", channel: "#iirc", nick: "iirc", reason: null }),
      ])
    );

    const out = await until(registry, roster("p0"), (shown) => shown._tag === "Out");

    const header = await until(
      registry,
      timelineHeader("p0"),
      (shown) => shown?._tag === "Channel" && shown.note !== undefined
    );

    expect({
      note: header?._tag === "Channel" ? header.note : undefined,
      out,
    }).toStrictEqual({
      note: "kicked from this Channel, which is joined again",
      out: { _tag: "Out", note: "kicked from this Channel, which is joined again", timeline: iirc },
    });
  });
});

/**
 * Releases every read the fake holds of one kind.
 * @param held - The reads held.
 */
const release = (held: (() => void)[]) => {
  for (const one of held.splice(0)) {
    one();
  }
};

describe("/query and how the Network folds names", () => {
  const bobs = [listed(squareBob, "[bob]", "Direct"), listed(curlyBob, "{bob}", "Direct")];

  it("opens nothing, and says so, when how the Network folds names cannot be read", async () => {
    const { daemon, registry } = await inChannel([], { timelines: bobs });
    const place = timelineId(iirc);

    daemon.known.set("libera", { chantypes: "#", declared: "ascii" });
    daemon.knownDown = true;
    registry.set(edit, { text: "/query [BOB]", timeline: place });
    await run(registry, send, place);
    const failed = openOf(registry.get(timelinesState));
    const notice = draftOf(registry.get(composerState), place).notice?.message;

    daemon.knownDown = false;
    registry.set(edit, { text: "/query [BOB]", timeline: place });
    await run(registry, send, place);

    expect({
      failed,
      notice,
      opened: openOf(registry.get(timelinesState)),
    }).toStrictEqual({
      failed: iirc,
      notice:
        "The Daemon did not say how libera compares nicks, so /query [BOB] opened nothing, rather than risk another's Direct Message. Try again.",
      // Under ascii, `[BOB]` is `[bob]`, never `{bob}`.
      opened: squareBob,
    });
  });
});

describe("the heads of Channels the Sidebar lists", () => {
  it("ask for the open Channel's head while the others' hold, and each is read", async () => {
    const others = [7, 8, 9, 10].map((sequence) =>
      listed(idOf(sequence), `#c${sequence}`, "Channel")
    );

    const { daemon } = await inChannel([member("op")], { holdHead: true, timelines: others });
    const ours = daemon.channels.get(iirc);

    // Each is a Channel the Daemon reads, once its held reads are let go.
    for (const other of others) {
      if (ours !== undefined) {
        daemon.channels.set(other.id, {
          ...ours,
          header: { ...ours.header, name: other.name, timeline: timelineId(other.id) },
        });
      }
    }

    // The open Channel's read is asked though the heads before it hold every turn.
    await eventually(() => daemon.channelsAsked.includes(iirc));

    daemon.holdChannels = false;
    release(daemon.held.channel);
    await eventually(() => daemon.channelsRead.length === 5);

    expect(new Set(daemon.channelsRead).size).toBe(5);
  });
});

describe("completing by the Network's CHANTYPES", () => {
  it("completes a Channel's name by the CHANTYPES the Network said", async () => {
    const { daemon, registry } = await inChannel([], {
      timelines: [listed(idOf(8), "[bar", "Channel")],
    });

    const place = timelineId(iirc);

    // The Ircd said `[` starts a Channel's name too.
    daemon.known.set("libera", { chantypes: "#[", declared: null });
    registry.mount(chantypesSync);
    registry.set(typed, { text: "[b", timeline: place });
    registry.set(tab, { backwards: false, caret: 2, place, text: "[b" });
    await until(registry, chantypesState, (held) => held.get(timelineNetwork) !== undefined);
    await until(registry, completionState, (state) => state.phase._tag !== "Asking");

    registry.set(tab, { backwards: false, caret: 2, place, text: "[b" });

    expect({
      draft: draftOf(registry.get(composerState), place).text,
      kept: registry.get(chantypesState).get(timelineNetwork)?.chantypes,
    }).toStrictEqual({ draft: "[bar ", kept: "#[" });
  });
});
