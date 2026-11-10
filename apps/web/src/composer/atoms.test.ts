import { NetworkId, TimelineId } from "@iirc/api";
import type { Timeline, TimelineChangesEvent } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { followFrom, openOf } from "@iirc/frontend/timelines";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { mainView, openOptions } from "../options/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import { open, openTimeline, sync, timelinesState } from "../timelines/atoms.ts";
import { composerState, confirmSend, edit, send, takeUp } from "./atoms.ts";

const hex = (value: number, digits: number) => value.toString(16).padStart(digits, "0");
const idOf = (sequence: number) => `${hex(sequence, 14)}-00000000-00000000`;
const channel = Schema.decodeSync(TimelineId)(idOf(2));

const describeTimeline = (
  id: string,
  name: string,
  kind: "Network" | "Channel" | "Direct",
  changed = 1
): typeof Timeline.Encoded => ({
  changed,
  detached: false,
  id,
  key: kind === "Network" ? null : name.toLowerCase(),
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

/**
 * A Daemon with one Network, connected, and `#iirc` open in a browser signed in to it.
 * @returns The fake, and the registry.
 */
const composing = async () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(idOf(1), "libera", "Network") },
    { gaps: [], items: [], timeline: describeTimeline(idOf(2), "#iirc", "Channel") },
  ]);

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  await eventually(() => fake.daemon.followers.length === 1);
  registry.set(open, channel);
  await until(registry, openTimeline, (shown) => shown._tag === "Shown");

  /**
   * Types text into `#iirc`'s composer and presses Enter.
   * @param text - What is typed.
   */
  const type = async (text: string) => {
    registry.set(edit, { text, timeline: channel });
    await run(registry, send, channel);
  };

  const notice = () => draftOf(registry.get(composerState), channel).notice;

  return { ...fake, notice, registry, type };
};

const said = (target: string, text: string, intent: string, kind = "Privmsg") => ({
  intent,
  kind,
  target,
  text,
});

const network = Schema.decodeSync(TimelineId)(idOf(1));

/**
 * The changes stream saying the projection folded through a step.
 * @param sequence - The step.
 * @returns The event.
 */
const foldedThrough = (sequence: number): typeof TimelineChangesEvent.Encoded => ({
  data: JSON.stringify({ gaps: [], items: [], merged: [], sequence, timelines: [] }),
  event: "changed",
  id: `1.${sequence}`,
});

/**
 * `#iirc` open, and two Direct Message Timelines whose names collide only under rfc1459,
 * as two Users on a Network with CASEMAPPING=ascii.
 * @returns The fake, and the registry.
 */
const placing = async () => {
  const composed = await composing();

  composed.daemon.timelines
    .get("libera")
    ?.push(
      { gaps: [], items: [], timeline: describeTimeline(idOf(3), "[bob]", "Direct") },
      { gaps: [], items: [], timeline: describeTimeline(idOf(4), "{bob}", "Direct") }
    );
  composed.send({
    data: JSON.stringify({
      gaps: [],
      items: [],
      merged: [],
      sequence: 2,
      timelines: [
        describeTimeline(idOf(3), "[bob]", "Direct", 2),
        describeTimeline(idOf(4), "{bob}", "Direct", 2),
      ],
    }),
    event: "changed",
    id: "1.2",
  });
  await until(composed.registry, timelinesState, (state) =>
    [
      ...(state.networks.get(Schema.decodeSync(NetworkId)("libera"))?.timelines.keys() ?? []),
    ].includes(Schema.decodeSync(TimelineId)(idOf(4)))
  );

  return composed;
};

/**
 * The Daemon placed the Say at step 10 in `{bob}`'s Timeline, and folded through it.
 * @param daemon - The fake.
 */
const placeAt10 = (daemon: ReturnType<typeof fakeDaemon>["daemon"]) => {
  daemon.through = 10;
  daemon.placed.set(10, [
    {
      changed: 10,
      content: {
        _tag: "Message",
        at: { _tag: "Unknown" },
        id: { _tag: "Unknown" },
        kind: "Privmsg",
        live: true,
        ours: { delivery: { _tag: "Unconfirmed" }, intent: "web-1" },
        sender: "iirc",
        tags: [],
        target: "{bob}",
        text: "hello",
      },
      level: null,
      network: "libera",
      position: `${hex(2 ** 53 + 10_000, 14)}-${hex(10, 14)}-${hex(0, 8)}`,
      sequence: 10,
      timeline: idOf(4),
    },
  ]);
};

describe("saying", () => {
  it("says plain text under an intent it names, and clears the draft, keeping it in the history", async () => {
    const { daemon, notice, registry, type } = await composing();

    await type("hello");
    const draft = draftOf(registry.get(composerState), channel);

    expect({
      draft: [draft.text, draft.history],
      notice: notice(),
      says: daemon.says,
    }).toStrictEqual({
      draft: ["", ["hello"]],
      notice: undefined,
      says: [said("#iirc", "hello", "web-1")],
    });
  });

  it("says a refusal `say` answered with in words, and sends nothing after it", async () => {
    const { daemon, notice, type } = await composing();

    daemon.sayAnswers.push("Offline");
    await type("/me waves\nsecond");

    expect({ notice: notice()?.message, says: daemon.says }).toStrictEqual({
      notice:
        "Not said to #iirc: the Network had no Session when it arrived. Nothing after it was sent.",
      says: [said("#iirc", "waves", "web-1", "Action")],
    });
  });

  it("asks `said` when the Network stopped, and offers to send again under the same intent only when it was not journaled", async () => {
    const { daemon, notice, registry, type } = await composing();

    daemon.sayAnswers.push("NetworkStopped");
    await type("one\ntwo");
    const offered = notice();

    await run(registry, takeUp, channel);

    daemon.sayAnswers.push("NetworkStoppedJournaled");
    await type("three\nfour");
    const journaled = notice();

    expect({
      journaled: journaled?.message,
      journaledOffer: journaled?.offer,
      offered: [offered?.message, offered?.offer?._tag, offered?.offer?.intent],
      says: daemon.says.map((one) => [one.intent, one.text]),
    }).toStrictEqual({
      journaled:
        "This was journaled, but whether it reached the Ircd is unknown, and it is not sent again on its own. Its item in the Timeline shows its delivery. What came after it was not sent.",
      journaledOffer: {
        _tag: "SendAgain",
        intent: undefined,
        intents: [
          {
            _tag: "Say",
            kind: "Privmsg",
            network: "libera",
            opens: false,
            target: "#iirc",
            text: "four",
          },
        ],
      },
      offered: [
        "The Network stopped before this was journaled, so it was not said.",
        "SendAgain",
        "web-1",
      ],
      says: [
        ["web-1", "one"],
        ["web-1", "one"],
        ["web-2", "two"],
        ["web-3", "three"],
      ],
    });
  });

  it("never sends again after a lost response: `NotJournaled` stays unknown, and checking again finds it journaled late", async () => {
    const { daemon, notice, registry, type } = await composing();

    // The request got no answer, and the Daemon journals it only after `said` answered.
    daemon.sayAnswers.push("Lost");
    await type("lost");
    const first = notice();

    await run(registry, takeUp, channel);
    const checked = notice();

    expect({
      checked: checked?.message,
      first: [first?.message, first?.offer?._tag],
      says: daemon.says.map((one) => [one.intent, one.text]),
    }).toStrictEqual({
      checked:
        "This was journaled, but whether it reached the Ircd is unknown, and it is not sent again on its own. Its item in the Timeline shows its delivery.",
      first: [
        "The Daemon did not answer, so whether this was said is unknown. Nothing after it was sent.",
        "CheckAgain",
      ],
      says: [["web-1", "lost"]],
    });
  });

  it("keeps it unknown when checking again still finds nothing, or `said` does not answer", async () => {
    const { daemon, notice, registry, type } = await composing();

    daemon.sayAnswers.push("Down");
    await type("gone");
    await run(registry, takeUp, channel);
    const notJournaled = notice()?.offer?._tag;

    daemon.saidDown = true;
    await run(registry, takeUp, channel);

    expect({
      notJournaled,
      says: daemon.says.length,
      unanswered: notice()?.offer?._tag,
    }).toStrictEqual({ notJournaled: "CheckAgain", says: 1, unanswered: "CheckAgain" });
  });

  it("says an unknown Network in words, and sends nothing for an unknown command", async () => {
    const { daemon, notice, type } = await composing();

    daemon.sayAnswers.push("UnknownNetwork");
    await type("hello");
    const unknown = notice()?.message;

    await type("/frob");

    expect({ command: notice()?.message, says: daemon.says.length, unknown }).toStrictEqual({
      command: "There is no command /frob. Start with // to say text that begins with /.",
      says: 1,
      unknown: "The Daemon has no Network libera.",
    });
  });

  it("sends many lines only once confirmed, in order", async () => {
    const { daemon, registry, type } = await composing();
    const lines = ["1", "2", "3", "4", "5", "6"];

    await type(lines.join("\n"));
    const before = daemon.says.length;

    await run(registry, confirmSend, channel);

    expect({ after: daemon.says.map((one) => one.text), before }).toStrictEqual({
      after: lines,
      before: 0,
    });
  });

  it("waits for the projection to fold `/msg`'s step, reads it once, and opens `{bob}`'s, not `[bob]`'s", async () => {
    const { daemon, registry, send: sendChange } = await placing();

    registry.set(edit, { text: "/msg {bob} hello", timeline: channel });
    registry.set(send, channel);
    await eventually(() => daemon.says.length === 1);
    const before = [...daemon.locatesRead];

    // The projection catches up while the lookup waits.
    placeAt10(daemon);
    sendChange(foldedThrough(10));
    await until(registry, timelinesState, (state) => openOf(state) === idOf(4));

    expect({ after: daemon.locatesRead, before, says: daemon.says }).toStrictEqual({
      after: [10],
      before: [],
      says: [said("{bob}", "hello", "web-1")],
    });
  });

  it("shows the Direct Message `/msg` opens, though the options were showing when it was said", async () => {
    const { daemon, registry, send: sendChange } = await placing();

    await run(registry, openOptions, "");
    const before = registry.get(mainView);

    registry.set(edit, { text: "/msg {bob} hello", timeline: channel });
    registry.set(send, channel);
    await eventually(() => daemon.says.length === 1);
    placeAt10(daemon);
    sendChange(foldedThrough(10));
    await until(registry, timelinesState, (state) => openOf(state) === idOf(4));

    expect({ after: registry.get(mainView), before }).toStrictEqual({
      after: { _tag: "Timeline" },
      before: { _tag: "Options", filter: "" },
    });
  });

  it("reads the step again after a read that got no answer, and never says it again", async () => {
    const { daemon, registry, send: sendChange } = await placing();

    placeAt10(daemon);
    sendChange(foldedThrough(10));
    await until(registry, timelinesState, (state) => followFrom(state)?.sequence === 10);
    daemon.locateFailures = 1;

    registry.set(edit, { text: "/msg {bob} hello", timeline: channel });
    registry.set(send, channel);
    await until(registry, timelinesState, (state) => openOf(state) === idOf(4));

    expect({ reads: daemon.locatesRead, says: daemon.says.length }).toStrictEqual({
      reads: [10, 10],
      says: 1,
    });
  });

  it("lets the lookup go when the Owner opens another Timeline while it waits", async () => {
    const { daemon, registry, send: sendChange } = await placing();

    registry.set(edit, { text: "/msg {bob} hello", timeline: channel });
    registry.set(send, channel);
    await eventually(() => daemon.says.length === 1);
    registry.set(open, network);

    placeAt10(daemon);
    sendChange(foldedThrough(10));
    await until(registry, timelinesState, (state) => followFrom(state)?.sequence === 10);
    await Effect.runPromise(Effect.sleep("50 millis"));

    expect({ open: openOf(registry.get(timelinesState)), reads: daemon.locatesRead }).toStrictEqual(
      {
        open: network,
        reads: [],
      }
    );
  });

  it("opens nothing when the Owner opened another Timeline while the read was answered late", async () => {
    const { daemon, registry, send: sendChange } = await placing();

    placeAt10(daemon);
    sendChange(foldedThrough(10));
    await until(registry, timelinesState, (state) => followFrom(state)?.sequence === 10);
    daemon.holdLocates = true;

    registry.set(edit, { text: "/msg {bob} hello", timeline: channel });
    registry.set(send, channel);
    await eventually(() => daemon.locatesHeld.length === 1);
    registry.set(open, network);

    for (const release of daemon.locatesHeld.splice(0)) {
      release();
    }

    await Effect.runPromise(Effect.sleep("50 millis"));

    expect(openOf(registry.get(timelinesState))).toBe(network);
  });

  it("opens nothing for a `/msg` the Client refused", async () => {
    const { daemon, notice, registry, type } = await composing();

    daemon.sayAnswers.push("Offline");
    daemon.through = 10;
    await type("/msg peer hi");

    expect({ notice: notice()?.offer, open: openOf(registry.get(timelinesState)) }).toStrictEqual({
      notice: undefined,
      open: channel,
    });
  });
});
