import { Knowledge, NetworkId, Timeline } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { closeOf, initialLeaving, isJoined, leaveOf, reduceLeaving } from "./closing.ts";
import type { Leaving, LeavingEvent } from "./closing.ts";

const libera = Schema.decodeSync(NetworkId)("libera");

const timelineOf = (
  kind: "Network" | "Channel" | "Direct",
  name: string,
  more: Partial<typeof Timeline.Encoded> = {}
) =>
  Schema.decodeSync(Timeline)({
    changed: 1,
    closed: false,
    detached: false,
    head: null,
    id: "00000000000002-00000000-00000000",
    key: kind === "Network" ? null : name.toLowerCase(),
    kind,
    latest: null,
    life: 1,
    name,
    network: "libera",
    read: null,
    removed: false,
    unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
    ...more,
  });

const known = (
  casemapping: "ascii" | "rfc1459",
  channels: readonly (readonly [string, "Joined" | "Kicked" | "Wanted"])[]
) =>
  Schema.decodeSync(Knowledge)({
    casemapping,
    channels: channels.map(([name, standing]) => ({
      key: name.toLowerCase(),
      members: [],
      modes: { _tag: "Unknown" },
      name,
      standing,
      topic: { _tag: "Unknown" },
      wanted: true,
    })),
    chantypes: "#",
    declared: casemapping,
    life: 1,
    self: null,
    session: { _tag: "Offline", since: null },
    users: [],
  });

const folded = (events: readonly LeavingEvent[], from: Leaving = initialLeaving) => {
  let state = from;

  for (const event of events) {
    state = reduceLeaving(state, event);
  }

  return state;
};

const offered: LeavingEvent = { _tag: "Offered", channel: "#iirc", network: libera };

describe("closing a Timeline", () => {
  it("closes a Channel's or a Direct Message's from its row, by its Target, and never a Network's own", () => {
    expect({
      channel: closeOf(timelineOf("Channel", "#iirc")),
      detached: closeOf(timelineOf("Direct", "peer", { detached: true, key: null })),
      direct: closeOf(timelineOf("Direct", "peer")),
      network: closeOf(timelineOf("Network", "libera")),
      removed: closeOf(timelineOf("Channel", "#iirc", { removed: true })),
    }).toStrictEqual({
      channel: { _tag: "CloseTimeline", network: libera, target: "#iirc" },
      detached: undefined,
      direct: { _tag: "CloseTimeline", network: libera, target: "peer" },
      network: undefined,
      removed: undefined,
    });
  });

  it("finds a Channel Self is in by its name as the Connection folds it, and only one joined", () => {
    const held = known("rfc1459", [
      ["#iirc{a}", "Joined"],
      ["#gone", "Kicked"],
      ["#later", "Wanted"],
    ]);

    expect({
      folded: isJoined(held, "#IIRC[A]"),
      kicked: isJoined(held, "#gone"),
      nick: isJoined(held, "peer"),
      notHeld: isJoined(held, "#other"),
      wanted: isJoined(held, "#later"),
    }).toStrictEqual({
      folded: true,
      kicked: false,
      nick: false,
      notHeld: false,
      wanted: false,
    });
  });
});

describe("the offer to leave a Channel instead", () => {
  it("offers to leave it, and leaves it as `/part` with its name does, once", () => {
    const asked = folded([offered]);
    const sent = folded([{ _tag: "Sent" }], asked);

    expect({
      // An edit in flight is sent once, and holds the offer until it is answered.
      again: leaveOf(sent),
      asked: leaveOf(asked),
      dismissed: folded([{ _tag: "Dismissed" }], sent)._tag,
      left: folded([{ _tag: "Answered", failure: undefined }], sent),
    }).toStrictEqual({
      again: undefined,
      asked: { edit: { _tag: "Part", channels: ["#iirc"] }, network: libera },
      dismissed: "Offered",
      left: initialLeaving,
    });
  });

  it("says why leaving failed, and can be tried again or let go", () => {
    const failed = folded([offered, { _tag: "Sent" }, { _tag: "Answered", failure: "No." }]);

    expect({
      dismissed: folded([{ _tag: "Dismissed" }], failed),
      failed,
      retried: folded([{ _tag: "Sent" }], failed),
    }).toStrictEqual({
      dismissed: initialLeaving,
      failed: {
        _tag: "Offered",
        channel: "#iirc",
        failure: "No.",
        network: libera,
        sending: false,
      },
      retried: {
        _tag: "Offered",
        channel: "#iirc",
        failure: undefined,
        network: libera,
        sending: true,
      },
    });
  });

  it("ignores an answer to nothing sent, and changes nothing sent with nothing offered", () => {
    expect([
      folded([{ _tag: "Answered", failure: undefined }]),
      folded([{ _tag: "Sent" }]),
      folded([offered, { _tag: "Answered", failure: "No." }]),
    ]).toStrictEqual([
      initialLeaving,
      initialLeaving,
      { _tag: "Offered", channel: "#iirc", failure: undefined, network: libera, sending: false },
    ]);
  });
});
