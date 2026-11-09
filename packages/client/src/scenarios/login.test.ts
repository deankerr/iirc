/**
 * The core's login rule: a Session begins, and anything is sent past registration, only
 * if the Configuration in force does not require a login, or a `903` arrived on this
 * Connection. It holds at `CAP END`, at `001`, and whenever a `Configured` arrives,
 * whatever the Features do.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const none = configured({ channels: [{ name: "#iirc" }] });

const required = configured({
  login: { _tag: "Sasl", account: "iirc", credential: CredentialName.make("pw"), required: true },
});

const opened = lines(
  "!! configure",
  "-> dial irc.test:6697 tls",
  "== opened",
  ">> CAP LS 302",
  ">> NICK iirc",
  ">> USER iirc 0 * iirc"
);

const givesUp = lines(">> QUIT", "-> hangup");
const failed = lines("== closed HungUp", "?? connection-failed LoginFailed");

// Whether a Session began, or anything was joined.
const began = (transcript: string): boolean =>
  transcript.includes("session-began") || transcript.includes(">> JOIN");

describe("a Configured that requires a login", () => {
  it("gives up when it comes after CAP END and before 001, and takes up no Session", () => {
    // The reviewer's interleaving: SASL negotiated with no login, `CAP END`, then a
    // login required, then `001`.
    const played = play(client, {
      configuration: none,
      transcript: [
        opened,
        lines(
          "<< :irc.test CAP * LS :sasl=PLAIN",
          ">> CAP REQ sasl",
          "<< :irc.test CAP * ACK :sasl",
          ">> CAP END",
          "!! configure login=required,iirc,pw"
        ),
        givesUp,
        lines("<< :irc.test 001 iirc :Welcome"),
        failed,
      ],
    });

    expect(began(played.transcript)).toBeFalsy();
  });

  it("gives up a Session that never logged in", () => {
    play(client, {
      configuration: none,
      transcript: [
        registered(none, { offered: ["sasl=PLAIN"] }).replace(
          /(?<welcome><< :irc\.test 001 [^\n]*\n)/u,
          "$<welcome>>> JOIN #iirc\n"
        ),
        lines("!! configure login=required,iirc,pw"),
        givesUp,
        lines("== closed HungUp", "?? session-ended LoginFailed"),
      ],
    });

    expect.assertions(0);
  });

  it("changes nothing in a Session that logged in", () => {
    const optional = configured({
      login: {
        _tag: "Sasl",
        account: "iirc",
        credential: CredentialName.make("pw"),
        required: false,
      },
    });

    const played = play(client, {
      configuration: optional,
      transcript: [
        registered(optional, { offered: ["sasl=PLAIN"] }),
        lines("!! configure login=required,iirc,pw"),
      ],
    });

    expect(played.steps.at(-1)?.outputs).toStrictEqual([]);
  });

  it("gives up at once when the Ircd has no cap negotiation", () => {
    play(client, {
      configuration: none,
      transcript: [
        opened,
        lines("<< :irc.test 421 * CAP :Unknown command", "!! configure login=required,iirc,pw"),
        givesUp,
      ],
    });

    expect.assertions(0);
  });

  it("begins SASL when negotiation is still open, and ends it only after 903", () => {
    play(client, {
      configuration: none,
      transcript: [
        opened,
        lines(
          "<< :irc.test CAP * LS :sasl=PLAIN",
          ">> CAP REQ sasl",
          "<< :irc.test CAP * NEW :multi-prefix",
          ">> CAP REQ multi-prefix",
          "<< :irc.test CAP * ACK :sasl",
          "!! configure login=required,iirc,pw",
          ">> AUTHENTICATE PLAIN",
          "<< :irc.test CAP * ACK :multi-prefix",
          "<< AUTHENTICATE +",
          ">> {AuthenticatePlain credential=pw authcid=iirc authzid=iirc}",
          "<< :irc.test 903 iirc :SASL authentication successful",
          ">> CAP END",
          "<< :irc.test 001 iirc :Welcome",
          "?? session-began iirc",
          ">> JOIN #iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("gives up when negotiation settles with no way to log in", () => {
    play(client, {
      configuration: none,
      transcript: [
        opened,
        lines(
          "<< :irc.test CAP * LS :multi-prefix",
          ">> CAP REQ multi-prefix",
          "!! configure login=required,iirc,pw",
          "<< :irc.test CAP * ACK :multi-prefix"
        ),
        givesUp,
      ],
    });

    expect.assertions(0);
  });

  it("waits while the list is still arriving, and logs in once it is in", () => {
    play(client, {
      configuration: none,
      transcript: [
        opened,
        lines(
          "<< :irc.test CAP * LS * :multi-prefix",
          "!! configure login=required,iirc,pw",
          "<< :irc.test CAP * LS :sasl=PLAIN",
          ">> CAP REQ :sasl multi-prefix",
          "<< :irc.test CAP * ACK :sasl multi-prefix",
          ">> AUTHENTICATE PLAIN"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("the rule holds without any Feature", () => {
  const floor = makeClient([]);

  it("gives up before CAP END", () => {
    play(floor, {
      configuration: required,
      transcript: [opened, lines("<< :irc.test CAP * LS :sasl=PLAIN"), givesUp],
    });

    expect.assertions(0);
  });

  it("gives up at 001, and takes up no Session", () => {
    const played = play(floor, {
      configuration: required,
      transcript: [opened, lines("<< :irc.test 001 iirc :Welcome"), givesUp, failed],
    });

    expect(began(played.transcript)).toBeFalsy();
  });

  it("lets a Session begin after a 903, however it came", () => {
    play(floor, {
      configuration: required,
      transcript: [
        opened,
        lines(
          "<< :irc.test 903 iirc :SASL authentication successful",
          "<< :irc.test 001 iirc :Welcome",
          "?? session-began iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("does not count a 903 from an earlier Connection", () => {
    play(floor, {
      configuration: required,
      transcript: [
        opened,
        lines(
          "<< :irc.test 903 iirc :SASL authentication successful",
          "<< :irc.test 001 iirc :Welcome",
          "== closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls",
          "== opened",
          ">> CAP LS 302",
          ">> NICK iirc",
          ">> USER iirc 0 * iirc",
          "<< :irc.test 001 iirc :Welcome"
        ),
        givesUp,
      ],
    });

    expect.assertions(0);
  });
});

// Kept so the joined prelude is exercised with the rule: an optional login still joins.
describe("an optional login", () => {
  it("lets the Session begin and join without one", () => {
    const optional = configured({
      login: {
        _tag: "Sasl",
        account: "iirc",
        credential: CredentialName.make("pw"),
        required: false,
      },
    });

    play(client, {
      configuration: optional,
      transcript: [registered(optional), joined(optional, "#iirc")],
    });

    expect.assertions(0);
  });
});
