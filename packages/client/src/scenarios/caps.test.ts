/**
 * Cap negotiation with the registry's Features: what is asked for, how answers and
 * changes mid-Session turn Features on and off, and caps' values.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { FeatureName } from "../ids.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const opened = lines(
  "!! configure",
  "-> dial irc.test:6697 tls",
  "== opened",
  ">> CAP LS 302",
  ">> NICK iirc",
  ">> USER iirc 0 * iirc"
);

const welcome = lines("<< :irc.test 001 iirc :Welcome", "?? session-began iirc");

// Every cap a Feature in the registry asks for, in the order it asks.
const all =
  "cap-notify sasl message-tags server-time batch labeled-response echo-message multi-prefix away-notify";

describe("asking for caps", () => {
  it("asks for every cap a Feature needs, in registry order, whatever order they are offered in", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        opened.trimEnd(),
        `<< :irc.test CAP * LS :${all.split(" ").toReversed().join(" ")} chghost draft/chathistory`,
        `>> CAP REQ :${all}`,
        `<< :irc.test CAP * ACK :${all.split(" ").toReversed().join(" ")}`,
        ">> CAP END"
      ),
    });

    expect(client.inspect(played.state).features).toStrictEqual([
      "cap-notify",
      "sasl",
      "message-tags",
      "server-time",
      "batch",
      "echo-message",
      "multi-prefix",
      "away-notify",
    ]);
  });

  it("asks for nothing a Feature the Owner declined needs", () => {
    const declined = configured({
      declined: [FeatureName.make("multi-prefix"), FeatureName.make("echo-message")],
    });

    play(client, {
      configuration: declined,
      transcript: registered(declined, {
        offered: ["batch", "labeled-response", "echo-message", "multi-prefix", "away-notify"],
        requested: ["batch", "away-notify"],
      }),
    });

    expect.assertions(0);
  });

  it("reads an LS over several Lines, with a Feature's caps split between them", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * LS * :labeled-response sasl=PLAIN,EXTERNAL",
        "<< :irc.test CAP * LS * :draft/languages=1,en multi-prefix",
        "<< :irc.test CAP * LS :echo-message",
        ">> CAP REQ :sasl labeled-response echo-message multi-prefix",
        "<< :irc.test CAP * ACK :sasl labeled-response echo-message multi-prefix",
        ">> CAP END"
      ),
    });

    expect.assertions(0);
  });

  it("reads caps' values, with = in them or none", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * LS :sasl=PLAIN,EXTERNAL draft/multiline=max-bytes=4096,max-lines=100 multi-prefix=",
        ">> CAP REQ :sasl multi-prefix",
        "<< :irc.test CAP * ACK :sasl multi-prefix",
        ">> CAP END"
      ),
    });

    expect(client.inspect(played.state).caps.offered).toStrictEqual(
      new Map([
        ["sasl", "PLAIN,EXTERNAL"],
        ["draft/multiline", "max-bytes=4096,max-lines=100"],
        ["multi-prefix", ""],
      ])
    );
  });

  it("asks for nothing when no Feature wants what is offered", () => {
    play(client, {
      configuration: base,
      transcript: registered(base, { offered: ["chghost", "account-notify"], requested: [] }),
    });

    expect.assertions(0);
  });
});

describe("answers", () => {
  it("turns on only what the Ircd acknowledged", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * LS :multi-prefix away-notify",
        ">> CAP REQ :multi-prefix away-notify",
        "<< :irc.test CAP * ACK :away-notify",
        ">> CAP END"
      ),
    });

    expect(client.inspect(played.state).features).toStrictEqual(["away-notify"]);
  });

  it("turns on nothing when the request is refused, and ends negotiation", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * LS :multi-prefix away-notify",
        ">> CAP REQ :multi-prefix away-notify",
        "<< :irc.test CAP * NAK :multi-prefix away-notify",
        ">> CAP END"
      ),
    });

    expect(client.inspect(played.state).features).toStrictEqual([]);
  });

  it("refuses the whole request when the NAK names only part of it", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * LS :multi-prefix away-notify",
        ">> CAP REQ :multi-prefix away-notify",
        "<< :irc.test CAP * NAK :away-notify",
        ">> CAP END"
      ),
    });

    expect(client.inspect(played.state).features).toStrictEqual([]);
  });

  it("waits for the last Line of an ACK spread over several", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * LS :multi-prefix away-notify",
        ">> CAP REQ :multi-prefix away-notify",
        "<< :irc.test CAP * ACK * :multi-prefix",
        "<< :irc.test CAP * ACK :away-notify",
        ">> CAP END"
      ),
    });

    expect(client.inspect(played.state).features).toStrictEqual(["multi-prefix", "away-notify"]);
  });

  it("takes an answer that comes after 001", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        lines(opened.trimEnd(), "<< :irc.test CAP * LS :multi-prefix", ">> CAP REQ multi-prefix"),
        welcome,
        lines("<< :irc.test CAP iirc ACK :multi-prefix"),
      ],
    });

    expect(client.inspect(played.state)).toMatchObject({
      features: ["multi-prefix"],
      states: { caps: "Ready.Steady" },
    });
  });
});

describe("caps changing mid-Session", () => {
  const steady = [
    registered(base, { offered: ["cap-notify", "multi-prefix"] }),
    joined(base, "#iirc", ["@op"]),
  ];

  it("asks for what it wants of a CAP NEW, and only that", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...steady,
        lines(
          "<< :irc.test CAP iirc NEW :away-notify chghost",
          ">> CAP REQ away-notify",
          "<< :irc.test CAP iirc ACK :away-notify"
        ),
      ],
    });

    expect(client.inspect(played.state)).toMatchObject({
      features: ["cap-notify", "multi-prefix", "away-notify"],
      states: { caps: "Ready.Steady" },
    });
  });

  it("asks for nothing when a CAP NEW holds nothing it wants", () => {
    const played = play(client, {
      configuration: base,
      transcript: [...steady, lines("<< :irc.test CAP iirc NEW :chghost")],
    });

    expect(client.inspect(played.state).states.caps).toBe("Ready.Steady");
  });

  it("asks for all of a Feature's caps when the one it lacked is new", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, {
          offered: ["cap-notify", "labeled-response"],
          requested: ["cap-notify"],
        }),
        lines(
          "<< :irc.test CAP iirc NEW :echo-message",
          ">> CAP REQ :labeled-response echo-message",
          "<< :irc.test CAP iirc ACK :labeled-response echo-message"
        ),
      ],
    });

    expect(client.inspect(played.state).features).toContain("echo-message");
  });

  it("turns Features off on CAP DEL, and their kept facts go stale", () => {
    const played = play(client, {
      configuration: base,
      transcript: [...steady, lines("+1s", "<< :irc.test CAP iirc DEL :multi-prefix")],
    });

    expect(client.inspect(played.state).features).toStrictEqual(["cap-notify"]);
    expect(
      client.known(played.state).channels.get("#iirc")?.members.get("op")?.prefixes
    ).toMatchObject({
      _tag: "Stale",
    });
  });

  it("takes a CAP NEW while its own request is still unanswered", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        lines(
          opened.trimEnd(),
          "<< :irc.test CAP * LS :cap-notify multi-prefix",
          ">> CAP REQ :cap-notify multi-prefix",
          "<< :irc.test CAP * NEW :away-notify",
          ">> CAP REQ away-notify",
          "<< :irc.test CAP * ACK :cap-notify multi-prefix",
          "<< :irc.test CAP * ACK :away-notify",
          ">> CAP END"
        ),
        welcome,
      ],
    });

    expect(client.inspect(played.state).features).toStrictEqual([
      "cap-notify",
      "multi-prefix",
      "away-notify",
    ]);
  });

  it("takes a CAP DEL before negotiation is over", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        lines(
          opened.trimEnd(),
          "<< :irc.test CAP * LS :multi-prefix away-notify",
          ">> CAP REQ :multi-prefix away-notify",
          "<< :irc.test CAP * ACK :multi-prefix away-notify",
          ">> CAP END",
          "<< :irc.test CAP * DEL :away-notify"
        ),
        welcome,
      ],
    });

    expect(client.inspect(played.state).features).toStrictEqual(["multi-prefix"]);
  });

  it("ignores CAP NEW and DEL before the list is in", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        opened.trimEnd(),
        "<< :irc.test CAP * NEW :multi-prefix",
        "?? ignored NotNow Received",
        "<< :irc.test CAP * DEL :multi-prefix",
        "?? ignored NotNow Received"
      ),
    });

    expect.assertions(0);
  });
});
