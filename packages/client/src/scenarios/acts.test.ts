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
        "?? refused i1 Offline topic=#iirc in=network",
        "!! kick #iirc peer",
        "?? refused i2 Offline kick=#iirc:peer in=network",
        "!! mode #iirc +m",
        "?? refused i3 Offline mode=#iirc:+m in=network",
        "!! invite peer #iirc",
        "?? refused i4 Offline invite=peer:#iirc in=network",
        "!! nick other",
        "?? refused i5 Offline nick=other in=network",
        "!! quote WHOIS peer",
        "?? refused i6 Offline raw=WHOIS in=network"
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
        "?? refused i1 Unsendable topic=#iirc in=channel:#iirc",
        "!! topic #iirc :abcde",
        ">> TOPIC #iirc abcde",
        "!! topic #iirc :ééé",
        "?? refused i3 Unsendable topic=#iirc in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused for a name that is not a Channel's, or a topic with a line break", () => {
    played([
      ...inChannel(),
      lines(
        "!! topic peer :hi",
        "?? refused i1 Unsendable topic=peer in=network",
        "!! topic #a,#b :hi",
        "?? refused i2 Unsendable topic=#a,#b in=network"
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
      {
        _tag: "Refused",
        action: {
          attempted: { _tag: "Topic", channel: "#iirc" },
          where: { _tag: "Channel", key: "#iirc", name: "#iirc" },
        },
        intent: "i9",
        reason: { _tag: "Unsendable" },
      },
    ]);
  });

  it("is refused when the Ircd says 482 of its Channel", () => {
    played([
      ...inChannel(),
      lines(
        "!! topic #iirc :mine now",
        ">> TOPIC #iirc :mine now",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i1 Rejected 482 topic=#iirc in=channel:#iirc"
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
      lines(
        "!! topic #iirc :hi",
        ">> TOPIC #iirc hi",
        "== unsent 1",
        "?? refused i1 Unsent topic=#iirc in=channel:#iirc"
      ),
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
          "?? refused i1 Rejected 482 topic=#iirc in=channel:#iirc",
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
        "?? refused i1 Unsendable kick=#iirc:peer in=channel:#iirc",
        "!! kick #iirc peer :bye",
        ">> KICK #iirc peer bye",
        "!! kick #iirc @peer",
        '?? refused i3 Unsendable kick=#iirc:"@peer" in=channel:#iirc',
        "!! kick peer peer",
        "?? refused i4 Unsendable kick=peer:peer in=network"
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
        "?? refused i1 Rejected 441 kick=#iirc:a,b in=channel:#iirc",
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
        "?? refused i1 Rejected 441 kick=#iirc:a,b in=channel:#iirc"
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
          "?? refused i1 Rejected 482 kick=#iirc:a,b in=channel:#iirc",
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
        "?? refused i2 Unsendable mode=#iirc:+l in=channel:#iirc",
        "!! mode #iirc -j=3",
        "?? refused i3 Unsendable mode=#iirc:-j in=channel:#iirc",
        "!! mode #iirc +o",
        "?? refused i4 Unsendable mode=#iirc:+o in=channel:#iirc",
        "!! mode #iirc +m=x",
        "?? refused i5 Unsendable mode=#iirc:+m in=channel:#iirc",
        "!! mode #iirc +x",
        "?? refused i6 Unsendable mode=#iirc:+x in=channel:#iirc",
        "!! mode #iirc +k=:x",
        "?? refused i7 Unsendable mode=#iirc:+k in=channel:#iirc"
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
        "?? refused i1 Rejected 441 mode=#iirc:+oo in=channel:#iirc"
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
        "?? refused i2 Unsendable mode=peer:+i in=network"
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
        "?? refused i1 Rejected 441 mode=#iirc:+o in=channel:#iirc",
        "!! mode #iirc +m",
        ">> MODE #iirc +m",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i2 Rejected 482 mode=#iirc:+m in=channel:#iirc"
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
        "?? refused i1 Rejected 443 invite=peer:#iirc in=channel:#iirc"
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
    played([
      ...inChannel(),
      lines("!! invite #x #iirc", "?? refused i1 Unsendable invite=#x:#iirc in=channel:#iirc"),
    ]);

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
        "?? refused i1 Rejected 433 nick=taken in=network"
      ),
    ]);

    expect(client.known(run.state).self?.nick).toBe("iirc");
  });

  it("is refused past NICKLEN, or RFC 2812's 9 until the Ircd says, or when not a nick", () => {
    played([
      ...inChannel(),
      lines(
        "!! nick abcdefghij",
        "?? refused i1 Unsendable nick=abcdefghij in=network",
        "!! nick #chan",
        "?? refused i2 Unsendable nick=#chan in=network",
        "!! nick a*",
        "?? refused i3 Unsendable nick=a* in=network"
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

  it("reports what the Ircd confirmed as Self's AwayChanged, in the Network's own Timeline", () => {
    played([
      ...inChannel(),
      lines(
        "!! away :gone fishing",
        ">> AWAY :gone fishing",
        "<< :irc.test 306 iirc :You have been marked as being away",
        "?? activity AwayChanged iirc in=network :gone fishing",
        "!! away",
        ">> AWAY",
        "<< :irc.test 305 iirc :You are no longer marked as away",
        "?? activity AwayChanged iirc back in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused when AWAYLEN cannot carry it, and the Owner stays as they were", () => {
    played([
      ...inChannel(["AWAYLEN=4"]),
      lines(
        "!! away :lunch",
        "?? refused i1 Unsendable away in=network",
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
          "?? refused i2 Rejected 482 topic=#iirc in=channel:#iirc"
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
        "?? refused i1 Rejected 441 kick=#iirc:a,a in=channel:#iirc"
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
        "?? refused i1 Rejected 441 kick=#iirc:[x],{X} in=channel:#iirc"
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
        "?? refused i1 Rejected 441 mode=#iirc:+oo in=channel:#iirc"
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
        "?? refused i1 Rejected 441 kick=#iirc:[a] in=channel:#iirc"
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
        "?? refused i2 Rejected 482 topic=#iirc in=channel:#iirc"
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
        "?? refused i1 Rejected 441 kick=#iirc:[A] in=channel:#iirc"
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
        "?? refused i1 Unsendable raw in=network",
        "!! quote CAP REQ :echo-message",
        "?? refused i2 Unsendable raw=CAP in=network",
        "!! quote PASS hunter2",
        "?? refused i3 Unsendable raw=PASS in=network",
        "!! quote AUTHENTICATE PLAIN",
        "?? refused i4 Unsendable raw=AUTHENTICATE in=network",
        "!! quote OPER admin hunter2",
        "?? refused i5 Unsendable raw=OPER in=network",
        "!! quote oper admin hunter2",
        "?? refused i6 Unsendable raw=OPER in=network",
        "!! quote Pass hunter2",
        "?? refused i7 Unsendable raw=PASS in=network",
        "!! quote @label=x PING a",
        "?? refused i8 Unsendable raw=PING in=network",
        "!! quote @time=x PING a",
        "?? refused i9 Unsendable raw in=network",
        `!! quote PRIVMSG #iirc :${"x".repeat(500)}`,
        "?? refused i10 Unsendable raw in=network",
        "!! quote 12 x",
        "?? refused i11 Unsendable raw in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused when it joins or parts a Channel the Configuration wants", () => {
    played([
      ...inChannel(),
      lines(
        "!! quote PART #iirc",
        "?? refused i1 Unsendable raw=PART in=network",
        "!! quote PART #other,#IIRC :bye",
        "?? refused i2 Unsendable raw=PART in=network",
        "!! quote JOIN #iirc",
        "?? refused i3 Unsendable raw=JOIN in=network",
        "!! quote JOIN 0",
        "?? refused i4 Unsendable raw=JOIN in=network",
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
        "?? refused i1 Rejected 421 raw=FROB in=network",
        "!! quote KNOCK",
        ">> KNOCK",
        "<< :irc.test 461 iirc KNOCK :Not enough parameters",
        "?? refused i2 Rejected 461 raw=KNOCK in=network"
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

describe("where a refused action belongs", () => {
  it("is the Channel it was about, when the Client holds it, keyed as where keys it", () => {
    played([
      registered(base, { isupport: [...floorIsupport, "CASEMAPPING=ascii"] }),
      joined(base, "#IIRC", ["peer"]),
      lines(
        "!! kick #IIRC peer",
        ">> KICK #IIRC peer",
        "<< :irc.test 482 iirc #IIRC :You're not channel operator",
        "?? refused i1 Rejected 482 kick=#IIRC:peer in=channel:#iirc:#IIRC",
        "!! invite peer #IIRC",
        ">> INVITE peer #IIRC",
        "<< :irc.test 443 iirc peer #IIRC :is already on channel",
        "?? refused i2 Rejected 443 invite=peer:#IIRC in=channel:#iirc:#IIRC"
      ),
    ]);

    expect.assertions(0);
  });

  it("is the Network's own for a Channel the Client does not hold, a nick, Self's modes, and a raw Line", () => {
    played([
      ...inChannel(),
      lines(
        "!! topic #elsewhere :hi",
        ">> TOPIC #elsewhere hi",
        "<< :irc.test 442 iirc #elsewhere :You're not on that channel",
        "?? refused i1 Rejected 442 topic=#elsewhere in=network",
        "!! nick taken",
        ">> NICK taken",
        "<< :irc.test 433 iirc taken :Nickname is already in use",
        "?? refused i2 Rejected 433 nick=taken in=network",
        "!! mode iirc +i",
        ">> MODE iirc +i",
        "== unsent 1",
        "?? refused i3 Unsent mode=iirc:+i in=network",
        "!! quote FROB x",
        ">> FROB x",
        "<< :irc.test 421 iirc FROB :Unknown command",
        "?? refused i4 Rejected 421 raw=FROB in=network"
      ),
    ]);

    expect.assertions(0);
  });

  it("names the modes it changed by sign and letter, never a parameter such as a key", () => {
    played([
      ...inChannel(),
      lines(
        "!! mode #iirc +k=hunter2 +o=peer -v=peer",
        ">> MODE #iirc +ko-v hunter2 peer peer",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i1 Rejected 482 mode=#iirc:+ko-v in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("is said of an Unsent after its Connection ended, and of away", () => {
    played([
      ...inChannel(),
      lines(
        "!! away :lunch",
        ">> AWAY lunch",
        "!! topic #iirc :hi",
        ">> TOPIC #iirc hi",
        "== closed Reset",
        "...",
        "== connection 1",
        "== unsent 2",
        "?? refused i1 Unsent away in=network",
        "?? refused i2 Unsent topic=#iirc in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("is forgotten for the oldest of more than 64 actions, and never said of a Say", () => {
    const pings = Array.from({ length: 64 }, (_each, index) => [
      `!! quote PING ${index}`,
      `>> PING ${index}`,
    ]).flat();

    const run = played([
      ...inChannel(),
      lines(
        "!! topic #iirc :first",
        ">> TOPIC #iirc first",
        ...pings,
        "!! say #iirc :hi",
        ">> PRIVMSG #iirc hi",
        "...",
        "== unsent 66"
      ),
    ]);

    const refused = refusals(run);

    expect(refused).toHaveLength(66);
    expect(refused[0]).toMatchObject({ action: undefined, intent: "i1" });
    expect(refused[1]).toMatchObject({
      action: { attempted: { _tag: "Raw", command: "PING" }, where: { _tag: "Network" } },
      intent: "i2",
    });
    expect(refused.at(-1)).toMatchObject({ action: undefined, intent: "i66" });
  });
});
