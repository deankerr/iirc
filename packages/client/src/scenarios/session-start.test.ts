/**
 * The Owner's own start to a Session: user modes set on Self as one `MODE`, then Lines
 * written as text, in order, after the welcome and any service login, before any Channel
 * is joined.
 */
import { CredentialName } from "@iirc/protocol/line";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { NetworkConfiguration } from "../configuration.ts";
import { client } from "../core.ts";
import { configured, play } from "../testing/index.ts";

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const opened = lines(
  "!! configure",
  "-> dial irc.test:6697 tls",
  "== opened",
  ">> CAP LS 302",
  ">> NICK iirc",
  ">> USER iirc 0 * iirc",
  "<< :irc.test 421 * CAP :Unknown command"
);

const own = {
  channels: [{ name: "#iirc" }],
  lines: ["PRIVMSG HostServ :ON", "away :back soon"],
  userModes: "+ix-w",
};

describe("the Owner's start to a Session", () => {
  it("sets the user modes, then sends the Lines in order, after the welcome and before any join", () => {
    play(client, {
      configuration: configured(own),
      transcript: [
        opened,
        lines(
          "<< :irc.test 001 iirc :Welcome",
          "?? session-began iirc",
          ">> MODE iirc +ix-w",
          ">> PRIVMSG HostServ ON",
          ">> AWAY :back soon",
          ">> JOIN #iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("waits on a service login, sending them only once the Ircd says Self is logged in", () => {
    play(client, {
      configuration: configured({
        ...own,
        login: {
          _tag: "Service",
          account: "acct",
          credential: CredentialName.make("pw"),
          service: "NickServ",
          wait: 5,
        },
      }),
      transcript: [
        opened,
        lines(
          "<< :irc.test 001 iirc :Welcome",
          "?? session-began iirc",
          ">> {Identify credential=pw account=acct service=NickServ}",
          "+1s",
          "<< :irc.test 900 iirc iirc!iirc@iirc.test acct :You are now logged in",
          ">> MODE iirc +ix-w",
          ">> PRIVMSG HostServ ON",
          ">> AWAY :back soon",
          ">> JOIN #iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("sends them, then joins, when the service login waited on is taken out of the Configuration", () => {
    play(client, {
      configuration: configured({
        ...own,
        login: {
          _tag: "Service",
          account: "acct",
          credential: CredentialName.make("pw"),
          service: "NickServ",
          wait: 5,
        },
      }),
      transcript: [
        opened,
        lines(
          "<< :irc.test 001 iirc :Welcome",
          ">> {Identify credential=pw account=acct service=NickServ}",
          "!! configure login=none",
          ">> MODE iirc +ix-w",
          ">> PRIVMSG HostServ ON",
          ">> AWAY :back soon",
          ">> JOIN #iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("sends them again as the next Session begins", () => {
    play(client, {
      configuration: configured({ ...own, channels: [] }),
      transcript: [
        opened,
        lines(
          "<< :irc.test 001 iirc :Welcome",
          ">> MODE iirc +ix-w",
          ">> PRIVMSG HostServ ON",
          ">> AWAY :back soon",
          "== closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls",
          "== opened",
          ">> CAP LS 302",
          ">> NICK iirc",
          ">> USER iirc 0 * iirc",
          "<< :irc.test 421 * CAP :Unknown command",
          "<< :irc.test 001 iirc :Welcome",
          ">> MODE iirc +ix-w",
          ">> PRIVMSG HostServ ON",
          ">> AWAY :back soon"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("never sends a Line that /quote would refuse now, such as a PART of a Channel it wants", () => {
    play(client, {
      configuration: configured({ ...own, lines: ["PART #iirc", "PRIVMSG HostServ :ON"] }),
      transcript: [
        opened,
        lines(
          "<< :irc.test 001 iirc :Welcome",
          ">> MODE iirc +ix-w",
          ">> PRIVMSG HostServ ON",
          ">> JOIN #iirc",
          "?? ignored Unsendable PART"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("starts as it always has with neither", () => {
    play(client, {
      configuration: configured({ channels: [{ name: "#iirc" }] }),
      transcript: [
        opened,
        lines("<< :irc.test 001 iirc :Welcome", "?? session-began iirc", ">> JOIN #iirc"),
      ],
    });

    expect.assertions(0);
  });
});

const encoded = Schema.encodeSync(NetworkConfiguration)(configured());

const takes = (fields: Partial<typeof NetworkConfiguration.Encoded>): boolean =>
  Result.isSuccess(Schema.decodeResult(NetworkConfiguration)({ ...encoded, ...fields }));

describe("the Owner's Lines in Configuration", () => {
  it.each([
    ["a Line that carries a Credential", "PASS hunter2"],
    ["a Line with a source", ":me PRIVMSG #iirc :hi"],
    ["cap negotiation", "CAP REQ :echo-message"],
    ["a tag that is not client-only", "@label=x PING a"],
    ["two Lines in one", "PING a\r\nQUIT"],
    ["nothing", ""],
  ])("refuses %s, as /quote does", (_, line) => {
    expect(takes({ lines: [line] })).toBeFalsy();
  });

  it("takes a Line /quote takes", () => {
    expect(
      takes({ lines: ["@+typing=active TAGMSG #iirc", "privmsg #iirc :hi there"] })
    ).toBeTruthy();
  });

  it("takes at most 16", () => {
    expect(takes({ lines: Array.from({ length: 16 }, () => "PING a") })).toBeTruthy();
    expect(takes({ lines: Array.from({ length: 17 }, () => "PING a") })).toBeFalsy();
  });

  it.each(["+i", "-w", "+ix-w+R"])("takes the user modes %s", (userModes) => {
    expect(takes({ userModes })).toBeTruthy();
  });

  it.each(["i", "+", "+i x", "+i,-w", "+1"])("refuses the user modes %j", (userModes) => {
    expect(takes({ userModes })).toBeFalsy();
  });
});
