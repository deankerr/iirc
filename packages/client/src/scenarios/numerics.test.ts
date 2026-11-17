/**
 * What an Ircd says that nothing else reports is shown in the Network's own Timeline, each
 * numeric as it came. Which numerics are not shown is decided by number, and by what waits
 * for an answer, never by their text.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

describe("a Session's opening", () => {
  it("shows the welcome, as it came, after the Session began", () => {
    play(client, {
      configuration: base,
      transcript: registered(base)
        .replace(
          /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
          "$<welcome>?? session-began iirc\n?? activity Numeric 001 in=network :Welcome to the iirc-test Network iirc\n"
        )
        .replace(
          /(?<host><< :irc\.test 002 [^\n]*\n)/u,
          "$<host>?? activity Numeric 002 in=network :Your host is irc.test, running version test-1\n"
        )
        .replace(
          /(?<info><< :irc\.test 004 [^\n]*\n)/u,
          "$<info>?? activity Numeric 004 irc.test test-1 iow in=network :beIklmnostv\n"
        ),
    });
  });

  it("shows the counts of Users and Channels, each parameter after Self's in order", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 251 iirc :There are 3 users and 0 services on 1 servers",
          "?? activity Numeric 251 in=network :There are 3 users and 0 services on 1 servers",
          "<< :irc.test 252 iirc 1 :operator(s) online",
          "?? activity Numeric 252 1 in=network :operator(s) online",
          "<< :irc.test 254 iirc 2 :channels formed",
          "?? activity Numeric 254 2 in=network :channels formed",
          "<< :irc.test 265 iirc 3 10 :Current local users 3, max 10",
          "?? activity Numeric 265 3 10 in=network :Current local users 3, max 10",
          "<< :irc.test 250 iirc :Highest connection count: 4 (3 clients)",
          "?? activity Numeric 250 in=network :Highest connection count: 4 (3 clients)",
          "<< :irc.test 422 iirc :MOTD File is missing",
          "?? activity Numeric 422 in=network :MOTD File is missing"
        ),
      ],
    });
  });

  it("shows a numeric it has no model for, and one before the welcome", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base).replace(
          /(?<welcome><< :irc\.test 001 )/u,
          "<< :irc.test 020 * :Please wait while we process your connection.\n$<welcome>"
        ),
        lines("<< :irc.test 396 iirc cloaked.test :is now your displayed host"),
      ],
    });

    expect(
      played.steps.flatMap((step) =>
        step.news.flatMap((news) =>
          news._tag === "Activity" && news.activity._tag === "Numeric" ? [news.activity] : []
        )
      )
    ).toStrictEqual([
      {
        _tag: "Numeric",
        numeric: "020",
        params: ["Please wait while we process your connection."],
      },
      { _tag: "Numeric", numeric: "001", params: ["Welcome to the iirc-test Network iirc"] },
      {
        _tag: "Numeric",
        numeric: "002",
        params: ["Your host is irc.test, running version test-1"],
      },
      { _tag: "Numeric", numeric: "003", params: ["This server was created at the epoch"] },
      {
        _tag: "Numeric",
        numeric: "004",
        params: ["irc.test", "test-1", "iow", "beIklmnostv"],
      },
      { _tag: "Numeric", numeric: "396", params: ["cloaked.test", "is now your displayed host"] },
    ]);
  });
});

// The numerics a step showed.
const numericsOf = (played: ReturnType<typeof play>): readonly string[] =>
  played.steps.flatMap((step) =>
    step.news.flatMap((news) =>
      news._tag === "Activity" && news.activity._tag === "Numeric" ? [news.activity.numeric] : []
    )
  );

describe("a numeric shown once", () => {
  it("never shows ISUPPORT, NAMES, a topic, or the Client's own MODE and WHO", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["@peer"]),
        lines(
          "...",
          "<< :irc.test 332 iirc #iirc :the topic",
          "<< :irc.test 333 iirc #iirc peer 1767225600",
          "<< :irc.test 324 iirc #iirc +nt",
          "<< :irc.test 329 iirc #iirc 1767225600",
          "..."
        ),
      ],
    });

    expect(numericsOf(played)).toStrictEqual(["001", "002", "003", "004"]);
  });

  it("never shows the message of the day, which is shown whole", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 375 iirc :- irc.test Message of the Day -",
          "<< :irc.test 372 iirc :- hello",
          "<< :irc.test 376 iirc :End of /MOTD command."
        ),
      ],
    });

    expect(numericsOf(played)).toStrictEqual(["001", "002", "003", "004"]);
  });

  it("never shows what a Lookup collected", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! whois peer",
          ">> WHOIS peer",
          "<< :irc.test 311 iirc peer u h * :Peer",
          "<< :irc.test 318 iirc peer :End of /WHOIS list.",
          "?? looked-up i1 whois=peer found profiles=1"
        ),
      ],
    });

    expect(numericsOf(played)).toStrictEqual(["001", "002", "003", "004"]);
  });

  it("never shows the error that refused an action", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["@peer"]),
        lines(
          "!! topic #iirc :mine now",
          ">> TOPIC #iirc :mine now",
          "<< :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i1 Rejected 482 topic=#iirc in=channel:#iirc"
        ),
      ],
    });

    expect(numericsOf(played)).toStrictEqual(["001", "002", "003", "004"]);
  });

  it("never shows a labelled numeric, which answers its intent", () => {
    const configuration = configured();

    const played = play(client, {
      configuration,
      transcript: [
        registered(configuration, { offered: ["batch", "echo-message", "labeled-response"] }),
        lines(
          "!! quote LUSERS",
          ">> @label=l1 LUSERS",
          "<< @label=l1 :irc.test 251 iirc :There are 3 users",
          "..."
        ),
      ],
    });

    expect(numericsOf(played)).toStrictEqual(["001", "002", "003", "004"]);
  });

  it("shows an error no action awaits", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 481 iirc :Permission Denied- You're not an IRC operator",
          "?? activity Numeric 481 in=network :Permission Denied- You're not an IRC operator"
        ),
      ],
    });
  });

  it("never shows the answer to Self's OPER, which is reported as itself", () => {
    const configuration = configured({
      oper: { _tag: "Login", credential: CredentialName.make("oper"), name: "admin" },
    });

    const played = play(client, {
      configuration,
      transcript: [
        registered(configuration),
        lines(
          "<< :irc.test 381 iirc :You are now an IRC operator",
          "?? activity OperGranted iirc in=network",
          "<< :irc.test 381 iirc :You are now an IRC operator",
          "?? activity Numeric 381 in=network :You are now an IRC operator"
        ),
      ],
    });

    expect(numericsOf(played)).toStrictEqual(["001", "002", "003", "004", "381"]);
  });
});
