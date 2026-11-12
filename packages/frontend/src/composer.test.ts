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
  placeOfDraft,
  reduceComposers,
  started,
  takeOffer,
  submit,
} from "./composer.ts";
import type { ComposerEvent, Composers, Notice, Place } from "./composer.ts";

const network = Schema.decodeSync(NetworkId)("libera");
const timelineId = Schema.decodeSync(TimelineId);
const intentId = Schema.decodeSync(CallerIntent);
const channel = timelineId("00000000000002-00000000-00000000");
const other = timelineId("00000000000003-00000000-00000000");

const context: CommandContext = {
  behind: false,
  draft: undefined,
  focus: {
    detached: false,
    key: "#iirc",
    kind: "Channel",
    name: "#iirc",
    network,
    timeline: channel,
  },
  head: undefined,
  open: channel,
  panes: 1,
  session: true,
  shown: [],
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

const offerOf = (notice: Notice | undefined) =>
  notice?._tag === "Offering" ? notice.offer : undefined;

const edited = (text: string, timeline: Place = channel): ComposerEvent => ({
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
  it("refuses a raw PASS, AUTHENTICATE, or OPER by either name, in any case, and keeps none of it", () => {
    const before = sendAll(["hello"]);

    const refusedOne = (text: string) => {
      const { intents, state } = submit(reduceComposers(before, edited(text)), channel, context);
      const draft = draftOf(state, channel);

      return [intents.length, draft.text, draft.history, draft.notice?.message];
    };

    const words =
      "A Credential never goes in a raw Line: PASS, AUTHENTICATE, and OPER carry one, and a raw Line is journaled whole. It was cleared, and nothing was sent.";

    expect([
      refusedOne("/quote PASS one"),
      refusedOne("/RAW pass two"),
      refusedOne("/Quote @+x=y :me Authenticate three"),
      refusedOne("hi\n/raw AuThEnTiCaTe four"),
      refusedOne("/quote Oper admin five"),
      refusedOne("/raw OPER admin six"),
    ]).toStrictEqual([
      [0, "", ["hello"], words],
      [0, "", ["hello"], words],
      [0, "", ["hello"], words],
      [0, "", ["hello"], words],
      [0, "", ["hello"], words],
      [0, "", ["hello"], words],
    ]);
  });

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
        failure: {
          _tag: "Refused",
          action: undefined,
          reason: { _tag: "Offline" },
          target: "#iirc",
        },
        intent,
        intents: [say("one")],
        timeline: channel,
      },
    ]);

    const more = fold([
      {
        _tag: "Failed",
        failure: {
          _tag: "Refused",
          action: undefined,
          reason: { _tag: "Unsendable" },
          target: "\u202Epeer",
        },
        intent,
        intents: [say("one"), say("two")],
        timeline: channel,
      },
    ]);

    expect([draftOf(one, channel).notice, draftOf(more, channel).notice]).toStrictEqual([
      {
        _tag: "Outcome",
        message: "Not said to #iirc: the Network had no Session when it arrived.",
      },
      {
        _tag: "Outcome",
        message:
          "Not said to \u202Epeer\u202C: no IRC Line can carry it there. Nothing after it was sent.",
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
      notJournaled: offerOf(draftOf(notJournaled, channel).notice),
      taken: [taken.offer?._tag, draftOf(taken.state, channel).notice],
    }).toStrictEqual({
      journaled: {
        _tag: "Offering",
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
      _tag: "Offering",
      message:
        "The Daemon did not answer, so whether this was said is unknown. Nothing after it was sent.",
      offer: { _tag: "CheckAgain", intent, intents, network },
    });
  });
});

describe("a draft that came to show its Timeline", () => {
  const draft = placeOfDraft(network, "bob");

  const refused: ComposerEvent = {
    _tag: "Failed",
    failure: { _tag: "Refused", action: undefined, reason: { _tag: "Offline" }, target: "bob" },
    intent: intentId("web-1"),
    intents: [],
    timeline: draft,
  };

  it("carries its text and notice to the Timeline's composer, and says what answers later there", () => {
    const before = fold([
      { _tag: "Edited", text: "not sent yet", timeline: draft },
      { _tag: "Noticed", message: "said before", timeline: draft },
    ]);

    const carried = reduceComposers(before, { _tag: "Carried", from: draft, to: other });

    const later = reduceComposers(
      reduceComposers(carried, { _tag: "Dismissed", timeline: other }),
      refused
    );

    expect({
      carried: [draftOf(carried, other).text, draftOf(carried, other).notice?.message],
      draft: draftOf(later, draft).notice,
      later: draftOf(later, other).notice?.message.includes("bob"),
    }).toStrictEqual({
      carried: ["not sent yet", "said before"],
      draft: undefined,
      later: true,
    });
  });

  it("keeps what the Timeline's composer holds already", () => {
    const state = reduceComposers(
      fold([
        { _tag: "Edited", text: "under the draft", timeline: draft },
        { _tag: "Edited", text: "under the Timeline", timeline: other },
      ]),
      { _tag: "Carried", from: draft, to: other }
    );

    expect(draftOf(state, other).text).toBe("under the Timeline");
  });
});

/**
 * The composer after `/d` was submitted, which no command reads.
 * @returns The composers.
 */
const complained = () => submit(fold([edited("/d")]), channel, context).state;

const tagOf = (state: Composers, timeline: Place = channel) =>
  draftOf(state, timeline).notice?._tag;

describe("how long a notice lasts", () => {
  const intent = intentId("web-1");

  const refused = (timeline: Place = channel): ComposerEvent => ({
    _tag: "Failed",
    failure: { _tag: "Refused", action: undefined, reason: { _tag: "Offline" }, target: "#iirc" },
    intent,
    intents: [say("hi")],
    timeline,
  });

  const offering = (timeline: Place = channel): ComposerEvent => ({
    _tag: "Failed",
    failure: { _tag: "NotJournaled" },
    intent,
    intents: [say("hi")],
    timeline,
  });

  it("says what a submit could not read as about the text", () => {
    expect(tagOf(complained())).toBe("AboutText");
  });

  it("lets go of a notice about the text as soon as the text is edited", () => {
    const state = complained();

    expect({
      before: tagOf(state),
      edited: tagOf(reduceComposers(state, edited("/de"))),
      emptied: tagOf(reduceComposers(state, edited(""))),
      same: tagOf(reduceComposers(state, edited("/d"))),
    }).toStrictEqual({
      before: "AboutText",
      edited: undefined,
      emptied: undefined,
      same: "AboutText",
    });
  });

  it("lets go of a notice about the text when the text is recalled from the history, and not when nothing is", () => {
    const sentOne = sendAll(["hello"]);
    const state = reduceComposers(sentOne, edited("/d"));
    const complaint = submit(state, channel, context).state;

    const recalled = reduceComposers(complaint, {
      _tag: "Recalled",
      direction: "Older",
      timeline: channel,
    });

    const nothing = reduceComposers(complained(), {
      _tag: "Recalled",
      direction: "Older",
      timeline: channel,
    });

    expect({
      nothing: tagOf(nothing),
      recalled: [tagOf(recalled), draftOf(recalled, channel).text],
    }).toStrictEqual({ nothing: "AboutText", recalled: [undefined, "hello"] });
  });

  it("lets go of a notice about the text when the composer turns to another Timeline, and the text stays", () => {
    const state = reduceComposers(complained(), { _tag: "Left", timeline: channel });

    expect([tagOf(state), draftOf(state, channel).text]).toStrictEqual([undefined, "/d"]);
  });

  it("turns away from a Timeline with no notice about its text, touching nothing", () => {
    const state = fold([edited("hello")]);
    const away = reduceComposers(state, { _tag: "Left", timeline: channel });
    const never = reduceComposers(state, { _tag: "Left", timeline: other });

    expect({
      away: away === state,
      made: never.drafts.has(other),
      never: never === state,
    }).toStrictEqual({ away: true, made: false, never: true });
  });

  it("keeps a refused Credential's notice on the draft it cleared, until the text is edited", () => {
    const { state } = submit(
      fold([edited("/set network.libera.password secret")]),
      channel,
      context
    );

    const cleared = reduceComposers(state, edited(""));

    expect({
      cleared: [tagOf(cleared), draftOf(cleared, channel).text],
      refused: [tagOf(state), draftOf(state, channel).text],
      typed: tagOf(reduceComposers(state, edited("hi"))),
    }).toStrictEqual({
      cleared: ["AboutText", ""],
      refused: ["AboutText", ""],
      typed: undefined,
    });
  });

  it("says that a draft with text was not replaced as about the text, so clearing it lets the notice go", () => {
    const state = started(fold([edited("hello")]), channel, "/me ");

    expect({
      before: tagOf(state),
      cleared: tagOf(reduceComposers(state, edited(""))),
    }).toStrictEqual({ before: "AboutText", cleared: undefined });
  });

  it("keeps a notice with an offer through an edit and through turning away, until it is taken or dismissed", () => {
    const state = fold([edited("hi"), offering()]);

    const through = reduceComposers(reduceComposers(state, edited("hi there")), {
      _tag: "Left",
      timeline: channel,
    });

    const taken = takeOffer(through, channel);
    const dismissed = reduceComposers(through, { _tag: "Dismissed", timeline: channel });

    expect({
      dismissed: tagOf(dismissed),
      taken: [taken.offer?._tag, tagOf(taken.state)],
      through: [tagOf(through), offerOf(draftOf(through, channel).notice)?._tag],
    }).toStrictEqual({
      dismissed: undefined,
      taken: ["SendAgain", undefined],
      through: ["Offering", "SendAgain"],
    });
  });

  it("keeps a notice of an outcome that arrived later through an edit and through turning away, until dismissed", () => {
    const noticed = fold([
      edited("hi"),
      { _tag: "Noticed", message: "the change did not go as asked", timeline: channel },
    ]);

    const failed = fold([edited("hi"), refused()]);

    const through = (state: Composers) =>
      reduceComposers(reduceComposers(state, edited("hi there")), {
        _tag: "Left",
        timeline: channel,
      });

    expect({
      dismissed: tagOf(reduceComposers(through(noticed), { _tag: "Dismissed", timeline: channel })),
      failed: tagOf(through(failed)),
      noticed: tagOf(through(noticed)),
      recalled: tagOf(reduceComposers(reduceComposers(sendAll(["one"]), refused()), up())),
    }).toStrictEqual({
      dismissed: undefined,
      failed: "Outcome",
      noticed: "Outcome",
      recalled: "Outcome",
    });
  });

  it("lets go of an outcome at the next submit that is sent, and replaces it at one that is refused", () => {
    const noticed = fold([
      { _tag: "Noticed", message: "the change did not go as asked", timeline: channel },
      edited("hello"),
    ]);

    const sent = submit(noticed, channel, context);
    const bad = submit(reduceComposers(noticed, edited("/d")), channel, context);

    expect({
      bad: tagOf(bad.state),
      sent: [tagOf(sent.state), sent.intents.length],
    }).toStrictEqual({ bad: "AboutText", sent: [undefined, 1] });
  });

  it("keeps an offer through a later submit that is sent, and through lines waiting and confirmed", () => {
    const state = fold([edited("hi"), offering(), edited("something else")]);
    const sent = submit(state, channel, context);
    const many = ["one", "two", "three", "four", "five", "six"].join("\n");
    const waiting = submit(reduceComposers(state, edited(many)), channel, context);
    const confirmed = confirm(waiting.state, channel);

    expect({
      confirmed: [tagOf(confirmed.state), confirmed.intents.length],
      sent: [tagOf(sent.state), offerOf(draftOf(sent.state, channel).notice)?._tag],
      waiting: [tagOf(waiting.state), draftOf(waiting.state, channel).confirming?.lines],
    }).toStrictEqual({
      confirmed: ["Offering", 6],
      sent: ["Offering", "SendAgain"],
      waiting: ["Offering", 6],
    });
  });

  it("lets go of an outcome at Enter on an empty composer, and keeps an offer and a complaint there", () => {
    const empty = (event: ComposerEvent) =>
      tagOf(submit(reduceComposers(initialComposers, event), channel, context).state);

    const complaint = reduceComposers(
      submit(fold([edited("/d")]), channel, context).state,
      // The same text again, as the runtime sets it: nothing was edited.
      edited("/d")
    );

    expect({
      complaint: tagOf(complaint),
      offering: empty(offering()),
      outcome: empty({ _tag: "Noticed", message: "no", timeline: channel }),
    }).toStrictEqual({ complaint: "AboutText", offering: "Offering", outcome: undefined });
  });

  it("carries a draft's offer and outcome to its Timeline, and leaves a notice about its text behind", () => {
    const draft = placeOfDraft(network, "bob");

    const carry = (event: ComposerEvent) => {
      const state = reduceComposers(fold([edited("hi", draft)]), event);

      return tagOf(reduceComposers(state, { _tag: "Carried", from: draft, to: other }), other);
    };

    const complaint = submit(fold([edited("/d", draft)]), draft, {
      ...context,
      draft: undefined,
    }).state;

    expect({
      complaint: tagOf(
        reduceComposers(complaint, { _tag: "Carried", from: draft, to: other }),
        other
      ),
      offering: carry(offering(draft)),
      outcome: carry({ _tag: "Noticed", message: "no", timeline: draft }),
    }).toStrictEqual({ complaint: undefined, offering: "Offering", outcome: "Outcome" });
  });
});
