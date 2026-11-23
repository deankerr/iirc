/**
 * A Timeline marked by its id, by a Change no Client steps: folded as a Client's Read
 * Marker or close is, for a Timeline the directory holds, and told to the store by its id
 * for one it does not, a detached one or a removed Network's.
 */
import { Instant, MessageId } from "@iirc/client";
import type { Marked, News, Where } from "@iirc/client";
import { describe, expect, it } from "vitest";

import type { Change } from "./change.ts";
import { emptyDirectory, step, stepMarking } from "./fold.ts";
import type { Directory, Happened, Marking } from "./fold.ts";
import { timelineIdOf } from "./timeline.ts";
import type { TimelineId } from "./timeline.ts";

const t0 = Instant.make(1_762_560_000_000);
const later = (ms: number) => Instant.make(t0 + ms);

const channel = (name: string, key = name.toLowerCase()): Marked => ({
  _tag: "Channel",
  key,
  name,
});

const direct = (name: string): Marked => ({
  _tag: "Direct",
  existing: false,
  key: name.toLowerCase(),
  name,
});

const message = (where: readonly Where[]): News => ({
  _tag: "Message",
  answers: undefined,
  at: { _tag: "Known", at: t0, from: "ircd", value: t0 },
  bot: false,
  context: undefined,
  highlight: false,
  id: { _tag: "Known", at: t0, from: "ircd", value: MessageId.make(`m${where.length}`) },
  kind: "Privmsg",
  live: true,
  nicks: [],
  ours: undefined,
  prefix: undefined,
  self: false,
  sender: "peer",
  tags: new Map(),
  target: "#iirc",
  text: "hi",
  where,
});

const happened = (sequence: number, news: readonly News[]): Happened => ({
  at: t0,
  life: 1,
  network: "libera",
  news,
  sequence,
});

const read = (sequence: number, timeline: TimelineId, at: Instant): Marking => ({
  _tag: "TimelineRead",
  network: "libera",
  read: at,
  sequence,
  timeline,
});

const close = (sequence: number, timeline: TimelineId): Marking => ({
  _tag: "TimelineClosed",
  network: "libera",
  sequence,
  timeline,
});

/**
 * Folds steps and markings in order, as the projector does.
 * @param each - Each step or marking.
 * @returns The directory after the last, and every change, in order.
 */
const fold = (each: readonly (Happened | Marking)[]) => {
  let directory: Directory = emptyDirectory;
  const changes: Change[] = [];

  for (const one of each) {
    const stepped = "news" in one ? step(directory, one) : stepMarking(directory, one);

    ({ directory } = stepped);
    changes.push(...stepped.changes);
  }

  return { changes, directory };
};

const marks = (changes: readonly Change[], from = 0) =>
  changes.flatMap((change) =>
    change.sequence > from && (change._tag === "ReadMarker" || change._tag === "Closed")
      ? [[change._tag, change.timeline, change._tag === "ReadMarker" ? change.read : undefined]]
      : []
  );

const own = timelineIdOf(1, 0, 0);
const iirc = timelineIdOf(1, 0, 1);

describe("a Timeline marked read by its id", () => {
  it("moves a Read Marker the directory holds only forward, alike with a Client's", () => {
    const { changes, directory } = fold([
      happened(1, [message([channel("#iirc")])]),
      read(2, iirc, later(5)),
      read(3, iirc, later(3)),
      read(4, own, later(2)),
      read(5, own, later(2)),
      // A Client's Read Marker behind the one set by id moves nothing.
      happened(6, [{ _tag: "ReadMarker", read: later(4), where: channel("#iirc") }]),
      read(7, iirc, later(9)),
    ]);

    expect(marks(changes)).toStrictEqual([
      ["ReadMarker", iirc, later(5)],
      ["ReadMarker", own, later(2)],
      ["ReadMarker", iirc, later(9)],
    ]);
    expect(directory.networks.get("libera")?.keyed.get(iirc)?.read).toBe(later(9));
    expect(directory.networks.get("libera")?.read).toBe(later(2));
  });

  it("of the Timeline a merge kept is judged against the later of the two", () => {
    const kept = timelineIdOf(1, 0, 1);

    const { changes } = fold([
      happened(1, [message([channel("#a[", "#a[")]), message([channel("#a{", "#a{")])]),
      happened(2, [
        { _tag: "ReadMarker", read: later(1), where: channel("#a[", "#a[") },
        { _tag: "ReadMarker", read: later(9), where: channel("#a{", "#a{") },
      ]),
      happened(3, [{ _tag: "Refolded", casemapping: "rfc1459" }]),
      read(4, kept, later(5)),
      read(5, kept, later(10)),
    ]);

    expect(marks(changes, 3)).toStrictEqual([["ReadMarker", kept, later(10)]]);
  });

  it("is told to the store by id for a Timeline the directory no longer holds", () => {
    const peer = timelineIdOf(1, 0, 1);

    const { changes, directory } = fold([
      happened(1, [message([direct("peer")]), message([direct("Peer2")])]),
      // `peer` becomes `Peer2`, so the Timeline `Peer2` had is detached.
      happened(2, [
        {
          _tag: "Activity",
          activity: { _tag: "NickChanged", from: "peer", to: "Peer2" },
          at: { _tag: "Known", at: t0, from: "ircd", value: t0 },
          id: { _tag: "Unknown" },
          live: true,
          where: [
            {
              _tag: "DirectRenamed",
              key: "peer",
              name: "peer",
              to: { key: "peer2", name: "Peer2" },
            },
          ],
        },
      ]),
      read(3, timelineIdOf(1, 1, 1), later(5)),
      read(4, timelineIdOf(1, 1, 1), later(3)),
    ]);

    // Its Read Marker is the store's to hold, which moves it only forward.
    expect(marks(changes, 2)).toStrictEqual([
      ["ReadMarker", timelineIdOf(1, 1, 1), later(5)],
      ["ReadMarker", timelineIdOf(1, 1, 1), later(3)],
    ]);
    expect(directory.networks.get("libera")?.keyed.has(peer)).toBeTruthy();
  });

  it("is told to the store by id for a removed Network's kept Timelines, and opens nothing", () => {
    const { changes, directory } = fold([
      happened(1, [message([channel("#iirc")])]),
      happened(2, [{ _tag: "NetworkRemoved", keep: true }]),
      read(3, iirc, later(5)),
      read(4, own, later(5)),
    ]);

    expect(changes.filter(({ sequence }) => sequence > 2)).toStrictEqual([
      { _tag: "ReadMarker", network: "libera", read: later(5), sequence: 3, timeline: iirc },
      { _tag: "ReadMarker", network: "libera", read: later(5), sequence: 4, timeline: own },
    ]);
    expect(directory.networks.has("libera")).toBeFalsy();
  });
});

describe("a Timeline closed by its id", () => {
  it("is closed as a Client's close closes it, but never the Network's own", () => {
    const { changes, directory } = fold([
      happened(1, [message([channel("#iirc")])]),
      close(2, iirc),
      close(3, own),
    ]);

    expect(marks(changes)).toStrictEqual([["Closed", iirc, undefined]]);
    expect(directory.networks.get("libera")?.last.sequence).toBe(1);
  });

  it("is told to the store by id for a removed Network's, never its own, and opens nothing", () => {
    const { changes } = fold([
      happened(1, [message([channel("#iirc")])]),
      happened(2, [{ _tag: "NetworkRemoved", keep: true }]),
      close(3, iirc),
      close(4, own),
    ]);

    expect(changes.filter(({ sequence }) => sequence > 2)).toStrictEqual([
      { _tag: "Closed", network: "libera", sequence: 3, timeline: iirc },
    ]);
  });
});
