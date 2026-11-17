import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured({ whoOnJoin: true });
const whox = [...floorIsupport, "WHOX"];

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Self's JOIN confirmed, and the members listed, with the queries it draws written apart:
// the `MODE` after the echo, and the `WHO` after the listing ends.
const echo = (
  channel: string,
  { mode = [], who = [] }: { readonly mode?: readonly string[]; readonly who?: readonly string[] }
) =>
  lines(
    `<< :iirc!~iirc@iirc.test JOIN ${channel}`,
    ...mode,
    `<< :irc.test 353 iirc = ${channel} :iirc @op peer`,
    `<< :irc.test 366 iirc ${channel} :End of /NAMES list.`,
    ...who
  );

// Registration that joins the Channels at `001`, for a Configuration that wants them.
const joining = (configuration = base, isupport = floorIsupport) =>
  registered(configuration, { isupport }).replace(
    /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
    `$<welcome>>> JOIN ${configuration.channels.map(({ name }) => name).join(",")}\n`
  );

const userOf = (played: Played<State>, nick: string) => client.known(played.state).users.get(nick);

// What a step said beyond the Client learning a Channel: what a Timeline would show, or
// any refusal or Line it ignored.
const noise = (played: Played<State>, from: number): readonly News["_tag"][] =>
  played.steps
    .slice(from)
    .flatMap((step) => step.news)
    .flatMap((news) => (news._tag === "ChannelLearned" ? [] : [news._tag]));

describe("asking who is in a Channel on joining it", () => {
  it("asks once its members are listed, and learns each as no Activity", () => {
    const transcript = [registered(base), lines("!! configure +#iirc", ">> JOIN #iirc")];
    const before = play(client, { configuration: base, transcript }).steps.length;

    const played = play(client, {
      configuration: base,
      transcript: [
        ...transcript,
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc"] }),
        lines(
          "<< :irc.test 352 iirc #iirc ~iirc iirc.test irc.test iirc H :0 iirc",
          "<< :irc.test 352 iirc #iirc ~op op.test irc.test op G@ :0 Op Person",
          "<< :irc.test 352 iirc #iirc ~peer peer.test irc.test peer H :3 Pe Er",
          "<< :irc.test 315 iirc #iirc :End of WHO list",
          "?? channel-learned channel:#iirc",
          "+31s"
        ),
      ],
    });

    expect(userOf(played, "op")).toMatchObject({
      account: { _tag: "Unknown" },
      away: { _tag: "Known", from: "replied", value: { message: "" } },
      mask: { _tag: "Known", value: { host: "op.test", user: "~op" } },
      realname: { _tag: "Known", value: "Op Person" },
    });
    expect(userOf(played, "peer")).toMatchObject({
      away: { _tag: "Known", value: null },
      realname: { _tag: "Known", value: "Pe Er" },
    });
    // The JOIN's echo is the only Activity: the query and its answer show nowhere.
    expect(noise(played, before)).toStrictEqual(["Activity"]);
    expect(client.inspect(played.state).states.who).toBeUndefined();
  });

  it("asks for the fields it keeps and its own token with WHOX, and reads only its token", () => {
    const transcript = [
      registered(base, { isupport: whox }),
      lines("!! configure +#iirc", ">> JOIN #iirc"),
    ];

    const before = play(client, { configuration: base, transcript }).steps.length;

    const played = play(client, {
      configuration: base,
      transcript: [
        ...transcript,
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc %tcuhnfar,152"] }),
        lines(
          "<< :irc.test 354 iirc 42 #iirc ~peer peer.test peer G other :Not Ours",
          "<< :irc.test 354 iirc 152 #iirc ~op op.test op G@ opacct :Op Person",
          "<< :irc.test 354 iirc 152 #iirc ~peer peer.test peer H 0 :Pe Er",
          "<< :irc.test 315 iirc #iirc :End of WHO list",
          "?? channel-learned channel:#iirc"
        ),
      ],
    });

    expect(userOf(played, "op")).toMatchObject({
      account: { _tag: "Known", from: "replied", value: "opacct" },
      away: { _tag: "Known", value: { message: "" } },
      mask: { _tag: "Known", value: { host: "op.test", user: "~op" } },
      realname: { _tag: "Known", value: "Op Person" },
    });
    expect(userOf(played, "peer")).toMatchObject({
      account: { _tag: "Known", value: null },
      away: { _tag: "Known", value: null },
      realname: { _tag: "Known", value: "Pe Er" },
    });
    expect(noise(played, before)).toStrictEqual(["Activity"]);
  });

  it("keeps an away message already known, since WHO gives none", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["away-notify"] }),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc"] }),
        lines(
          "<< :op!~op@op.test AWAY :lunch",
          "?? activity AwayChanged op in=existing-direct:op :lunch",
          "<< :irc.test 352 iirc #iirc ~op op.test irc.test op G@ :0 Op",
          "<< :irc.test 315 iirc #iirc :End of WHO list"
        ),
      ],
    });

    expect(userOf(played, "op")?.away).toMatchObject({
      _tag: "Known",
      from: "replied",
      value: { message: "lunch" },
    });
  });

  it("reads no answer for another Channel, nor one after the query ended", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc"] }),
        lines(
          "<< :irc.test 352 iirc #other ~op op.test irc.test op G :0 Op",
          "<< :irc.test 315 iirc #iirc :End of WHO list",
          "<< :irc.test 352 iirc #iirc ~peer peer.test irc.test peer G :0 Peer"
        ),
      ],
    });

    expect(userOf(played, "op")?.away).toStrictEqual({ _tag: "Unknown" });
    expect(userOf(played, "peer")?.away).toStrictEqual({ _tag: "Unknown" });
  });

  it("asks many Channels one after another, each when the last is answered", () => {
    const three = configured({
      channels: [{ name: "#a" }, { name: "#b" }, { name: "#c" }],
      whoOnJoin: true,
    });

    play(client, {
      configuration: three,
      transcript: [
        joining(three),
        echo("#a", { mode: [">> MODE #a"], who: [">> WHO #a"] }),
        echo("#b", {}),
        echo("#c", {}),
        lines(
          "!! say #c :hello",
          ">> PRIVMSG #c hello",
          "<< :irc.test 315 iirc #a :End of WHO list",
          ">> WHO #b",
          "<< :irc.test 315 iirc #b :End of WHO list",
          ">> WHO #c"
        ),
      ],
    });

    expect.assertions(0);
  });

  it.each([
    [
      "WHOX",
      whox,
      ">> WHO #a %tcuhnfar,152",
      ">> WHO #b %tcuhnfar,152",
      "<< :irc.test 354 iirc 152 #a ~op op.test op G acct :Op",
    ],
    [
      "a plain WHO",
      floorIsupport,
      ">> WHO #a",
      ">> WHO #b",
      "<< :irc.test 352 iirc #a ~op op.test irc.test op G :0 Op",
    ],
  ])(
    "asks the next once one goes unanswered for 30 s, and still reads the late %s answer",
    (_name, isupport, first, next, late) => {
      const two = configured({ channels: [{ name: "#a" }, { name: "#b" }], whoOnJoin: true });

      const played = play(client, {
        configuration: two,
        transcript: [
          joining(two, isupport),
          echo("#a", { mode: [">> MODE #a"], who: [first] }),
          echo("#b", {}),
          lines(
            "<< :irc.test 324 iirc #a +nt",
            ">> MODE #b",
            "<< :irc.test 324 iirc #b +nt",
            "+29999ms",
            "+1ms",
            next,
            late,
            "<< :irc.test 315 iirc #a :End of WHO list",
            "?? channel-learned channel:#a"
          ),
        ],
      });

      expect(userOf(played, "op")?.away).toMatchObject({ _tag: "Known", value: { message: "" } });
      // The query of #b still waits, and #a is never asked again.
      expect(client.inspect(played.state).states.who).toBe("Asking");
    }
  );

  it("leaves an error naming the Channel to the Owner's action, though the WHO was sent first", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc"] }),
        lines(
          "<< :irc.test 324 iirc #iirc +nt",
          "!! topic #iirc :new",
          ">> TOPIC #iirc new",
          "<< :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i1 Rejected 482 topic=#iirc in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("leaves an error naming the Channel to the Owner's Lookup, though the WHO was sent first", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc"] }),
        lines(
          "<< :irc.test 324 iirc #iirc +nt",
          "!! bans #iirc",
          ">> MODE #iirc +b",
          "<< :irc.test 442 iirc #iirc :You're not on that channel",
          "?? looked-up i1 bans=#iirc failed=442"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("still reads its answer after an error that names its Channel, sent for a Say", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: whox }),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc %tcuhnfar,152"] }),
        lines(
          "<< :irc.test 324 iirc #iirc +nt",
          "!! say #iirc :hello",
          ">> PRIVMSG #iirc hello",
          "<< :irc.test 404 iirc #iirc :Cannot send to channel",
          "<< :irc.test 354 iirc 152 #iirc ~op op.test op G acct :Op",
          "<< :irc.test 315 iirc #iirc :End of WHO list",
          "?? channel-learned channel:#iirc"
        ),
      ],
    });

    expect(userOf(played, "op")?.account).toMatchObject({ _tag: "Known", value: "acct" });
  });

  it.each([
    ["an unknown command", "<< :irc.test 421 iirc who :Unknown command"],
    ["too few parameters", "<< :irc.test 461 iirc WHO :Not enough parameters"],
    ["a FAIL", "<< :irc.test FAIL WHO TOO_MANY_REQUESTS #a :Slow down"],
  ])("asks the next when the answer is %s", (_name, error) => {
    const two = configured({ channels: [{ name: "#a" }, { name: "#b" }], whoOnJoin: true });

    play(client, {
      configuration: two,
      transcript: [
        joining(two),
        echo("#a", { mode: [">> MODE #a"], who: [">> WHO #a"] }),
        echo("#b", {}),
        lines("<< :irc.test 324 iirc #a +nt", ">> MODE #b", error, "...", ">> WHO #b"),
      ],
    });

    expect.assertions(0);
  });

  it("never asks again in a Session, though Self joins again, and asks in the next", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc"] }),
        lines(
          "<< :irc.test 324 iirc #iirc +nt",
          "<< :irc.test 315 iirc #iirc :End of WHO list",
          "<< :op!u@h KICK #iirc iirc :out",
          "+2s",
          ">> JOIN #iirc"
        ),
        echo("#iirc", { mode: [">> MODE #iirc"] }),
        lines(
          "<< :irc.test 324 iirc #iirc +nt",
          "== closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls"
        ),
        registered(base)
          .replace(/^!! configure\n-> dial[^\n]*\n/u, "")
          .replace(/(?<welcome><< :irc\.test 001 [^\n]*\n)/u, "$<welcome>>> JOIN #iirc\n"),
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc"] }),
      ],
    });

    expect.assertions(0);
  });

  it.each([
    ["left out, as a Journal written before it", configured()],
    ["off", configured({ whoOnJoin: false })],
  ])("asks nothing when the option is %s", (_name, configuration) => {
    const played = play(client, {
      configuration,
      transcript: [
        registered(configuration),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", { mode: [">> MODE #iirc"] }),
        lines("<< :irc.test 324 iirc #iirc +nt", "+31s"),
      ],
    });

    expect(client.inspect(played.state).states.who).toBeUndefined();
  });

  it("awaits nothing once its WHO never left", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("!! configure +#iirc", ">> JOIN #iirc"),
        echo("#iirc", { mode: [">> MODE #iirc"], who: [">> WHO #iirc"] }),
        lines("== unsent 1", "<< :irc.test 352 iirc #iirc ~op op.test irc.test op G :0 Op"),
      ],
    });

    expect(client.inspect(played.state).states.who).toBeUndefined();
    expect([...played.timers.keys()]).not.toContain("who");
    expect(userOf(played, "op")?.away).toStrictEqual({ _tag: "Unknown" });
  });
});
