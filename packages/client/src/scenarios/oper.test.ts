/**
 * An operator login: Self sends `OPER` with its Credential as each Session begins, and the
 * Ircd's numeric alone says whether it worked, reported in the Network's own Timeline.
 */
import { CredentialName } from "@iirc/protocol/line";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { NetworkConfiguration } from "../configuration.ts";
import { client } from "../core.ts";
import { configured, play, registered } from "../testing/index.ts";

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const opering = configured({
  channels: [{ name: "#iirc" }],
  oper: { _tag: "Login", name: "admin", password: CredentialName.make("operpw") },
});

const opened = lines(
  "!! configure",
  "-> dial irc.test:6697 tls",
  "== opened",
  ">> CAP LS 302",
  ">> NICK iirc",
  ">> USER iirc 0 * iirc",
  "<< :irc.test 421 * CAP :Unknown command"
);

// `001`, and `OPER` at once, before any Channel is joined.
const welcomed = lines(
  "<< :irc.test 001 iirc :Welcome",
  "?? session-began iirc",
  ">> {Oper credential=operpw name=admin}",
  ">> JOIN #iirc"
);

// Every Activity the Client reported, by kind, but the numerics it showed as they came.
const activities = (played: ReturnType<typeof play>): readonly string[] =>
  played.steps.flatMap((step) =>
    step.news.flatMap((news) =>
      news._tag === "Activity" && news.activity._tag !== "Numeric" ? [news.activity._tag] : []
    )
  );

// Every numeric the Client showed as it came, by number.
const numerics = (played: ReturnType<typeof play>): readonly string[] =>
  played.steps.flatMap((step) =>
    step.news.flatMap((news) =>
      news._tag === "Activity" && news.activity._tag === "Numeric" ? [news.activity.numeric] : []
    )
  );

// Every SecretLine the Client sent, by kind.
const sentSecrets = (played: ReturnType<typeof play>): readonly string[] =>
  played.steps.flatMap((step) =>
    step.outputs.flatMap((output) => (output._tag === "SendSecret" ? [output.line._tag] : []))
  );

describe("an operator login", () => {
  it("sends OPER after 001, and reports 381 as granted in the Network's own Timeline", () => {
    play(client, {
      configuration: opering,
      transcript: [
        opened,
        welcomed,
        lines(
          "<< :irc.test 381 iirc :You are now an IRC operator",
          "?? activity OperGranted iirc in=network"
        ),
      ],
    });

    expect.assertions(0);
  });

  it.each(["464", "491"])("reports %s as refused, by its numeric alone", (numeric) => {
    play(client, {
      configuration: opering,
      transcript: [
        opened,
        welcomed,
        lines(
          `<< :irc.test ${numeric} iirc :You are now an IRC operator`,
          `?? activity OperRefused iirc reply=${numeric} in=network`
        ),
      ],
    });

    expect.assertions(0);
  });

  it("reports a 461 that names OPER as refused, and one that names another command as nothing", () => {
    const played = play(client, {
      configuration: opering,
      transcript: [
        opened,
        welcomed,
        lines("<< :irc.test 461 iirc TOPIC :Not enough parameters"),
        lines(
          "<< :irc.test 461 iirc oper :Not enough parameters",
          "?? activity OperRefused iirc reply=461 in=network"
        ),
      ],
    });

    expect(activities(played)).toStrictEqual(["OperRefused"]);
  });

  it("takes no numeric addressed to another User, or to no one, as the answer", () => {
    const played = play(client, {
      configuration: opering,
      transcript: [
        opened,
        welcomed,
        lines(
          "<< :irc.test 381 othernick :You are now an IRC operator",
          "<< :irc.test 381",
          "<< :irc.test 491 * :No O-lines for your host"
        ),
        lines(
          "<< :irc.test 464 IIRC :Password incorrect",
          "?? activity OperRefused iirc reply=464 in=network"
        ),
      ],
    });

    expect(activities(played)).toStrictEqual(["OperRefused"]);
  });

  it("reports one answer, and none for a numeric when nothing awaits it", () => {
    const played = play(client, {
      configuration: opering,
      transcript: [
        opened,
        welcomed,
        lines("<< :irc.test 381 iirc :You are now an IRC operator"),
        lines(
          "<< :irc.test 381 iirc :You are now an IRC operator",
          "<< :irc.test 464 iirc :Password incorrect",
          "<< :irc.test 491 iirc :No O-lines for your host"
        ),
      ],
    });

    expect(activities(played)).toStrictEqual(["OperGranted"]);
  });

  it("reports no answer for a 381 with no OPER sent, and shows it as it came", () => {
    const none = configured({ channels: [{ name: "#iirc" }] });

    const played = play(client, {
      configuration: none,
      transcript: [
        opened,
        lines(
          "<< :irc.test 001 iirc :Welcome",
          "?? session-began iirc",
          ">> JOIN #iirc",
          "<< :irc.test 381 iirc :You are now an IRC operator",
          "<< :irc.test 491 iirc :No O-lines for your host"
        ),
      ],
    });

    expect([sentSecrets(played), activities(played), numerics(played)]).toStrictEqual([
      [],
      [],
      ["001", "381", "491"],
    ]);
  });

  it("reports nothing, and sends nothing more, when the Credential cannot be filled", () => {
    const played = play(client, {
      configuration: opering,
      transcript: [
        opened,
        welcomed,
        lines("== unfilled Missing"),
        lines("<< :irc.test 381 iirc :You are now an IRC operator"),
      ],
    });

    expect([sentSecrets(played), activities(played)]).toStrictEqual([["Oper"], []]);
  });

  it("sends OPER again in a new Session after a reconnect", () => {
    const played = play(client, {
      configuration: opering,
      transcript: [
        opened,
        welcomed,
        lines("<< :irc.test 381 iirc :You are now an IRC operator"),
        lines("== closed Reset", "?? session-ended Closed Reset", "..."),
        lines("!! retry", "-> dial irc.test:6697 tls", "== opened", ">> CAP LS 302"),
        lines(">> NICK iirc", ">> USER iirc 0 * iirc", "<< :irc.test 421 * CAP :Unknown command"),
        welcomed,
        lines(
          "<< :irc.test 464 iirc :Password incorrect",
          "?? activity OperRefused iirc reply=464 in=network"
        ),
      ],
    });

    expect([sentSecrets(played), activities(played)]).toStrictEqual([
      ["Oper", "Oper"],
      ["OperGranted", "OperRefused"],
    ]);
  });

  it("sends OPER in the next Session once configured, and none once it is none", () => {
    const none = configured({ channels: [{ name: "#iirc" }] });

    const played = play(client, {
      configuration: none,
      transcript: [
        opened,
        lines("<< :irc.test 001 iirc :Welcome", "?? session-began iirc", ">> JOIN #iirc"),
        lines("!! configure oper=admin,operpw"),
        lines("== closed Reset", "..."),
        lines("!! retry", "-> dial irc.test:6697 tls", "== opened", ">> CAP LS 302"),
        lines(">> NICK iirc", ">> USER iirc 0 * iirc", "<< :irc.test 421 * CAP :Unknown command"),
        welcomed,
        lines("!! configure oper=none"),
        lines("== closed Reset", "..."),
        lines("!! retry", "-> dial irc.test:6697 tls", "== opened", ">> CAP LS 302"),
        lines(">> NICK iirc", ">> USER iirc 0 * iirc", "<< :irc.test 421 * CAP :Unknown command"),
        lines("<< :irc.test 001 iirc :Welcome", "?? session-began iirc", ">> JOIN #iirc"),
      ],
    });

    expect(sentSecrets(played)).toStrictEqual(["Oper"]);
  });

  it("is sent in the registered prelude, after a service login", () => {
    const both = configured({
      login: {
        _tag: "Service",
        account: "acct",
        password: CredentialName.make("pw"),
        service: "NickServ",
        wait: 5,
      },
      oper: opering.oper,
    });

    const played = play(client, { configuration: both, transcript: [registered(both)] });

    expect(sentSecrets(played)).toStrictEqual(["Identify", "Oper"]);
  });

  it("decodes a Configured with no operator login as none", () => {
    const { oper: _oper, ...rest } = Schema.encodeSync(NetworkConfiguration)(opering);

    expect(Schema.decodeSync(NetworkConfiguration)(rest).oper).toStrictEqual({
      _tag: "None",
    });
  });
});
