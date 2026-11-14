/**
 * CTCP requests and replies. Self answers `VERSION`, `PING`, `TIME`, and `CLIENTINFO`
 * with a `NOTICE` to the User who asked, within a budget, unless the Configuration turns
 * answers off. Every request is Activity with what became of it, and so is every reply.
 */
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { FeatureName } from "../ids.ts";
import type { News } from "../news.ts";
import { register, registry } from "../registry.ts";
import type { State } from "../state.ts";
import { configured, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannel = [registered(base), joined(base, "#iirc", ["peer"])];

const played = (transcript: readonly string[]) => play(client, { configuration: base, transcript });

// The Target of each NOTICE sent.
const notices = (run: Played<State>): readonly unknown[] =>
  run.steps.flatMap((step) =>
    step.outputs.flatMap((output) =>
      output._tag === "Send" && output.line.command === "NOTICE" ? [output.line.params[0]] : []
    )
  );

const requests = (run: Played<State>): readonly Extract<News, { _tag: "Activity" }>[] =>
  run.steps.flatMap((step) =>
    step.news.flatMap((news) =>
      news._tag === "Activity" && news.activity._tag === "CtcpRequest" ? [news] : []
    )
  );

describe("a CTCP request Self answers", () => {
  it("answers VERSION, PING, TIME, and CLIENTINFO with a NOTICE to the User who asked", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "?? activity CtcpRequest peer iirc VERSION answered=iirc in=existing-direct:peer in=network",
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01PING 1767225600 123\\x01",
        ">>\\ NOTICE peer :\\x01PING 1767225600 123\\x01",
        '?? activity CtcpRequest peer iirc PING answered="1767225600 123" in=existing-direct:peer in=network :1767225600 123',
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01TIME\\x01",
        ">>\\ NOTICE peer :\\x01TIME Thu, 01 Jan 2026 00:00:00 GMT\\x01",
        '?? activity CtcpRequest peer iirc TIME answered="Thu, 01 Jan 2026 00:00:00 GMT" in=existing-direct:peer in=network'
      ),
    ]);

    expect.assertions(0);
  });

  it("lists in CLIENTINFO the CTCP it understands", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01clientinfo\\x01",
        ">>\\ NOTICE peer :\\x01CLIENTINFO ACTION CLIENTINFO PING TIME VERSION\\x01",
        '?? activity CtcpRequest peer iirc CLIENTINFO answered="ACTION CLIENTINFO PING TIME VERSION" in=existing-direct:peer in=network'
      ),
    ]);

    expect.assertions(0);
  });

  it("answers a request to a Channel to the User who asked, never to the Channel", () => {
    const run = played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG #iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "?? activity CtcpRequest peer #iirc VERSION answered=iirc in=channel:#iirc"
      ),
    ]);

    expect(notices(run)).toStrictEqual(["peer"]);
  });

  it("answers TIME with when the request arrived, not when the Ircd says it was sent", () => {
    played([
      registered(base, { offered: ["server-time"] }),
      joined(base, "#iirc", ["peer"]),
      lines(
        "+59s",
        "<<\\ @time=2020-01-01T00:00:00.000Z :peer!u@h PRIVMSG iirc :\\x01TIME\\x01",
        ">>\\ NOTICE peer :\\x01TIME Thu, 01 Jan 2026 00:00:59 GMT\\x01",
        '?? activity CtcpRequest peer iirc TIME answered="Thu, 01 Jan 2026 00:00:59 GMT" at=ircd:t-189388800s@t-189388800s in=existing-direct:peer in=network'
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a CTCP request Self does not answer", () => {
  it("reports an unknown CTCP, and answers nothing", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01FINGER\\x01",
        "?? activity CtcpRequest peer iirc FINGER unanswered=Unknown in=existing-direct:peer in=network",
        "<<\\ :peer!u@h PRIVMSG #iirc :\\x01USERINFO who are you\\x01",
        "?? activity CtcpRequest peer #iirc USERINFO unanswered=Unknown in=channel:#iirc :who are you"
      ),
    ]);

    expect.assertions(0);
  });

  it("still drops a DCC, neither reported nor answered", () => {
    const run = played([
      ...inChannel,
      lines("<<\\ :peer!u@h PRIVMSG iirc :\\x01DCC SEND file 2130706433 5000 10\\x01"),
    ]);

    expect(run.steps.at(-1)).toMatchObject({ news: [], outputs: [] });
  });

  it("answers nothing when the Configuration turns answers off, and still reports each", () => {
    play(client, {
      configuration: configured({ answerCtcp: false }),
      transcript: [
        registered(base),
        lines(
          "<<\\ :peer!u@h PRIVMSG iirc :\\x01VERSION\\x01",
          "?? activity CtcpRequest peer iirc VERSION unanswered=Off in=existing-direct:peer in=network",
          "<<\\ :peer!u@h PRIVMSG iirc :\\x01PING x\\x01",
          "?? activity CtcpRequest peer iirc PING unanswered=Off in=existing-direct:peer in=network :x"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("answers no source that could name a Channel, a mask, or a server", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :#victims!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        "?? activity CtcpRequest #victims iirc VERSION unanswered=Unreachable in=network",
        "<<\\ :$*.test!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        "?? activity CtcpRequest $*.test iirc VERSION unanswered=Unreachable in=network",
        "<<\\ :irc.test PRIVMSG iirc :\\x01VERSION\\x01",
        "?? activity CtcpRequest irc.test iirc VERSION unanswered=Unreachable in=network",
        "<<\\ PRIVMSG iirc :\\x01VERSION\\x01",
        "?? activity CtcpRequest irc.test iirc VERSION unanswered=Unreachable in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("answers no request read from history, and still reports it", () => {
    // Every Line in a batch is history.
    const history: Feature = {
      label: (arrival) => ({
        value: arrival.batch === undefined ? arrival : { ...arrival, live: false },
      }),
      name: FeatureName.make("history"),
      needs: {},
      own: undefined,
    };

    play(makeClient([...registry, register(history)]), {
      configuration: base,
      transcript: [
        registered(base, { offered: ["batch"] }),
        joined(base, "#iirc", ["peer"]),
        lines(
          "<< :irc.test BATCH +h chathistory iirc",
          "<<\\ @batch=h :peer!u@h PRIVMSG iirc :\\x01VERSION\\x01",
          "?? activity CtcpRequest peer iirc VERSION unanswered=History history in=existing-direct:peer in=network",
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("answers no request of Self's own, and reports none, as an echo of its answer", () => {
    const run = played([
      ...inChannel,
      lines(
        "<<\\ :iirc!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        "<<\\ :iirc!u@h NOTICE peer :\\x01VERSION iirc\\x01"
      ),
    ]);

    expect(run.steps.slice(-2)).toMatchObject([
      { news: [], outputs: [] },
      { news: [], outputs: [] },
    ]);
  });

  it("answers no PING it cannot send whole, and never cuts it short", () => {
    const long = "x".repeat(480);

    const run = played([
      ...inChannel,
      lines(
        `<<\\ :peer!u@h PRIVMSG iirc :\\x01PING ${long}\\x01`,
        `?? activity CtcpRequest peer iirc PING unanswered=Unsendable in=existing-direct:peer in=network :${long}`
      ),
    ]);

    expect(notices(run)).toStrictEqual([]);
  });
});

describe("the budget for answers", () => {
  it("answers a few at once, then one every ten seconds, and reports every request over it", () => {
    const flood = Array.from(
      { length: 50 },
      (_, index) => `<<\\ :peer${index}!u@h PRIVMSG #iirc :\\x01VERSION\\x01\n...\n`
    );

    const run = played([...inChannel, ...flood, "+10s\n", ...flood, "+60s\n", ...flood]);

    const answers = requests(run).map(({ activity }) =>
      activity._tag === "CtcpRequest" ? activity.answer._tag : undefined
    );

    // Three at once, one after ten seconds, and three again once the budget has refilled.
    expect(notices(run)).toHaveLength(7);
    expect(answers.filter((answer) => answer === "Answered")).toHaveLength(7);
    expect(answers).toHaveLength(150);
    expect(
      requests(run).filter(
        ({ activity }) =>
          activity._tag === "CtcpRequest" &&
          activity.answer._tag === "Unanswered" &&
          activity.answer.reason === "Limited"
      )
    ).toHaveLength(143);
  });

  it("never sends more than three answers plus one for every ten seconds, however requests come", () => {
    const steps = Array.from({ length: 600 }, (_, index) =>
      index % 7 === 0 ? "+1s\n" : `<<\\ :peer!u@h PRIVMSG iirc :\\x01PING ${index}\\x01\n...\n`
    );

    const run = played([...inChannel, ...steps]);
    const seconds = steps.filter((step) => step === "+1s\n").length;

    expect(notices(run).length).toBeLessThanOrEqual(3 + Math.floor(seconds / 10));
  });

  it("spends nothing on a request it does not answer", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01FINGER\\x01",
        "...",
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01FINGER\\x01",
        "...",
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01FINGER\\x01",
        "...",
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01FINGER\\x01",
        "...",
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "..."
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a CTCP reply", () => {
  it("is Activity that names who replied, and with what, and answers nothing", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h NOTICE iirc :\\x01VERSION irssi 1.4\\x01",
        "?? activity CtcpReply peer iirc VERSION in=existing-direct:peer in=network :irssi 1.4",
        "<<\\ :peer!u@h NOTICE iirc :\\x01PING 123",
        "?? activity CtcpReply peer iirc PING in=existing-direct:peer in=network :123"
      ),
    ]);

    expect.assertions(0);
  });
});
