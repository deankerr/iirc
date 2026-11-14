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

describe("a FAIL answering what Self sent", () => {
  it("still refuses a labelled action, by its code", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! topic #iirc :one",
        ">> @label=l1 TOPIC #iirc one",
        "<< @label=l1 :irc.test FAIL TOPIC NO_PERMISSION #iirc :Not allowed",
        "?? refused i1 Rejected NO_PERMISSION topic=#iirc in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

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
