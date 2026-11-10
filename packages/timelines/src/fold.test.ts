/**
 * The fold, rule by rule: where each News lands, what opens and moves a Timeline, and
 * what a store is told.
 */
import { Instant, IntentId, MessageId } from "@iirc/client";
import type { News, Where } from "@iirc/client";
import type { Fact } from "@iirc/client/known";
import { describe, expect, it } from "vitest";

import type { Change } from "./change.ts";
import { emptyDirectory, step } from "./fold.ts";
import type { Directory, Happened } from "./fold.ts";
import { timelineIdOf } from "./timeline.ts";

const t0 = Instant.make(1_762_560_000_000);
const later = (ms: number) => Instant.make(t0 + ms);

const known = <T>(value: T, at = t0): Fact<T> => ({ _tag: "Known", at, from: "ircd", value });

const unknown = { _tag: "Unknown" } as const;

const channel = (name: string, key = name.toLowerCase()): Where => ({ _tag: "Channel", key, name });

const direct = (name: string, existing = false): Where => ({
  _tag: "Direct",
  existing,
  key: name.toLowerCase(),
  name,
});

const network: Where = { _tag: "Network" };

const message = (
  where: readonly Where[],
  options: {
    readonly at?: Fact<Instant>;
    readonly id?: Fact<MessageId>;
    readonly text?: string;
    readonly ours?: { readonly intent: string; readonly echo: boolean };
  } = {}
): News => ({
  _tag: "Message",
  at: options.at ?? known(t0),
  id: options.id ?? unknown,
  kind: "Privmsg",
  live: true,
  ours:
    options.ours === undefined
      ? undefined
      : { echo: options.ours.echo, intent: IntentId.make(options.ours.intent) },
  sender: "peer",
  tags: new Map([["+draft/reply", "abc"]]),
  target: "#iirc",
  text: options.text ?? "hi",
  where,
});

const nickChanged = (where: readonly Where[]): News => ({
  _tag: "Activity",
  activity: { _tag: "NickChanged", from: "peer", to: "Peer2" },
  at: known(t0),
  id: unknown,
  live: true,
  where,
});

const happened = (sequence: number, news: readonly News[], at = t0): Happened => ({
  at,
  network: "libera",
  news,
  sequence,
});

/**
 * Folds steps in order.
 * @param steps - The steps.
 * @param from - The directory to start from.
 * @returns The directory after the last, and every change, in order.
 */
const fold = (steps: readonly Happened[], from: Directory = emptyDirectory) => {
  let directory = from;
  const changes: Change[] = [];

  for (const each of steps) {
    const stepped = step(directory, each);

    ({ directory } = stepped);
    changes.push(...stepped.changes);
  }

  return { changes, directory };
};

const ofTag = <T extends Change["_tag"]>(changes: readonly Change[], tag: T) =>
  changes.filter((change): change is Extract<Change, { readonly _tag: T }> => change._tag === tag);

const net = (directory: Directory) => {
  const found = directory.networks.get("libera");

  if (found === undefined) {
    throw new Error("no directory for libera");
  }

  return found;
};

describe("opening Timelines", () => {
  it("opens the Network's own on its first step, whatever that step holds", () => {
    const { changes, directory } = fold([
      happened(3, [{ _tag: "Ignored", reason: { _tag: "NotNow", input: "Opened" } }]),
    ]);

    expect(changes).toStrictEqual([
      {
        _tag: "Described",
        sequence: 3,
        timeline: {
          id: timelineIdOf(3, 0, 0),
          key: null,
          kind: "Network",
          name: "libera",
          network: "libera",
        },
      },
    ]);
    expect(net(directory).timeline).toBe("00000000000003-00000000-00000000");
  });

  it("opens a Channel's on its first News, by the step, the News, and the entry", () => {
    const { changes, directory } = fold([
      happened(1, [message([network])]),
      happened(5, [message([network]), message([channel("#a"), channel("#B")])]),
      happened(6, [message([channel("#b", "#b")])]),
    ]);

    const opened = ofTag(changes, "Described").map(({ timeline }) => timeline.id);

    expect(opened).toStrictEqual([
      timelineIdOf(1, 0, 0),
      timelineIdOf(5, 1, 1),
      timelineIdOf(5, 1, 2),
    ]);
    expect(ofTag(changes, "Added").map(({ timeline }) => timeline)).toStrictEqual([
      timelineIdOf(1, 0, 0),
      timelineIdOf(1, 0, 0),
      timelineIdOf(5, 1, 1),
      timelineIdOf(5, 1, 2),
      timelineIdOf(5, 1, 2),
    ]);
    expect([...net(directory).channels]).toStrictEqual([
      ["#a", timelineIdOf(5, 1, 1)],
      ["#b", timelineIdOf(5, 1, 2)],
    ]);
  });

  it("opens a Direct Message's unless the entry touches only one that exists", () => {
    const { changes } = fold([
      happened(1, [message([direct("peer", true)])]),
      happened(2, [message([direct("peer")])]),
      happened(3, [message([direct("Peer", true)])]),
    ]);

    expect(
      ofTag(changes, "Added").map(({ timeline, sequence }) => [sequence, timeline])
    ).toStrictEqual([
      [2, timelineIdOf(2, 0, 1)],
      [3, timelineIdOf(2, 0, 1)],
    ]);
  });

  it("places a News once in each Timeline, however often `where` names it", () => {
    const { changes } = fold([happened(1, [message([channel("#a"), channel("#a"), network])])]);

    expect(ofTag(changes, "Added")).toHaveLength(2);
  });
});

describe("items", () => {
  it("carry what a Frontend shows, at the time of their News", () => {
    const { changes } = fold([
      happened(
        4,
        [
          message([network], { at: known(later(-5000)), id: known(MessageId.make("m1")) }),
          message([network], { at: { _tag: "Stale", since: t0, was: later(7) } }),
          message([network], { at: unknown }),
        ],
        later(9)
      ),
    ]);

    const added = ofTag(changes, "Added");

    expect(added.map(({ position }) => position)).toStrictEqual([
      { at: later(-5000), n: 0, sequence: 4 },
      { at: later(7), n: 1, sequence: 4 },
      { at: later(9), n: 2, sequence: 4 },
    ]);
    expect(added.map(({ messageId }) => messageId)).toStrictEqual(["m1", undefined, undefined]);
    expect(added[0]?.content).toStrictEqual({
      _tag: "Message",
      at: known(later(-5000)),
      id: known("m1"),
      kind: "Privmsg",
      live: true,
      ours: undefined,
      sender: "peer",
      tags: [["+draft/reply", "abc"]],
      target: "#iirc",
      text: "hi",
    });
  });

  it("of ours wait for an echo only when the Ircd will give one", () => {
    const { changes } = fold([
      happened(1, [
        message([network], { ours: { echo: true, intent: "i1" } }),
        message([network], { ours: { echo: false, intent: "i2" } }),
      ]),
    ]);

    expect(
      ofTag(changes, "Added").map(({ content, intent }) => [
        intent,
        content._tag === "Message" ? content.ours?.delivery._tag : undefined,
      ])
    ).toStrictEqual([
      ["i1", "Pending"],
      ["i2", "Unconfirmed"],
    ]);
  });
});

describe("our Messages' fate", () => {
  it("is confirmed by the intent, with the Ircd's time, id, and text", () => {
    const { changes } = fold([
      happened(1, [message([network], { ours: { echo: true, intent: "i1" } })]),
      happened(2, [
        {
          _tag: "Confirmed",
          at: known(later(3)),
          id: known(MessageId.make("m9")),
          intent: IntentId.make("i1"),
          text: "hi!",
        },
      ]),
    ]);

    expect(ofTag(changes, "Confirmed")).toStrictEqual([
      {
        _tag: "Confirmed",
        at: known(later(3)),
        id: known("m9"),
        intent: "i1",
        messageId: "m9",
        network: "libera",
        sequence: 2,
        text: "hi!",
      },
    ]);
  });

  it("is Unsent only for a Refused Unsent, and nothing else changes anything", () => {
    const intent = IntentId.make("i1");

    const { changes } = fold([
      happened(1, [message([network])]),
      happened(2, [
        { _tag: "Refused", intent, reason: { _tag: "Unsent" } },
        { _tag: "Refused", intent, reason: { _tag: "Offline" } },
        { _tag: "Refused", intent, reason: { _tag: "Rejected", reply: "404" } },
        { _tag: "Ignored", reason: { _tag: "UnmatchedEcho" } },
      ]),
    ]);

    expect(changes.filter(({ sequence }) => sequence === 2)).toStrictEqual([
      { _tag: "Unsent", intent, network: "libera", sequence: 2 },
    ]);
  });
});

describe("a Direct Message partner's rename", () => {
  it("moves their Timeline to the new nick, which takes the item", () => {
    const { changes, directory } = fold([
      happened(1, [message([direct("peer")])]),
      happened(2, [
        nickChanged([
          channel("#a"),
          { _tag: "DirectRenamed", key: "peer", name: "peer", to: { key: "peer2", name: "Peer2" } },
        ]),
      ]),
      happened(3, [message([direct("Peer2")])]),
    ]);

    const peer = timelineIdOf(1, 0, 1);

    expect(ofTag(changes, "Described").at(-1)?.timeline).toStrictEqual({
      id: peer,
      key: "peer2",
      kind: "Direct",
      name: "Peer2",
      network: "libera",
    });
    expect(
      ofTag(changes, "Added")
        .filter(({ timeline }) => timeline === peer)
        .map(({ sequence }) => sequence)
    ).toStrictEqual([1, 2, 3]);
    expect([...net(directory).directs]).toStrictEqual([["peer2", peer]]);
  });

  it("touches nothing when no Timeline has the old nick", () => {
    const { changes } = fold([
      happened(1, [
        nickChanged([
          { _tag: "DirectRenamed", key: "peer", name: "peer", to: { key: "peer2", name: "Peer2" } },
        ]),
      ]),
    ]);

    expect(changes.map(({ _tag }) => _tag)).toStrictEqual(["Described"]);
  });

  it("detaches a Timeline the new nick already had", () => {
    const { changes, directory } = fold([
      happened(1, [message([direct("peer")]), message([direct("Peer2")])]),
      happened(2, [
        nickChanged([
          { _tag: "DirectRenamed", key: "peer", name: "peer", to: { key: "peer2", name: "Peer2" } },
        ]),
      ]),
      happened(3, [message([direct("Peer2")]), message([direct("peer")])]),
    ]);

    const peer = timelineIdOf(1, 0, 1);
    const other = timelineIdOf(1, 1, 1);

    expect(ofTag(changes, "Described").filter(({ sequence }) => sequence === 2)).toStrictEqual([
      {
        _tag: "Described",
        sequence: 2,
        timeline: { id: other, key: null, kind: "Direct", name: "Peer2", network: "libera" },
      },
      {
        _tag: "Described",
        sequence: 2,
        timeline: { id: peer, key: "peer2", kind: "Direct", name: "Peer2", network: "libera" },
      },
    ]);
    // The detached one receives nothing more, and the old nick starts afresh.
    expect(
      ofTag(changes, "Added")
        .filter(({ sequence }) => sequence === 3)
        .map(({ timeline }) => timeline)
    ).toStrictEqual([peer, timelineIdOf(3, 1, 1)]);
    expect(net(directory).keyed.has(other)).toBeFalsy();
  });

  it("renames in place when only the case changed", () => {
    const { changes } = fold([
      happened(1, [message([direct("peer")])]),
      happened(2, [
        nickChanged([
          { _tag: "DirectRenamed", key: "peer", name: "peer", to: { key: "peer", name: "PEER" } },
        ]),
      ]),
    ]);

    expect(ofTag(changes, "Described").at(-1)?.timeline.name).toBe("PEER");
    expect(
      ofTag(changes, "Described").filter(({ timeline }) => timeline.key === null)
    ).toHaveLength(1);
  });
});

describe("a new casemapping", () => {
  it("keys every Timeline again, and merges into the first opened where keys meet", () => {
    const { changes, directory } = fold([
      happened(1, [
        message([channel("#a[", "#a[")]),
        message([channel("#a{", "#a{")]),
        message([direct("x~")]),
      ]),
      happened(2, [{ _tag: "Refolded", casemapping: "rfc1459" }]),
      happened(3, [message([channel("#A[", "#a{")])]),
    ]);

    const first = timelineIdOf(1, 0, 1);
    const second = timelineIdOf(1, 1, 1);
    const nick = timelineIdOf(1, 2, 1);

    expect(changes.filter(({ sequence }) => sequence === 2)).toStrictEqual([
      {
        _tag: "Described",
        sequence: 2,
        timeline: { id: first, key: "#a{", kind: "Channel", name: "#a[", network: "libera" },
      },
      { _tag: "Merged", from: second, into: first, network: "libera", sequence: 2 },
      {
        _tag: "Described",
        sequence: 2,
        timeline: { id: nick, key: "x^", kind: "Direct", name: "x~", network: "libera" },
      },
    ]);
    expect(ofTag(changes, "Added").at(-1)?.timeline).toBe(first);
    expect([...net(directory).channels]).toStrictEqual([["#a{", first]]);
    expect([...net(directory).keyed.keys()]).toStrictEqual([first, nick]);
  });

  it("changes nothing when no key changes", () => {
    const { changes } = fold([
      happened(1, [message([channel("#a")])]),
      happened(2, [{ _tag: "Refolded", casemapping: "ascii" }]),
    ]);

    expect(changes.filter(({ sequence }) => sequence === 2)).toStrictEqual([]);
  });
});

const began = (at: Instant): News => ({ _tag: "SessionBegan", at, nick: "iirc" });

const ended = (at: Instant, restarted = false): News => ({
  _tag: "SessionEnded",
  at,
  reason: restarted ? { _tag: "Restarted" } : { _tag: "Silent" },
});

const failed = (at: Instant): News => ({
  _tag: "ConnectionFailed",
  at,
  reason: { _tag: "Closed", reason: "Refused" },
});

describe("Sessions and Gaps", () => {
  it("are items in the Network's Timeline", () => {
    const { changes } = fold([happened(1, [began(t0)]), happened(2, [ended(later(1))])]);

    expect(
      ofTag(changes, "Added").map(({ timeline, content }) => [timeline, content])
    ).toStrictEqual([
      [timelineIdOf(1, 0, 0), { _tag: "SessionBegan", at: t0, nick: "iirc" }],
      [timelineIdOf(1, 0, 0), { _tag: "SessionEnded", at: later(1), reason: { _tag: "Silent" } }],
    ]);
  });

  it("run from a Session's end, over failed Connections, to the next Session", () => {
    const { changes, directory } = fold([
      happened(1, [began(t0)]),
      happened(2, [ended(later(10))]),
      happened(3, [failed(later(20))]),
      happened(4, [failed(later(30))]),
      happened(5, [began(later(40))]),
      happened(6, [failed(later(50))]),
    ]);

    expect(ofTag(changes, "Gap")).toStrictEqual([
      {
        _tag: "Gap",
        from: { at: later(10), n: 0, sequence: 2 },
        network: "libera",
        sequence: 2,
        to: undefined,
      },
      {
        _tag: "Gap",
        from: { at: later(10), n: 0, sequence: 2 },
        network: "libera",
        sequence: 5,
        to: { at: later(40), n: 0, sequence: 5 },
      },
      {
        _tag: "Gap",
        from: { at: later(50), n: 0, sequence: 6 },
        network: "libera",
        sequence: 6,
        to: undefined,
      },
    ]);
    expect(net(directory).gap).toStrictEqual({ at: later(50), n: 0, sequence: 6 });
  });

  it("begin at the last step folded when a restart ends the Session", () => {
    const { changes } = fold([
      happened(1, [began(t0)], t0),
      happened(2, [message([network]), message([network])], later(5)),
      happened(9, [ended(later(60_000), true)], later(60_000)),
    ]);

    expect(ofTag(changes, "Gap")[0]?.from).toStrictEqual({ at: later(5), n: 1, sequence: 2 });
  });
});

describe("every change", () => {
  it("carries the sequence of its step", () => {
    const { changes } = fold([
      happened(7, [
        message([channel("#a"), direct("peer")]),
        { _tag: "Refolded", casemapping: "ascii" },
      ]),
    ]);

    expect(changes.every(({ sequence }) => sequence === 7)).toBeTruthy();
  });
});

describe("Networks", () => {
  it("are kept apart", () => {
    const { directory } = fold([
      happened(1, [message([channel("#a")])]),
      { ...happened(2, [message([channel("#a")])]), network: "oftc" },
    ]);

    expect([...directory.networks.keys()]).toStrictEqual(["libera", "oftc"]);
    expect(directory.networks.get("oftc")?.channels.get("#a")).toBe(timelineIdOf(2, 0, 1));
  });
});
