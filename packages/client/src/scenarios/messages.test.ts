import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { Instant, IntentId } from "../ids.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannel = [registered(base), joined(base, "#iirc", ["peer"])];

describe("Messages heard", () => {
  it("reports PRIVMSG and NOTICE to a Channel and to Self, with sender and Target", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< :peer!u@h PRIVMSG #iirc :hello all",
          "?? message Privmsg peer #iirc in=channel:#iirc :hello all",
          "<< :peer!u@h PRIVMSG iirc :psst",
          "?? message Privmsg peer iirc in=direct:peer :psst",
          "<< :peer!u@h NOTICE #iirc :heads up",
          "?? message Notice peer #iirc in=channel:#iirc :heads up",
          "<< :peer!u@h PRIVMSG @#iirc :ops only",
          // With no `STATUSMSG`, `@#iirc` names no Channel.
          '?? message Privmsg peer "@#iirc" in=network :ops only'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("names the Ircd as the sender of a Line with no source, even before 001", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< NOTICE * :*** Looking up your hostname",
        "?? message Notice irc.test * in=network :*** Looking up your hostname"
      ),
    });

    expect.assertions(0);
  });

  it("reads a CTCP ACTION, with or without its closing byte", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<<\\ :peer!u@h PRIVMSG #iirc :\\x01ACTION waves\\x01",
          "?? message Action peer #iirc in=channel:#iirc :waves",
          "<<\\ :peer!u@h PRIVMSG #iirc :\\x01ACTION shrugs",
          "?? message Action peer #iirc in=channel:#iirc :shrugs"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("reports no Message for other CTCP, and answers none", () => {
    const played = play(client, {
      configuration: base,
      transcript: [...inChannel, lines("<<\\ :peer!u@h PRIVMSG iirc :\\x01VERSION\\x01")],
    });

    expect(played.steps.at(-1)).toMatchObject({ news: [], outputs: [] });
  });

  it("keeps client-only tags as data, and the time of receipt without server-time", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "<< @+draft/reply=m0;time=2020-01-01T00:00:00.000Z;msgid=x :peer!u@h PRIVMSG #iirc :yes",
          '?? message Privmsg peer #iirc in=channel:#iirc tags=+draft/reply="m0" :yes'
        ),
      ],
    });

    expect.assertions(0);
  });

  it("ignores a PRIVMSG with no text", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines("<< :peer!u@h PRIVMSG #iirc", "?? ignored Malformed PRIVMSG"),
      ],
    });

    expect.assertions(0);
  });
});

describe("saying something", () => {
  it("sends what the Owner says, and reports it as ours", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel,
        lines(
          "+1s",
          "!! say #iirc :hello there",
          ">> PRIVMSG #iirc :hello there",
          "?? message Privmsg iirc #iirc at=ours:t+1s in=channel:#iirc ours=i1 :hello there",
          "!! notice peer :fyi",
          ">> NOTICE peer fyi",
          "?? message Notice iirc peer at=ours:t+1s in=direct:peer ours=i2 :fyi",
          "!! action #iirc :waves",
          ">>\\ PRIVMSG #iirc :\\x01ACTION waves\\x01",
          "?? message Action iirc #iirc at=ours:t+1s in=channel:#iirc ours=i3 :waves"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("refuses while offline, and while hanging up", () => {
    play(client, {
      configuration: base,
      transcript: [
        lines(
          "!! configure",
          "-> dial irc.test:6697 tls",
          "!! say #iirc :too soon",
          "?? refused i1 Offline"
        ),
      ],
    });
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure disable",
          ">> QUIT",
          "-> hangup",
          "!! say #iirc :too late",
          "?? refused i1 Offline"
        ),
      ],
    });

    expect.assertions(0);
  });

  it.each([
    ["empty text", "#iirc", ""],
    ["a Target with a space", "#a b", "hi"],
    ["a list of Targets", "#a,#b", "hi"],
    ["text that would break the Line", "#iirc", "one\r\nQUIT :injected"],
  ])("refuses %s as unsendable", (_name, target, text) => {
    const played = play(client, { configuration: base, transcript: registered(base) });

    const step = client.step(played.state, {
      _tag: "Say",
      at: Instant.make(played.inputs.at(-1)?.at ?? 0),
      intent: IntentId.make("i1"),
      kind: "Privmsg",
      target,
      text,
    });

    expect(step.outputs).toStrictEqual([]);
    expect(step.news).toStrictEqual([
      { _tag: "Refused", action: undefined, intent: "i1", reason: { _tag: "Unsendable" } },
    ]);
  });

  it("refuses text that would be cut short when the Ircd relays it", () => {
    // `PRIVMSG #iirc ` and CRLF take 16 bytes, and the Ircd's `:iirc!user@host ` up to 80
    // while Self's mask is unknown.
    const fits = "x".repeat(416);

    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          `!! say #iirc :${fits}`,
          `>> PRIVMSG #iirc ${fits}`,
          `!! say #iirc :${fits}x`,
          "?? refused i2 Unsendable"
        ),
      ],
    });

    expect(played.ignored).toStrictEqual([]);
  });

  it("allows more once Self's mask is known", () => {
    // `:iirc!~iirc@iirc.test ` takes 22.
    const fits = "x".repeat(474);

    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc"),
        lines(
          `!! say #iirc :${fits}`,
          `>> PRIVMSG #iirc ${fits}`,
          `!! say #iirc :${fits}x`,
          "?? refused i2 Unsendable"
        ),
      ],
    });

    expect.assertions(0);
  });
});
