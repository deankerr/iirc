import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

describe("a Session", () => {
  it("begins at 001 and ends with its Connection, and says so", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base).replace(
          /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
          "$<welcome>?? session-began iirc\n"
        ),
        lines("+5s", "== closed Reset", "?? session-ended Closed Reset"),
      ],
    });

    expect(client.known(played.state).session).toStrictEqual({
      _tag: "Offline",
      since: played.inputs.at(-1)?.at,
    });
  });

  it("knows where it is, who Self is, and which Ircd", () => {
    const played = play(client, { configuration: base, transcript: registered(base) });
    const known = client.known(played.state);

    expect(known.session).toMatchObject({ _tag: "Registered", ircd: "irc.test" });
    expect(known.self).toMatchObject({
      account: { _tag: "Unknown" },
      away: { _tag: "Unknown" },
      mask: { _tag: "Unknown" },
      nick: "iirc",
      realname: { _tag: "Known", from: "ours", value: "iirc" },
    });
    expect(known.users.get("iirc")?.nick).toBe("iirc");
  });

  it("reads Self's mask from 001 when the Ircd ends its welcome with it", () => {
    const played = play(client, {
      configuration: base,
      transcript: registered(base).replace(
        ":Welcome to the iirc-test Network iirc",
        ":Welcome to the Internet Relay Network iirc!~iirc@127.0.0.1"
      ),
    });

    expect(client.known(played.state).self?.mask).toMatchObject({
      _tag: "Known",
      from: "ircd",
      value: { host: "127.0.0.1", user: "~iirc" },
    });
  });

  it("does not take another nick's mask from 001", () => {
    const played = play(client, {
      configuration: base,
      transcript: registered(base).replace(
        ":Welcome to the iirc-test Network iirc",
        ":Welcome other!~o@elsewhere"
      ),
    });

    expect(client.known(played.state).self?.mask._tag).toBe("Unknown");
  });

  it("reads Self's mask from the echo of its JOIN", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), joined(base, "#iirc")],
    });

    expect(client.known(played.state).self?.mask).toMatchObject({
      _tag: "Known",
      value: { host: "iirc.test", user: "~iirc" },
    });
  });

  it("reads Self's account from a login's numerics", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("<< :irc.test 900 iirc iirc!~iirc@h acct :You are now logged in as acct"),
      ],
    });

    expect(client.known(played.state).self?.account).toMatchObject({
      _tag: "Known",
      value: "acct",
    });

    const out = play(client, {
      configuration: base,
      transcript: [registered(base), lines("<< :irc.test 901 iirc iirc!~iirc@h :logged out")],
    });

    expect(client.known(out.state).self?.account).toMatchObject({ _tag: "Known", value: null });
  });
});

describe("ISUPPORT", () => {
  it("accumulates tokens over several 005s", () => {
    const tokens = [
      ...floorIsupport,
      ...Array.from({ length: 20 }, (_unused, index) => `T${index}=${index}`),
    ];

    const played = play(client, {
      configuration: base,
      transcript: registered(base, { isupport: tokens }),
    });

    const { isupport } = client.inspect(played.state);

    expect(isupport.size).toBe(tokens.length);
    expect(isupport.get("T19")).toBe("19");
    expect(isupport.get("PREFIX")).toBe("(ov)@+");
  });

  it("takes a token back when it is negated, and sets it again", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["NETWORK=one", "EXCEPTS", "NICKLEN=9"] }),
        lines(
          "<< :irc.test 005 iirc -EXCEPTS -NICKLEN :are supported",
          "<< :irc.test 005 iirc NICKLEN=30 :are supported"
        ),
      ],
    });

    expect(client.inspect(played.state).isupport).toStrictEqual(
      new Map([
        ["NETWORK", "one"],
        ["NICKLEN", "30"],
      ])
    );
  });

  it("starts again with each Session", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), lines("== closed Reset", "+2s", "-> dial irc.test:6697 tls")],
    });

    expect(client.inspect(played.state).isupport.size).toBe(0);
  });
});

describe("casemapping", () => {
  it("folds names by rfc1459 until the Ircd says otherwise, brackets included", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CHANTYPES=#"] }),
        lines(
          "!! configure +#Dev[Ops]",
          ">> JOIN #Dev[Ops]",
          "<< :iirc!~iirc@h JOIN #dev{ops}",
          "?? activity Joined #dev{ops} iirc",
          "<< :irc.test 353 iirc = #DEV{OPS} :iirc @Peer[1]",
          "<< :irc.test 366 iirc #dev[ops] :End",
          "<< :peer{1}!u@h PRIVMSG #dev{ops} :hi",
          "?? message Privmsg peer{1} #dev{ops} :hi"
        ),
      ],
    });

    const known = client.known(played.state);
    const channel = known.channels.get("#dev{ops}");

    expect(known.casemapping).toBe("rfc1459");
    expect(channel).toMatchObject({ name: "#Dev[Ops]", standing: "Joined" });
    expect([...(channel?.members.keys() ?? [])]).toStrictEqual(["iirc", "peer{1}"]);
  });

  it("folds again when the Ircd names another casemapping", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: ["CHANTYPES=#"] }),
        lines(
          "!! configure +#Dev[Ops]",
          ">> JOIN #Dev[Ops]",
          "<< :irc.test 005 iirc CASEMAPPING=ascii :are supported"
        ),
      ],
    });

    const known = client.known(played.state);

    expect(known.casemapping).toBe("ascii");
    expect([...known.channels.keys()]).toStrictEqual(["#dev[ops]"]);
  });

  it("reads rfc8265 from UTF8MAPPING, and folds a mapping it does not know as ascii", () => {
    const utf8 = play(client, {
      configuration: base,
      transcript: registered(base, { isupport: ["CASEMAPPING=ascii", "UTF8MAPPING=rfc8265"] }),
    });

    const odd = play(client, {
      configuration: base,
      transcript: registered(base, { isupport: ["CASEMAPPING=klingon"] }),
    });

    expect(client.known(utf8.state).casemapping).toBe("rfc8265");
    expect(client.known(odd.state).casemapping).toBe("ascii");
  });
});
