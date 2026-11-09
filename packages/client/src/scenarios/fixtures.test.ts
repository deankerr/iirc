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
  ],
  ["ergo/floor", ergoFloor, configured({ ircds: [ergo(6667, false)] })],
  ["ngircd/first-features", ngircdFeatures, configured({ ircds: [ngircd] })],
  ["ngircd/floor", ngircdFloor, configured({ ircds: [ngircd] })],
] as const;

describe("the recorded fixtures", () => {
  it.each(fixtures)(
    "%s registers, joins, and ignores nothing",
    (_name, transcript, configuration) => {
      const played = replay(client, { configuration, transcript });

      expect(played.ignored).toStrictEqual([]);
      expect(played.transcript).toContain("?? session-began iirc_");
      expect(played.transcript).toContain("?? activity Joined #iirc iirc_");
      expect(played.transcript).toMatch(/\?\? message Privmsg peer #iirc .*:hello from the peer/u);
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

const until = (transcript: string, marker: string) =>
  transcript.slice(0, transcript.indexOf(marker));

describe("the first Features on the recorded Ircds", () => {
  const [[, ergoTranscript, ergoConfiguration], , [, ngircdTranscript, ngircdConfiguration]] =
    fixtures;

  it("logs in to Ergo with SASL, and confirms our Messages by their echoes", () => {
    const played = replay(client, {
      configuration: ergoConfiguration,
      transcript: ergoTranscript,
    });

    expect(played.transcript).toContain(
      ">> {AuthenticatePlain credential=iirc authcid=iirc authzid=iirc}"
    );
    expect(played.transcript).toContain(">> @label=l1 PRIVMSG #iirc :hello from iirc");
    expect(played.transcript).toContain(
      "?? message Privmsg iirc_ #iirc at=ours:t+1s ours=i1 echo :hello from iirc"
    );
    expect(played.transcript).toContain("?? confirmed i1 at=ircd:t+1s id=ircd:m4 :hello from iirc");
    expect(played.transcript).toContain("?? confirmed i2 at=ircd:t+2s id=ircd:m6 :psst back");
  });

  it("knows what Ergo's Features made known", () => {
    const played = replay(client, {
      configuration: ergoConfiguration,
      transcript: until(ergoTranscript, ">> QUIT"),
    });

    const known = client.known(played.state);

    expect(client.inspect(played.state).features).toStrictEqual([
      "cap-notify",
      "sasl",
      "message-tags",
      "server-time",
      "batch",
      "echo-message",
      "multi-prefix",
      "utf8only",
    ]);
    expect(known.self?.account).toMatchObject({ _tag: "Known", value: "iirc" });
    expect(known.channels.get("#iirc")?.members.get("iirc_")?.prefixes).toMatchObject({
      _tag: "Known",
      value: new Set(["o"]),
    });
  });

  it("turns on only multi-prefix with ngircd", () => {
    const played = replay(client, {
      configuration: ngircdConfiguration,
      transcript: until(ngircdTranscript, ">> QUIT"),
    });

    expect(client.inspect(played.state).features).toStrictEqual(["multi-prefix"]);
    expect(
      client.known(played.state).channels.get("#iirc")?.members.get("iirc_")?.prefixes
    ).toMatchObject({ _tag: "Known", value: new Set(["o"]) });
    expect(played.transcript).toContain(
      "?? message Privmsg iirc_ #iirc at=ours:t+5s ours=i1 :hello from iirc"
    );
  });
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
