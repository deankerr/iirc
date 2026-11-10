/**
 * Highlights: a Message said live by a User other than Self that names Self's nick, or a
 * highlight word, as a whole word (ADR 0014).
 */
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { mentions } from "../highlight.ts";
import { FeatureName } from "../ids.ts";
import { register, registry } from "../registry.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannel = [registered(base), joined(base, "#iirc", ["peer"])];

// Every Line in a batch is history, as `chathistory` will make it.
const history: Feature = {
  label: (arrival) => ({
    value: arrival.batch === undefined ? arrival : { ...arrival, live: false },
  }),
  name: FeatureName.make("history"),
  needs: {},
  own: undefined,
};

const withHistory = makeClient([...registry, register(history)]);

describe("a Message naming Self", () => {
  it("is a Highlight when the nick is a whole word, and not inside another", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :peer!u@h PRIVMSG #iirc :iirc: hello",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :iirc: hello",
          "<< :peer!u@h PRIVMSG #iirc :hello iirc",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :hello iirc",
          "<< :peer!u@h PRIVMSG #iirc :ask iirc's owner, <iirc> or @iirc, (iirc).",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :ask iirc's owner, <iirc> or @iirc, (iirc).",
          "<< :peer!u@h PRIVMSG #iirc :iirc",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :iirc",
          // Inside a word, or joined by what a nick may hold, it is another word.
          "<< :peer!u@h PRIVMSG #iirc :iirco and xiirc",
          "?? message Privmsg peer #iirc in=channel:#iirc :iirco and xiirc",
          "<< :peer!u@h PRIVMSG #iirc :iirc_ iirc- [iirc] iirc2 iirc|away",
          "?? message Privmsg peer #iirc in=channel:#iirc :iirc_ iirc- [iirc] iirc2 iirc|away",
          // A `/` ends a word, so a path or a URL that holds the nick names it.
          "<< :peer!u@h PRIVMSG #iirc :see https://example.test/iirc",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :see https://example.test/iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is a Highlight with formatting codes between the words, never inside the nick", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<<\\ :peer!u@h PRIVMSG #iirc :\\x02iirc\\x02: look",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :\u0002iirc\u0002: look",
          "<<\\ :peer!u@h PRIVMSG #iirc :ii\\x0304,01rc",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :ii\u000304,01rc",
          "<<\\ :peer!u@h PRIVMSG #iirc :x\\x0fiirc",
          "?? message Privmsg peer #iirc in=channel:#iirc :x\u000Fiirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("compares by the casemapping in force", () => {
    const bracketed = configured({ nicks: ["dean[m]"] });

    play(client, {
      configuration: bracketed,
      transcript: [
        registered(bracketed),
        joined(bracketed, "#iirc", ["peer"], { nick: "dean[m]" }),
        lines(
          "<< :peer!u@h PRIVMSG #iirc :DEAN{M}: rfc1459 folds these together",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :DEAN{M}: rfc1459 folds these together",
          "<< :irc.test 005 dean[m] CASEMAPPING=ascii :are supported by this server",
          "<< :peer!u@h PRIVMSG #iirc :DEAN{M}: ascii does not",
          "?? message Privmsg peer #iirc in=channel:#iirc :DEAN{M}: ascii does not",
          "<< :peer!u@h PRIVMSG #iirc :DEAN[M]: but it folds letters",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :DEAN[M]: but it folds letters"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("follows Self's nick as it changes", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :iirc!u@h NICK other",
          "<< :peer!u@h PRIVMSG #iirc :iirc?",
          "?? message Privmsg peer #iirc in=channel:#iirc :iirc?",
          "<< :peer!u@h PRIVMSG #iirc :other?",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :other?"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("counts a Notice, an Action, and a Direct Message alike", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :peer!u@h NOTICE #iirc :iirc, a notice",
          "?? message Notice peer #iirc highlight in=channel:#iirc :iirc, a notice",
          "<<\\ :peer!u@h PRIVMSG #iirc :\\x01ACTION waves at iirc\\x01",
          "?? message Action peer #iirc highlight in=channel:#iirc :waves at iirc",
          // A Direct Message is its own level, and a Highlight only when it names Self too.
          "<< :peer!u@h PRIVMSG iirc :psst",
          "?? message Privmsg peer iirc in=direct:peer :psst",
          "<< :peer!u@h PRIVMSG iirc :psst iirc",
          "?? message Privmsg peer iirc highlight in=direct:peer :psst iirc"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("what is never a Highlight", () => {
  it("is our own Message, Self's from elsewhere, or one from a server", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "!! say #iirc :iirc talking to itself",
          ">> PRIVMSG #iirc :iirc talking to itself",
          "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 :iirc talking to itself",
          "<< :iirc!u@h PRIVMSG #iirc :iirc from elsewhere",
          "?? message Privmsg iirc #iirc self in=channel:#iirc :iirc from elsewhere",
          "<< :IIRC!u@h PRIVMSG #iirc :iirc in any case",
          "?? message Privmsg IIRC #iirc self in=channel:#iirc :iirc in any case",
          "<< :irc.test NOTICE iirc :welcome, iirc",
          "?? message Notice irc.test iirc in=network :welcome, iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is Self's echo", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["batch", "echo-message", "labeled-response"] }),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! say #iirc :hi iirc",
          ">> @label=l1 PRIVMSG #iirc :hi iirc",
          "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 echo :hi iirc",
          "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hi iirc",
          "?? confirmed i1 :hi iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is a Message from history", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        registered(base, { offered: ["batch"] }),
        joined(base, "#iirc", ["peer"]),
        lines(
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h :peer!u@h PRIVMSG #iirc :iirc, earlier",
          "?? message Privmsg peer #iirc history in=channel:#iirc :iirc, earlier",
          "<< :irc.test BATCH -h",
          "<< :peer!u@h PRIVMSG #iirc :iirc, now",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :iirc, now"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("highlight words", () => {
  it("make a Message a Highlight as whole words, in any case", () => {
    const watching = configured({ highlights: ["release", "Ünïcode", ""] });

    play(client, {
      configuration: watching,
      transcript: [
        registered(watching),
        joined(watching, "#iirc", ["peer"]),
        lines(
          "<< :peer!u@h PRIVMSG #iirc :RELEASE today",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :RELEASE today",
          "<< :peer!u@h PRIVMSG #iirc :released today",
          "?? message Privmsg peer #iirc in=channel:#iirc :released today",
          "<< :peer!u@h PRIVMSG #iirc :about Ünïcode.",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :about Ünïcode.",
          // An empty word names nothing.
          "<< :peer!u@h PRIVMSG #iirc :nothing here",
          "?? message Privmsg peer #iirc in=channel:#iirc :nothing here",
          "!! configure highlights=",
          "<< :peer!u@h PRIVMSG #iirc :release",
          "?? message Privmsg peer #iirc in=channel:#iirc :release",
          "!! configure highlights=nothing,here",
          "<< :peer!u@h PRIVMSG #iirc :nothing here",
          "?? message Privmsg peer #iirc highlight in=channel:#iirc :nothing here"
        ),
      ],
    });

    expect.assertions(0);
  });
});

const ascii = (name: string) => name.toLowerCase();

describe(mentions, () => {
  it.each<readonly [string, readonly string[], boolean]>([
    ["iirc", ["iirc"], true],
    ["", ["iirc"], false],
    ["iirc", [""], false],
    ["two words here", ["words here"], true],
    ["two words herein", ["words here"], false],
    ["a.b.c", ["b"], true],
    ["café", ["caf"], false],
    ["café", ["cafe"], false],
    // Bounds are the pinned Unicode table's: marks and letters of any script, astral too,
    // and digits of any script stand inside a word; emoji, joiners, and marks of direction
    // do not.
    ["iirc\u0301", ["iirc"], false],
    ["\u{10330}iirc", ["iirc"], false],
    ["iirc\u{1F600}", ["iirc"], true],
    ["\u{1F469}\u200Diirc", ["iirc"], true],
    ["\u05E9\u05DC\u05D5\u05DD iirc", ["iirc"], true],
    ["\u05E9iirc", ["iirc"], false],
    ["\u200Fiirc\u200F", ["iirc"], true],
    ["iirc\u0663", ["iirc"], false],
    ["iirc\uFF11", ["iirc"], false],
    ["\u05E9\u05DC\u05D5\u05DD", ["\u05E9\u05DC\u05D5\u05DD"], true],
    // A match that fails its bounds does not hide a later one that holds.
    ["aaa aa", ["aa"], true],
    ["xiirc iirc", ["iirc"], true],
  ])("finds in %j each of %j: %s", (text, words, found) => {
    expect(mentions(ascii, text, words)).toBe(found);
  });

  it("does work linear in the text, however the word repeats itself", () => {
    const nick = `${".".repeat(20_000)}b`;
    const text = ".".repeat(40_000);
    // oxlint-disable-next-line no-restricted-globals -- times a regression: quadratic work here takes seconds.
    const began = performance.now();

    expect(mentions(ascii, text, [nick])).toBeFalsy();
    // oxlint-disable-next-line no-restricted-globals -- as above.
    expect(performance.now() - began).toBeLessThan(500);
  });
});
