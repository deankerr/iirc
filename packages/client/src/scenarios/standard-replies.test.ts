/**
 * Standard replies: `FAIL`, `WARN`, and `NOTE`, read by their command and code. One that
 * answers something Self sent is shown with it, by label where there is one and by command
 * otherwise, and one that answers nothing is shown in the Network's Timeline. Nothing is
 * decided from a description's text.
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

const echo = ["batch", "echo-message", "labeled-response"];

const inChannel = (offered: readonly string[] = []) => [
  registered(base, { offered: [...offered] }),
  joined(base, "#iirc", ["peer"]),
];

const played = (transcript: readonly string[]) => play(client, { configuration: base, transcript });

const replies = (run: Played<State>): readonly Extract<News, { _tag: "Activity" }>[] =>
  run.steps.flatMap((step) =>
    step.news.flatMap((news) =>
      news._tag === "Activity" && news.activity._tag === "StandardReply" ? [news] : []
    )
  );

const refusals = (run: Played<State>): readonly Extract<News, { _tag: "Refused" }>[] =>
  run.steps.flatMap((step) => step.news.flatMap((news) => (news._tag === "Refused" ? [news] : [])));

const confirmations = (run: Played<State>): number =>
  run.steps.flatMap((step) => step.news.filter((news) => news._tag === "Confirmed")).length;

describe("a WARN or NOTE answering what Self sent, by label", () => {
  it("is shown in the Timeline a Say's Message stands in, and neither confirms nor refuses it", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! say #iirc :hello",
        ">> @label=l1 PRIVMSG #iirc hello",
        "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 echo :hello",
        "<< @label=l1 :irc.test BATCH +r labeled-response",
        "<< @batch=r :irc.test WARN PRIVMSG INVALID_UTF8 :Modified",
        "?? activity StandardReply WARN PRIVMSG INVALID_UTF8 in=channel:#iirc :Modified",
        "<< @batch=r :iirc!u@h PRIVMSG #iirc :hello",
        "?? confirmed i1 :hello",
        "<< :irc.test BATCH -r",
        "!! say peer :psst",
        ">> @label=l2 PRIVMSG peer psst",
        "?? message Privmsg iirc peer at=ours:t+0s in=direct:peer ours=i2 echo :psst",
        "<< @label=l2 :irc.test NOTE PRIVMSG QUEUED peer :Held for a moment",
        "?? activity StandardReply NOTE PRIVMSG QUEUED context=peer in=direct:peer :Held for a moment"
      ),
    ]);

    expect.assertions(0);
  });

  it("is shown where an action belongs, and settles nothing: a later error still refuses it", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! topic #iirc :one",
        ">> @label=l1 TOPIC #iirc one",
        "<< @label=l1 :irc.test BATCH +r labeled-response",
        "<< @batch=r :irc.test NOTE TOPIC SLOW #iirc :Working on it",
        "?? activity StandardReply NOTE TOPIC SLOW context=#iirc in=channel:#iirc :Working on it",
        "<< @batch=r :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i1 Rejected 482 topic=#iirc in=channel:#iirc",
        "<< :irc.test BATCH -r"
      ),
    ]);

    expect.assertions(0);
  });

  it("is kept on a Lookup's result, which a FAIL still ends by its code", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! whois peer",
        ">> @label=l1 WHOIS peer",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test WARN WHOIS SLOW peer :Took a while",
        "<< @batch=b1 :irc.test 311 iirc peer ~u peer.test * :Peer",
        "<< @batch=b1 :irc.test 318 iirc peer :End",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 whois=peer found profiles=1 note=WARN:SLOW",
        "!! whowas gone",
        ">> @label=l2 WHOWAS gone",
        "<< @label=l2 :irc.test BATCH +b2 labeled-response",
        "<< @batch=b2 :irc.test NOTE WHOWAS PARTIAL :Some history is missing",
        "<< @batch=b2 :irc.test FAIL WHOWAS TEMPORARILY_UNAVAILABLE :Try later",
        "<< :irc.test BATCH -b2",
        "?? looked-up i2 whowas=gone failed=TEMPORARILY_UNAVAILABLE note=NOTE:PARTIAL"
      ),
    ]);

    const looked = run.steps.flatMap((step) =>
      step.news.flatMap((news) => (news._tag === "LookedUp" ? [news.result] : []))
    );

    expect(looked[0]).toMatchObject({
      notes: [
        {
          code: "SLOW",
          command: "WHOIS",
          context: ["peer"],
          description: "Took a while",
          kind: "WARN",
        },
      ],
    });
  });
});

describe("a standard reply after the echo, in the same labelled answer", () => {
  it("is shown in the Say's Timeline, and confirms the Message only once", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! say #iirc :hello",
        ">> @label=l1 PRIVMSG #iirc hello",
        "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 echo :hello",
        "<< @label=l1 :irc.test BATCH +r labeled-response",
        "<< @batch=r :iirc!u@h PRIVMSG #iirc :hello",
        "?? confirmed i1 :hello",
        "<< @batch=r :irc.test WARN PRIVMSG INVALID_UTF8 :Modified",
        "?? activity StandardReply WARN PRIVMSG INVALID_UTF8 in=channel:#iirc :Modified",
        "<< @batch=r :irc.test NOTE PRIVMSG QUEUED #iirc :Held for a moment",
        "?? activity StandardReply NOTE PRIVMSG QUEUED context=#iirc in=channel:#iirc :Held for a moment",
        "<< @batch=r :iirc!u@h PRIVMSG #iirc :hello again",
        "<< :irc.test BATCH -r"
      ),
    ]);

    expect(confirmations(run)).toBe(1);
    expect(refusals(run)).toHaveLength(0);
  });

  it("shows a FAIL after the echo too, and refuses nothing", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! say #iirc :hello",
        ">> @label=l1 PRIVMSG #iirc hello",
        "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 echo :hello",
        "<< @label=l1 :irc.test BATCH +r labeled-response",
        "<< @batch=r :iirc!u@h PRIVMSG #iirc :hello",
        "?? confirmed i1 :hello",
        "<< @batch=r :irc.test FAIL PRIVMSG TOO_LATE :Late",
        "?? activity StandardReply FAIL PRIVMSG TOO_LATE in=channel:#iirc :Late",
        "<< :irc.test BATCH -r"
      ),
    ]);

    expect(refusals(run)).toHaveLength(0);
  });

  it("is shown where an action belongs after its FAIL, which refuses it once", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! topic #iirc :one",
        ">> @label=l1 TOPIC #iirc one",
        "<< @label=l1 :irc.test BATCH +r labeled-response",
        "<< @batch=r :irc.test FAIL TOPIC NO_PERMISSION #iirc :Not allowed",
        "?? refused i1 Rejected NO_PERMISSION topic=#iirc in=channel:#iirc",
        "<< @batch=r :irc.test FAIL TOPIC STILL_NO #iirc :Really not",
        "<< @batch=r :irc.test NOTE TOPIC ADVICE #iirc :Ask an operator",
        "?? activity StandardReply NOTE TOPIC ADVICE context=#iirc in=channel:#iirc :Ask an operator",
        "<< :irc.test BATCH -r"
      ),
    ]);

    expect(refusals(run)).toHaveLength(1);
  });

  it("stops being tied to the Say once the batch ends", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! say #iirc :hello",
        ">> @label=l1 PRIVMSG #iirc hello",
        "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 echo :hello",
        "<< @label=l1 :irc.test BATCH +r labeled-response",
        "<< @batch=r :iirc!u@h PRIVMSG #iirc :hello",
        "?? confirmed i1 :hello",
        "<< :irc.test BATCH -r",
        "<< @label=l1 :irc.test WARN PRIVMSG LATE :Long after",
        "?? activity StandardReply WARN PRIVMSG LATE in=network :Long after"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a FAIL answering what Self sent", () => {
  it("refuses the oldest action awaiting an answer with its command, without a label", () => {
    played([
      ...inChannel(),
      lines(
        "!! quote FROB x",
        ">> FROB x",
        "<< :irc.test FAIL frob DISABLED :Frobbing is off",
        "?? refused i1 Rejected DISABLED raw=FROB in=network"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a WARN or NOTE without a label", () => {
  it("is tied by its command to the oldest action awaiting an answer, and settles nothing", () => {
    played([
      ...inChannel(),
      lines(
        "!! topic #iirc :one",
        ">> TOPIC #iirc one",
        "<< :irc.test WARN TOPIC TRUNCATED #iirc :Topic shortened",
        "?? activity StandardReply WARN TOPIC TRUNCATED context=#iirc in=channel:#iirc :Topic shortened",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i1 Rejected 482 topic=#iirc in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("is shown in the Network's Timeline for the command *, or one nothing awaits", () => {
    played([
      ...inChannel(),
      lines(
        "<< :irc.test NOTE * OPER_MESSAGE :The server restarts soon",
        "?? activity StandardReply NOTE * OPER_MESSAGE in=network :The server restarts soon",
        "!! topic #iirc :one",
        ">> TOPIC #iirc one",
        "<< :irc.test NOTE KICK UNRELATED a b :Nothing of ours",
        "?? activity StandardReply NOTE KICK UNRELATED context=a context=b in=network :Nothing of ours"
      ),
    ]);

    expect.assertions(0);
  });

  it("is kept on a Lookup on the floor whose command it names", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test NOTE WHOIS CACHED :From cache",
        "<< :irc.test 311 iirc peer ~u peer.test * :Peer",
        "<< :irc.test 318 iirc peer :End",
        "?? looked-up i1 whois=peer found profiles=1 note=NOTE:CACHED"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a standard reply for a PRIVMSG or NOTICE, without a label", () => {
  it("is shown in the Channel the latest Say of that command went to", () => {
    played([
      ...inChannel(),
      lines(
        "!! say #iirc :one",
        ">> PRIVMSG #iirc one",
        "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 :one",
        "<< :irc.test WARN PRIVMSG MODIFIED :Changed",
        "?? activity StandardReply WARN PRIVMSG MODIFIED in=channel:#iirc :Changed"
      ),
    ]);

    expect.assertions(0);
  });

  it("is shown with the Direct partner of the latest NOTICE, and not with a PRIVMSG's", () => {
    played([
      ...inChannel(),
      lines(
        "!! notice peer :psst",
        ">> NOTICE peer psst",
        "?? message Notice iirc peer at=ours:t+0s in=direct:peer ours=i1 :psst",
        "!! say #iirc :loud",
        ">> PRIVMSG #iirc loud",
        "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i2 :loud",
        "<< :irc.test NOTE NOTICE QUEUED :Held",
        "?? activity StandardReply NOTE NOTICE QUEUED in=direct:peer :Held",
        "<< :irc.test NOTE PRIVMSG QUEUED :Held",
        "?? activity StandardReply NOTE PRIVMSG QUEUED in=channel:#iirc :Held"
      ),
    ]);

    expect.assertions(0);
  });

  it("follows the Say most recent for its command, and the casemapping now in force", () => {
    played([
      ...inChannel(),
      lines(
        "!! say #iirc :one",
        ">> PRIVMSG #iirc one",
        "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 :one",
        "!! say peer :two",
        ">> PRIVMSG peer two",
        "?? message Privmsg iirc peer at=ours:t+0s in=direct:peer ours=i2 :two",
        "<< :irc.test WARN privmsg MODIFIED :Changed",
        "?? activity StandardReply WARN privmsg MODIFIED in=direct:peer :Changed"
      ),
    ]);

    expect.assertions(0);
  });

  it("shows a FAIL there, and refuses nothing", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! say peer :psst",
        ">> PRIVMSG peer psst",
        "?? message Privmsg iirc peer at=ours:t+0s in=direct:peer ours=i1 :psst",
        "<< :irc.test FAIL PRIVMSG CANNOT_SEND :Not allowed",
        "?? activity StandardReply FAIL PRIVMSG CANNOT_SEND in=direct:peer :Not allowed"
      ),
    ]);

    expect(refusals(run)).toHaveLength(0);
  });

  it("is shown in the Network's Timeline when nothing of that command was said", () => {
    played([
      ...inChannel(),
      lines(
        "<< :irc.test WARN PRIVMSG MODIFIED :Changed",
        "?? activity StandardReply WARN PRIVMSG MODIFIED in=network :Changed",
        "!! notice peer :psst",
        ">> NOTICE peer psst",
        "?? message Notice iirc peer at=ours:t+0s in=direct:peer ours=i1 :psst",
        "<< :irc.test WARN PRIVMSG MODIFIED :Changed",
        "?? activity StandardReply WARN PRIVMSG MODIFIED in=network :Changed"
      ),
    ]);

    expect.assertions(0);
  });

  it("is forgotten when the Connection ends", () => {
    played([
      ...inChannel(),
      lines(
        "!! say #iirc :one",
        ">> PRIVMSG #iirc one",
        "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 :one",
        "== closed Reset",
        "?? session-ended Closed Reset",
        "+2s",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< :irc.test 421 * CAP :Unknown command",
        "<< :irc.test 001 iirc :Welcome",
        ">> JOIN #iirc",
        "<< :irc.test WARN PRIVMSG MODIFIED :Changed",
        "?? activity StandardReply WARN PRIVMSG MODIFIED in=network :Changed"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a standard reply for a Say to a partner who changed nick since", () => {
  it("is shown in the renamed Timeline, by label", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! say peer :psst",
        ">> @label=l1 PRIVMSG peer psst",
        "?? message Privmsg iirc peer at=ours:t+0s in=direct:peer ours=i1 echo :psst",
        "<< :peer!u@h NICK peer2",
        "?? activity NickChanged peer peer2 in=channel:#iirc in=renamed:peer>peer2",
        "<< @label=l1 :irc.test WARN PRIVMSG QUEUED peer :Held for a moment",
        "?? activity StandardReply WARN PRIVMSG QUEUED context=peer in=direct:peer2 :Held for a moment"
      ),
    ]);

    expect.assertions(0);
  });

  it("is shown in the renamed Timeline, without a label", () => {
    played([
      ...inChannel(),
      lines(
        "!! say peer :psst",
        ">> PRIVMSG peer psst",
        "?? message Privmsg iirc peer at=ours:t+0s in=direct:peer ours=i1 :psst",
        "<< :peer!u@h NICK PEER2",
        "?? activity NickChanged peer PEER2 in=channel:#iirc in=renamed:peer>peer2:PEER2",
        "<< :irc.test FAIL PRIVMSG CANNOT_SEND :Not allowed",
        "?? activity StandardReply FAIL PRIVMSG CANNOT_SEND in=direct:peer2:PEER2 :Not allowed"
      ),
    ]);

    expect.assertions(0);
  });

  it("goes on following it through another rename", () => {
    played([
      ...inChannel(),
      lines(
        "!! say peer :psst",
        ">> PRIVMSG peer psst",
        "?? message Privmsg iirc peer at=ours:t+0s in=direct:peer ours=i1 :psst",
        "<< :peer!u@h NICK peer2",
        "?? activity NickChanged peer peer2 in=channel:#iirc in=renamed:peer>peer2",
        "<< :peer2!u@h NICK peer3",
        "?? activity NickChanged peer2 peer3 in=channel:#iirc in=renamed:peer2>peer3",
        "<< :irc.test WARN PRIVMSG QUEUED :Held",
        "?? activity StandardReply WARN PRIVMSG QUEUED in=direct:peer3 :Held"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a standard reply for a Say to a partner whose nick another User took", () => {
  const withBoth = [registered(base, { offered: echo }), joined(base, "#iirc", ["bob", "alice"])];

  const said = lines(
    "!! say bob :hi",
    ">> @label=l1 PRIVMSG bob hi",
    "?? message Privmsg iirc bob at=ours:t+0s in=direct:bob ours=i1 echo :hi",
    "!! say alice :yo",
    ">> @label=l2 PRIVMSG alice yo",
    "?? message Privmsg iirc alice at=ours:t+0s in=direct:alice ours=i2 echo :yo"
  );

  it("is shown in the Network's Timeline, by label, and not in the new Bob's", () => {
    played([
      ...withBoth,
      said,
      lines(
        "<< :bob!u@h QUIT :bye",
        "...",
        "<< :alice!u@h NICK bob",
        "?? activity NickChanged alice bob in=channel:#iirc in=renamed:alice>bob",
        "<< @label=l1 :irc.test WARN PRIVMSG QUEUED bob :Held for a moment",
        "?? activity StandardReply WARN PRIVMSG QUEUED context=bob in=network :Held for a moment",
        "<< @label=l2 :irc.test WARN PRIVMSG QUEUED alice :Held for a moment",
        "?? activity StandardReply WARN PRIVMSG QUEUED context=alice in=direct:bob :Held for a moment"
      ),
    ]);

    expect.assertions(0);
  });

  it("is shown in the Network's Timeline, without a label", () => {
    played([
      registered(base),
      joined(base, "#iirc", ["bob", "alice"]),
      lines(
        "!! notice bob :hi",
        ">> NOTICE bob hi",
        "?? message Notice iirc bob at=ours:t+0s in=direct:bob ours=i1 :hi",
        "!! say alice :yo",
        ">> PRIVMSG alice yo",
        "?? message Privmsg iirc alice at=ours:t+0s in=direct:alice ours=i2 :yo",
        "<< :bob!u@h QUIT :bye",
        "...",
        "<< :alice!u@h NICK bob",
        "?? activity NickChanged alice bob in=channel:#iirc in=renamed:alice>bob",
        "<< :irc.test NOTE NOTICE QUEUED :Held",
        "?? activity StandardReply NOTE NOTICE QUEUED in=network :Held",
        "<< :irc.test NOTE PRIVMSG QUEUED :Held",
        "?? activity StandardReply NOTE PRIVMSG QUEUED in=direct:bob :Held"
      ),
    ]);

    expect.assertions(0);
  });

  it("is still shown with the Say after a plain Quit, which detaches nothing", () => {
    played([
      ...withBoth,
      said,
      lines(
        "<< :bob!u@h QUIT :bye",
        "...",
        "<< @label=l1 :irc.test WARN PRIVMSG QUEUED bob :Held for a moment",
        "?? activity StandardReply WARN PRIVMSG QUEUED context=bob in=direct:bob :Held for a moment"
      ),
    ]);

    expect.assertions(0);
  });

  it("is still shown with the Say when the nick taken was folded the same, in another case", () => {
    played([
      ...withBoth,
      said,
      lines(
        "<< :alice!u@h NICK BOB",
        "?? activity NickChanged alice BOB in=channel:#iirc in=renamed:alice>bob:BOB",
        "<< @label=l1 :irc.test WARN PRIVMSG QUEUED bob :Held for a moment",
        "?? activity StandardReply WARN PRIVMSG QUEUED context=bob in=network :Held for a moment"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("every FAIL that refuses nothing", () => {
  it("is shown where a labelled action belongs, after the first refused it", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! quote FROB x",
        ">> @label=l1 FROB x",
        "<< @label=l1 :irc.test BATCH +r labeled-response",
        "<< @batch=r :irc.test FAIL FROB FIRST x :First failure",
        "?? refused i1 Rejected FIRST raw=FROB in=network",
        "<< @batch=r :irc.test FAIL FROB SECOND y :Another failure",
        "?? activity StandardReply FAIL FROB SECOND context=y in=network :Another failure",
        "<< :irc.test BATCH -r"
      ),
    ]);

    expect(refusals(run)).toHaveLength(1);
  });

  it("is shown where an action belongs on the floor, after another Line of it refused it", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! kick #iirc peer,other :bye",
        ">> KICK #iirc peer bye",
        ">> KICK #iirc other bye",
        "<< :irc.test FAIL KICK FIRST #iirc peer :First failure",
        "?? refused i1 Rejected FIRST kick=#iirc:peer,other in=channel:#iirc",
        "<< :irc.test FAIL KICK SECOND #iirc other :Another failure",
        "?? activity StandardReply FAIL KICK SECOND context=#iirc context=other in=channel:#iirc :Another failure"
      ),
    ]);

    expect(refusals(run)).toHaveLength(1);
  });

  it("is shown where an action belongs, on a second labelled Line of it", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! kick #iirc peer,other :bye",
        ">> @label=l1 KICK #iirc peer bye",
        ">> @label=l2 KICK #iirc other bye",
        "<< @label=l1 :irc.test FAIL KICK FIRST #iirc peer :First failure",
        "?? refused i1 Rejected FIRST kick=#iirc:peer,other in=channel:#iirc",
        "<< @label=l2 :irc.test FAIL KICK SECOND #iirc other :Another failure",
        "?? activity StandardReply FAIL KICK SECOND context=#iirc context=other in=channel:#iirc :Another failure"
      ),
    ]);

    expect(refusals(run)).toHaveLength(1);
  });
});

describe("a FAIL for a Lookup", () => {
  it("ends one sent without a label at once, by its code, and frees its slot", () => {
    // More than a Connection holds at once, each ended by a `FAIL` with no end numeric.
    const pairs = Array.from({ length: 10 }, (_, index) => [
      `!! whois nick${index}`,
      `>> WHOIS nick${index}`,
      `<< :irc.test FAIL WHOIS SOME_CODE nick${index} :No`,
      `?? looked-up i${index + 1} whois=nick${index} failed=SOME_CODE`,
    ]);

    const run = played([...inChannel(), lines(...pairs.flat())]);

    // Only the keepalive is left: no Lookup waits to time out.
    expect([...run.timers.keys()]).toStrictEqual(["keepalive"]);
  });

  it("still waits for the end numeric after an error numeric, and keeps a later FAIL in its notes", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois ghost",
        ">> WHOIS ghost",
        "<< :irc.test 401 iirc ghost :No such nick",
        "<< :irc.test FAIL WHOIS LATE ghost :Also failed",
        "<< :irc.test 318 iirc ghost :End",
        "?? looked-up i1 whois=ghost not-found=401 note=FAIL:LATE"
      ),
    ]);

    expect.assertions(0);
  });

  it("keeps the first FAIL of a labelled reply as its result, and every later one in its notes", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! whowas gone",
        ">> @label=l1 WHOWAS gone",
        "<< @label=l1 :irc.test BATCH +b labeled-response",
        "<< @batch=b :irc.test FAIL WHOWAS FIRST gone :First failure",
        "<< @batch=b :irc.test FAIL WHOWAS SECOND gone :Another failure",
        "<< @batch=b :irc.test NOTE WHOWAS EXTRA :And a note",
        "<< :irc.test BATCH -b",
        "?? looked-up i1 whowas=gone failed=FIRST note=FAIL:SECOND note=NOTE:EXTRA"
      ),
    ]);

    const looked = run.steps.flatMap((step) =>
      step.news.flatMap((news) => (news._tag === "LookedUp" ? [news.result] : []))
    );

    expect(looked[0]).toMatchObject({
      notes: [
        { code: "SECOND", description: "Another failure", kind: "FAIL" },
        { code: "EXTRA", kind: "NOTE" },
      ],
      reply: "FIRST",
    });
  });
});

describe("a FAIL nothing else reads", () => {
  it("is shown in the Network's Timeline, never dropped", () => {
    played([
      ...inChannel(),
      lines(
        "<< :irc.test FAIL CHATHISTORY INVALID_TARGET LATEST #nope :Unknown target",
        "?? activity StandardReply FAIL CHATHISTORY INVALID_TARGET context=LATEST context=#nope in=network :Unknown target",
        "<< :irc.test FAIL * ACCOUNT_REQUIRED :Authentication required",
        "?? activity StandardReply FAIL * ACCOUNT_REQUIRED in=network :Authentication required"
      ),
    ]);

    expect.assertions(0);
  });
});

// The Activity a `WARN` for an action gives, with its description cleared.
const warned = (description: string) =>
  replies(
    played([
      ...inChannel(),
      lines(
        "!! topic #iirc :one",
        ">> TOPIC #iirc one",
        `<< :irc.test WARN TOPIC TRUNCATED #iirc :${description}`,
        "..."
      ),
    ])
  ).map((news) => ({ ...news, activity: { ...news.activity, description: "" } }));

describe("reading a standard reply", () => {
  it("decides nothing from its description", () => {
    expect(warned("Topic shortened")).toStrictEqual(warned("Your topic was rejected entirely"));
    expect(warned("Topic shortened")).toHaveLength(1);
  });

  it("is Malformed with fewer than a command, a code, and a description", () => {
    played([
      ...inChannel(),
      lines(
        "<< :irc.test WARN PRIVMSG :Only two",
        "?? ignored Malformed WARN",
        "<< :irc.test FAIL",
        "?? ignored Malformed FAIL"
      ),
    ]);

    expect.assertions(0);
  });

  it("is reported from history in the Network's Timeline, and moves nothing", () => {
    // Every Line the batch Feature says is in a batch is history.
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
        ...inChannel(["batch"]),
        lines(
          "!! quote FROB x",
          ">> FROB x",
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h :irc.test FAIL FROB DISABLED :Long ago",
          "?? activity StandardReply FAIL FROB DISABLED history in=network :Long ago",
          "<< :irc.test BATCH -h",
          "<< :irc.test 421 iirc FROB :Unknown command",
          "?? refused i1 Rejected 421 raw=FROB in=network"
        ),
      ],
    });

    expect.assertions(0);
  });
});
