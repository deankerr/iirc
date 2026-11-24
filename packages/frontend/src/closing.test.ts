import { NetworkId, Timeline } from "@iirc/api";
import { NetworkConfiguration } from "@iirc/client/configuration";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  closeOf,
  closingShown,
  initialClosing,
  initialLeaving,
  leaveOf,
  reduceClosing,
  reduceLeaving,
} from "./closing.ts";
import type { ClosingEvent, Leaving, LeavingEvent } from "./closing.ts";
import type { Naming } from "./options.ts";

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
    unread: { activity: 0, botDirect: 0, botMessages: 0, direct: 0, highlights: 0, messages: 0 },
    ...more,
  });

const folded = (events: readonly LeavingEvent[], from: Leaving = initialLeaving) => {
  let state = from;

  for (const event of events) {
    state = reduceLeaving(state, event);
  }

  return state;
};

const configurationOf = (...channels: readonly string[]) =>
  Schema.decodeSync(NetworkConfiguration)({
    answerCtcp: true,
    channels: channels.map((name) => ({ name })),
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    login: { _tag: "None" },
    nicks: ["dean"],
    realname: "Dean",
    servers: [{ host: "irc.libera.chat", port: 6697, tls: true }],
    username: "dean",
    whoOnJoin: true,
  });

const rfc: Naming = { casemapping: "rfc1459", chantypes: "#" };

const offered: LeavingEvent = { _tag: "Offered", channel: "#iirc", network: libera };

const closedById = (timeline: Timeline) => closeOf(timeline)?.timeline;

describe("closing a conversation", () => {
  it("closes a channel or a direct message from its row, by its id, whatever names it, and never a network's own", () => {
    const idOf = timelineOf("Channel", "#iirc").id;

    expect({
      channel: closeOf(timelineOf("Channel", "#iirc")),
      // No Target names a detached Direct Message, and no Client holds what a removed Network kept.
      detached: closedById(timelineOf("Direct", "peer", { detached: true, key: null })),
      direct: closeOf(timelineOf("Direct", "peer")),
      network: closeOf(timelineOf("Network", "libera")),
      removedChannel: closedById(timelineOf("Channel", "#iirc", { removed: true })),
      removedDirect: closedById(timelineOf("Direct", "peer", { removed: true })),
    }).toStrictEqual({
      channel: { _tag: "CloseTimeline", network: libera, timeline: idOf },
      detached: idOf,
      direct: { _tag: "CloseTimeline", network: libera, timeline: idOf },
      network: undefined,
      removedChannel: idOf,
      removedDirect: idOf,
    });
  });
});

describe("the offer to leave a channel instead", () => {
  it("offers to leave it, and leaves it as `/part` with its name does, once", () => {
    const asked = folded([offered]);
    const sent = folded([{ _tag: "Sent" }], asked);
    const saved = configurationOf("#iirc");

    expect({
      // An edit in flight is sent once, and holds the offer until it is answered.
      again: leaveOf(sent, saved, rfc),
      asked: leaveOf(asked, saved, rfc),
      dismissed: folded([{ _tag: "Dismissed" }], sent)._tag,
      left: folded([{ _tag: "Answered", failure: undefined }], sent),
    }).toStrictEqual({
      again: undefined,
      asked: { _tag: "Configure", edit: { _tag: "Part", channels: ["#iirc"] }, network: libera },
      dismissed: "Offered",
      left: initialLeaving,
    });
  });

  it("leaves a channel the settings wants by the edit, saved with other case or not, and one it does not by parting it", () => {
    const asked = folded([{ _tag: "Offered", channel: "#[Iirc]", network: libera }]);

    const edit = {
      _tag: "Configure",
      edit: { _tag: "Part", channels: ["#[Iirc]"] },
      network: libera,
    };

    expect({
      // Folded as the Network folds them: `[` and `{` are one letter in rfc1459.
      folded: leaveOf(asked, configurationOf("#{iirc}"), rfc),
      // While no casemapping is known, names are compared exactly.
      inexact: leaveOf(asked, configurationOf("#{iirc}"), {
        casemapping: undefined,
        chantypes: "#",
      })?._tag,
      none: leaveOf(asked, configurationOf(), rfc),
      other: leaveOf(asked, configurationOf("#other"), rfc),
      same: leaveOf(asked, configurationOf("#[Iirc]"), rfc),
    }).toStrictEqual({
      folded: edit,
      inexact: "Act",
      none: {
        _tag: "Act",
        action: { _tag: "Part", channel: "#[Iirc]", reason: null },
        network: libera,
      },
      other: {
        _tag: "Act",
        action: { _tag: "Part", channel: "#[Iirc]", reason: null },
        network: libera,
      },
      same: edit,
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

const channel = timelineOf("Channel", "#iirc");

const heldWith = (timeline: Timeline) =>
  new Map([[libera, { timelines: new Map([[timeline.id, timeline]]) }]]);

const closes = (events: readonly ClosingEvent[]) => {
  let state = initialClosing;

  for (const event of events) {
    state = reduceClosing(state, event);
  }

  return state;
};

describe("a close on its way", () => {
  it("shows its conversation closed from when it is asked until the stream says it is, once answered closed", () => {
    const asked = closes([{ _tag: "Asked", network: libera, timeline: channel.id }]);
    const answered = reduceClosing(asked, { _tag: "Answered", ask: 0, closedAt: 5 });

    expect({
      answered: [...closingShown(answered, heldWith(channel))],
      asked: [...closingShown(asked, heldWith(channel))],
      said: [
        ...closingShown(
          answered,
          heldWith(timelineOf("Channel", "#iirc", { changed: 5, closed: true }))
        ),
      ],
    }).toStrictEqual({ answered: [channel.id], asked: [channel.id], said: [] });
  });

  it("shows its conversation again once it is refused or failed", () => {
    const refused = closes([
      { _tag: "Asked", network: libera, timeline: channel.id },
      { _tag: "Answered", ask: 0, closedAt: undefined },
    ]);

    expect([...closingShown(refused, heldWith(channel))]).toStrictEqual([]);
  });
});
