import { NetworkId, TimelineId } from "@iirc/api";
import type { Member, Timeline, TimelineChangesEvent, TimelineItem } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { mainOf, openOf } from "@iirc/frontend/timelines";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { composerState, edit, perform, recall, send } from "../composer/atoms.ts";
import { chantypesState } from "../composer/chantypes-state.ts";
import { completionState } from "../composer/completion-state.ts";
import { chantypesSync, completer, tab, typed } from "../composer/completion.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import type { FakeChannel } from "../testing/fake-daemon.ts";
import { open, openTimeline, sync, timelinesState } from "../timelines/atoms.ts";
import type { WaitTimes } from "../timelines/atoms.ts";
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

const none = { activity: 0, direct: 0, highlights: 0, messages: 0 };

const listed = (
  id: string,
  name: string,
  kind: "Network" | "Channel" | "Direct"
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  id,
  key: kind === "Network" ? null : name.toLowerCase(),
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: none,
});

const said = (sequence: number, sender: string): typeof TimelineItem.Encoded => ({
  changed: sequence,
  content: {
    _tag: "Message",
    at: { _tag: "Unknown" },
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours: null,
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
  data: JSON.stringify({ gaps: [], items, merged: [], sequence, timelines: [] }),
  event: "changed",
  id: `1.${sequence}`,
});

const member = (
  nick: string,
  prefixes: readonly string[] = [],
  away = false
): typeof Member.Encoded => ({
  away: { _tag: "Known", at: 1, from: "ircd", value: away ? { message: "out" } : null },
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
 * @param more - Waits other than the tests', whether the head's reads are held, and more
 * Timelines.
 * @returns The fake and the registry.
 */
const inChannel = async (
  members: readonly (typeof Member.Encoded)[],
  more: {
    readonly waits?: Partial<WaitTimes>;
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
      chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
      chantypes: "#&",
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

  const registry = registryFor(fake.fetch, more.waits);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(channelSync);
  registry.mount(completer);
  await eventually(() => fake.daemon.followers.length === 1);
  fake.daemon.holdChannels = more.holdHead ?? false;
  registry.set(open, timelineId(iirc));
  await until(registry, openTimeline, (shown) => shown._tag === "Shown");

  return { ...fake, registry };
};

/**
 * Waits a while, for what should not happen to have its chance.
 * @param millis - How long.
 */
const wait = async (millis: number) => {
  await Effect.runPromise(Effect.sleep(`${millis} millis`));
};

describe("the header", () => {
  it("reads the open Channel's head, and again once, after a moment, when Activity there may change it", async () => {
    const { daemon, registry, send } = await inChannel([member("op", ["o"]), member("peer")]);

    const first = await until(
      registry,
      timelineHeader("p0"),
      (header) => header?._tag === "Channel" && header.members === 2
    );

    const reads = daemon.channelsRead.length;

    // A Message changes nothing the head shows.
    send(changed(3, [said(3, "peer")]));
    await wait(80);
    const afterMessage = daemon.channelsRead.length;

    // The topic is set, then someone joins at once: one read, after the second.
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

    await wait(80);

    expect({
      after:
        after?._tag === "Channel" && after.topic._tag === "Set"
          ? [after.members, after.topic.by, after.topic.at, after.modes]
          : after,
      afterMessage: afterMessage - reads,
      first: first?._tag === "Channel" ? first.topic._tag : first,
      reads,
      reread: daemon.channelsRead.length - reads,
    }).toStrictEqual({
      after: [3, "op", 2000, "+n"],
      afterMessage: 0,
      first: "None",
      reads: 1,
      reread: 1,
    });
  });

  it("reads no head for a Direct Message, and says the Network's connection for its own", async () => {
    const { daemon, registry } = await inChannel([]);

    await until(registry, timelineHeader("p0"), (header) => header?._tag === "Channel");
    const reads = daemon.channelsRead.length;

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

    await wait(50);

    expect({ direct, network, reads: daemon.channelsRead.length - reads }).toStrictEqual({
      direct: { _tag: "Direct", name: "peer", note: undefined, timeline: peer },
      network: { _tag: "Network", name: "libera", status: "connected", timeline: own },
      reads: 0,
    });
  });
});

describe("the members", () => {
  it("are read only once /members shows them, a page at a time as the Owner scrolls, and again on Activity", async () => {
    const many = Array.from({ length: 130 }, (_, index) =>
      member(`user${String(index).padStart(3, "0")}`, index === 0 ? ["o"] : [], index === 1)
    );

    const { daemon, registry, send } = await inChannel(many);

    await until(registry, timelineHeader("p0"), (header) => header?._tag === "Channel");
    await wait(50);
    const hidden = daemon.membersRead.length;

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
      hidden,
      queries: daemon.membersRead.map((query) => new URLSearchParams(query).get("limit")),
      rows: rows.slice(0, 2).map((row) => [row.symbol, row.away, row.label]),
      second: new URLSearchParams(daemon.membersRead[1]).has("after"),
      shown: registry.get(membersShown),
      total: all._tag === "Listed" ? all.count : undefined,
    }).toStrictEqual({
      first: [100, true],
      hidden: 0,
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

describe("/query", () => {
  it("opens the Direct Message with a nick, or one not yet begun when nothing was said yet", async () => {
    const { registry } = await inChannel([]);

    registry.set(edit, { text: "/query PEER", timeline: timelineId(iirc) });
    await run(registry, send, timelineId(iirc));
    const opened = await until(registry, timelinesState, (state) => openOf(state) === peer);

    await until(
      registry,
      openTimeline,
      (shown) => shown._tag === "Shown" && shown.timeline === peer
    );
    registry.set(edit, { text: "/query stranger", timeline: timelineId(peer) });
    await run(registry, send, timelineId(peer));

    const drafted = await until(
      registry,
      timelinesState,
      (state) => mainOf(state)._tag === "DirectDraft"
    );

    expect({
      draft: draftOf(registry.get(composerState), timelineId(peer)).text,
      main: mainOf(drafted),
      opened: openOf(opened),
    }).toStrictEqual({
      draft: "",
      main: {
        _tag: "DirectDraft",
        back: { _tag: "Timeline" },
        declared: null,
        network: "libera",
        nick: "stranger",
      },
      opened: peer,
    });
  });
});

describe("completing a nick", () => {
  it("asks the members route by prefix once, after a moment, however often Tab is pressed, and puts the nick in with `: `", async () => {
    const { daemon, registry } = await inChannel([
      member("op", ["o"]),
      member("pat"),
      member("peer"),
    ]);

    const place = timelineId(iirc);

    registry.set(typed, { text: "p", timeline: place });
    registry.set(tab, { backwards: false, caret: 1, place, text: "p" });
    registry.set(tab, { backwards: false, caret: 1, place, text: "p" });

    await until(registry, completionState, (state) => state.phase._tag === "Cycling");

    const first = draftOf(registry.get(composerState), place).text;
    const asked = daemon.membersRead.map((query) => new URLSearchParams(query).get("prefix"));

    registry.set(tab, { backwards: false, caret: first.length, place, text: first });
    const second = draftOf(registry.get(composerState), place).text;

    expect({ asked, first, second }).toStrictEqual({
      asked: ["p"],
      // `pat` spoke in the window, so comes first.
      first: "pat: ",
      second: "peer: ",
    });
  });

  it("asks only for the latest word when a Tab supersedes another before the Daemon is asked", async () => {
    const { daemon, registry } = await inChannel([member("pat"), member("zed")]);
    const place = timelineId(iirc);

    registry.set(typed, { text: "p", timeline: place });
    registry.set(tab, { backwards: false, caret: 1, place, text: "p" });
    registry.set(typed, { text: "z", timeline: place });
    registry.set(tab, { backwards: false, caret: 1, place, text: "z" });

    await until(registry, completionState, (state) => state.phase._tag === "Cycling");
    await wait(50);

    expect({
      asked: daemon.membersRead.map((query) => new URLSearchParams(query).get("prefix")),
      draft: draftOf(registry.get(composerState), place).text,
    }).toStrictEqual({ asked: ["z"], draft: "zed: " });
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

describe("an answer for a draft no longer shown", () => {
  it("puts in nothing when the Owner recalled what was sent before the nicks came", async () => {
    const { daemon, registry } = await inChannel([member("peer")]);
    const place = timelineId(iirc);

    registry.set(edit, { text: "said before", timeline: place });
    await run(registry, send, place);

    daemon.holdMembers = true;
    registry.set(typed, { text: "pe", timeline: place });
    registry.set(tab, { backwards: false, caret: 2, place, text: "pe" });
    await eventually(() => daemon.held.members.length === 1);

    registry.set(recall, { direction: "Older", timeline: place });
    release(daemon.held.members);
    await wait(50);

    expect({
      draft: draftOf(registry.get(composerState), place).text,
      phase: registry.get(completionState).phase._tag,
    }).toStrictEqual({ draft: "said before", phase: "Idle" });
  });

  it("puts in nothing when the Owner sent the draft before the nicks came", async () => {
    const { daemon, registry } = await inChannel([member("peer")]);
    const place = timelineId(iirc);

    daemon.holdMembers = true;
    registry.set(typed, { text: "pe", timeline: place });
    registry.set(tab, { backwards: false, caret: 2, place, text: "pe" });
    await eventually(() => daemon.held.members.length === 1);

    await run(registry, send, place);
    release(daemon.held.members);
    await wait(50);

    expect({
      draft: draftOf(registry.get(composerState), place).text,
      said: daemon.says.map((one) => one.text),
    }).toStrictEqual({ draft: "", said: ["pe"] });
  });
});

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

  it("lets go of a /query once the Owner opened another Timeline while it waited", async () => {
    const { daemon, registry } = await inChannel([]);
    const place = timelineId(iirc);

    daemon.holdKnown = true;
    registry.set(edit, { text: "/query peer", timeline: place });
    registry.set(send, place);
    await eventually(() => daemon.held.known.length === 1);

    registry.set(open, timelineId(own));
    release(daemon.held.known);
    await wait(50);

    expect(openOf(registry.get(timelinesState))).toBe(own);
  });
});

describe("re-reading under sustained Activity", () => {
  it(
    "reads the head again about once a second while Activity comes every 200 ms, and once more after",
    { timeout: 10_000 },
    async () => {
      const {
        daemon,
        registry,
        send: sendEvent,
      } = await inChannel([member("op")], {
        waits: { debounce: "250 millis", interval: "1 second" },
      });

      await until(
        registry,
        timelineHeader("p0"),
        (header) => header?._tag === "Channel" && header.members === 1
      );
      const reads = daemon.channelsRead.length;

      for (let index = 0; index < 16; index += 1) {
        sendEvent(
          changed(3 + index, [
            activity(3 + index, { _tag: "Joined", channel: "#iirc", nick: `n${index}` }),
          ])
        );
        // oxlint-disable-next-line no-await-in-loop -- Activity, every 200 ms
        await wait(200);
      }

      const during = daemon.channelsRead.length - reads;

      await wait(1300);

      const after = daemon.channelsRead.length - reads;

      expect({ after: after - during, during: during >= 2 && during <= 4 }).toStrictEqual({
        after: 1,
        during: true,
      });
    }
  );

  it(
    "lets a slow first read finish under Activity, then reads again",
    { timeout: 10_000 },
    async () => {
      const {
        daemon,
        registry,
        send: sendEvent,
      } = await inChannel([member("op")], {
        holdHead: true,
        waits: { debounce: "250 millis", interval: "1 second" },
      });

      await eventually(() => daemon.held.channel.length === 1);

      for (let index = 0; index < 5; index += 1) {
        sendEvent(
          changed(3 + index, [
            activity(3 + index, { _tag: "Joined", channel: "#iirc", nick: `n${index}` }),
          ])
        );
        // oxlint-disable-next-line no-await-in-loop -- Activity, every 200 ms
        await wait(200);
      }

      const asked = daemon.held.channel.length;

      daemon.holdChannels = false;
      release(daemon.held.channel);
      await until(
        registry,
        timelineHeader("p0"),
        (header) => header?._tag === "Channel" && header.members === 1
      );
      await eventually(() => daemon.channelsRead.length === 2);

      expect({ asked, reads: daemon.channelsRead.length }).toStrictEqual({ asked: 1, reads: 2 });
    }
  );
});

describe("completing by the Network's CHANTYPES", () => {
  it("completes a word as a nick when the Network no longer says its first character starts a Channel", async () => {
    const { daemon, registry } = await inChannel([member("[bob]")], {
      timelines: [listed(idOf(7), "[old", "Channel")],
    });

    daemon.known.set("libera", { chantypes: "#", declared: null });
    registry.mount(chantypesSync);
    await until(registry, chantypesState, (held) => held.get(timelineNetwork) !== undefined);

    const place = timelineId(iirc);

    registry.set(typed, { text: "[b", timeline: place });
    registry.set(tab, { backwards: false, caret: 2, place, text: "[b" });
    await until(registry, completionState, (state) => state.phase._tag === "Cycling");

    expect(draftOf(registry.get(composerState), place).text).toBe("[bob]: ");
  });

  it("reads again, as completion needs it, a CHANTYPES the Session had not said yet", async () => {
    const { daemon, registry } = await inChannel([], {
      timelines: [listed(idOf(8), "[bar", "Channel")],
    });

    const place = timelineId(iirc);

    // Read before the Ircd's 005: none said yet, which is not kept.
    daemon.known.set("libera", { chantypes: null, declared: null });
    registry.mount(chantypesSync);
    await wait(50);
    const provisional = registry.get(chantypesState).get(timelineNetwork);

    // Later in the same Session, the Ircd said `[` starts a Channel's name too.
    daemon.known.set("libera", { chantypes: "#[", declared: null });
    registry.set(typed, { text: "[b", timeline: place });
    registry.set(tab, { backwards: false, caret: 2, place, text: "[b" });
    await until(registry, chantypesState, (held) => held.get(timelineNetwork) !== undefined);
    await until(registry, completionState, (state) => state.phase._tag !== "Asking");

    registry.set(tab, { backwards: false, caret: 2, place, text: "[b" });

    expect({
      draft: draftOf(registry.get(composerState), place).text,
      kept: registry.get(chantypesState).get(timelineNetwork)?.chantypes,
      provisional,
    }).toStrictEqual({ draft: "[bar ", kept: "#[", provisional: undefined });
  });
});
