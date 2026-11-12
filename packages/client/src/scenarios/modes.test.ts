import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Self's JOIN confirmed, and the members listed, with the query it draws written apart.
const echo = (channel: string, ...asked: readonly string[]) =>
  lines(
    `<< :iirc!~iirc@iirc.test JOIN ${channel}`,
    ...asked,
    `<< :irc.test 353 iirc = ${channel} :iirc @op`,
    `<< :irc.test 366 iirc ${channel} :End of /NAMES list.`
  );

const modesOf = (played: Played<State>, channel = "#iirc") =>
  client.known(played.state).channels.get(channel)?.modes;

// What a step said beyond the Client learning a Channel: what a Timeline would show, or
// any refusal or Line it ignored.
const noise = (played: Played<State>, from: number): readonly News["_tag"][] =>
  played.steps
    .slice(from)
    .flatMap((step) => step.news)
    .flatMap((news) => (news._tag === "ChannelLearned" ? [] : [news._tag]));

describe("learning a Channel's modes", () => {
  it("asks once when Self's join is confirmed, and folds the answer as no Message or Activity", () => {
    const transcript = [registered(base), lines("!! configure +#iirc", ">> JOIN #iirc")];
    const before = play(client, { configuration: base, transcript }).steps.length;

    const played = play(client, {
      configuration: base,
      transcript: [
        ...transcript,
        echo("#iirc", ">> MODE #iirc"),
        lines(
          "<< :irc.test 324 iirc #iirc +ntl 10",
          "?? channel-learned channel:#iirc",
          "<< :irc.test 329 iirc #iirc 1767225600",
          "+31s"
        ),
      ],
    });

    expect(modesOf(played)).toMatchObject({
      _tag: "Known",
      from: "replied",
      value: new Map([
        ["n", null],
        ["t", null],
        ["l", "10"],
      ]),
    });
    // The JOIN's echo is the only Activity: the query and its answer show nowhere.
    expect(noise(played, before)).toStrictEqual(["Activity"]);
    expect(client.inspect(played.state).states.modes).toBeUndefined();
  });

  it("asks one Channel at a time, so the Owner's Lines never wait behind a hundred queries", () => {
    const names = Array.from({ length: 100 }, (_unused, index) => `#c${index}`);
    const many = configured({ channels: names.map((name) => ({ name })) });

    const played = play(client, {
      configuration: many,
      transcript: [
        registered(many).replace(/(?<welcome><< :irc\.test 001 [^\n]*\n)/u, "$<welcome>...\n"),
        "+1s\n",
        ...names.map((name, index) => echo(name, ...(index === 0 ? [">> MODE #c0"] : []))),
        lines(
          "!! say #c99 :hello",
          ">> PRIVMSG #c99 hello",
          "<< :irc.test 324 iirc #c0 +nt",
          "?? channel-learned channel:#c0",
          ">> MODE #c1",
          "<< :irc.test 324 iirc #c1 +s",
          "?? channel-learned channel:#c1",
          ">> MODE #c2"
        ),
      ],
    });

    expect(modesOf(played, "#c1")).toMatchObject({ _tag: "Known", value: new Map([["s", null]]) });
    expect(modesOf(played, "#c2")).toStrictEqual({ _tag: "Unknown" });
  });

  it("asks the next once one goes unanswered for 30 s, and still folds a late answer", () => {
    const two = configured({ channels: [{ name: "#a" }, { name: "#b" }] });

    const played = play(client, {
      configuration: two,
      transcript: [
        registered(two).replace(
          /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
          "$<welcome>>> JOIN #a,#b\n"
        ),
        echo("#a", ">> MODE #a"),
        echo("#b"),
        lines("+29999ms", "+1ms", ">> MODE #b", "<< :irc.test 324 iirc #a +m"),
      ],
    });

    expect(modesOf(played, "#a")).toMatchObject({ _tag: "Known", value: new Map([["m", null]]) });
    expect(modesOf(played, "#b")).toStrictEqual({ _tag: "Unknown" });
  });

  it("skips a Channel whose modes an Ircd volunteered before its turn", () => {
    const two = configured({ channels: [{ name: "#a" }, { name: "#b" }] });

    const played = play(client, {
      configuration: two,
      transcript: [
        registered(two).replace(
          /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
          "$<welcome>>> JOIN #a,#b\n"
        ),
        echo("#a", ">> MODE #a"),
        echo("#b"),
        lines(
          "<< :irc.test 324 iirc #b +i",
          "?? channel-learned channel:#b",
          "<< :irc.test 324 iirc #a +n",
          "?? channel-learned channel:#a"
        ),
      ],
    });

    expect(modesOf(played, "#b")).toMatchObject({ _tag: "Known", value: new Map([["i", null]]) });
  });

  it.each([
    ["not on the Channel", "<< :irc.test 442 iirc #iirc :You're not on that channel"],
    ["no such Channel", "<< :irc.test 403 iirc #IIRC :No such channel"],
    ["a numeric no document names", "<< :irc.test 499 iirc #iirc :Something else"],
    ["an unknown command", "<< :irc.test 421 iirc mode :Unknown command"],
    ["too few parameters", "<< :irc.test 461 iirc MODE :Not enough parameters"],
  ])("leaves the modes unknown when the answer is %s, and asks the next", (_name, error) => {
    const two = configured({ channels: [{ name: "#iirc" }, { name: "#b" }] });

    const transcript = [
      registered(two).replace(
        /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
        "$<welcome>>> JOIN #iirc,#b\n"
      ),
      echo("#iirc", ">> MODE #iirc"),
      echo("#b"),
    ];

    const before = play(client, { configuration: two, transcript }).steps.length;

    const played = play(client, {
      configuration: two,
      transcript: [...transcript, lines(error, ">> MODE #b")],
    });

    expect(modesOf(played)).toStrictEqual({ _tag: "Unknown" });
    expect(noise(played, before)).toStrictEqual([]);
    expect(client.known(played.state).channels.get("#iirc")?.standing).toBe("Joined");
  });

  it("asks nothing more once the Ircd never answers, and costs only the Line", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", ">> MODE #iirc"),
        lines("+30s", "+30s", ">> PING iirc"),
      ],
    });

    expect(modesOf(played)).toStrictEqual({ _tag: "Unknown" });
    expect(client.inspect(played.state).states.modes).toBeUndefined();
  });

  it("asks again when Self joins the Channel again, and in each Session", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", ">> MODE #iirc"),
        lines(
          "<< :irc.test 324 iirc #iirc +nt",
          "<< :op!u@h KICK #iirc iirc :out",
          "+2s",
          ">> JOIN #iirc"
        ),
        echo("#iirc", ">> MODE #iirc"),
        lines(
          "<< :irc.test 324 iirc #iirc +nt",
          "== closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls"
        ),
        registered(base)
          .replace(/^!! configure\n-> dial[^\n]*\n/u, "")
          .replace(/(?<welcome><< :irc\.test 001 [^\n]*\n)/u, "$<welcome>>> JOIN #iirc\n"),
        echo("#iirc", ">> MODE #iirc"),
      ],
    });

    expect.assertions(0);
  });

  it("asks no Channel the Ircd joined Self to in another's name", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", ">> MODE #iirc"),
        lines("<< :peer!u@h JOIN #iirc", "?? activity Joined #iirc peer in=channel:#iirc"),
      ],
    });

    expect.assertions(0);
  });
});

describe("telling the query's answers from the Owner's /mode", () => {
  const joinedAsking = [
    registered(base),
    lines("!! configure +#iirc", ">> JOIN #iirc"),
    echo("#iirc", ">> MODE #iirc"),
  ];

  it("gives an error sent first to the query, and the next to the Owner's action", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...joinedAsking,
        lines(
          "!! mode #iirc +m",
          ">> MODE #iirc +m",
          "<< :irc.test 482 iirc #iirc :You're not channel operator",
          "<< :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i1 Rejected 482 mode=#iirc:+m in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("leaves an error that answers only a change to the Owner's action, though the query was sent first", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...joinedAsking,
        lines(
          "!! mode #iirc +l=5",
          ">> MODE #iirc +l 5",
          "<< :irc.test 696 iirc #iirc l 5 :Invalid mode parameter",
          "?? refused i1 Rejected 696 mode=#iirc:+l in=channel:#iirc",
          "<< :irc.test 324 iirc #iirc +nt",
          "?? channel-learned channel:#iirc"
        ),
      ],
    });

    expect(modesOf(played)).toMatchObject({ _tag: "Known" });
  });

  it("never takes a 324 as the answer to an action", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...joinedAsking,
        lines(
          "!! mode #iirc +l=5",
          ">> MODE #iirc +l 5",
          "<< :irc.test 324 iirc #iirc +nt",
          "?? channel-learned channel:#iirc",
          "<< :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i1 Rejected 482 mode=#iirc:+l in=channel:#iirc"
        ),
      ],
    });

    expect(modesOf(played)).toMatchObject({
      _tag: "Known",
      value: new Map([
        ["n", null],
        ["t", null],
      ]),
    });
  });

  it("leaves an action sent before it the error that names them both", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        lines(
          "!! mode #iirc +m",
          ">> MODE #iirc +m",
          "<< :iirc!~iirc@iirc.test JOIN #iirc",
          ">> MODE #iirc",
          "<< :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i1 Rejected 482 mode=#iirc:+m in=channel:#iirc",
          "<< :irc.test 324 iirc #iirc +nt",
          "?? channel-learned channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("folds the 324 the Owner asked for by a raw MODE as the Client's own", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...joinedAsking,
        lines(
          "<< :irc.test 324 iirc #iirc +nt",
          "!! quote MODE #iirc",
          ">> MODE #iirc",
          "<< :irc.test 324 iirc #iirc +ntk secret",
          "?? channel-learned channel:#iirc"
        ),
      ],
    });

    expect(modesOf(played)).toMatchObject({
      _tag: "Known",
      value: new Map([
        ["n", null],
        ["t", null],
        ["k", null],
      ]),
    });
  });
});

describe("keeping the modes true", () => {
  it("follows MODE by CHANMODES types A to D, and keeps PREFIX's modes as membership", () => {
    const rules = configured();

    const played = play(client, {
      configuration: rules,
      transcript: [
        registered(rules, {
          isupport: [
            ...floorIsupport.filter((token) => !token.startsWith("PREFIX")),
            "PREFIX=(qaohv)~&@%+",
            "CHANMODES=beI,kf,lj,imnpst",
          ],
        }),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", ">> MODE #iirc"),
        lines(
          "<< :irc.test 324 iirc #iirc +ntkfl secret 3:5 10",
          "<< :op!u@h MODE #iirc +qbjm-tl op *!*@bad 3:5",
          "...",
          "<< :op!u@h MODE #iirc -f-j+e-k 3:5 *!*@good secret",
          "..."
        ),
      ],
    });

    expect(modesOf(played)).toMatchObject({
      _tag: "Known",
      from: "ircd",
      value: new Map([
        ["n", null],
        ["m", null],
      ]),
    });
    expect(
      client.known(played.state).channels.get("#iirc")?.members.get("op")?.prefixes
    ).toMatchObject({ atLeast: new Set(["o", "q"]) });
  });

  it("keeps them unknown through a MODE while unknown, never a partial set as whole", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", ">> MODE #iirc"),
        lines(
          "<< :op!u@h MODE #iirc +m",
          "?? activity ModeChanged #iirc by=op +m in=channel:#iirc",
          "<< :irc.test 442 iirc #iirc :You're not on that channel"
        ),
      ],
    });

    expect(modesOf(played)).toStrictEqual({ _tag: "Unknown" });
  });

  it("keeps no key, in what is known or in News", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", ">> MODE #iirc"),
        lines(
          "<< :irc.test 324 iirc #iirc +k hunter2",
          "<< :op!u@h MODE #iirc +k hunter3",
          "?? activity ModeChanged #iirc by=op +k in=channel:#iirc"
        ),
      ],
    });

    expect(modesOf(played)).toMatchObject({ value: new Map([["k", null]]) });
    expect(JSON.stringify(played.steps.flatMap((step) => step.news))).not.toContain("hunter");
  });
});
