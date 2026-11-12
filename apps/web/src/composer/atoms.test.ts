import { NetworkId, TimelineId } from "@iirc/api";
import type { Timeline, TimelineChangesEvent } from "@iirc/api";
import { draftOf, placeOfDraft } from "@iirc/frontend/composer";
import type { Notice } from "@iirc/frontend/composer";
import { followFrom, openOf } from "@iirc/frontend/timelines";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { closeOptions, mainView, openOptions } from "../options/atoms.ts";
import { closeSearch, showSearch } from "../search/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import {
  open,
  openTimeline,
  showDraft,
  sidebarNetworks,
  sync,
  timelinesState,
} from "../timelines/atoms.ts";
import { composerState, confirmSend, draftsCarried, edit, send, takeUp } from "./atoms.ts";

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

const offerOf = (notice: Notice | undefined) =>
  notice?._tag === "Offering" ? notice.offer : undefined;

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
      journaledOffer: offerOf(journaled),
      offered: [offered?.message, offerOf(offered)?._tag, offerOf(offered)?.intent],
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
      first: [first?.message, offerOf(first)?._tag],
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
    const notJournaled = offerOf(notice())?._tag;

    daemon.saidDown = true;
    await run(registry, takeUp, channel);

    expect({
      notJournaled,
      says: daemon.says.length,
      unanswered: offerOf(notice())?._tag,
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
      before: { _tag: "Options", back: { _tag: "Timeline" }, filter: "" },
    });
  });

  it("says plain text in a Direct Message not yet begun to its nick, and shows the Timeline it made", async () => {
    const { daemon, registry, send: sendChange } = await composing();
    const libera = Schema.decodeSync(NetworkId)("libera");
    const place = placeOfDraft(libera, "{bob}");

    registry.set(showDraft, { declared: null, network: libera, nick: "{bob}" });
    const drafted = registry.get(mainView);

    registry.set(edit, { text: "hello", timeline: place });
    registry.set(send, place);
    await eventually(() => daemon.says.length === 1);

    // The Daemon makes `{bob}`'s Timeline with the Message, and places it there.
    placeAt10(daemon);
    sendChange({
      data: JSON.stringify({
        gaps: [],
        items: [],
        merged: [],
        sequence: 10,
        timelines: [describeTimeline(idOf(4), "{bob}", "Direct", 10)],
      }),
      event: "changed",
      id: "1.10",
    });
    await until(registry, timelinesState, (state) => openOf(state) === idOf(4));

    expect({
      after: registry.get(mainView),
      draft: draftOf(registry.get(composerState), place).text,
      drafted: drafted._tag,
      said: daemon.says.map((one) => [one.target, one.text]),
    }).toStrictEqual({
      after: { _tag: "Timeline" },
      draft: "",
      drafted: "DirectDraft",
      said: [["{bob}", "hello"]],
    });
  });

  it("shows a draft's Timeline once one is listed, whoever spoke first, carrying what was typed", async () => {
    const { registry, send: sendChange } = await composing();
    const libera = Schema.decodeSync(NetworkId)("libera");

    registry.mount(draftsCarried);

    /**
     * A Message in a Direct Message Timeline, said by a sender, as a step lists it.
     * @param sequence - The step, which is also the Timeline's id.
     * @param name - The partner's nick.
     * @param sender - Who said it: the partner, or Self from another Frontend.
     */
    const listed = (sequence: number, name: string, sender: string) => {
      sendChange({
        data: JSON.stringify({
          gaps: [],
          items: [
            {
              changed: sequence,
              content: {
                _tag: "Message",
                at: { _tag: "Unknown" },
                id: { _tag: "Unknown" },
                kind: "Privmsg",
                live: true,
                ours:
                  sender === "iirc"
                    ? { delivery: { _tag: "Unconfirmed" }, intent: "other-1" }
                    : null,
                sender,
                tags: [],
                target: sender === "iirc" ? name : "iirc",
                text: "hello",
              },
              level: sender === "iirc" ? null : "Direct",
              network: "libera",
              position: `${hex(2 ** 53 + sequence * 1000, 14)}-${hex(sequence, 14)}-${hex(0, 8)}`,
              sequence,
              timeline: idOf(sequence),
            },
          ],
          merged: [],
          sequence,
          timelines: [describeTimeline(idOf(sequence), name, "Direct", sequence)],
        }),
        event: "changed",
        id: `1.${sequence}`,
      });
    };

    // Bob speaks first, while a draft to him holds words not yet sent.
    registry.set(showDraft, { declared: null, network: libera, nick: "Bob" });
    registry.set(edit, { text: "not sent yet", timeline: placeOfDraft(libera, "Bob") });
    const { navigation } = registry.get(timelinesState);

    listed(4, "Bob", "Bob");
    await until(registry, timelinesState, (state) => openOf(state) === idOf(4));

    const bob = {
      main: registry.get(mainView)._tag,
      moved: registry.get(timelinesState).navigation !== navigation,
      text: draftOf(registry.get(composerState), Schema.decodeSync(TimelineId)(idOf(4))).text,
    };

    // Another Frontend says something to Carol, while a draft to her shows.
    registry.set(showDraft, { declared: null, network: libera, nick: "carol" });
    listed(5, "carol", "iirc");
    await until(registry, timelinesState, (state) => openOf(state) === idOf(5));

    expect({
      bob,
      carol: registry.get(mainView)._tag,
      draft: draftOf(registry.get(composerState), placeOfDraft(libera, "Bob")).text,
    }).toStrictEqual({
      bob: { main: "Timeline", moved: false, text: "not sent yet" },
      carol: "Timeline",
      draft: "",
    });
  });

  it("carries a draft's text when closing the options or the search over it shows its Timeline", async () => {
    const { registry, send: sendChange } = await composing();
    const libera = Schema.decodeSync(NetworkId)("libera");

    registry.mount(draftsCarried);

    const covered = async (nick: string, sequence: number, cover: "options" | "search") => {
      const place = placeOfDraft(libera, nick);
      const timeline = Schema.decodeSync(TimelineId)(idOf(sequence));

      registry.set(showDraft, { declared: null, network: libera, nick });
      registry.set(edit, { text: `to ${nick}`, timeline: place });

      if (cover === "options") {
        await run(registry, openOptions, "");
      } else {
        registry.set(showSearch, undefined);
      }

      sendChange({
        data: JSON.stringify({
          gaps: [],
          items: [],
          merged: [],
          sequence,
          timelines: [describeTimeline(idOf(sequence), nick, "Direct", sequence)],
        }),
        event: "changed",
        id: `1.${sequence}`,
      });
      await until(registry, sidebarNetworks, (networks) =>
        networks.some((one) => one.timelines.some((listed) => listed.id === timeline))
      );
      registry.set(cover === "options" ? closeOptions : closeSearch, undefined);
      await until(registry, timelinesState, (state) => openOf(state) === timeline);

      return draftOf(registry.get(composerState), timeline).text;
    };

    expect({
      options: await covered("erin", 6, "options"),
      search: await covered("finn", 7, "search"),
    }).toStrictEqual({ options: "to erin", search: "to finn" });
  });

  it("says a Say's failure under the Timeline a draft came to show while the Say was in flight", async () => {
    const { daemon, registry, send: sendChange } = await composing();
    const libera = Schema.decodeSync(NetworkId)("libera");
    const place = placeOfDraft(libera, "dave");
    const dave = Schema.decodeSync(TimelineId)(idOf(6));

    registry.mount(draftsCarried);
    registry.set(showDraft, { declared: null, network: libera, nick: "dave" });

    // The Say is held, then refused, while Dave speaks first and makes his Timeline.
    daemon.holdSays = true;
    daemon.sayAnswers.push("Offline");
    registry.set(edit, { text: "hello", timeline: place });
    registry.set(send, place);
    await eventually(() => daemon.held.says.length === 1);

    sendChange({
      data: JSON.stringify({
        gaps: [],
        items: [],
        merged: [],
        sequence: 6,
        timelines: [describeTimeline(idOf(6), "dave", "Direct", 6)],
      }),
      event: "changed",
      id: "1.6",
    });
    await until(registry, timelinesState, (state) => openOf(state) === dave);

    for (const release of daemon.held.says.splice(0)) {
      release();
    }

    const notice = await until(
      registry,
      composerState,
      (state) => draftOf(state, dave).notice !== undefined
    );

    expect({
      draft: draftOf(notice, place).notice,
      shown: draftOf(notice, dave).notice?.message.includes("dave"),
    }).toStrictEqual({ draft: undefined, shown: true });
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

    expect({ notice: offerOf(notice()), open: openOf(registry.get(timelinesState)) }).toStrictEqual(
      {
        notice: undefined,
        open: channel,
      }
    );
  });
});

describe("how long a notice lasts", () => {
  it("lets go of a complaint about the text when the composer turns to another Timeline, keeps the text, and keeps an offer", async () => {
    const { daemon, notice, registry, type } = await composing();

    registry.mount(draftsCarried);

    await type("/d");
    const complaint = notice()?._tag;
    const text = () => draftOf(registry.get(composerState), channel).text;

    registry.set(open, network);
    await until(
      registry,
      openTimeline,
      (shown) => shown._tag === "Shown" && shown.timeline === network
    );
    const away = [notice()?._tag, text()];

    registry.set(open, channel);
    await until(
      registry,
      openTimeline,
      (shown) => shown._tag === "Shown" && shown.timeline === channel
    );
    registry.set(edit, { text: "kept", timeline: channel });

    daemon.sayAnswers.push("NetworkStopped");
    await type("one");
    const offered = notice()?._tag;

    registry.set(open, network);
    await until(
      registry,
      openTimeline,
      (shown) => shown._tag === "Shown" && shown.timeline === network
    );

    expect({ away, complaint, offered, offeredStays: notice()?._tag }).toStrictEqual({
      away: [undefined, "/d"],
      complaint: "AboutText",
      offered: "Offering",
      offeredStays: "Offering",
    });
  });

  it("keeps a Credential's refusal on the draft it cleared, which the clearing does not let go of", async () => {
    const { notice, registry, type } = await composing();

    await type("/set network.libera.password hunter2");

    expect({
      notice: notice()?._tag,
      text: draftOf(registry.get(composerState), channel).text,
    }).toStrictEqual({ notice: "AboutText", text: "" });
  });
});

describe("acting", () => {
  it("acts under an intent it names, as `act` takes it, and clears the draft", async () => {
    const { daemon, notice, registry, type } = await composing();

    await type("/kick peer,other go away");

    expect({
      acts: daemon.acts,
      draft: draftOf(registry.get(composerState), channel).text,
      notice: notice(),
    }).toStrictEqual({
      acts: [
        {
          action: { _tag: "Kick", channel: "#iirc", nicks: ["peer", "other"], reason: "go away" },
          intent: "web-1",
        },
      ],
      draft: "",
      notice: undefined,
    });
  });

  it("says a refusal `act` answered with in words, and sends nothing after it", async () => {
    const { daemon, notice, type } = await composing();

    daemon.sayAnswers.push("Offline");
    await type("/kick peer\nhello");

    expect({
      acts: daemon.acts.length,
      notice: notice()?.message,
      says: daemon.says,
    }).toStrictEqual({
      acts: 1,
      notice:
        "Your kick of peer from #iirc was not sent: the Network had no Session when it arrived. Nothing after it was sent.",
      says: [],
    });
  });

  it("asks `said` when the Network stopped, and acts again under the same intent only when it was not journaled", async () => {
    const { daemon, notice, registry, type } = await composing();

    daemon.sayAnswers.push("NetworkStopped");
    await type("/topic a new topic");
    const offered = notice();

    await run(registry, takeUp, channel);

    daemon.sayAnswers.push("NetworkStoppedJournaled");
    await type("/away gone");
    const journaled = notice();

    expect({
      acts: daemon.acts.map((one) => one.intent),
      journaled: [journaled?.message, offerOf(journaled)],
      offered: [offered?.message, offerOf(offered)?._tag, offerOf(offered)?.intent],
    }).toStrictEqual({
      acts: ["web-1", "web-1", "web-2"],
      journaled: [
        "This was journaled, but whether it reached the Ircd is unknown, and it is not sent again on its own. What the Ircd did shows in the Timeline, and a refusal there too.",
        undefined,
      ],
      offered: [
        "The Network stopped before this was journaled, so it was not sent.",
        "SendAgain",
        "web-1",
      ],
    });
  });

  it("never acts again after a lost response, and only offers to check", async () => {
    const { daemon, notice, registry, type } = await composing();

    daemon.sayAnswers.push("Lost");
    await type("/nick other");
    const first = notice();

    await run(registry, takeUp, channel);

    expect({
      acts: daemon.acts.length,
      checked: offerOf(notice()),
      first: [first?.message, offerOf(first)?._tag],
    }).toStrictEqual({
      acts: 1,
      checked: undefined,
      first: [
        "The Daemon did not answer, so whether this was sent is unknown. Nothing after it was sent.",
        "CheckAgain",
      ],
    });
  });

  it("shows Self away as `known` says once the Ircd confirmed it, read again for Self's AwayChanged", async () => {
    const { daemon, registry, send: changed } = await composing();
    const awayOf = () => registry.get(sidebarNetworks)[0]?.away;

    await until(registry, sidebarNetworks, (held) => held[0]?.away._tag === "Unknown");

    const awayChanged = (sequence: number, message: string | null) => {
      daemon.selves.set("libera", {
        account: { _tag: "Unknown" },
        away:
          message === null
            ? { _tag: "Known", at: sequence, from: "ircd", value: null }
            : { _tag: "Known", at: sequence, from: "ircd", value: { message } },
        mask: { _tag: "Unknown" },
        nick: "iirc",
        realname: { _tag: "Unknown" },
      });
      changed({
        data: JSON.stringify({
          gaps: [],
          items: [
            {
              changed: sequence,
              content: {
                _tag: "Activity",
                activity: {
                  _tag: "AwayChanged",
                  away: message === null ? null : { message },
                  nick: "iirc",
                },
                at: { _tag: "Unknown" },
                id: { _tag: "Unknown" },
                live: true,
              },
              level: "Activity",
              network: "libera",
              position: `${hex(2 ** 53 + sequence, 14)}-${hex(sequence, 14)}-${hex(0, 8)}`,
              sequence,
              timeline: idOf(1),
            },
          ],
          merged: [],
          sequence,
          timelines: [],
        }),
        event: "changed",
        id: `1.${sequence}`,
      });
    };

    awayChanged(5, "gone");
    const away = await until(registry, sidebarNetworks, (held) => held[0]?.away._tag === "Away");

    awayChanged(6, null);
    await until(registry, sidebarNetworks, (held) => held[0]?.away._tag === "Here");

    expect({ away: away[0]?.away, back: awayOf() }).toStrictEqual({
      away: { _tag: "Away", message: "gone" },
      back: { _tag: "Here" },
    });
  });
});
