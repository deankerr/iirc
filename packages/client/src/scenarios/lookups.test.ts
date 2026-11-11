/**
 * Lookups: a `WHOIS` or `WHOWAS` is sent, its reply collected by structure, by label or
 * by the numerics that name its nick, and reported once as `LookedUp`.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { Instant } from "../ids.ts";
import type { LookResult, News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, epoch, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const echo = ["batch", "echo-message", "labeled-response"];

const inChannel = (offered: readonly string[] = []) => [
  registered(base, { offered: [...offered] }),
  joined(base, "#iirc", ["peer", "pal"]),
];

const played = (transcript: readonly string[]) => play(client, { configuration: base, transcript });

const lookedUp = (run: Played<State>): readonly Extract<News, { _tag: "LookedUp" }>[] =>
  run.steps.flatMap((step) => step.news.filter((news) => news._tag === "LookedUp"));

const resultOf = (run: Played<State>, index = 0): LookResult | undefined =>
  lookedUp(run)[index]?.result;

const seconds = (count: number) => Instant.make(count * 1000);

const profileFrom = (...replies: readonly string[]) =>
  resultOf(
    played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        ...replies.map((reply) => `<< :irc.test ${reply}`),
        "<< :irc.test 318 iirc peer :End"
      ),
    ])
  );

const shown = (...replies: readonly string[]) => {
  const result = profileFrom(...replies);
  const [profile] = result?._tag === "Found" ? result.profiles : [];

  return profile === undefined
    ? undefined
    : { actual: profile.actual, modes: profile.modes, other: profile.other };
};

describe("a WHOIS on the floor", () => {
  it("collects an ngircd-like reply, with an unknown numeric kept", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 311 iirc peer ~u peer.test * :Peer Person",
        "<< :irc.test 319 iirc peer :@#iirc +#other",
        "<< :irc.test 319 iirc peer :#third",
        "<< :irc.test 312 iirc peer irc.test :The test server",
        "<< :irc.test 301 iirc peer :gone fishing",
        "<< :irc.test 317 iirc peer 42 1767225600 :seconds idle, signon time",
        "<< :irc.test 378 iirc peer :is connecting from *@peer.test 192.0.2.1",
        "<< :irc.test 379 iirc peer :is using modes +i",
        "<< :irc.test 318 iirc peer :End of WHOIS list",
        "?? looked-up i1 whois=peer found profiles=1"
      ),
    ]);

    expect(resultOf(run)).toStrictEqual({
      _tag: "Found",
      profiles: [
        {
          account: undefined,
          actual: undefined,
          away: "gone fishing",
          channels: [
            { name: "#iirc", prefixes: ["o"] },
            { name: "#other", prefixes: ["v"] },
            { name: "#third", prefixes: [] },
          ],
          host: "peer.test",
          idle: 42,
          modes: "+i",
          nick: "peer",
          operator: false,
          other: [{ numeric: "378", params: ["peer", "is connecting from *@peer.test 192.0.2.1"] }],
          realname: "Peer Person",
          secure: false,
          server: { info: "The test server", name: "irc.test" },
          signon: seconds(1_767_225_600),
          user: "~u",
        },
      ],
    });
  });

  it("collects an Ergo-like reply, with account, operator, secure, and multi-prefix", () => {
    const run = played([
      ...inChannel(["multi-prefix"]),
      lines(
        "!! whois Peer",
        ">> WHOIS Peer",
        "<< :ergo.test 311 iirc peer ~u peer.test * :Peer",
        "<< :ergo.test 319 iirc peer :@+#iirc",
        "<< :ergo.test 312 iirc peer ergo.test :Ergo server",
        "<< :ergo.test 313 iirc peer :is an IRC operator",
        "<< :ergo.test 330 iirc peer peeracct :is logged in as",
        "<< :ergo.test 338 iirc peer ~u@203.0.113.22 203.0.113.22 :Actual user@host, Actual IP",
        "<< :ergo.test 379 iirc peer :is using modes +Zi",
        "<< :ergo.test 671 iirc peer :is using a secure connection",
        "<< :ergo.test 317 iirc peer 7 1767225000 :seconds idle, signon time",
        "<< :ergo.test 318 iirc peer :End of /WHOIS list",
        "?? looked-up i1 whois=Peer found profiles=1"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({
      _tag: "Found",
      profiles: [
        {
          account: "peeracct",
          actual: { ip: "203.0.113.22", mask: "~u@203.0.113.22" },
          channels: [{ name: "#iirc", prefixes: ["o", "v"] }],
          modes: "+Zi",
          operator: true,
          other: [],
          secure: true,
          signon: seconds(1_767_225_000),
        },
      ],
    });
  });

  it("reads 338 and 379 by the shape of their parameters and words, and keeps any other form", () => {
    expect({
      bareText: shown("338 iirc peer :is actually peer@192.0.2.1", "379 iirc peer :is using modes"),
      hostName: shown("338 iirc peer real.example :actually using host"),
      ipv6: shown("338 iirc peer 0::1 :actually using host"),
      mapped: shown("338 iirc peer 0::ffff:192.0.2.1 :actually using host"),
      notIp: shown("338 iirc peer 192.0.2.256 :actually using host"),
      octal: shown("338 iirc peer 010.000.000.001 :actually using host"),
      solanum: shown("338 iirc peer 127.0.0.1 :actually using host"),
      twoMasks: shown("338 iirc peer a@b c@d :actual"),
      twoModes: shown("379 iirc peer :is using modes +iwx +cF"),
      v4First: shown("338 iirc peer 192.0.2.1:: :actually using host"),
      v4Inside: shown("338 iirc peer 0::192.0.2.1:1 :actually using host"),
    }).toStrictEqual({
      bareText: {
        actual: undefined,
        modes: undefined,
        other: [
          { numeric: "338", params: ["peer", "is actually peer@192.0.2.1"] },
          { numeric: "379", params: ["peer", "is using modes"] },
        ],
      },
      hostName: {
        actual: undefined,
        modes: undefined,
        other: [{ numeric: "338", params: ["peer", "real.example", "actually using host"] }],
      },
      ipv6: { actual: { ip: "0::1", mask: undefined }, modes: undefined, other: [] },
      mapped: { actual: { ip: "0::ffff:192.0.2.1", mask: undefined }, modes: undefined, other: [] },
      notIp: {
        actual: undefined,
        modes: undefined,
        other: [{ numeric: "338", params: ["peer", "192.0.2.256", "actually using host"] }],
      },
      octal: {
        actual: undefined,
        modes: undefined,
        other: [{ numeric: "338", params: ["peer", "010.000.000.001", "actually using host"] }],
      },
      solanum: { actual: { ip: "127.0.0.1", mask: undefined }, modes: undefined, other: [] },
      twoMasks: {
        actual: undefined,
        modes: undefined,
        other: [{ numeric: "338", params: ["peer", "a@b", "c@d", "actual"] }],
      },
      twoModes: {
        actual: undefined,
        modes: undefined,
        other: [{ numeric: "379", params: ["peer", "is using modes +iwx +cF"] }],
      },
      v4First: {
        actual: undefined,
        modes: undefined,
        other: [{ numeric: "338", params: ["peer", "192.0.2.1::", "actually using host"] }],
      },
      v4Inside: {
        actual: undefined,
        modes: undefined,
        other: [{ numeric: "338", params: ["peer", "0::192.0.2.1:1", "actually using host"] }],
      },
    });
  });

  it("refreshes a User's mask and away status it models, as replied", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 311 iirc peer ~u peer.test * :Peer",
        "<< :irc.test 301 iirc peer :away",
        "<< :irc.test 330 iirc peer acct :is logged in as",
        "<< :irc.test 318 iirc peer :End",
        "...",
        "!! whois iirc",
        ">> WHOIS iirc",
        "<< :irc.test 311 iirc iirc ~me me.test * :Me Myself",
        "<< :irc.test 330 iirc iirc mine :is logged in as",
        "<< :irc.test 318 iirc iirc :End"
      ),
    ]);

    const known = client.known(run.state);

    expect(known.users.get("peer")).toMatchObject({
      account: { _tag: "Unknown" },
      away: { _tag: "Known", from: "replied", value: { message: "away" } },
      mask: { _tag: "Known", from: "replied", value: { host: "peer.test", user: "~u" } },
    });
    expect(known.self).toMatchObject({
      account: { _tag: "Known", from: "replied", value: "mine" },
      mask: { _tag: "Known", from: "replied", value: { host: "me.test", user: "~me" } },
      realname: { _tag: "Known", from: "replied", value: "Me Myself" },
    });
  });

  it("refreshes a fact as of the Line that said it, and nothing said of it since", () => {
    const back = played([
      ...inChannel(),
      lines(
        "!! whois iirc",
        ">> WHOIS iirc",
        "<< :irc.test 311 iirc iirc ~me me.test * :Me",
        "<< :irc.test 301 iirc iirc :old",
        "!! away",
        ">> AWAY",
        "<< :irc.test 305 iirc :You are no longer marked as being away",
        "<< :irc.test 318 iirc iirc :End"
      ),
    ]);

    const away = played([
      ...inChannel(),
      lines(
        "!! whois iirc",
        ">> WHOIS iirc",
        "<< :irc.test 301 iirc iirc :old",
        "!! away :new",
        ">> AWAY new",
        "<< :irc.test 306 iirc :You have been marked as being away",
        "<< :irc.test 318 iirc iirc :End"
      ),
    ]);

    const notified = played([
      ...inChannel(["away-notify"]),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 301 iirc peer :old",
        "<< :peer!~u@peer.test AWAY",
        "<< :irc.test 318 iirc peer :End"
      ),
    ]);

    const later = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 301 iirc peer :old",
        "+5s",
        "<< :irc.test 318 iirc peer :End"
      ),
    ]);

    expect([
      client.known(back.state).self?.away,
      client.known(back.state).self?.mask,
      client.known(away.state).self?.away,
      client.known(notified.state).users.get("peer")?.away,
      client.known(later.state).users.get("peer")?.away,
    ]).toMatchObject([
      { _tag: "Known", from: "ircd", value: null },
      { _tag: "Known", from: "replied", value: { host: "me.test", user: "~me" } },
      { _tag: "Known", from: "ircd", value: { message: "new" } },
      { _tag: "Known", from: "ircd", value: null },
      // As of the `301`, before the clock moved, not of the `318`.
      { _tag: "Known", at: epoch, from: "replied", value: { message: "old" } },
    ]);
  });

  it("is not found by 401 followed by 318", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois ghost",
        ">> WHOIS ghost",
        "<< :irc.test 401 iirc ghost :No such nick/channel",
        "<< :irc.test 318 iirc ghost :End of WHOIS list",
        "?? looked-up i1 whois=ghost not-found=401"
      ),
    ]);

    expect.assertions(0);
  });

  it("is not found by an end with nothing before it", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois ghost",
        ">> WHOIS ghost",
        "<< :irc.test 318 iirc ghost :End of WHOIS list",
        "?? looked-up i1 whois=ghost not-found=318"
      ),
    ]);

    expect.assertions(0);
  });

  it("fails by another error numeric", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 402 iirc peer :No such server",
        "<< :irc.test 318 iirc peer :End",
        "?? looked-up i1 whois=peer failed=402"
      ),
    ]);

    expect.assertions(0);
  });

  it("ties two concurrent Lookups to their own nicks", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "!! whois pal",
        ">> WHOIS pal",
        "<< :irc.test 311 iirc pal ~p pal.test * :Pal",
        "<< :irc.test 311 iirc peer ~u peer.test * :Peer",
        "<< :irc.test 318 iirc pal :End",
        "?? looked-up i2 whois=pal found profiles=1",
        "<< :irc.test 312 iirc peer irc.test :info",
        "<< :irc.test 318 iirc peer :End",
        "?? looked-up i1 whois=peer found profiles=1"
      ),
    ]);

    expect(lookedUp(run).map((news) => news.result)).toMatchObject([
      { profiles: [{ nick: "pal", server: undefined, user: "~p" }] },
      { profiles: [{ nick: "peer", server: { name: "irc.test" }, user: "~u" }] },
    ]);
  });

  it("ties a second Lookup of the same nick after the first ends", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 311 iirc peer ~one peer.test * :Peer",
        "<< :irc.test 318 iirc peer :End",
        "?? looked-up i1 whois=peer found profiles=1",
        "<< :irc.test 311 iirc peer ~two peer.test * :Peer",
        "<< :irc.test 318 iirc peer :End",
        "?? looked-up i2 whois=peer found profiles=1"
      ),
    ]);

    expect(lookedUp(run).map((news) => news.result)).toMatchObject([
      { profiles: [{ user: "~one" }] },
      { profiles: [{ user: "~two" }] },
    ]);
  });

  it("reports what it has when no end comes within its time", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 311 iirc peer ~u peer.test * :Peer",
        "+29s",
        "+1s",
        "?? looked-up i1 whois=peer partial=TimedOut profiles=1",
        "<< :irc.test 318 iirc peer :End"
      ),
    ]);

    expect.assertions(0);
  });

  it("reports what it has when its Connection ends", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 311 iirc peer ~u peer.test * :Peer",
        "== closed Reset",
        "?? looked-up i1 whois=peer partial=Ended profiles=1",
        "?? session-ended Closed Reset"
      ),
    ]);

    expect.assertions(0);
  });

  it("reports Unsent when its Line never left", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "== unsent 1",
        "?? looked-up i1 whois=peer unsent",
        "== closed Reset"
      ),
    ]);

    expect(lookedUp(run)).toHaveLength(1);
    expect(
      run.steps.flatMap((step) => step.news).some((news) => news._tag === "Refused")
    ).toBeFalsy();
  });

  it("keeps at most 64 Lines of a reply, and reports it Bounded", () => {
    const flood = Array.from(
      { length: 70 },
      (_, index) => `<< :irc.test 319 iirc peer :#c${index} #d${index}`
    );

    const run = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        ...flood,
        "<< :irc.test 318 iirc peer :End",
        "?? looked-up i1 whois=peer partial=Bounded profiles=1"
      ),
    ]);

    const result = resultOf(run);

    expect(result?._tag === "Partial" ? result.profiles[0]?.channels : []).toHaveLength(128);
  });

  it("ignores hostile replies that do not fit, and keeps the rest", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 311 iirc peer ~u",
        "?? ignored Malformed 311",
        "<< :irc.test 317 iirc peer soon :seconds idle",
        "?? ignored Malformed 317",
        "<< :irc.test 319 iirc peer :#ok notachannel",
        "?? ignored Malformed 319",
        "<< :irc.test 330 iirc peer :is logged in",
        "?? ignored Malformed 330",
        "<< :irc.test 317 iirc peer 5 :seconds idle",
        "<< :irc.test 318 iirc peer :End",
        "?? looked-up i1 whois=peer found profiles=1"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({
      profiles: [{ account: undefined, channels: [], idle: 5, signon: undefined, user: undefined }],
    });
  });

  it("is refused before any Configuration, offline, for a name that is not a nick, and past eight at once", () => {
    const busy = Array.from({ length: 8 }, (_, index) => [
      `!! whois p${index}`,
      `>> WHOIS p${index}`,
    ]).flat();

    played([lines("!! whois peer", "?? looked-up i1 whois=peer refused=Offline")]);
    played([
      lines("!! configure", "-> dial irc.test:6697 tls", "!! whois peer"),
      lines("?? looked-up i1 whois=peer refused=Offline"),
    ]);
    played([
      ...inChannel(),
      lines(
        "!! whois a*",
        "?? looked-up i1 whois=a* refused=Unsendable",
        "!! whois #iirc",
        "?? looked-up i2 whois=#iirc refused=Unsendable",
        "!! whowas @op",
        '?? looked-up i3 whowas="@op" refused=Unsendable',
        ...busy,
        "!! whois p8",
        "?? looked-up i12 whois=p8 refused=Busy"
      ),
    ]);

    expect.assertions(0);
  });

  it("leaves an action sent before it its own 401 for the same nick", () => {
    played([
      ...inChannel(),
      lines(
        "!! invite peer #iirc",
        ">> INVITE peer #iirc",
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 401 iirc peer :No such nick",
        "?? refused i1 Rejected 401 invite=peer:#iirc in=channel:#iirc",
        "<< :irc.test 401 iirc peer :No such nick",
        "<< :irc.test 318 iirc peer :End of WHOIS list",
        "?? looked-up i2 whois=peer not-found=401"
      ),
    ]);

    expect.assertions(0);
  });

  it("takes its own 401 before an action sent after it for the same nick", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "!! invite peer #iirc",
        ">> INVITE peer #iirc",
        "<< :irc.test 401 iirc peer :No such nick",
        "<< :irc.test 318 iirc peer :End of WHOIS list",
        "?? looked-up i1 whois=peer not-found=401",
        "<< :irc.test 401 iirc peer :No such nick",
        "?? refused i2 Rejected 401 invite=peer:#iirc in=channel:#iirc"
      ),
    ]);

    expect(run.steps.at(-3)?.news.some((news) => news._tag === "Refused")).toBeFalsy();
  });

  it("sends a dotted name as a nick, for the Ircd to decide", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois irc.example.com",
        ">> WHOIS irc.example.com",
        "<< :irc.test 401 iirc irc.example.com :No such nick",
        "<< :irc.test 318 iirc irc.example.com :End",
        "?? looked-up i1 whois=irc.example.com not-found=401"
      ),
    ]);

    expect.assertions(0);
  });

  it("leaves a 401 for another nick to an action", () => {
    played([
      ...inChannel(),
      lines(
        "!! whois peer",
        ">> WHOIS peer",
        "!! invite ghost #iirc",
        ">> INVITE ghost #iirc",
        "<< :irc.test 401 iirc ghost :No such nick",
        "?? refused i2 Rejected 401 invite=ghost:#iirc in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a WHOWAS", () => {
  it("collects each entry, with its server", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! whowas gone",
        ">> WHOWAS gone",
        "<< :irc.test 314 iirc gone ~a a.test * :First",
        "<< :irc.test 312 iirc gone irc.test :Sat Jan 1",
        "<< :irc.test 314 iirc gone ~b b.test * :Second",
        "<< :irc.test 312 iirc gone other.test :Fri Dec 31",
        "<< :irc.test 369 iirc gone :End of WHOWAS",
        "?? looked-up i1 whowas=gone found profiles=2"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({
      profiles: [
        { realname: "First", server: { name: "irc.test" }, user: "~a" },
        { realname: "Second", server: { name: "other.test" }, user: "~b" },
      ],
    });
  });

  it("is not found by 406 followed by 369", () => {
    played([
      ...inChannel(),
      lines(
        "!! whowas gone",
        ">> WHOWAS gone",
        "<< :irc.test 406 iirc gone :There was no such nickname",
        "<< :irc.test 369 iirc gone :End of WHOWAS",
        "?? looked-up i1 whowas=gone not-found=406"
      ),
    ]);

    expect.assertions(0);
  });

  it("takes no WHOIS numeric as its own", () => {
    played([
      ...inChannel(),
      lines(
        "!! whowas peer",
        ">> WHOWAS peer",
        "!! whois peer",
        ">> WHOIS peer",
        "<< :irc.test 406 iirc peer :There was no such nickname",
        "<< :irc.test 369 iirc peer :End of WHOWAS",
        "?? looked-up i1 whowas=peer not-found=406",
        "<< :irc.test 311 iirc peer ~u peer.test * :Peer",
        "<< :irc.test 318 iirc peer :End",
        "?? looked-up i2 whois=peer found profiles=1"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a labelled Lookup", () => {
  it("collects its batch by label, and nothing outside it", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! whois peer",
        ">> @label=l1 WHOIS peer",
        "<< :irc.test 311 iirc peer ~floor floor.test * :Not ours",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 311 iirc peer ~u peer.test * :Peer",
        "<< @batch=b1 :irc.test 319 iirc peer :#iirc",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 whois=peer found profiles=1"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({
      profiles: [{ channels: [{ name: "#iirc" }], user: "~u" }],
    });
  });

  it("ends with its batch, keeping what comes after the end numeric inside it", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! whois peer",
        ">> @label=l1 WHOIS peer",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 311 iirc peer ~u peer.test * :Peer",
        "<< @batch=b1 :irc.test 318 iirc peer :End",
        "<< @batch=b1 :irc.test 330 iirc peer acct :is logged in as",
        "<< @batch=b1 :irc.test 319 iirc peer :#iirc",
        "<< @batch=b1 :irc.test 671 iirc peer :is using a secure connection",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 whois=peer found profiles=1"
      ),
    ]);

    expect(lookedUp(run)).toHaveLength(1);
    expect(resultOf(run)).toMatchObject({
      profiles: [{ account: "acct", channels: [{ name: "#iirc" }], secure: true, user: "~u" }],
    });
  });

  it("is rejected by an error after the end numeric inside its batch", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! whois peer",
        ">> @label=l1 WHOIS peer",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 318 iirc peer :End",
        "<< @batch=b1 :irc.test 402 iirc peer :No such server",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 whois=peer failed=402"
      ),
    ]);

    expect.assertions(0);
  });

  it("fails by a lone labelled NOTICE, still read as a Message", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! whois peer",
        ">> @label=l1 WHOIS peer",
        "<< @label=l1 :irc.test NOTICE iirc :WHOIS unavailable",
        "?? looked-up i1 whois=peer failed=NOTICE",
        "?? message Notice irc.test iirc in=network :WHOIS unavailable"
      ),
    ]);

    expect(lookedUp(run)).toHaveLength(1);
  });

  it("takes no User from a NOTICE in its batch, and fails by an empty one", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! whois peer",
        ">> @label=l1 WHOIS peer",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test NOTICE iirc :looking",
        "<< @batch=b1 :irc.test 311 iirc peer ~u peer.test * :Peer",
        "<< @batch=b1 :irc.test 318 iirc peer :End",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 whois=peer found profiles=1",
        "!! whowas gone",
        ">> @label=l2 WHOWAS gone",
        "<< @label=l2 :irc.test BATCH +b2 labeled-response",
        "<< :irc.test BATCH -b2",
        "?? looked-up i2 whowas=gone failed=BATCH"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({ profiles: [{ other: [], user: "~u" }] });
  });

  it("is not found by a lone labelled 401", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! whois ghost",
        ">> @label=l1 WHOIS ghost",
        "<< @label=l1 :irc.test 401 iirc ghost :No such nick",
        "?? looked-up i1 whois=ghost not-found=401"
      ),
    ]);

    expect.assertions(0);
  });

  it("fails by a FAIL's code", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! whowas ghost",
        ">> @label=l1 WHOWAS ghost",
        "<< @label=l1 :irc.test FAIL WHOWAS TEMPORARILY_UNAVAILABLE :Try later",
        "?? looked-up i1 whowas=ghost failed=TEMPORARILY_UNAVAILABLE"
      ),
    ]);

    expect.assertions(0);
  });
});
