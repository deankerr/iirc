/**
 * `sasl` with `SCRAM-SHA-256`: which mechanism a password login uses, the rounds the Client
 * asks the Runtime to answer, and how a SCRAM login fails, never by trying `PLAIN`.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import type { SaslMechanism } from "../configuration.ts";
import { client } from "../core.ts";
import { configured, play } from "../testing/index.ts";

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const login = (required: boolean, mechanism: SaslMechanism = "auto") =>
  configured({
    login: {
      _tag: "Sasl",
      account: "iirc",
      credential: CredentialName.make("pw"),
      mechanism,
      required,
    },
  });

const opened = lines(
  "!! configure",
  "-> dial irc.test:6697 tls",
  "== opened",
  ">> CAP LS 302",
  ">> NICK iirc",
  ">> USER iirc 0 * iirc"
);

const offered = (value: string) =>
  opened +
  lines(`<< :irc.test CAP * LS :sasl=${value}`, ">> CAP REQ sasl", "<< :irc.test CAP * ACK :sasl");

const both = "PLAIN,SCRAM-SHA-256";

// The base64 of RFC 7677's server-first and server-final messages.
const serverFirst =
  "cj1yT3ByTkdmd0ViZVJXZ2JORWtxTyVodllEcFdVYTJSYVRDQWZ1eEZJbGopaE5sRiRrMCxzPVcyMlphSjBTTlk3c29Fc1VFamI2Z1E9PSxpPTQwOTY=";

const serverFinal = "dj02cnJpVFJCaTIzV3BSUi93dHVwK21NaFVaVW4vZEI1bkxUSlJzamw5NUc0PQ==";

// Up to the client-final message, on an Ircd that lists both.
const proved =
  offered(both) +
  lines(
    ">> AUTHENTICATE SCRAM-SHA-256",
    "<< AUTHENTICATE +",
    ">> {ScramFirst credential=pw authcid=iirc}",
    `<< AUTHENTICATE ${serverFirst}`,
    `>> {ScramFinal credential=pw serverFirst=${serverFirst}}`
  );

// Up to the check of the server-final message.
const checking = proved + lines(`<< AUTHENTICATE ${serverFinal}`, `-> check-scram ${serverFinal}`);

const welcome = lines("<< :irc.test 001 iirc :Welcome", "?? session-began iirc");

const givesUp = lines(
  ">> QUIT",
  "-> hangup",
  "== closed HungUp",
  "?? connection-failed LoginFailed"
);

// Whether the Client ever tried `PLAIN`.
const triedPlain = (played: ReturnType<typeof play>) =>
  played.steps.some((step) =>
    step.outputs.some(
      (output) =>
        (output._tag === "SendSecret" && output.line._tag === "AuthenticatePlain") ||
        (output._tag === "Send" && output.line.params[0] === "PLAIN")
    )
  );

describe("choosing a mechanism", () => {
  it("logs in with SCRAM-SHA-256 where the Ircd lists it, once the server is verified", () => {
    const played = play(client, {
      configuration: login(true),
      transcript: [
        checking,
        lines(
          "== scram-checked verified",
          ">> AUTHENTICATE +",
          "<< :irc.test 900 iirc iirc!iirc@host iirc :You are now logged in as iirc",
          "<< :irc.test 903 iirc :SASL authentication successful",
          ">> CAP END"
        ),
        welcome,
      ],
    });

    expect(client.known(played.state).self?.account).toMatchObject({
      _tag: "Known",
      value: "iirc",
    });
  });

  it("uses PLAIN where the Ircd lists mechanisms without SCRAM-SHA-256", () => {
    play(client, {
      configuration: login(false),
      transcript: offered("PLAIN,EXTERNAL") + lines(">> AUTHENTICATE PLAIN"),
    });

    expect.assertions(0);
  });

  it("uses PLAIN where the Ircd lists no mechanisms", () => {
    play(client, {
      configuration: login(false),
      transcript: offered("") + lines(">> AUTHENTICATE PLAIN"),
    });

    expect.assertions(0);
  });

  it("uses PLAIN when the login pins it, though SCRAM-SHA-256 is listed", () => {
    play(client, {
      configuration: login(false, "plain"),
      transcript: offered(both) + lines(">> AUTHENTICATE PLAIN"),
    });

    expect.assertions(0);
  });

  it("does not try a login pinned to SCRAM-SHA-256 where it is not listed, and a required one gives up", () => {
    play(client, {
      configuration: login(true, "scram-sha-256"),
      transcript: [offered("PLAIN,EXTERNAL"), givesUp],
    });

    expect.assertions(0);
  });

  it("does not try a login pinned to SCRAM-SHA-256 where the cap lists nothing", () => {
    play(client, {
      configuration: login(true, "scram-sha-256"),
      transcript: [offered(""), givesUp],
    });

    expect.assertions(0);
  });

  it("reads a server-first message split over full AUTHENTICATE Lines", () => {
    const full = "A".repeat(400);

    play(client, {
      configuration: login(false),
      transcript: [
        offered(both),
        lines(
          ">> AUTHENTICATE SCRAM-SHA-256",
          "<< AUTHENTICATE +",
          ">> {ScramFirst credential=pw authcid=iirc}",
          `<< AUTHENTICATE ${full}`,
          "<< AUTHENTICATE +",
          `>> {ScramFinal credential=pw serverFirst=${full}}`
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a SCRAM-SHA-256 login that fails", () => {
  it("aborts on a server signature that is not verified, and never tries PLAIN", () => {
    const played = play(client, {
      configuration: login(true),
      transcript: [checking, lines("== scram-checked unverified", ">> AUTHENTICATE *"), givesUp],
    });

    expect(triedPlain(played)).toBeFalsy();
  });

  it("aborts when the Runtime cannot answer the server-first message, such as a nonce not ours", () => {
    const played = play(client, {
      configuration: login(false),
      transcript: [
        proved,
        lines("== unfilled Unanswerable", ">> AUTHENTICATE *", ">> CAP END"),
        welcome,
      ],
    });

    expect(triedPlain(played)).toBeFalsy();
  });

  it("fails on 904, and never tries PLAIN", () => {
    const played = play(client, {
      configuration: login(true),
      transcript: [proved, lines("<< :irc.test 904 iirc :SASL authentication failed"), givesUp],
    });

    expect(triedPlain(played)).toBeFalsy();
  });

  it("is no login when 903 comes before the first challenge", () => {
    play(client, {
      configuration: login(true),
      transcript: [
        offered(both),
        lines(
          ">> AUTHENTICATE SCRAM-SHA-256",
          "<< :irc.test 903 iirc :SASL authentication successful"
        ),
        givesUp,
      ],
    });

    expect.assertions(0);
  });

  it("is no login when 903 comes before the server is verified", () => {
    play(client, {
      configuration: login(true),
      transcript: [proved, lines("<< :irc.test 903 iirc :SASL authentication successful"), givesUp],
    });

    expect.assertions(0);
  });
});
