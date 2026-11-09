/**
 * The recorded fixtures, replayed through the Client, and one long synthetic scenario
 * folded again in a fresh process. The fixtures' `>>` Lines are the recorder's, so they
 * are not matched: what matters is that the Client registers, follows the Session, and
 * ignores only what a correct Client should.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import ergoFeatures from "../../../../fixtures/transcripts/ergo/first-features.irc?raw";
import ergoFloor from "../../../../fixtures/transcripts/ergo/floor.irc?raw";
import ngircdFeatures from "../../../../fixtures/transcripts/ngircd/first-features.irc?raw";
import ngircdFloor from "../../../../fixtures/transcripts/ngircd/floor.irc?raw";
import { client } from "../core.ts";
import { configured, joined, play, registered, replay, replayFresh } from "../testing/index.ts";

const ergo = (port: number, tls: boolean) => ({ host: "ergo.test", port, tls });
const ngircd = { host: "ngircd.test", port: 6667, tls: false };

// The recorder asked for caps the floor Client has no Feature for. With an empty
// registry, the Client ends negotiation at once, so the Ircd's acknowledgement of the
// recorder's request comes when nothing was asked: that alone is ignored.
const unasked = "?? ignored NotNow Received";

const fixtures = [
  [
    "ergo/first-features",
    ergoFeatures,
    configured({
      ircds: [ergo(6697, true)],
      login: {
        _tag: "Sasl",
        account: "iirc",
        credential: CredentialName.make("iirc"),
        required: true,
      },
    }),
    [unasked],
  ],
  ["ergo/floor", ergoFloor, configured({ ircds: [ergo(6667, false)] }), []],
  ["ngircd/first-features", ngircdFeatures, configured({ ircds: [ngircd] }), [unasked]],
  ["ngircd/floor", ngircdFloor, configured({ ircds: [ngircd] }), []],
] as const;

describe("the recorded fixtures", () => {
  it.each(fixtures)(
    "%s registers, joins, and ignores only what it should",
    (_name, transcript, configuration, ignored) => {
      const played = replay(client, { configuration, transcript });

      expect(played.ignored.map((each) => each.split("\n").at(-1))).toStrictEqual(ignored);
      expect(played.transcript).toContain("?? session-began iirc_");
      expect(played.transcript).toContain("?? activity Joined #iirc iirc_");
      expect(played.transcript).toContain("?? message Privmsg peer #iirc :hello from the peer");
      expect(played.transcript).toContain("?? session-ended Error");
    }
  );

  it.each(fixtures)(
    "%s leaves Knowledge as the Session left it",
    (_name, transcript, configuration) => {
      const before = replay(client, {
        configuration,
        transcript: transcript.slice(0, transcript.indexOf(">> QUIT")),
      });

      const known = client.known(before.state);
      const channel = known.channels.get("#iirc");

      expect(known.session._tag).toBe("Registered");
      expect(known.casemapping).toBe("ascii");
      expect(channel?.standing).toBe("Joined");
      expect([...(channel?.members.keys() ?? [])].toSorted()).toStrictEqual(["iirc_", "peer"]);
    }
  );
});

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// A Session's worth of traffic: Messages, Activity, `PING`s, and a quiet spell long
// enough for the lag `PING`.
const traffic = (round: number): string =>
  Array.from({ length: 20 }, (_unused, index) =>
    lines(
      "+3s",
      `<< :peer${index}!u@h JOIN #iirc`,
      `<< :peer${index}!u@h PRIVMSG #iirc :round ${round} line ${index}`,
      `<< :op!u@h MODE #iirc +v peer${index}`,
      `<< :peer${index}!u@h NICK other${index}`,
      `<< :other${index}!u@h PART #iirc :bye`,
      "<< PING :keep",
      ">> PONG keep"
    )
  ).join("") + lines("+60s", ">> PING iirc", "<< :irc.test PONG irc.test iirc");

// Registration again after a redial, without the first Configured and dial.
const again = (): string =>
  registered(base)
    .replace(/^!! configure\n-> dial[^\n]*\n/u, "")
    .replace(/(?<welcome><< :irc\.test 001 [^\n]*\n)/u, "$<welcome>>> JOIN #iirc\n");

const long = [
  registered(base),
  joined(base, "#iirc", ["@op"]),
  traffic(1),
  lines("== closed Reset", "+2s", "-> dial irc.test:6697 tls"),
  again(),
  lines(
    "<< :iirc!~iirc@iirc.test JOIN #iirc",
    "<< :irc.test 353 iirc = #iirc :iirc @op",
    "<< :irc.test 366 iirc #iirc :End"
  ),
  traffic(2),
  lines(
    "+60s",
    ">> PING iirc",
    "+30s",
    "-> hangup",
    "== closed HungUp",
    "+4s",
    "-> dial irc.test:6697 tls"
  ),
  again(),
  traffic(3),
];

describe("a long scenario", () => {
  it("plays, with reconnects, hundreds of Lines, and timers", () => {
    const played = play(client, { configuration: base, transcript: long });

    expect(played.inputs.length).toBeGreaterThan(400);
    expect(client.inspect(played.state).connection).toBe(3);
  });

  it("folds the same in a fresh process", async () => {
    const played = play(client, { configuration: base, transcript: long });

    await expect(
      replayFresh(client, played.inputs, {
        module: new URL("../core.ts", import.meta.url),
        name: "client",
      })
    ).resolves.toBeUndefined();
  });
});
