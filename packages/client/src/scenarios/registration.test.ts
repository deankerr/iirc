import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { CapName } from "../ids.ts";
import { configured, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const opened = (nick = "iirc") =>
  lines(
    "!! configure",
    "-> dial irc.test:6697 tls",
    "== opened",
    ">> CAP LS 302",
    `>> NICK ${nick}`,
    ">> USER iirc 0 * iirc"
  );

const welcome = (nick = "iirc") =>
  `<< :irc.test 001 ${nick} :Welcome ${nick}\n?? session-began ${nick}\n`;

describe("cap negotiation on the floor", () => {
  it("registers when the Ircd answers CAP with 421", () => {
    const played = play(client, { configuration: base, transcript: registered(base) });

    expect(client.inspect(played.state).states).toMatchObject({
      caps: "None",
      network: "Connection.Open",
      presence: "Session",
    });
    expect(played.ignored).toStrictEqual([]);
  });

  it("registers when the Ircd never answers CAP and goes straight to 001", () => {
    const played = play(client, { configuration: base, transcript: opened() + welcome() });

    expect(client.inspect(played.state).states.caps).toBe("None");
  });

  it("ends negotiation at once when it wants none of the caps offered", () => {
    const played = play(client, {
      configuration: base,
      transcript: registered(base, { offered: ["multi-prefix", "sasl=PLAIN"], requested: [] }),
    });

    expect(client.inspect(played.state)).toMatchObject({
      caps: {
        enabled: new Set(),
        offered: new Map([
          ["multi-prefix", ""],
          ["sasl", "PLAIN"],
        ]),
      },
      features: [],
      states: { caps: "Ready.Steady" },
    });
  });

  it("reads a CAP LS over several Lines before ending negotiation", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        opened(),
        lines(
          "<< :irc.test CAP * LS * :multi-prefix sasl=PLAIN,EXTERNAL",
          "<< :irc.test CAP * LS * :server-time",
          "<< :irc.test CAP * LS :away-notify",
          ">> CAP END"
        ),
        welcome(),
      ],
    });

    expect([...client.inspect(played.state).caps.offered.keys()]).toStrictEqual([
      "multi-prefix",
      "sasl",
      "server-time",
      "away-notify",
    ]);
  });

  it("follows CAP NEW and CAP DEL once negotiation is over", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["multi-prefix"], requested: [] }),
        lines("<< :irc.test CAP iirc NEW :away-notify", "<< :irc.test CAP iirc DEL :multi-prefix"),
      ],
    });

    expect(client.inspect(played.state).caps.offered).toStrictEqual(
      new Map([[CapName.make("away-notify"), ""]])
    );
  });

  it("ignores a CAP Line that makes no sense now, and one that does not fit", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["multi-prefix"], requested: [] }),
        lines(
          "<< :irc.test CAP iirc ACK :multi-prefix",
          "?? ignored NotNow Received",
          "<< :irc.test CAP iirc LS :multi-prefix",
          "?? ignored NotNow Received",
          "<< :irc.test CAP iirc LIST :multi-prefix",
          "?? ignored NotNow Received",
          "<< :irc.test CAP *",
          "?? ignored Malformed CAP"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("ignores CAP once an Ircd has shown it has no cap negotiation", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        "<< :irc.test CAP iirc NEW :multi-prefix\n?? ignored NotNow Received\n",
      ],
    });

    expect.assertions(0);
  });
});

describe("PASS, NICK, and USER", () => {
  it("sends PASS by its Credential's name, before NICK", () => {
    const withPass = configured({ password: CredentialName.make("network") });

    play(client, { configuration: withPass, transcript: registered(withPass) });

    expect.assertions(0);
  });

  it("goes on without PASS when it cannot be filled, and the Ircd decides", () => {
    const withPass = configured({ password: CredentialName.make("network") });

    play(client, {
      configuration: withPass,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> {Pass credential=network}",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "== unfilled Missing",
        "<< :irc.test 421 * CAP :Unknown command",
        "<< :irc.test 001 iirc :Welcome",
        "?? session-began iirc"
      ),
    });

    expect.assertions(0);
  });

  it("skips a configured nick that cannot be sent", () => {
    play(client, {
      configuration: configured({ nicks: ["bad nick", "good"] }),
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK good",
        ">> USER iirc 0 * iirc"
      ),
    });

    expect.assertions(0);
  });
});

describe("offering nicks", () => {
  it("offers the next nick on a 433 before CAP is answered", () => {
    play(client, {
      configuration: base,
      transcript: [
        opened(),
        lines(
          "<< :irc.test 433 * iirc :Nickname is already in use",
          ">> NICK iirc_",
          "<< :irc.test CAP * LS :multi-prefix",
          ">> CAP END"
        ),
        welcome("iirc_"),
      ],
    });

    expect.assertions(0);
  });

  it("offers the next nick on a 433 after CAP END", () => {
    play(client, {
      configuration: base,
      transcript: [
        opened(),
        lines(
          "<< :irc.test CAP * LS :multi-prefix",
          ">> CAP END",
          "<< :irc.test 433 * iirc :Nickname is already in use",
          ">> NICK iirc_"
        ),
        welcome("iirc_"),
      ],
    });

    expect.assertions(0);
  });

  it("offers the next nick on a 433 from an Ircd with no CAP", () => {
    play(client, {
      configuration: base,
      transcript: [
        opened(),
        lines(
          "<< :irc.test 421 * CAP :Unknown command",
          "<< :irc.test 433 * iirc :Nickname is already in use",
          ">> NICK iirc_"
        ),
        welcome("iirc_"),
      ],
    });

    expect.assertions(0);
  });

  it("offers the configured nicks in order, then fallbacks made from the first", () => {
    play(client, {
      configuration: configured({ nicks: ["ab", "cd"] }),
      transcript: [
        opened("ab"),
        lines(
          "<< :irc.test 433 * ab :in use",
          ">> NICK cd",
          "<< :irc.test 432 * cd :Erroneous nickname",
          ">> NICK ab_",
          "<< :irc.test 436 * ab_ :Nickname collision",
          ">> NICK ab2",
          "<< :irc.test 437 * ab2 :Nick temporarily unavailable",
          ">> NICK ab3"
        ),
        welcome("ab3"),
      ],
    });

    expect.assertions(0);
  });

  it("keeps a fallback as long as the first nick, or 9 characters", () => {
    const long = "averyveryverylongnick";

    play(client, {
      configuration: configured({ nicks: [long] }),
      transcript: [
        opened(long),
        lines(
          `<< :irc.test 433 * ${long} :in use`,
          ">> NICK averyveryverylongnic_",
          "<< :irc.test 433 * averyveryverylongnic_ :in use",
          ">> NICK averyveryverylongnic2"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("takes Self's nick from 001, whatever was offered", () => {
    const played = play(client, {
      configuration: base,
      transcript: [opened(), welcome("Changed")],
    });

    expect(client.known(played.state).self?.nick).toBe("Changed");
  });

  it("takes the nick on offer when 001 names none", () => {
    play(client, {
      configuration: base,
      transcript: [opened(), "<< :irc.test 001\n?? session-began iirc\n"],
    });

    expect.assertions(0);
  });

  it("offers no nick on a 433 after 001", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), "<< :irc.test 433 iirc other :in use\n"],
    });

    expect(played.steps.at(-1)?.outputs).toStrictEqual([]);
  });

  it("ignores a second 001", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        "<< :irc.test 001 iirc :Welcome again\n?? ignored NotNow Received\n",
      ],
    });

    expect.assertions(0);
  });
});

describe("the registration deadline", () => {
  it("ends a Connection that never reaches 001 after 60 s, and redials", () => {
    play(client, {
      configuration: base,
      transcript: [
        opened(),
        lines(
          "+59s",
          "<< :irc.test 433 * iirc :in use",
          ">> NICK iirc_",
          "+1s",
          "-> hangup",
          "== closed HungUp",
          "?? connection-failed Silent",
          "+2s",
          "-> dial irc.test:6697 tls"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is cancelled by 001", () => {
    const played = play(client, { configuration: base, transcript: registered(base) });

    expect([...client.inspect(played.state).timers.keys()]).toStrictEqual(["keepalive"]);
  });

  it("ignores a stale firing of it", () => {
    play(client, {
      configuration: base,
      transcript: [registered(base), "== fired register t+60s\n?? ignored StaleTimer register\n"],
    });

    expect.assertions(0);
  });
});
