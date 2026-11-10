import { CallerIntent, NetworkId, TimelineId } from "@iirc/api";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { interpret } from "./commands.ts";
import type { CommandContext, Intent } from "./commands.ts";
import {
  confirm,
  confirmAbove,
  draftOf,
  historyCap,
  initialComposers,
  linesOf,
  reduceComposers,
  takeOffer,
  submit,
} from "./composer.ts";
import type { ComposerEvent, Composers } from "./composer.ts";

const network = Schema.decodeSync(NetworkId)("libera");
const timelineId = Schema.decodeSync(TimelineId);
const intentId = Schema.decodeSync(CallerIntent);
const channel = timelineId("00000000000002-00000000-00000000");
const other = timelineId("00000000000003-00000000-00000000");

const context: CommandContext = {
  focus: {
    detached: false,
    key: "#iirc",
    kind: "Channel",
    name: "#iirc",
    network,
    timeline: channel,
  },
  open: channel,
  session: true,
  timelines: [channel],
  unread: [],
};

const fold = (events: readonly ComposerEvent[], from: Composers = initialComposers) => {
  let state = from;

  for (const event of events) {
    state = reduceComposers(state, event);
  }

  return state;
};

const edited = (text: string, timeline = channel): ComposerEvent => ({
  _tag: "Edited",
  text,
  timeline,
});

/**
 * Types each text into a Timeline's composer and submits it.
 * @param texts - What is sent, in order.
 * @param timeline - The Timeline.
 * @returns The state after.
 */
const sendAll = (texts: readonly string[], timeline = channel) => {
  let state = initialComposers;

  for (const text of texts) {
    ({ state } = submit(reduceComposers(state, edited(text, timeline)), timeline, context));
  }

  return state;
};

const up = (timeline = channel): ComposerEvent => ({
  _tag: "Recalled",
  direction: "Older",
  timeline,
});

const down = (timeline = channel): ComposerEvent => ({
  _tag: "Recalled",
  direction: "Newer",
  timeline,
});

const say = (text: string): Intent => ({
  _tag: "Say",
  kind: "Privmsg",
  network,
  opens: false,
  target: "#iirc",
  text,
});

describe("submitting", () => {
  it("sends a line, clears the draft, and keeps it in the history", () => {
    const { intents, state } = submit(fold([edited("hello")]), channel, context);

    expect({ draft: draftOf(state, channel), intents }).toStrictEqual({
      draft: { ...draftOf(initialComposers, channel), history: ["hello"] },
      intents: [say("hello")],
    });
  });

  it("sends one Say per non-empty line, in order", () => {
    const { intents } = submit(fold([edited("one\r\n\ntwo\r  \nthree")]), channel, context);

    expect(intents).toStrictEqual([say("one"), say("two"), say("three")]);
  });

  it("sends nothing for whitespace", () => {
    const before = fold([edited("  \n ")]);

    expect(submit(before, channel, context)).toStrictEqual({ intents: [], state: before });
  });

  it("refuses text with a NUL, and any line that cannot be sent, sending nothing", () => {
    const nul = submit(fold([edited("a\0b")]), channel, context);
    const bad = submit(fold([edited("fine\n/frob")]), channel, context);

    expect({
      bad: [
        bad.intents,
        draftOf(bad.state, channel).notice?.message,
        draftOf(bad.state, channel).text,
      ],
      nul: [nul.intents, draftOf(nul.state, channel).notice?.message],
    }).toStrictEqual({
      bad: [
        [],
        "Line 2: There is no command /frob. Start with // to say text that begins with /.",
        "fine\n/frob",
      ],
      nul: [[], "It holds a NUL character, which no IRC Line can carry. Nothing was sent."],
    });
  });

  it(`asks to confirm more than ${confirmAbove} lines, and sends them once confirmed`, () => {
    const lines = Array.from({ length: confirmAbove + 1 }, (_, index) => `line ${index}`);
    const atLimit = submit(fold([edited(lines.slice(1).join("\n"))]), channel, context);
    const asked = submit(fold([edited(lines.join("\n"))]), channel, context);
    const confirmed = confirm(asked.state, channel);
    const dismissed = fold([{ _tag: "Dismissed", timeline: channel }], asked.state);
    const changed = fold([edited("changed")], asked.state);

    expect({
      asked: [asked.intents, draftOf(asked.state, channel).confirming?.lines],
      atLimit: atLimit.intents.length,
      confirmed: [confirmed.intents, draftOf(confirmed.state, channel).text],
      dismissed: [draftOf(dismissed, channel).confirming, draftOf(dismissed, channel).text],
      editedAway: draftOf(changed, channel).confirming,
    }).toStrictEqual({
      asked: [[], confirmAbove + 1],
      atLimit: confirmAbove,
      confirmed: [lines.map(say), ""],
      dismissed: [undefined, lines.join("\n")],
      editedAway: undefined,
    });
  });

  it("lets go of lines waiting to be confirmed when recall changes what is shown", () => {
    const sent = sendAll(["earlier"]);
    const lines = Array.from({ length: confirmAbove + 1 }, (_, index) => `line ${index}`);
    const asked = submit(fold([edited(lines.join("\n"))], sent), channel, context);
    const recalled = fold([up()], asked.state);
    const enter = confirm(recalled, channel);

    expect({
      confirming: draftOf(recalled, channel).confirming,
      sent: enter.intents,
      shown: draftOf(recalled, channel).text,
    }).toStrictEqual({ confirming: undefined, sent: [], shown: "earlier" });
  });

  it("property: what waits to be confirmed is always exactly what is shown", () => {
    const line = fc.constantFrom("a", "b", "/me c", "");

    const text = fc
      .array(line, { maxLength: confirmAbove + 3, minLength: 1 })
      .map((lines) => lines.join("\n"));

    const event: fc.Arbitrary<"Submit" | "Confirm" | ComposerEvent> = fc.oneof(
      text.map((typed) => edited(typed)),
      fc.constant(up()),
      fc.constant(down()),
      fc.constant<ComposerEvent>({ _tag: "Dismissed", timeline: channel }),
      fc.constant("Submit" as const),
      fc.constant("Confirm" as const)
    );

    fc.assert(
      fc.property(fc.array(event, { maxLength: 40, minLength: 10 }), (events) => {
        let state = initialComposers;
        let shownAlways = true;

        for (const one of events) {
          if (one === "Submit") {
            ({ state } = submit(state, channel, context));
          } else if (one === "Confirm") {
            ({ state } = confirm(state, channel));
          } else {
            state = reduceComposers(state, one);
          }

          const { confirming, text } = draftOf(state, channel);

          const shown = linesOf(text).flatMap((shownLine) => {
            const read = interpret(shownLine, context);

            return read._tag === "Parsed" ? read.value : [];
          });

          shownAlways &&=
            confirming === undefined ||
            JSON.stringify(confirming.intents) === JSON.stringify(shown);
        }

        expect(shownAlways).toBeTruthy();
      }),
      { numRuns: 500 }
    );
  });

  it("splits lines at any line break", () => {
    expect(linesOf("a\rb\nc\r\nd")).toStrictEqual(["a", "b", "c", "d"]);
  });
});

describe("the draft and its history", () => {
  it("keeps each Timeline's draft apart", () => {
    const state = fold([edited("for the channel"), edited("for the other", other)]);

    expect([draftOf(state, channel).text, draftOf(state, other).text]).toStrictEqual([
      "for the channel",
      "for the other",
    ]);
  });

  it("recalls what was sent, newest first, and comes back down to the draft", () => {
    const sent = sendAll(["first", "second"]);
    const typing = fold([edited("half")], sent);

    const texts: string[] = [];
    let state = typing;

    for (const event of [up(), up(), up(), down(), down(), down()]) {
      state = reduceComposers(state, event);
      texts.push(draftOf(state, channel).text);
    }

    expect(texts).toStrictEqual(["second", "first", "first", "second", "half", "half"]);
  });

  it("properties: drafts are per Timeline, history is bounded, newest first, and recall returns to the draft", () => {
    const text = fc.string({ maxLength: 4, minLength: 1, unit: fc.constantFrom("a", "b", " ") });

    fc.assert(
      fc.property(
        fc.array(text, { maxLength: historyCap + 20 }),
        text,
        fc.nat({ max: historyCap + 30 }),
        (sent, draft, ups) => {
          const said = sendAll(sent.filter((one) => one.trim() !== ""));
          const typed = fold([edited(draft), edited("elsewhere", other)], said);
          const { history } = draftOf(typed, channel);

          const recalled = fold(
            Array.from({ length: ups }, () => up()),
            typed
          );

          const back = fold(
            Array.from({ length: ups }, () => down()),
            recalled
          );

          // Consecutive repeats are kept once.
          const expected = sent
            .filter((one) => one.trim() !== "")
            .filter((one, index, all) => all[index - 1] !== one)
            .toReversed()
            .slice(0, historyCap);

          expect({
            back: draftOf(back, channel).text,
            history,
            other: draftOf(typed, other).text,
            recalled: draftOf(recalled, channel).text,
            survives: structuredClone(back),
          }).toStrictEqual({
            back: draft,
            history: expected,
            other: "elsewhere",
            recalled: ups === 0 ? draft : (expected[Math.min(ups, expected.length) - 1] ?? draft),
            survives: back,
          });
        }
      )
    );
  });
});

describe("what became of a Say", () => {
  const intent = intentId("web-1");

  it("says a refusal in words, and that nothing after it was sent", () => {
    const one = fold([
      {
        _tag: "Failed",
        failure: { _tag: "Refused", reason: { _tag: "Offline" }, target: "#iirc" },
        intent,
        intents: [say("one")],
        timeline: channel,
      },
    ]);

    const more = fold([
      {
        _tag: "Failed",
        failure: { _tag: "Refused", reason: { _tag: "Unsendable" }, target: "\u202Epeer" },
        intent,
        intents: [say("one"), say("two")],
        timeline: channel,
      },
    ]);

    expect([draftOf(one, channel).notice, draftOf(more, channel).notice]).toStrictEqual([
      {
        message: "Not said to #iirc: the Network had no Session when it arrived.",
        offer: undefined,
      },
      {
        message:
          "Not said to \u202Epeer\u202C: no IRC Line can carry it there. Nothing after it was sent.",
        offer: undefined,
      },
    ]);
  });

  it("offers to send again only what the Network stopped before journaling, and never promises delivery", () => {
    const intents = [say("one"), say("two")] as const;

    const notJournaled = fold([
      { _tag: "Failed", failure: { _tag: "NotJournaled" }, intent, intents, timeline: channel },
    ]);

    const journaled = fold([
      { _tag: "Failed", failure: { _tag: "Journaled" }, intent, intents, timeline: channel },
    ]);

    const taken = takeOffer(notJournaled, channel);

    expect({
      journaled: draftOf(journaled, channel).notice,
      notJournaled: draftOf(notJournaled, channel).notice?.offer,
      taken: [taken.offer?._tag, draftOf(taken.state, channel).notice],
    }).toStrictEqual({
      journaled: {
        message:
          "This was journaled, but whether it reached the Ircd is unknown, and it is not sent again on its own. Its item in the Timeline shows its delivery. What came after it was not sent.",
        offer: { _tag: "SendAgain", intent: undefined, intents: [say("two")] },
      },
      notJournaled: { _tag: "SendAgain", intent, intents },
      taken: ["SendAgain", undefined],
    });
  });

  it("offers only to check again when no answer came, never to send again", () => {
    const intents = [say("one")] as const;

    const lost = fold([
      {
        _tag: "Failed",
        failure: { _tag: "Unknown", network },
        intent,
        intents,
        timeline: channel,
      },
    ]);

    expect(draftOf(lost, channel).notice).toStrictEqual({
      message:
        "The Daemon did not answer, so whether this was said is unknown. Nothing after it was sent.",
      offer: { _tag: "CheckAgain", intent, intents, network },
    });
  });
});
