/**
 * The Owner's actions beyond saying: each is built by `@iirc/protocol`, checked against
 * ISUPPORT, sent whole or refused, and tied to the Ircd's error numerics by structure.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { Instant, IntentId } from "../ids.ts";
import type { News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, epoch, floorIsupport, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannel = (isupport: readonly string[] = []) => [
  registered(base, { isupport: [...floorIsupport, ...isupport] }),
  joined(base, "#iirc", ["peer"]),
];

const played = (transcript: readonly string[]) => play(client, { configuration: base, transcript });

const refusals = (run: Played<State>): readonly News[] =>
  run.steps.flatMap((step) => step.news.filter((news) => news._tag === "Refused"));

describe("an action while offline", () => {
  it("is refused as Offline, and nothing is sent", () => {
    const run = played([
      lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "!! topic #iirc :hi",
        "?? refused i1 Offline",
        "!! kick #iirc peer",
        "?? refused i2 Offline",
        "!! mode #iirc +m",
        "?? refused i3 Offline",
        "!! invite peer #iirc",
        "?? refused i4 Offline",
        "!! nick other",
        "?? refused i5 Offline",
        "!! quote WHOIS peer",
        "?? refused i6 Offline"
      ),
    ]);

    expect(run.steps.at(-1)?.outputs).toStrictEqual([]);
  });
});

describe("a topic", () => {
  it("is set, and cleared with an empty topic", () => {
    played([
      ...inChannel(),
      lines(
        "!! topic #iirc :a new topic",
        ">> TOPIC #iirc :a new topic",
        "!! topic #iirc :",
        ">> TOPIC #iirc :"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused when TOPICLEN cannot carry it, never cut short", () => {
    played([
      ...inChannel(["TOPICLEN=5"]),
      lines(
        "!! topic #iirc :abcdef",
        "?? refused i1 Unsendable",
        "!! topic #iirc :abcde",
        ">> TOPIC #iirc abcde",
        "!! topic #iirc :ééé",
        "?? refused i3 Unsendable"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused for a name that is not a Channel's, or a topic with a line break", () => {
    played([
      ...inChannel(),
      lines(
        "!! topic peer :hi",
        "?? refused i1 Unsendable",
        "!! topic #a,#b :hi",
        "?? refused i2 Unsendable"
      ),
    ]);

    const run = play(client, {
      configuration: base,
      transcript: [...inChannel()],
    });

    const step = client.step(run.state, {
      _tag: "Act",
      action: { _tag: "Topic", channel: "#iirc", text: "hi\r\nQUIT" },
      at: Instant.make(epoch),
      intent: IntentId.make("i9"),
    });

    expect(step.outputs).toStrictEqual([]);
    expect(step.news).toStrictEqual([
      { _tag: "Refused", intent: "i9", reason: { _tag: "Unsendable" } },
    ]);
  });

  it("is refused when the Ircd says 482 of its Channel", () => {
    played([
      ...inChannel(),
      lines(
        "!! topic #iirc :mine now",
        ">> TOPIC #iirc :mine now",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i1 Rejected 482"
      ),
    ]);

    expect.assertions(0);
  });

  it("is not refused by an error after the Ircd did it", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! topic #iirc :mine now",
        ">> TOPIC #iirc :mine now",
        "<< :iirc!~iirc@iirc.test TOPIC #iirc :mine now",
        "...",
        "<< :irc.test 482 iirc #iirc :You're not channel operator"
      ),
    ]);

    expect(refusals(run)).toStrictEqual([]);
  });

  it("is not refused by a 482 for another Channel", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! topic #iirc :mine now",
        ">> TOPIC #iirc :mine now",
        "<< :irc.test 482 iirc #other :You're not channel operator"
      ),
    ]);

    expect(refusals(run)).toStrictEqual([]);
  });

  it("is refused as Unsent when its Line never left", () => {
    played([
      ...inChannel(),
      lines("!! topic #iirc :hi", ">> TOPIC #iirc hi", "== unsent 1", "?? refused i1 Unsent"),
    ]);

    expect.assertions(0);
  });

  it("is labelled, and refused by its label, with labeled-response", () => {
    const echo = ["batch", "echo-message", "labeled-response"];

    const run = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: echo }),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! topic #iirc :one",
          ">> @label=l1 TOPIC #iirc one",
          "<< @label=l1 :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i1 Rejected 482",
          "!! topic #iirc :two",
          ">> @label=l2 TOPIC #iirc two",
          "<< @label=l2 :iirc!~iirc@iirc.test TOPIC #iirc two",
          "...",
          "<< :irc.test 482 iirc #iirc :not tied to anything"
        ),
      ],
    });

    expect(refusals(run)).toHaveLength(1);
  });
});

describe("a kick", () => {
  it("sends one nick to a Line without TARGMAX", () => {
    played([
      ...inChannel(),
      lines("!! kick #iirc a,b :bye now", ">> KICK #iirc a :bye now", ">> KICK #iirc b :bye now"),
    ]);

    expect.assertions(0);
  });

  it("shares Lines as TARGMAX allows", () => {
    played([
      ...inChannel(["TARGMAX=KICK:2"]),
      lines("!! kick #iirc a,b,c", ">> KICK #iirc a,b", ">> KICK #iirc c"),
    ]);
    played([
      ...inChannel(["TARGMAX=PRIVMSG:4,KICK:"]),
      lines("!! kick #iirc a,b,c", ">> KICK #iirc a,b,c"),
    ]);

    expect.assertions(0);
  });

  it("is refused when KICKLEN cannot carry its reason, or a nick is not one", () => {
    played([
      ...inChannel(["KICKLEN=3"]),
      lines(
        "!! kick #iirc peer :goodbye",
        "?? refused i1 Unsendable",
        "!! kick #iirc peer :bye",
        ">> KICK #iirc peer bye",
        "!! kick #iirc @peer",
        "?? refused i3 Unsendable",
        "!! kick peer peer",
        "?? refused i4 Unsendable"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused once by 441 naming a nick it kicked, and not again", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! kick #iirc a,b",
        ">> KICK #iirc a",
        ">> KICK #iirc b",
        "<< :irc.test 441 iirc b #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441",
        "<< :irc.test 482 iirc #iirc :You're not channel operator"
      ),
    ]);

    expect(refusals(run)).toHaveLength(1);
  });

  it("awaits each nick of a Line until it is answered, so a later 441 still refuses it", () => {
    const run = played([
      ...inChannel(["TARGMAX=KICK:2"]),
      lines(
        "!! kick #iirc a,b",
        ">> KICK #iirc a,b",
        "<< :iirc!~iirc@iirc.test KICK #iirc a",
        "...",
        "<< :irc.test 441 iirc b #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441"
      ),
    ]);

    expect(refusals(run)).toHaveLength(1);
  });

  it("is refused once when each of its labelled Lines is refused", () => {
    const run = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["batch", "echo-message", "labeled-response"] }),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! kick #iirc a,b",
          ">> @label=l1 KICK #iirc a",
          ">> @label=l2 KICK #iirc b",
          "<< @label=l1 :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i1 Rejected 482",
          "<< @label=l2 :irc.test 482 iirc #iirc :You're not channel operator"
        ),
      ],
    });

    expect(refusals(run)).toHaveLength(1);
  });

  it("is not refused by 441 for a nick it did not kick", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! kick #iirc a",
        ">> KICK #iirc a",
        "<< :irc.test 441 iirc b #iirc :They aren't on that channel"
      ),
    ]);

    expect(refusals(run)).toStrictEqual([]);
  });
});

describe("modes", () => {
  it("are split across Lines by MODES, counting only changes with a parameter", () => {
    played([
      ...inChannel(),
      lines(
        "!! mode #iirc +o=a +o=b +v=c +v=d +m -l",
        ">> MODE #iirc +oov a b c",
        ">> MODE #iirc +vm-l d"
      ),
    ]);
    played([
      ...inChannel(["MODES=1"]),
      lines("!! mode #iirc +o=a -v=b +i", ">> MODE #iirc +o a", ">> MODE #iirc -v+i b"),
    ]);

    expect.assertions(0);
  });

  it("take a parameter exactly as CHANMODES and PREFIX say", () => {
    played([
      ...inChannel(["CHANMODES=b,k,lj,imnt"]),
      lines(
        "!! mode #iirc +j=3:5 -j +k=secret -k=secret +b=*!*@bad.test",
        ">> MODE #iirc +j-j+k-k 3:5 secret secret",
        ">> MODE #iirc +b *!*@bad.test",
        "!! mode #iirc +l",
        "?? refused i2 Unsendable",
        "!! mode #iirc -j=3",
        "?? refused i3 Unsendable",
        "!! mode #iirc +o",
        "?? refused i4 Unsendable",
        "!! mode #iirc +m=x",
        "?? refused i5 Unsendable",
        "!! mode #iirc +x",
        "?? refused i6 Unsendable",
        "!! mode #iirc +k=:x",
        "?? refused i7 Unsendable"
      ),
    ]);

    expect.assertions(0);
  });

  it("await each parameter of a Line until it is answered", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! mode #iirc +o=a +o=b",
        ">> MODE #iirc +oo a b",
        "<< :iirc!~iirc@iirc.test MODE #iirc +o a",
        "...",
        "<< :irc.test 441 iirc b #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441"
      ),
    ]);

    expect(refusals(run)).toHaveLength(1);
  });

  it("change Self's user modes, and no other User's", () => {
    played([
      ...inChannel(),
      lines(
        "!! mode IIRC +i -w",
        ">> MODE IIRC +i-w",
        "!! mode peer +i",
        "?? refused i2 Unsendable"
      ),
    ]);

    expect.assertions(0);
  });

  it("are refused by 482 and 441 naming them", () => {
    played([
      ...inChannel(),
      lines(
        "!! mode #iirc +o=peer",
        ">> MODE #iirc +o peer",
        "<< :irc.test 441 iirc peer #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441",
        "!! mode #iirc +m",
        ">> MODE #iirc +m",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i2 Rejected 482"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("an invite", () => {
  it("is sent, and refused by 443 naming its nick and Channel", () => {
    played([
      ...inChannel(),
      lines(
        "!! invite peer #iirc",
        ">> INVITE peer #iirc",
        "<< :irc.test 443 iirc peer #iirc :is already on channel",
        "?? refused i1 Rejected 443"
      ),
    ]);

    expect.assertions(0);
  });

  it("is answered by 341, after which nothing ties to it", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! invite pal #iirc",
        ">> INVITE pal #iirc",
        "<< :irc.test 341 iirc pal #iirc",
        "<< :irc.test 482 iirc #iirc :You're not channel operator"
      ),
    ]);

    expect(refusals(run)).toStrictEqual([]);
  });

  it("is refused for a nick that is not one", () => {
    played([...inChannel(), lines("!! invite #x #iirc", "?? refused i1 Unsendable")]);

    expect.assertions(0);
  });
});

describe("a nick", () => {
  it("changes Self's nick when the Ircd says so", () => {
    const run = played([
      ...inChannel(),
      lines("!! nick other", ">> NICK other", "<< :iirc!~iirc@iirc.test NICK other"),
    ]);

    expect(client.known(run.state).self?.nick).toBe("other");
  });

  it("is refused by 433 naming it, and Self keeps its nick", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! nick taken",
        ">> NICK taken",
        "<< :irc.test 433 iirc taken :Nickname is already in use",
        "?? refused i1 Rejected 433"
      ),
    ]);

    expect(client.known(run.state).self?.nick).toBe("iirc");
  });

  it("is refused past NICKLEN, or RFC 2812's 9 until the Ircd says, or when not a nick", () => {
    played([
      ...inChannel(),
      lines(
        "!! nick abcdefghij",
        "?? refused i1 Unsendable",
        "!! nick #chan",
        "?? refused i2 Unsendable",
        "!! nick a*",
        "?? refused i3 Unsendable"
      ),
    ]);
    played([...inChannel(["NICKLEN=30"]), lines("!! nick abcdefghij", ">> NICK abcdefghij")]);

    expect.assertions(0);
  });

  it("lasts the Session: the next registers with the Configuration's nicks", () => {
    played([
      ...inChannel(),
      lines(
        "!! nick other",
        ">> NICK other",
        "<< :iirc!~iirc@iirc.test NICK other",
        "...",
        "== closed Reset",
        "+2s",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc"
      ),
    ]);

    expect.assertions(0);
  });
});

const known = (run: Played<State>) => client.known(run.state).self?.away;

describe("away", () => {
  it("is not away as a Session begins", () => {
    expect(known(played([...inChannel()]))).toMatchObject({
      _tag: "Known",
      from: "receipt",
      value: null,
    });
  });

  it("is known as the Ircd confirms it, not as asked", () => {
    const asked = [...inChannel(), lines("!! away :gone fishing", ">> AWAY :gone fishing")];

    expect(known(played(asked))).toMatchObject({ value: null });

    const away = [...asked, lines("<< :irc.test 306 iirc :You have been marked as being away")];

    expect(known(played(away))).toMatchObject({
      _tag: "Known",
      from: "ircd",
      value: { message: "gone fishing" },
    });

    const back = [
      ...away,
      lines("!! away", ">> AWAY", "<< :irc.test 305 iirc :You are no longer marked as away"),
    ];

    expect(known(played(back))).toMatchObject({ _tag: "Known", value: null });
  });

  it("is refused when AWAYLEN cannot carry it, and the Owner stays as they were", () => {
    played([
      ...inChannel(["AWAYLEN=4"]),
      lines(
        "!! away :lunch",
        "?? refused i1 Unsendable",
        "!! away :tea",
        ">> AWAY tea",
        "== closed Reset",
        "...",
        "+2s",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< :irc.test 421 iirc CAP :Unknown command",
        "<< :irc.test 001 iirc :Welcome",
        ">> AWAY tea",
        ">> JOIN #iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("is sent again after 001 on every Session, and comes back when asked", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! away :brb",
        ">> AWAY brb",
        "== closed Reset",
        "...",
        "+2s",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< :irc.test 421 iirc CAP :Unknown command",
        "<< :irc.test 001 iirc :Welcome",
        ">> AWAY brb",
        ">> JOIN #iirc",
        "<< :irc.test 306 iirc :You have been marked as being away",
        "!! away",
        ">> AWAY",
        "== closed Reset",
        "...",
        "+4s",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< :irc.test 421 iirc CAP :Unknown command",
        "<< :irc.test 001 iirc :Welcome",
        ">> JOIN #iirc"
      ),
    ]);

    expect(known(run)).toMatchObject({ value: null });
  });

  it("is kept while offline, and sent once a Session begins", () => {
    played([
      lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "!! away :later",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< :irc.test 421 iirc CAP :Unknown command",
        "<< :irc.test 001 iirc :Welcome",
        ">> AWAY later"
      ),
    ]);

    expect.assertions(0);
  });

  it("is known from Self's own AWAY, as away-notify may send it", () => {
    const run = played([
      registered(base, { offered: ["away-notify"] }),
      lines("<< :iirc!~iirc@iirc.test AWAY :elsewhere", "..."),
    ]);

    expect(known(run)).toMatchObject({ from: "ircd", value: { message: "elsewhere" } });
  });
});

// The intents a run refused, in order.
const refusedIntents = (run: Played<State>) =>
  refusals(run).flatMap((news) => (news._tag === "Refused" ? [news.intent] : []));

describe("tying the Ircd's answers to actions", () => {
  it("settles a key or a ban Self's MODE echoes, whatever its parameter, so a later error is another's", () => {
    for (const [asked, echoed] of [
      ["+k=secret", "+k secret"],
      ["+b=bad.test", "+b *!*@bad.test"],
      ["-k=secret", "-k *"],
    ] as const) {
      const sent = `MODE #iirc ${asked.replace("=", " ")}`;

      const run = played([
        ...inChannel(),
        lines(
          `!! mode #iirc ${asked}`,
          `>> ${sent}`,
          `<< :iirc!~iirc@iirc.test MODE #iirc ${echoed}`,
          "...",
          "!! topic #iirc :mine",
          ">> TOPIC #iirc mine",
          "<< :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i2 Rejected 482"
        ),
      ]);

      expect(refusedIntents(run)).toStrictEqual(["i2"]);
    }
  });

  it("answers one occurrence of a repeated nick or parameter at a time", () => {
    const kicks = played([
      ...inChannel(["TARGMAX=KICK:2"]),
      lines(
        "!! kick #iirc a,a",
        ">> KICK #iirc a,a",
        "<< :iirc!~iirc@iirc.test KICK #iirc a",
        "...",
        "<< :irc.test 441 iirc a #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441"
      ),
    ]);

    // `[x]` and `{X}` fold alike under rfc1459.
    const folded = played([
      ...inChannel(["TARGMAX=KICK:2"]),
      lines(
        "!! kick #iirc [x],{X}",
        ">> KICK #iirc [x],{X}",
        "<< :iirc!~iirc@iirc.test KICK #iirc {x}",
        "...",
        "<< :irc.test 441 iirc [X] #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441"
      ),
    ]);

    const modes = played([
      ...inChannel(),
      lines(
        "!! mode #iirc +o=a +o=a",
        ">> MODE #iirc +oo a a",
        "<< :iirc!~iirc@iirc.test MODE #iirc +o a",
        "...",
        "<< :irc.test 441 iirc a #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441"
      ),
    ]);

    expect([kicks, folded, modes].map(refusedIntents)).toStrictEqual([["i1"], ["i1"], ["i1"]]);
  });

  it("compares names by the casemapping in force when the answer comes, both ways", () => {
    const ascii = registered(base, {
      isupport: ["CASEMAPPING=ascii", "CHANTYPES=#", "PREFIX=(ov)@+"],
    });

    // Under ascii `[a]` and `{A}` differ, and under rfc1459 they are one nick.
    const toRfc = played([
      ascii,
      joined(base, "#iirc", ["peer"]),
      lines(
        "!! kick #iirc [a]",
        ">> KICK #iirc [a]",
        "<< :irc.test 005 iirc CASEMAPPING=rfc1459 :are supported by this server",
        "...",
        "<< :irc.test 441 iirc {A} #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441"
      ),
    ]);

    const echoed = played([
      ascii,
      joined(base, "#iirc", ["peer"]),
      lines(
        "!! kick #iirc [a]",
        ">> KICK #iirc [a]",
        "<< :irc.test 005 iirc CASEMAPPING=rfc1459 :are supported by this server",
        "...",
        "<< :iirc!~iirc@iirc.test KICK #iirc {A}",
        "...",
        "!! topic #iirc :mine",
        ">> TOPIC #iirc mine",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i2 Rejected 482"
      ),
    ]);

    // Under rfc1459 `[A]` folds to `{a}`, and under ascii to `[a]`, which `[a]` matches.
    const toAscii = played([
      ...inChannel(),
      lines(
        "!! kick #iirc [A]",
        ">> KICK #iirc [A]",
        "<< :irc.test 005 iirc CASEMAPPING=ascii :are supported by this server",
        "...",
        "<< :irc.test 441 iirc [a] #iirc :They aren't on that channel",
        "?? refused i1 Rejected 441"
      ),
    ]);

    expect([toRfc, echoed, toAscii].map(refusedIntents)).toStrictEqual([["i1"], ["i2"], ["i1"]]);
  });
});

describe("a Line written as text", () => {
  it("is sent as it reads, with client-only tags", () => {
    played([
      ...inChannel(),
      lines(
        "!! quote privmsg #iirc :hi there",
        ">> PRIVMSG #iirc :hi there",
        "!! quote @+typing=active TAGMSG #iirc",
        ">> @+typing=active TAGMSG #iirc",
        "!! quote WHOIS   peer",
        ">> WHOIS peer"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused when it does not parse, has a source, or would carry what is the Client's", () => {
    played([
      ...inChannel(),
      lines(
        "!! quote :me PRIVMSG #iirc :hi",
        "?? refused i1 Unsendable",
        "!! quote CAP REQ :echo-message",
        "?? refused i2 Unsendable",
        "!! quote PASS hunter2",
        "?? refused i3 Unsendable",
        "!! quote AUTHENTICATE PLAIN",
        "?? refused i4 Unsendable",
        "!! quote @label=x PING a",
        "?? refused i5 Unsendable",
        "!! quote @time=x PING a",
        "?? refused i6 Unsendable",
        `!! quote PRIVMSG #iirc :${"x".repeat(500)}`,
        "?? refused i7 Unsendable",
        "!! quote 12 x",
        "?? refused i8 Unsendable"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused when it joins or parts a Channel the Configuration wants", () => {
    played([
      ...inChannel(),
      lines(
        "!! quote PART #iirc",
        "?? refused i1 Unsendable",
        "!! quote PART #other,#IIRC :bye",
        "?? refused i2 Unsendable",
        "!! quote JOIN #iirc",
        "?? refused i3 Unsendable",
        "!! quote JOIN 0",
        "?? refused i4 Unsendable",
        "!! quote PART #other",
        ">> PART #other",
        "!! quote JOIN #other",
        ">> JOIN #other"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused by 421 and 461 naming its command", () => {
    played([
      ...inChannel(),
      lines(
        "!! quote FROB x",
        ">> FROB x",
        "<< :irc.test 421 iirc FROB :Unknown command",
        "?? refused i1 Rejected 421",
        "!! quote KNOCK",
        ">> KNOCK",
        "<< :irc.test 461 iirc KNOCK :Not enough parameters",
        "?? refused i2 Rejected 461"
      ),
    ]);

    expect.assertions(0);
  });

  it("desynchronises nothing: the Client follows what the Ircd sends back", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! quote NICK other",
        ">> NICK other",
        "<< :iirc!~iirc@iirc.test NICK other",
        "...",
        "!! quote JOIN #extra",
        ">> JOIN #extra",
        "<< :other!~iirc@iirc.test JOIN #extra",
        "...",
        "<< :irc.test 366 other #extra :End of /NAMES list."
      ),
    ]);

    const known = client.known(run.state);

    expect(known.self?.nick).toBe("other");
    expect(known.channels.get("#extra")).toMatchObject({ standing: "Joined", wanted: false });
  });

  it("keeps the AWAY it sends, which a 306 confirms", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! quote AWAY :be right back",
        ">> AWAY :be right back",
        "<< :irc.test 306 iirc :You have been marked as being away"
      ),
    ]);

    expect(client.known(run.state).self?.away).toMatchObject({
      value: { message: "be right back" },
    });
  });
});
