import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, describeOutput, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Registration with Channels already wanted: the Client joins them right after 001.
const registeredJoining = (configuration: typeof base, ...sent: readonly string[]): string =>
  registered(configuration).replace(
    /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
    `$<welcome>${lines(...sent)}`
  );

// The echo of Self's JOIN, and the MODE query it draws while no other waits.
const echo = (channel: string, asks = true) =>
  lines(
    `<< :iirc!~iirc@iirc.test JOIN ${channel}`,
    ...(asks ? [`>> MODE ${channel}`] : []),
    `<< :irc.test 353 iirc = ${channel} :iirc`,
    `<< :irc.test 366 iirc ${channel} :End of /NAMES list.`
  );

describe("joining", () => {
  it("joins on the echo of its JOIN, and lists the members", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), joined(base, "#iirc", ["@peer", "+voiced", "plain"])],
    });

    const channel = client.known(played.state).channels.get("#iirc");

    expect(channel).toMatchObject({
      modes: {
        _tag: "Known",
        from: "replied",
        value: new Map([
          ["n", null],
          ["t", null],
        ]),
      },
      name: "#iirc",
      standing: "Joined",
      topic: { _tag: "Known", from: "ircd", value: null },
    });
    const prefixes = (nick: string) => channel?.members.get(nick)?.prefixes;

    expect([...(channel?.members.keys() ?? [])]).toStrictEqual(["iirc", "peer", "voiced", "plain"]);
    expect(["iirc", "peer", "voiced", "plain"].map(prefixes)).toMatchObject([
      { _tag: "Known", value: new Set() },
      { _tag: "Partial", atLeast: new Set(["o"]) },
      { _tag: "Partial", atLeast: new Set(["v"]) },
      { _tag: "Known", value: new Set() },
    ]);
    expect(client.inspect(played.state).states["channel #iirc"]).toBe("Joined.Synced");
  });

  it("waits for a Session before joining, then joins every wanted Channel in one JOIN", () => {
    const two = configured({ channels: [{ name: "#a" }, { name: "#b" }] });

    const played = play(client, {
      configuration: two,
      transcript: [registeredJoining(two, ">> JOIN #a,#b"), echo("#a"), echo("#b", false)],
    });

    expect(
      [...client.known(played.state).channels.values()].map((each) => each.standing)
    ).toStrictEqual(["Joined", "Joined"]);
  });

  it("is Wanted until then, and Joining until the echo", () => {
    const played = play(client, {
      configuration: configured({ channels: [{ name: "#a" }] }),
      transcript: lines("!! configure", "-> dial irc.test:6697 tls"),
    });

    expect(client.known(played.state).channels.get("#a")?.standing).toBe("Wanted");

    const joining = play(client, {
      configuration: base,
      transcript: [registered(base), "!! configure +#a\n>> JOIN #a\n"],
    });

    expect(client.known(joining.state).channels.get("#a")?.standing).toBe("Joining");
  });

  it("sends a Channel with a key alone, naming its Credential", () => {
    const keyed = configured({
      channels: [
        { name: "#a" },
        { key: CredentialName.make("chankey"), name: "#secret" },
        { name: "#b" },
      ],
    });

    play(client, {
      configuration: keyed,
      transcript: registeredJoining(
        keyed,
        ">> {JoinWithKey credential=chankey channel=#secret}",
        ">> JOIN #a,#b"
      ),
    });

    expect.assertions(0);
  });

  it("splits JOINs to fit a Line", () => {
    const names = Array.from(
      { length: 30 },
      (_unused, index) => `#channel-with-a-long-name-${index}`
    );

    const many = configured({ channels: names.map((name) => ({ name })) });

    const played = play(client, {
      configuration: many,
      transcript: [registeredJoining(many, "..."), "+1s\n"],
    });

    const joins = played.steps
      .flatMap((step) => step.outputs)
      .flatMap((output) =>
        output._tag === "Send" && output.line.command === "JOIN" ? [describeOutput(output)] : []
      );

    expect(joins.length).toBeGreaterThan(1);
    expect(joins.flatMap((line) => line.replace(">> JOIN ", "").split(","))).toStrictEqual(names);
  });

  it("joins as many to a Line as TARGMAX allows", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["TARGMAX=JOIN:2,PRIVMSG:4"] }),
        "!! configure +#a +#b +#c\n>> JOIN #a,#b\n>> JOIN #c\n",
      ],
    });

    expect.assertions(0);
  });

  it("refuses a Channel whose name cannot be sent, until the Configuration changes", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), "!! configure +#a,b\n"],
    });

    expect(client.known(played.state).channels.get("#a,b")?.standing).toBe("Refused");
    expect(client.inspect(played.state).timers.size).toBe(1);
  });
});

describe("NAMES", () => {
  it("reads a listing split over many 353s, and replaces the members at its end", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["gone"]),
        lines(
          "<< :irc.test 353 iirc = #iirc :iirc @one",
          "<< :irc.test 353 iirc = #iirc :+two three",
          "<< :irc.test 353 iirc #iirc :four",
          "<< :irc.test 366 iirc #iirc :End of /NAMES list."
        ),
      ],
    });

    expect([
      ...(client.known(played.state).channels.get("#iirc")?.members.keys() ?? []),
    ]).toStrictEqual(["iirc", "one", "two", "three", "four"]);
  });

  it("reads prefixes by PREFIX, and a symbol it does not name as a prefix it cannot name", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["PREFIX=(qaohv)~&@%+"] }),
        joined(base, "#iirc", ["~owner", "%half", "!odd", "@+both"]),
      ],
    });

    const members = client.known(played.state).channels.get("#iirc")?.members;

    expect(members?.get("owner")?.prefixes).toMatchObject({
      _tag: "Partial",
      atLeast: new Set(["q"]),
    });
    expect(members?.get("half")?.prefixes).toMatchObject({
      _tag: "Partial",
      atLeast: new Set(["h"]),
    });
    expect(members?.get("odd")?.prefixes).toMatchObject({ _tag: "Partial", atLeast: new Set() });
    expect(members?.get("both")?.prefixes).toMatchObject({
      _tag: "Partial",
      atLeast: new Set(["o", "v"]),
    });
  });

  it("ignores a 353 or 366 that does not fit, and a listing of a Channel Self is not in", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 353 iirc :lonely",
          "?? ignored Malformed 353",
          "<< :irc.test 366 iirc",
          "?? ignored Malformed 366",
          "<< :irc.test 353 iirc = #other :someone",
          "<< :irc.test 366 iirc #other :End"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("refused, kicked, and parted", () => {
  it.each(["471", "473", "474", "475", "403", "405", "476", "477", "437"])(
    "retries after %s on the one backoff",
    (numeric) => {
      const played = play(client, {
        configuration: base,
        transcript: [
          registered(base),
          lines(
            "!! configure +#iirc",
            ">> JOIN #iirc",
            `<< :irc.test ${numeric} iirc #iirc :Cannot join channel`,
            "+1999ms",
            "+1ms",
            ">> JOIN #iirc",
            `<< :irc.test ${numeric} iirc #iirc :Cannot join channel`,
            "+3999ms",
            "+1ms",
            ">> JOIN #iirc"
          ),
        ],
      });

      expect(client.known(played.state).channels.get("#iirc")?.standing).toBe("Joining");
    }
  );

  it("starts the backoff again once joined", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure +#iirc",
          ">> JOIN #iirc",
          "<< :irc.test 474 iirc #iirc :Banned",
          "+2s",
          ">> JOIN #iirc"
        ),
        echo("#iirc"),
        lines(
          "<< :op!u@h KICK #iirc iirc :out",
          "?? activity Kicked #iirc iirc by=op in=channel:#iirc :out",
          "+1999ms",
          "+1ms",
          ">> JOIN #iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("ignores a refusal for a Channel it is not joining", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        "<< :irc.test 474 iirc #iirc :Banned\n",
      ],
    });

    expect(client.known(played.state).channels.get("#iirc")?.standing).toBe("Joined");
  });

  it("rejoins after a kick, on a timer", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["@op"]),
        "<< :op!u@h KICK #iirc iirc :bye\n",
      ],
    });

    const channel = client.known(played.state).channels.get("#iirc");

    expect(channel).toMatchObject({ members: new Map(), standing: "Kicked" });
    expect([...client.inspect(played.state).timers.keys()]).toContain("rejoin #iirc");
  });

  it("parts a Channel no longer wanted, and forgets it", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! configure -#iirc",
          ">> PART #iirc",
          "<< :iirc!~iirc@iirc.test PART #iirc",
          "?? activity Parted #iirc iirc in=channel:#iirc"
        ),
      ],
    });

    expect(client.known(played.state).channels.size).toBe(0);
    expect(client.known(played.state).users.size).toBe(1);
  });

  it("forgets a Channel no longer wanted while offline, without a PART", () => {
    const played = play(client, {
      configuration: configured({ channels: [{ name: "#a" }] }),
      transcript: lines("!! configure", "-> dial irc.test:6697 tls", "!! configure -#a"),
    });

    expect(client.known(played.state).channels.size).toBe(0);
  });

  it("rejoins a wanted Channel the Ircd parted Self from, on a timer", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        "<< :iirc!~iirc@iirc.test PART #iirc :forced\n+2s\n>> JOIN #iirc\n",
      ],
    });

    expect(client.known(played.state).channels.get("#iirc")?.standing).toBe("Joining");
  });

  it("returns joined Channels to Wanted when the Session ends, and joins them again", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        lines("== closed Reset", "+2s", "-> dial irc.test:6697 tls"),
        registeredJoining(base, ">> JOIN #iirc").replace(/^!! configure\n-> dial[^\n]*\n/u, ""),
      ],
    });

    expect.assertions(0);
  });
});

describe("a key that cannot be filled", () => {
  it("refuses the Channel until the Configuration changes", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure +#secret key=chankey",
          ">> {JoinWithKey credential=chankey channel=#secret}",
          "== unfilled Missing",
          "+50s",
          "<< PING :keep",
          ">> PONG keep"
        ),
      ],
    });

    expect(client.known(played.state).channels.get("#secret")?.standing).toBe("Refused");
  });

  it("tries again on the next Configuration", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure +#secret key=chankey",
          ">> {JoinWithKey credential=chankey channel=#secret}",
          "== unfilled Unavailable",
          "!! configure",
          ">> {JoinWithKey credential=chankey channel=#secret}"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("tries again in the next Session", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure +#secret key=chankey",
          ">> {JoinWithKey credential=chankey channel=#secret}",
          "== unfilled Unsendable",
          "== closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls"
        ),
        registeredJoining(base, ">> {JoinWithKey credential=chankey channel=#secret}").replace(
          /^!! configure\n-> dial[^\n]*\n/u,
          ""
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("what is known of a Channel", () => {
  it("reads the topic sent on joining, and who set it when", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure +#iirc",
          ">> JOIN #iirc",
          "<< :iirc!~iirc@iirc.test JOIN #iirc",
          ">> MODE #iirc",
          "<< :irc.test 332 iirc #iirc :Welcome to #iirc",
          "<< :irc.test 333 iirc #iirc op!u@h 1767225600",
          "<< :irc.test 353 iirc = #iirc :iirc",
          "<< :irc.test 366 iirc #iirc :End"
        ),
      ],
    });

    expect(client.known(played.state).channels.get("#iirc")?.topic).toMatchObject({
      _tag: "Known",
      from: "ircd",
      value: { setAt: 1_767_225_600_000, setBy: "op", text: "Welcome to #iirc" },
    });
  });

  it("follows TOPIC, and reports it", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["op"]),
        lines(
          "+1s",
          "<< :op!u@h TOPIC #iirc :new topic",
          "?? activity TopicChanged #iirc by=op setBy=op setAt=t+1s in=channel:#iirc :new topic",
          "<< :op!u@h TOPIC #iirc :",
          "?? activity TopicChanged #iirc by=op cleared in=channel:#iirc"
        ),
      ],
    });

    expect(client.known(played.state).channels.get("#iirc")?.topic).toMatchObject({
      _tag: "Known",
      value: null,
    });
  });

  it("reads a topic reply later as replied, and 331 as none", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        lines("<< :irc.test 332 iirc #iirc :asked for"),
      ],
    });

    expect(client.known(played.state).channels.get("#iirc")?.topic).toMatchObject({
      _tag: "Known",
      from: "replied",
    });

    const none = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        "<< :irc.test 331 iirc #iirc :No topic\n",
      ],
    });

    expect(client.known(none.state).channels.get("#iirc")?.topic).toMatchObject({ value: null });
  });

  it("reads the modes from 324, and follows MODE, never showing a key", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          "<< :irc.test 324 iirc #iirc +ntk secret",
          "<< :op!u@h MODE #iirc +o-t+l peer 10",
          "?? activity ModeChanged #iirc by=op +o=peer -t +l=10 in=channel:#iirc",
          "<< :op!u@h MODE #iirc -k+b secret *!*@bad",
          '?? activity ModeChanged #iirc by=op -k +b="*!*@bad" in=channel:#iirc'
        ),
      ],
    });

    const channel = client.known(played.state).channels.get("#iirc");

    expect(channel?.modes).toMatchObject({
      _tag: "Known",
      value: new Map([
        ["n", null],
        ["l", "10"],
      ]),
    });
    expect(channel?.members.get("peer")?.prefixes).toMatchObject({
      _tag: "Known",
      value: new Set(["o"]),
    });
  });

  it("keeps a member's prefixes partial when the listing showed only the highest", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["@peer"]),
        "<< :op!u@h MODE #iirc +v-o peer peer\n",
      ],
    });

    expect(
      client.known(played.state).channels.get("#iirc")?.members.get("peer")?.prefixes
    ).toMatchObject({
      _tag: "Partial",
      atLeast: new Set(["v"]),
    });
  });

  it("follows members who join, part, quit, are kicked, and change nick", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["a", "b", "c"]),
        lines(
          "<< :d!~d@d.host JOIN #iirc",
          "?? activity Joined #iirc d in=channel:#iirc",
          "<< :a!~a@a.host PART #iirc :later",
          "?? activity Parted #iirc a in=channel:#iirc :later",
          "<< :b!~b@b.host QUIT :gone",
          "?? activity Quit b in=channel:#iirc in=existing-direct:b :gone",
          "<< :op!u@h KICK #iirc c :out",
          "?? activity Kicked #iirc c by=op in=channel:#iirc :out",
          "<< :d!~d@d.host NICK e",
          "?? activity NickChanged d e in=channel:#iirc in=renamed:d>e"
        ),
      ],
    });

    const known = client.known(played.state);

    expect([...(known.channels.get("#iirc")?.members.keys() ?? [])]).toStrictEqual(["iirc", "e"]);
    expect(known.users.get("e")).toMatchObject({
      mask: { _tag: "Known", value: { host: "d.host", user: "~d" } },
      nick: "e",
    });
    expect([...known.users.keys()].toSorted()).toStrictEqual(["e", "iirc"]);
  });

  it("follows Self's own nick change", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        lines(
          "<< :iirc!~iirc@iirc.test NICK :renamed",
          "?? activity NickChanged iirc renamed in=network in=channel:#iirc"
        ),
      ],
    });

    const known = client.known(played.state);

    expect(known.self?.nick).toBe("renamed");
    expect([...(known.channels.get("#iirc")?.members.keys() ?? [])]).toStrictEqual(["renamed"]);
  });

  it("follows away status from AWAY Lines of members", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          "<< :peer!u@h AWAY :lunch",
          "?? activity AwayChanged peer in=existing-direct:peer :lunch",
          "<< :stranger!u@h AWAY :elsewhere",
          "?? activity AwayChanged stranger in=existing-direct:stranger :elsewhere"
        ),
      ],
    });

    const known = client.known(played.state);

    expect(known.users.get("peer")?.away).toMatchObject({
      _tag: "Known",
      value: { message: "lunch" },
    });
    expect(known.users.has("stranger")).toBeFalsy();
  });
});
