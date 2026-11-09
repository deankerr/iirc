import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

describe("answering the Ircd's PING", () => {
  it.each([
    ["with no source and a trailing colon", "<< PING :irc.test", ">> PONG irc.test"],
    ["with no source and no colon", "<< PING iirc", ">> PONG iirc"],
    ["with a source", "<< :irc.test PING irc.test", ">> PONG irc.test"],
    ["with a token that holds a space", "<< PING :two words", ">> PONG :two words"],
    ["with an empty token", "<< PING :", ">> PONG :"],
    ["with two parameters, echoing the first", "<< PING one two", ">> PONG one"],
  ])("answers a PING %s at once", (_name, ping, pong) => {
    play(client, { configuration: base, transcript: [registered(base), lines(ping, pong)] });

    expect.assertions(0);
  });

  it("echoes a token that is not UTF-8 byte for byte", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("<<\\ PING :\\xff\\xfe\\x80", ">>\\ PONG \\xff\\xfe\\x80"),
      ],
    });

    expect.assertions(0);
  });

  it("answers a PING before 001, as some Ircds ask during registration", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< PING :12345678",
        ">> PONG 12345678"
      ),
    });

    expect.assertions(0);
  });

  it("ignores a PING with no token", () => {
    play(client, {
      configuration: base,
      transcript: [registered(base), lines("<< PING", "?? ignored Malformed PING")],
    });

    expect.assertions(0);
  });
});

describe("hearing nothing", () => {
  it("sends a lag PING after 60 s of silence, and hangs up after 90 s", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "+59s",
          "+1s",
          ">> PING iirc",
          "+29s",
          "+1s",
          "-> hangup",
          "== closed HungUp",
          "?? session-ended Silent",
          "+2s",
          "-> dial irc.test:6697 tls"
        ),
      ],
    });

    expect(client.inspect(played.state).connection).toBe(2);
  });

  it("counts silence from the last Line heard", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "+50s",
          "<< :peer!u@h PRIVMSG iirc :hi",
          "+50s",
          "+9s",
          "+1s",
          ">> PING iirc",
          "+10s",
          "<< :irc.test PONG irc.test iirc",
          "+59s",
          "+1s",
          ">> PING iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("keeps one timer, and writes no Wake for a Line heard", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), lines("+10s", "<< :peer!u@h PRIVMSG iirc :hi")],
    });

    expect(played.steps.at(-1)?.outputs).toStrictEqual([]);
    expect([...client.inspect(played.state).timers.keys()]).toStrictEqual(["keepalive"]);
    expect(client.inspect(played.state).states.keepalive).toBe("Listening");
  });

  it("shows it has pinged until it hears something", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), lines("+60s", ">> PING iirc")],
    });

    expect(client.inspect(played.state).states.keepalive).toBe("Pinged");
  });
});
