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
import hybridWatch from "../../../../fixtures/transcripts/hybrid/watch.irc?raw";
import ngircdFeatures from "../../../../fixtures/transcripts/ngircd/first-features.irc?raw";
import ngircdFloor from "../../../../fixtures/transcripts/ngircd/floor.irc?raw";
import { client } from "../core.ts";
import {
  configured,
  floorIsupport,
  joined,
  play,
  registered,
  replay,
  replayFresh,
} from "../testing/index.ts";

const ergo = (port: number, tls: boolean) => ({ host: "ergo.test", port, tls });
const ngircd = { host: "ngircd.test", port: 6667, tls: false };
const hybrid = { host: "hybrid.test", port: 6667, tls: false };

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
  ["hybrid/watch", hybridWatch, configured({ ircds: [hybrid] })],
] as const;

// The transcript up to the first line that starts with the marker, as a peer's comment
// may hold the same words.
const until = (transcript: string, marker: string) =>
  transcript.slice(0, transcript.indexOf(`\n${marker}`) + 1);

describe("the recorded fixtures", () => {
  it.each(fixtures)(
    "%s registers, joins, and ignores nothing",
    (_name, transcript, configuration) => {
      const played = replay(client, { configuration, transcript });

      expect(played.ignored).toStrictEqual([]);
      expect(played.transcript).toContain("?? session-began iirc_");
      expect(played.transcript).toMatch(/\?\? activity Joined #iirc iirc_ .*in=channel:#iirc$/mu);
      expect(played.transcript).toMatch(
        /\?\? message Privmsg peer #iirc .*in=channel:#iirc :hello from the peer/u
      );
      expect(played.transcript).toContain("?? session-ended Error");
    }
  );

  it.each(fixtures)(
    "%s leaves Knowledge as the Session left it",
    (_name, transcript, configuration) => {
      const before = replay(client, {
        configuration,
        transcript: until(transcript, ">> QUIT"),
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

// Each numeric shown, by number, as `describeNews` writes it.
const shownNumerics = (transcript: string): readonly string[] =>
  [...transcript.matchAll(/^\?\? activity Numeric (?<numeric>\d{3}) /gmu)].map(
    (match) => match.groups?.numeric ?? ""
  );

describe("a Session's opening on the recorded Ircds", () => {
  it.each([
    [
      "ergo/floor",
      ["433", "001", "002", "003", "004", "251", "252", "253", "254", "255", "265", "266", "221"],
    ],
    ["ngircd/floor", ["433", "001", "002", "003", "004", "251", "254", "255", "265", "266", "250"]],
  ])("%s shows what the Ircd said that nothing else reports, once", (name, numerics) => {
    const [, transcript, configuration] = fixtures.find(([each]) => each === name) ?? [];

    if (transcript === undefined || configuration === undefined) {
      throw new TypeError(`no fixture ${name}`);
    }

    const played = replay(client, { configuration, transcript });

    expect(shownNumerics(played.transcript)).toStrictEqual(numerics);
    expect(played.transcript).toMatch(
      /^\?\? activity Numeric 251 in=network :There are \d+ users/mu
    );
  });
});

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
      "?? message Privmsg iirc_ #iirc at=ours:t+1s in=channel:#iirc ours=i1 echo :hello from iirc"
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
      "?? message Privmsg iirc_ #iirc at=ours:t+5s in=channel:#iirc ours=i1 :hello from iirc"
    );
  });
});

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const login = configured({
  login: { _tag: "Sasl", account: "iirc", credential: CredentialName.make("pw"), required: true },
});

const everyCap = [
  "cap-notify",
  "sasl=PLAIN",
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
  "multi-prefix",
  "away-notify",
];

// A Session's worth of traffic with every Feature on: tags, batches, labelled echoes,
// prefixes, away status, and a cap deleted and offered again.
const featured = (round: number, from: number): string =>
  Array.from({ length: 15 }, (_unused, index) => {
    const label = from + index;
    const time = `2026-01-01T00:0${round}:${String(index * 3).padStart(2, "0")}.000Z`;

    return lines(
      "+3s",
      `<< @msgid=j${round}-${index};time=${time} :peer${index}!u@h JOIN #iirc`,
      `<< :peer${index}!u@h AWAY :away ${index}`,
      `<< @msgid=p${round}-${index};time=${time};+reply=x :peer${index}!u@h PRIVMSG #iirc :round ${round} line ${index}`,
      `<< :irc.test BATCH +b${index} netsplit irc.hub other.host`,
      `<< @batch=b${index} :irc.test BATCH +n${index} example.com/inner`,
      `<< @batch=n${index};time=${time} :op!u@h MODE #iirc +v peer${index}`,
      `<< @batch=b${index} :irc.test BATCH -n${index}`,
      `<< :irc.test BATCH -b${index}`,
      `!! say #iirc :reply ${index}`,
      `>> @label=l${label} PRIVMSG #iirc :reply ${index}`,
      index % 3 === 0
        ? `<< @label=l${label} :irc.test BATCH +r${index} labeled-response`
        : `<< @label=l${label};msgid=e${round}-${index} :iirc!~iirc@iirc.test PRIVMSG #iirc :reply ${index}`,
      index % 3 === 0 ? `<< @batch=r${index} :irc.test 404 iirc #iirc :Cannot send` : "# echoed",
      index % 3 === 0 ? `<< :irc.test BATCH -r${index}` : "# answered",
      `<< :peer${index}!u@h QUIT :bye`,
      "<< PING :keep",
      ">> PONG keep"
    );
  }).join("") + lines("+60s", ">> PING iirc", "<< :irc.test PONG irc.test iirc");

const everyFeature = [
  registered(login, { isupport: [...floorIsupport, "UTF8ONLY"], offered: everyCap }),
  joined(login, "#iirc", ["@+op"]),
  featured(1, 1),
  lines(
    "<< :irc.test CAP iirc DEL :multi-prefix away-notify",
    "<<\\ :peer!u@h PRIVMSG iirc :caf\\xe9",
    "<< :irc.test CAP iirc NEW :multi-prefix away-notify",
    ">> CAP REQ :multi-prefix away-notify",
    "<< :irc.test CAP iirc ACK :multi-prefix away-notify",
    "== closed Reset",
    "+2s",
    "-> dial irc.test:6697 tls"
  ),
  registered(login, { isupport: [...floorIsupport, "UTF8ONLY"], offered: everyCap })
    .replace(/^!! configure\n-> dial[^\n]*\n/u, "")
    .replace(/(?<welcome><< :irc\.test 001 [^\n]*\n)/u, "$<welcome>>> JOIN #iirc\n"),
  lines(
    "<< :iirc!~iirc@iirc.test JOIN #iirc",
    ">> MODE #iirc",
    "<< :irc.test 353 iirc = #iirc :iirc @+op",
    "<< :irc.test 366 iirc #iirc :End",
    "<< :irc.test 324 iirc #iirc +nt",
    "<< :irc.test 329 iirc #iirc 1767225600"
  ),
  featured(2, 1),
];

describe("a long scenario with every Feature on", () => {
  it("folds the same in a fresh process", async () => {
    const played = play(client, { configuration: login, transcript: everyFeature });

    await expect(
      replayFresh(client, played.inputs, {
        module: new URL("../core.ts", import.meta.url),
        name: "client",
      })
    ).resolves.toBeUndefined();
  });
});

describe("the recorded WATCH Session", () => {
  it("tells a partner coming and going, as MONITOR's would", () => {
    const played = replay(client, {
      configuration: configured({ ircds: [hybrid] }),
      transcript: hybridWatch,
    });

    expect(played.transcript).toMatch(
      /\?\? activity CameOnline peer2 .*in=existing-direct:peer2$/mu
    );
    expect(played.transcript).toMatch(
      /\?\? activity WentOffline peer2 .*in=existing-direct:peer2$/mu
    );
  });
});
