/**
 * Regressions found in review. Each scenario failed before its fix. Where the
 * bug lived in State that Knowledge hides, the test reads State directly.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, joined, play, registered } from "../testing/index.ts";
import { openOf } from "../views.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Registration again after a redial, without the first Configured and its dial.
const again = (configuration = base, ...afterWelcome: readonly string[]): string =>
  registered(configuration, { isupport: [] })
    .replace(/^!! configure\n-> dial[^\n]*\n/u, "")
    .replace(/(?<welcome><< :irc\.test 001 [^\n]*\n)/u, `$<welcome>${lines(...afterWelcome)}`);

describe("1. Users who share no Channel are forgotten", () => {
  it("when a NAMES listing replaces the members", () => {
    const churn = Array.from({ length: 5 }, (_unused, index) =>
      lines(
        `<< :peer${index}!u@h JOIN #a`,
        `?? activity Joined #a peer${index} in=channel:#a`,
        "<< :irc.test 353 iirc = #a :iirc",
        "<< :irc.test 366 iirc #a :End"
      )
    ).join("");

    const played = play(client, {
      configuration: base,
      transcript: [registered(base), joined(base, "#a"), churn],
    });

    expect(openOf(played.state)?.users.size).toBe(0);
  });
});

describe("2. A casemapping change keeps every wanted Channel", () => {
  it("makes a machine for a Channel the new casemapping tells apart, and joins it", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure +#x[ +#x{",
          ">> JOIN #x[",
          "<< :irc.test 005 iirc CASEMAPPING=ascii :are supported",
          ">> JOIN #x{"
        ),
      ],
    });

    expect([...played.state.channels.keys()].toSorted()).toStrictEqual(["#x[", "#x{"]);
  });

  it("keeps the first of the Channels a new casemapping merges, and parts none", () => {
    const ascii = ["CASEMAPPING=ascii", "CHANTYPES=#"];

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ascii }),
        lines(
          "!! configure +#x[ +#x{",
          ">> JOIN #x[,#x{",
          "<< :iirc!~iirc@h JOIN #x[",
          ">> MODE #x[",
          "<< :iirc!~iirc@h JOIN #x{",
          "<< :irc.test 005 iirc CASEMAPPING=rfc1459 :are supported"
        ),
      ],
    });

    expect([...played.state.channels]).toMatchObject([
      ["#x{", { name: "#x[", phase: { _tag: "Joined" }, wanted: true }],
    ]);
  });
});

describe("3. Each Connection starts from the protocol's casemapping", () => {
  it("does not take the last Ircd's casemapping to the next", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CASEMAPPING=ascii"] }),
        lines(
          "!! configure +#X[",
          ">> JOIN #X[",
          "== closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls"
        ),
        again(base, ">> JOIN #X["),
        lines(
          "<< :iirc!~iirc@h JOIN #x{",
          "?? activity Joined #x{ iirc in=channel:#x{",
          ">> MODE #X["
        ),
      ],
    });

    const known = client.known(played.state);

    expect(known.casemapping).toBe("rfc1459");
    expect(known.channels.get("#x{")?.standing).toBe("Joined");
  });
});

describe("4. Membership changes during NAMES are kept when it ends", () => {
  it("during the first sync", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure +#a",
          ">> JOIN #a",
          "<< :iirc!~iirc@h JOIN #a",
          ">> MODE #a",
          "<< :irc.test 353 iirc = #a :iirc peer",
          "<< :op!u@h MODE #a +o peer",
          "<< :irc.test 366 iirc #a :End"
        ),
      ],
    });

    expect(
      client.known(played.state).channels.get("#a")?.members.get("peer")?.prefixes
    ).toMatchObject({
      _tag: "Known",
      value: new Set(["o"]),
    });
  });

  it("during a later NAMES", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#a", ["peer"]),
        lines(
          "<< :irc.test 353 iirc = #a :iirc peer",
          "<< :op!u@h MODE #a +v peer",
          "<< :late!u@h JOIN #a",
          "<< :irc.test 366 iirc #a :End"
        ),
      ],
    });

    const members = client.known(played.state).channels.get("#a")?.members;

    expect(members?.get("peer")?.prefixes).toMatchObject({ _tag: "Known", value: new Set(["v"]) });
    expect(members?.has("late")).toBeTruthy();
  });
});

describe("5. Nick fallbacks fit the Ircd's NICKLEN", () => {
  const long = "verylongnickname";

  const opening = lines(
    "!! configure",
    "-> dial irc.test:6697 tls",
    "== opened",
    ">> CAP LS 302",
    `>> NICK ${long}`,
    ">> USER iirc 0 * iirc"
  );

  it("assumes RFC 2812's 9 until NICKLEN is announced", () => {
    play(client, {
      configuration: configured({ nicks: [long] }),
      transcript: [
        opening,
        lines(
          `<< :irc.test 432 * ${long} :Erroneous nickname`,
          ">> NICK verylong_",
          "<< :irc.test 433 * verylong_ :in use",
          ">> NICK verylong2"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("uses NICKLEN once the Ircd announces it", () => {
    play(client, {
      configuration: configured({ nicks: [long] }),
      transcript: [
        opening,
        lines(
          "<< :irc.test 005 * NICKLEN=12 :are supported",
          `<< :irc.test 432 * ${long} :Erroneous nickname`,
          ">> NICK verylongnic_"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("6. Nothing is sent after QUIT and Hangup", () => {
  it("when a Configuration disables the Network and changes its Channels", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#old"),
        lines("!! configure disable +#new -#old", ">> QUIT", "-> hangup"),
      ],
    });

    expect.assertions(0);
  });

  it("when the Ircd says something while the Client hangs up", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure disable",
          ">> QUIT",
          "-> hangup",
          "<< PING :still there",
          "!! configure enable +#new",
          "<< :irc.test 005 iirc CASEMAPPING=ascii :are supported"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("7. A Channel Self is put in without asking is modelled, and not undone", () => {
  const forced = lines(
    "<< :iirc!~iirc@h JOIN #forced",
    "?? activity Joined #forced iirc in=channel:#forced",
    ">> MODE #forced",
    "<< :irc.test 332 iirc #forced :an oper put you here",
    "<< :irc.test 353 iirc = #forced :iirc @oper",
    "<< :irc.test 366 iirc #forced :End"
  );

  it("syncs it like any other, and shows it as not wanted", () => {
    const played = play(client, { configuration: base, transcript: [registered(base), forced] });
    const channel = client.known(played.state).channels.get("#forced");

    expect(channel).toMatchObject({
      standing: "Joined",
      topic: { _tag: "Known", value: { text: "an oper put you here" } },
      wanted: false,
    });
    expect([...(channel?.members.keys() ?? [])]).toStrictEqual(["iirc", "oper"]);
  });

  it("is not parted by a Configuration, and becomes wanted when the Owner names it", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        forced,
        lines("!! configure +#other", ">> JOIN #other", "!! configure +#forced"),
      ],
    });

    expect(client.known(played.state).channels.get("#forced")).toMatchObject({
      standing: "Joined",
      wanted: true,
    });
  });

  it("is forgotten when Self leaves it, or the Session ends, and never joined again", () => {
    const parted = play(client, {
      configuration: base,
      transcript: [registered(base), forced, "<< :iirc!~iirc@h PART #forced\n+60s\n>> PING iirc\n"],
    });

    const ended = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        forced,
        lines("== closed Reset", "+2s", "-> dial irc.test:6697 tls"),
        again(),
      ],
    });

    expect(parted.state.channels.size).toBe(0);
    expect(ended.state.channels.size).toBe(0);
  });

  it("is bounded by CHANLIMIT, and past it is ignored", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CHANLIMIT=#:2", "CHANTYPES=#"] }),
        lines(
          "<< :iirc!~iirc@h JOIN #one",
          ">> MODE #one",
          "<< :iirc!~iirc@h JOIN #two",
          "<< :iirc!~iirc@h JOIN #three",
          "?? activity Joined #three iirc in=channel:#three",
          "?? ignored NotNow Received"
        ),
      ],
    });

    expect([...played.state.channels.keys()]).toStrictEqual(["#one", "#two"]);
  });
});

describe("8. Self's mask is never read from 001's text", () => {
  const masked = registered(base).replace(
    ":Welcome to the iirc-test Network iirc",
    ":Welcome to the Internet Relay Network iirc!~iirc@127.0.0.1"
  );

  it("leaves the mask unknown", () => {
    const played = play(client, { configuration: base, transcript: masked });

    expect(client.known(played.state).self?.mask._tag).toBe("Unknown");
  });

  it("keeps the conservative allowance for what the Ircd relays", () => {
    const longest = "x".repeat(416);

    play(client, {
      configuration: base,
      transcript: [
        masked,
        lines(
          `!! say #iirc :${longest}`,
          `>> PRIVMSG #iirc ${longest}`,
          `!! say #iirc :${longest}x`,
          "?? refused i2 Unsendable"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("9. Generated nicks fit even a small NICKLEN", () => {
  const opening = lines(
    "!! configure",
    "-> dial irc.test:6697 tls",
    "== opened",
    ">> CAP LS 302",
    ">> NICK iirc",
    ">> USER iirc 0 * iirc"
  );

  it("offers no fallback at all when NICKLEN=1 leaves no room, and the deadline ends it", () => {
    play(client, {
      configuration: base,
      transcript: [
        opening,
        lines(
          "<< :irc.test 005 * NICKLEN=1 :are supported",
          "<< :irc.test 433 * iirc :in use",
          "+60s",
          "-> hangup"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("resumes offering when a later 005 raises NICKLEN", () => {
    play(client, {
      configuration: base,
      transcript: [
        opening,
        lines(
          "<< :irc.test 005 * NICKLEN=1 :are supported",
          "<< :irc.test 433 * iirc :in use",
          "<< :irc.test 005 * NICKLEN=2 :are supported",
          "<< :irc.test 433 * iirc :in use",
          ">> NICK i_"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("stops at the first fallback whose suffix leaves no room, when NICKLEN=2", () => {
    const fallbacks = ["i_", ...Array.from({ length: 8 }, (_unused, index) => `i${index + 2}`)];

    const offers = ["iirc", ...fallbacks]
      .map((refused, index) =>
        lines(
          `<< :irc.test 433 * ${refused} :in use`,
          ...(index < fallbacks.length ? [`>> NICK ${fallbacks[index]}`] : [])
        )
      )
      .join("");

    play(client, {
      configuration: base,
      transcript: [
        opening,
        "<< :irc.test 005 * NICKLEN=2 :are supported\n",
        offers,
        lines("+60s", "-> hangup"),
      ],
    });

    expect.assertions(0);
  });
});

// Self put in Channels without asking.
const forced = (...names: readonly string[]) =>
  lines(...names.map((name) => `<< :iirc!~iirc@h JOIN ${name}`));

// The MODE query the first of them draws, which no Ircd here answers, so it is the only one.
const asked = (name: string) => `>> MODE ${name}\n`;

describe("10. Forced Channels count within their own CHANLIMIT group", () => {
  it("keeps separate groups independent", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CHANTYPES=#&", "CHANLIMIT=#:1,&:1"] }),
        forced("#one"),
        asked("#one"),
        forced("#two"),
        "?? ignored NotNow Received\n",
        forced("&one"),
      ],
    });

    expect([...played.state.channels.keys()]).toStrictEqual(["#one", "&one"]);
  });

  it("shares one count within a grouped entry", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CHANTYPES=#&+", "CHANLIMIT=#&:2,+:5"] }),
        forced("+other"),
        asked("+other"),
        forced("#one", "&one"),
        forced("#two"),
        "?? ignored NotNow Received\n",
      ],
    });

    expect([...played.state.channels.keys()]).toStrictEqual(["+other", "#one", "&one"]);
  });

  it("ignores a JOIN to a name that is no Channel by CHANTYPES, and counts it nowhere", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CHANTYPES=#", "CHANLIMIT=#&:2"] }),
        forced("&one"),
        "?? ignored Malformed JOIN\n",
        forced("#one"),
        asked("#one"),
        forced("#two"),
      ],
    });

    expect([...played.state.channels.keys()]).toStrictEqual(["#one", "#two"]);
  });

  it("falls back to 64 for a prefix CHANLIMIT does not list", () => {
    const many = Array.from({ length: 64 }, (_unused, index) => `&c${index}`);

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CHANTYPES=#&", "CHANLIMIT=#:1"] }),
        forced("#one"),
        asked("#one"),
        forced(...many),
        forced("&late"),
        "?? ignored NotNow Received\n",
      ],
    });

    expect(played.state.channels.size).toBe(65);
  });
});
