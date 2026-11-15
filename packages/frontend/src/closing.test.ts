import { NetworkId, Timeline } from "@iirc/api";
import { NetworkConfiguration } from "@iirc/client/configuration";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { closeOf, initialLeaving, leaveOf, reduceLeaving } from "./closing.ts";
import type { Leaving, LeavingEvent } from "./closing.ts";
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
    unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
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
    ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
    login: { _tag: "None" },
    nicks: ["dean"],
    realname: "Dean",
    username: "dean",
  });

const rfc: Naming = { casemapping: "rfc1459", chantypes: "#" };

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
});

describe("the offer to leave a Channel instead", () => {
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

  it("leaves a Channel the Configuration wants by the edit, saved with other case or not, and one it does not by parting it", () => {
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
