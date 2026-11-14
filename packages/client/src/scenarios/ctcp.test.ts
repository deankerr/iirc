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
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";
import { openOf } from "../views.ts";

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

describe("an answer that never left", () => {
  it("is reported where the request was, in the Network's Timeline for one sent to Self", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "?? activity CtcpRequest peer iirc VERSION answered=iirc in=existing-direct:peer in=network",
        "== unsent 1",
        "?? activity CtcpUnsent peer iirc VERSION in=existing-direct:peer in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is reported in the Channel a request to a Channel was sent to", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG #iirc :\\x01PING 1\\x01",
        ">>\\ NOTICE peer :\\x01PING 1\\x01",
        "?? activity CtcpRequest peer #iirc PING answered=1 in=channel:#iirc :1",
        "== unsent 1",
        "?? activity CtcpUnsent peer #iirc PING in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("is reported after its Connection ended, since it still never left", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG #iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "...",
        "== closed Reset",
        "...",
        "== connection 1",
        "== unsent 1",
        "?? activity CtcpUnsent peer #iirc VERSION in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("sends nothing, and leaves a Say's Unsent as it was", () => {
    const run = played([
      ...inChannel,
      lines(
        "!! say #iirc :hi",
        ">> PRIVMSG #iirc hi",
        "...",
        "<<\\ :peer!u@h PRIVMSG #iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "...",
        "== unsent 2",
        "?? refused i1 Unsent",
        "?? activity CtcpUnsent peer #iirc VERSION in=channel:#iirc"
      ),
    ]);

    expect(run.steps.at(-1)?.outputs).toStrictEqual([]);
  });
});

describe("an answer that never left, after the Network changed since its request", () => {
  it("is reported in the Channel the request was in, though its name no longer reads as one", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG #iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "?? activity CtcpRequest peer #iirc VERSION answered=iirc in=channel:#iirc",
        "<< :irc.test 005 iirc CHANTYPES=& :are supported by this server",
        "== unsent 1",
        "?? activity CtcpUnsent peer #iirc VERSION in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("is reported in the Network's Timeline for a request to Self, though Channels changed", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "?? activity CtcpRequest peer iirc VERSION answered=iirc in=existing-direct:peer in=network",
        "<< :irc.test 005 iirc CHANTYPES=i :are supported by this server",
        "== unsent 1",
        "?? activity CtcpUnsent peer iirc VERSION in=existing-direct:peer in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is reported in the Timeline of the partner who asked, after they changed nick", () => {
    played([
      ...inChannel,
      lines(
        "<<\\ :peer!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE peer :\\x01VERSION iirc\\x01",
        "?? activity CtcpRequest peer iirc VERSION answered=iirc in=existing-direct:peer in=network",
        "<< :peer!u@h NICK other",
        "?? activity NickChanged peer other in=channel:#iirc in=renamed:peer>other",
        "<< :other!u@h NICK third",
        "?? activity NickChanged other third in=channel:#iirc in=renamed:other>third",
        "== unsent 1",
        "?? activity CtcpUnsent peer iirc VERSION in=existing-direct:third in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is reported in the Network's Timeline alone once another User took the nick that asked", () => {
    played([
      registered(base),
      joined(base, "#iirc", ["bob", "alice"]),
      lines(
        "<<\\ :bob!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE bob :\\x01VERSION iirc\\x01",
        "?? activity CtcpRequest bob iirc VERSION answered=iirc in=existing-direct:bob in=network",
        "<< :bob!u@h QUIT :bye",
        "...",
        "<< :alice!u@h NICK bob",
        "?? activity NickChanged alice bob in=channel:#iirc in=renamed:alice>bob",
        "== unsent 1",
        "?? activity CtcpUnsent bob iirc VERSION in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is reported in the Network's Timeline alone once later answers pushed it out of memory", () => {
    // Robert asked as bob, then 64 later answers to peer push his out, then alice takes
    // `bob`. Placed by the nick that asked, the report would land with alice.
    const later = Array.from({ length: 64 }, (_, index) =>
      lines(
        "+10s",
        `<<\\ :peer!u@h PRIVMSG iirc :\\x01PING ${index}\\x01`,
        `>>\\ NOTICE peer :\\x01PING ${index}\\x01`
      )
    );

    played([
      registered(base),
      joined(base, "#iirc", ["bob", "alice", "peer"]),
      lines(
        "<<\\ :bob!u@h PRIVMSG iirc :\\x01VERSION\\x01",
        ">>\\ NOTICE bob :\\x01VERSION iirc\\x01",
        "<< :bob!u@h NICK robert"
      ),
      ...later,
      lines(
        "<< :alice!u@h NICK bob",
        "== unsent 65",
        "?? activity CtcpUnsent bob iirc VERSION in=network"
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

// The token Self's `PING` carries: the instant it was sent, in milliseconds.
const sentAt = "1767225600000";

// What the Ircd says to a request, from `peer`, back to Self.
const pong = (token: string, from = "peer") =>
  `<<\\ :${from}!u@h NOTICE iirc :\\x01PING ${token}\\x01`;

const remembered = (run: Played<State>): readonly unknown[] =>
  openOf(run.state)?.pings.map((ping) => ping.token) ?? [];

describe("a CTCP request the Owner sends", () => {
  it("goes to the User verbatim, upper-cased, and is reported where their replies go", () => {
    played([
      ...inChannel,
      lines(
        "!! ctcp peer version",
        ">>\\ PRIVMSG peer \\x01VERSION\\x01",
        "?? activity CtcpSent peer VERSION in=existing-direct:peer in=network",
        "!! ctcp peer FINGER :are you there",
        ">>\\ PRIVMSG peer :\\x01FINGER are you there\\x01",
        "?? activity CtcpSent peer FINGER in=existing-direct:peer in=network :are you there",
        "<<\\ :peer!u@h NOTICE iirc :\\x01VERSION irssi 1.4\\x01",
        "?? activity CtcpReply peer iirc VERSION in=existing-direct:peer in=network :irssi 1.4"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused for a Channel, a STATUSMSG Target, or a mask, and nothing is sent", () => {
    const run = played([
      registered(base, { isupport: [...floorIsupport, "STATUSMSG=@+"] }),
      lines(
        "!! ctcp #iirc VERSION",
        "?? refused i1 Unsendable ctcp=#iirc:VERSION in=network",
        "!! ping #iirc",
        "?? refused i2 Unsendable ping=#iirc in=network",
        "!! ctcp @#iirc VERSION",
        '?? refused i3 Unsendable ctcp="@#iirc":VERSION in=network',
        "!! ping $*.test",
        "?? refused i4 Unsendable ping=$*.test in=network",
        "!! ctcp peer,other VERSION",
        "?? refused i5 Unsendable ctcp=peer,other:VERSION in=network"
      ),
    ]);

    expect(run.steps.slice(-5).flatMap((step) => step.outputs)).toStrictEqual([]);
  });

  it("is refused as ACTION, which is a Message, or DCC, which is never sent", () => {
    const run = played([
      registered(base),
      lines(
        "!! ctcp peer action :waves",
        "?? refused i1 Unsendable ctcp=peer:ACTION in=network",
        "!! ctcp peer Dcc :SEND file 2130706433 5000 10",
        "?? refused i2 Unsendable ctcp=peer:DCC in=network"
      ),
    ]);

    expect(run.steps.slice(-2).flatMap((step) => step.outputs)).toStrictEqual([]);
  });

  it("is refused when it cannot be built or sent whole, never cut short", () => {
    played([
      registered(base),
      lines(
        "!! ctcp peer VERSION :one\u0001TWO",
        "?? refused i1 Unsendable ctcp=peer:VERSION in=network",
        `!! ctcp peer VERSION :${"x".repeat(500)}`,
        "?? refused i2 Unsendable ctcp=peer:VERSION in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is Rejected when the Ircd says there is no such nick", () => {
    played([
      registered(base),
      lines(
        "!! ctcp nobody VERSION",
        ">>\\ PRIVMSG nobody \\x01VERSION\\x01",
        "<< :irc.test 401 iirc nobody :No such nick/channel",
        "?? refused i1 Rejected 401 ctcp=nobody:VERSION in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused as Offline without a Session", () => {
    played([
      lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "!! ping peer",
        "?? refused i1 Offline ping=peer in=network",
        "!! ctcp peer VERSION",
        "?? refused i2 Offline ctcp=peer:VERSION in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("with echo-message, is reported once, and its echo adds nothing", () => {
    const run = played([
      registered(base, { offered: ["batch", "echo-message", "labeled-response"] }),
      joined(base, "#iirc", ["peer"]),
      lines(
        "!! ping peer",
        `>>\\ @label=l1 PRIVMSG peer :\\x01PING ${sentAt}\\x01`,
        `?? activity CtcpSent peer PING in=existing-direct:peer in=network :${sentAt}`,
        `<<\\ @label=l1 :iirc!u@h PRIVMSG peer :\\x01PING ${sentAt}\\x01`,
        "+1s",
        pong(sentAt),
        `?? activity CtcpReply peer iirc PING round-trip=1000ms in=existing-direct:peer in=network :${sentAt}`
      ),
    ]);

    expect(run.steps.at(-2)).toMatchObject({ news: [], outputs: [] });
  });
});

describe("a PING the Owner sends", () => {
  it("carries the instant it was sent, and its reply the round trip, by when each was journaled", () => {
    played([
      ...inChannel,
      lines(
        "!! ping peer",
        `>>\\ PRIVMSG peer :\\x01PING ${sentAt}\\x01`,
        `?? activity CtcpSent peer PING in=existing-direct:peer in=network :${sentAt}`,
        "+250ms",
        pong(sentAt, "PEER"),
        `?? activity CtcpReply PEER iirc PING round-trip=250ms in=existing-direct:peer:PEER in=network :${sentAt}`
      ),
    ]);

    expect.assertions(0);
  });

  it("measures a PING sent as a CTCP with the Owner's own token too", () => {
    played([
      ...inChannel,
      lines(
        "!! ctcp peer ping :mine",
        ">>\\ PRIVMSG peer :\\x01PING mine\\x01",
        "+2s",
        pong("mine"),
        "?? activity CtcpReply peer iirc PING round-trip=2000ms in=existing-direct:peer in=network :mine"
      ),
    ]);

    expect.assertions(0);
  });

  it("tells apart PINGs sent in the same instant", () => {
    played([
      ...inChannel,
      lines(
        "!! ping peer",
        `>>\\ PRIVMSG peer :\\x01PING ${sentAt}\\x01`,
        "!! ping peer",
        `>>\\ PRIVMSG peer :\\x01PING ${sentAt}.1\\x01`,
        "+1s",
        pong(`${sentAt}.1`),
        `?? activity CtcpReply peer iirc PING round-trip=1000ms in=existing-direct:peer in=network :${sentAt}.1`,
        "+1s",
        pong(sentAt),
        `?? activity CtcpReply peer iirc PING round-trip=2000ms in=existing-direct:peer in=network :${sentAt}`
      ),
    ]);

    expect.assertions(0);
  });

  it("gives no round trip to a reply with another token, from another User, or unasked for", () => {
    played([
      ...inChannel,
      lines(
        "!! ping peer",
        `>>\\ PRIVMSG peer :\\x01PING ${sentAt}\\x01`,
        "+1s",
        pong("1767225600001"),
        "?? activity CtcpReply peer iirc PING in=existing-direct:peer in=network :1767225600001",
        pong(sentAt, "other"),
        `?? activity CtcpReply other iirc PING in=existing-direct:other in=network :${sentAt}`,
        `<<\\ :irc.test NOTICE iirc :\\x01PING ${sentAt}\\x01`,
        `?? activity CtcpReply irc.test iirc PING in=network :${sentAt}`,
        `<<\\ :peer!u@h NOTICE iirc :\\x01VERSION ${sentAt}\\x01`,
        `?? activity CtcpReply peer iirc VERSION in=existing-direct:peer in=network :${sentAt}`,
        pong(sentAt),
        `?? activity CtcpReply peer iirc PING round-trip=1000ms in=existing-direct:peer in=network :${sentAt}`,
        // Its round trip is told once.
        pong(sentAt),
        `?? activity CtcpReply peer iirc PING in=existing-direct:peer in=network :${sentAt}`
      ),
    ]);

    expect.assertions(0);
  });

  it("gives no round trip to a reply read from history", () => {
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
          "!! ping peer",
          `>>\\ PRIVMSG peer :\\x01PING ${sentAt}\\x01`,
          "<< :irc.test BATCH +h chathistory iirc",
          `<<\\ @batch=h :peer!u@h NOTICE iirc :\\x01PING ${sentAt}\\x01`,
          `?? activity CtcpReply peer iirc PING history in=existing-direct:peer in=network :${sentAt}`,
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("that is never answered sets no timer, and holds only a bounded memory", () => {
    const quiet = played([...inChannel]);

    const pinged = played([
      ...inChannel,
      lines("!! ping peer", `>>\\ PRIVMSG peer :\\x01PING ${sentAt}\\x01`),
    ]);

    expect(pinged.timers).toStrictEqual(quiet.timers);
    expect(remembered(pinged)).toStrictEqual([sentAt]);

    const many = played([
      ...inChannel,
      ...Array.from({ length: 65 }, (_unused, index) => lines(`!! ping p${index}`, "...", "+1ms")),
    ]);

    expect(remembered(many)).toHaveLength(64);
    expect(remembered(many)[0]).toBe("1767225600001");
  });

  it("forgets every PING when the Session ends, so a reply in the next gives no round trip", () => {
    const run = played([
      ...inChannel,
      lines(
        "!! ping peer",
        `>>\\ PRIVMSG peer :\\x01PING ${sentAt}\\x01`,
        "== closed Reset",
        "...",
        "+2s",
        "-> dial irc.test:6697 tls",
        "== opened",
        "...",
        "<< :irc.test 001 iirc :Welcome",
        "...",
        pong(sentAt),
        `?? activity CtcpReply peer iirc PING in=existing-direct:peer in=network :${sentAt}`
      ),
    ]);

    expect(remembered(run)).toStrictEqual([]);
  });
});
