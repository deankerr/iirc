/**
 * `+reply` and `+channel-context`: what a Message answers, and the Channel a Direct
 * Message belongs with, each read from its client-only tag and ignored as its spec says.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { SendableMessageId } from "../ids.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannel = [
  registered(base, { offered: ["message-tags"] }),
  joined(base, "#iirc", ["peer"]),
];

describe("+reply", () => {
  it("names the Message a reply answers", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< @msgid=m1;+reply=m0 :peer!u@h PRIVMSG #iirc :yes",
          '?? message Privmsg peer #iirc id=ircd:m1 in=channel:#iirc tags=+reply="m0" answers=m0 :yes'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("answers nothing when the tag is empty", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< @msgid=m1;+reply= :peer!u@h PRIVMSG #iirc :yes",
          '?? message Privmsg peer #iirc id=ircd:m1 in=channel:#iirc tags=+reply="" :yes'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("leaves what we say answering nothing", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "!! say #iirc :hello",
          "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 :hello",
          ">> PRIVMSG #iirc hello"
        ),
      ],
    });

    expect.assertions(0);
  });
});

const echoing = [
  registered(base, { offered: ["message-tags", "batch", "echo-message", "labeled-response"] }),
  joined(base, "#iirc", ["peer"]),
];

describe("a Say that answers", () => {
  it("sends a +reply tag where the Session carries tags, and reports what it answers", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "!! say #iirc answers=m0 :yes",
          '?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc tags=+reply="m0" answers=m0 ours=i1 :yes',
          ">> @+reply=m0 PRIVMSG #iirc yes"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("sends the tag with the label, and its echo confirms it, keeping what it answers", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...echoing,
        lines(
          "!! say #iirc answers=m0 :yes",
          ">> @+reply=m0;label=l1 PRIVMSG #iirc yes",
          '?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc tags=+reply="m0" answers=m0 ours=i1 echo :yes',
          "<< @+reply=m0;label=l1;msgid=m9 :iirc!u@h PRIVMSG #iirc :yes",
          "?? confirmed i1 id=ircd:m9 :yes"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is said without the tag, and answers nothing, where the Session carries no tags", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { offered: [] }),
        joined(base, "#iirc", ["peer"]),
        lines(
          "!! say #iirc answers=m0 :yes",
          "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 :yes",
          ">> PRIVMSG #iirc yes"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("answers in an Action and a Notice too", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "!! action #iirc answers=m0 :waves",
          ">>\\ @+reply=m0 PRIVMSG #iirc :\\x01ACTION waves\\x01",
          '?? message Action iirc #iirc at=ours:t+0s in=channel:#iirc tags=+reply="m0" answers=m0 ours=i1 :waves',
          "!! notice #iirc answers=m1 :fyi",
          ">> @+reply=m1 NOTICE #iirc fyi",
          '?? message Notice iirc #iirc at=ours:t+0s in=channel:#iirc tags=+reply="m1" answers=m1 ours=i2 :fyi'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("escapes an id as it writes it, so a semicolon or a backslash is only text", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "!! say #iirc answers=a;b\\c :yes",
          ">>\\ @+reply=a\\\\:b\\\\\\\\c PRIVMSG #iirc yes",
          '?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc tags=+reply="a;b\\\\c" answers="a;b\\\\c" ours=i1 :yes'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("measures the Line without its tag, which has a budget of its own", () => {
    const id = "m".repeat(256);

    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          `!! say #iirc answers=${id} :${"x".repeat(474)}`,
          `?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc tags=+reply="${id}" answers=${id} ours=i1 :${"x".repeat(474)}`,
          `>> @+reply=${id} PRIVMSG #iirc ${"x".repeat(474)}`,
          `!! say #iirc answers=${id} :${"x".repeat(475)}`,
          "?? refused i2 Unsendable"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a Message id to answer", () => {
  const is = Schema.is(SendableMessageId);

  it("is taken as it is", () => {
    expect([is("m0"), is("abc;d\\e"), is("x".repeat(256)), is("é")]).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it.each([
    ["empty", ""],
    ["spaced", "a b"],
    ["holding a carriage return", "a\rb"],
    ["holding a line feed", "a\nb"],
    ["holding a NUL", "a\u0000b"],
    ["holding a DEL", "a\u007Fb"],
    ["too long", "x".repeat(257)],
  ])("is refused when %s", (_name, id) => {
    expect(is(id)).toBeFalsy();
  });
});

describe("what a Session carries", () => {
  it("says whether it has tags in what is known of it", () => {
    const tagged = play(client, {
      configuration: base,
      transcript: [registered(base, { offered: ["message-tags"] })],
    });

    const bare = play(client, { configuration: base, transcript: [registered(base, {})] });

    expect([tagged, bare].map(({ state }) => client.known(state).session)).toMatchObject([
      { _tag: "Registered", tags: true },
      { _tag: "Registered", tags: false },
    ]);
  });
});

describe("+channel-context", () => {
  it("carries the Channel a Direct Message was said in the context of", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< @+channel-context=#iirc :bot!b@h NOTICE iirc :I'm helping.",
          '?? message Notice bot iirc in=direct:bot tags=+channel-context="#iirc" context=#iirc :I\'m helping.'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is ignored on a Message to a Channel", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< @+channel-context=#other :peer!u@h PRIVMSG #iirc :hi",
          '?? message Privmsg peer #iirc in=channel:#iirc tags=+channel-context="#other" :hi'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is ignored when its value is not a Channel's name", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< @+channel-context=peer :bot!b@h PRIVMSG iirc :hi",
          '?? message Privmsg bot iirc in=direct:bot tags=+channel-context="peer" :hi',
          "<< @+channel-context=#a,#b :bot!b@h PRIVMSG iirc :hi",
          '?? message Privmsg bot iirc in=direct:bot tags=+channel-context="#a,#b" :hi'
        ),
      ],
    });

    expect.assertions(0);
  });
});
