/**
 * `+reply` and `+channel-context`: what a Message answers, and the Channel a Direct
 * Message belongs with, each read from its client-only tag and ignored as its spec says.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
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
