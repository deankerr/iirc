/**
 * A service login, where there is no SASL: Self tells the service as a Session begins,
 * and joins its Channels once the Ircd says Self is logged in, by `900` or a `MODE` that
 * gives Self `+r`, or once the Configuration's bound runs out. Whether it worked is never
 * read from a `NOTICE`.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const service = configured({
  channels: [{ name: "#iirc" }, { key: CredentialName.make("chankey"), name: "#secret" }],
  login: {
    _tag: "Service",
    account: "acct",
    credential: CredentialName.make("pw"),
    service: "NickServ",
    wait: 5,
  },
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

// `001`, and the service told at once, before any Channel.
const welcomed = lines(
  "<< :irc.test 001 iirc :Welcome",
  "?? session-began iirc",
  ">> {Identify credential=pw account=acct service=NickServ}"
);

// Every SecretLine the Client sent, by kind.
const sentSecrets = (played: ReturnType<typeof play>): readonly string[] =>
  played.steps.flatMap((step) =>
    step.outputs.flatMap((output) => (output._tag === "SendSecret" ? [output.line._tag] : []))
  );

const joins = lines(">> {JoinWithKey credential=chankey channel=#secret}", ">> JOIN #iirc");

const loggedIn = lines("<< :irc.test 900 iirc iirc!iirc@iirc.test acct :You are now logged in");

describe("a service login", () => {
  it("tells the service after 001 and joins only when 900 says Self is logged in, knowing Self's account", () => {
    const played = play(client, {
      configuration: service,
      transcript: [
        opened,
        welcomed,
        lines(
          "<< :irc.test 002 iirc :Your host is irc.test",
          "<< :irc.test 005 iirc CHANTYPES=# :are supported by this server",
          "+2s"
        ),
        loggedIn,
        joins,
      ],
    });

    expect(client.known(played.state).self?.account).toMatchObject({
      _tag: "Known",
      from: "ircd",
      value: "acct",
    });
  });

  it("joins nothing for a MODE that gives Self +r, which may mean restricted, until the bound", () => {
    const played = play(client, {
      configuration: service,
      transcript: [
        opened,
        welcomed,
        lines(
          "<< :irc.test MODE iirc :+r",
          "<< :NickServ!s@services. MODE iirc :+r",
          "<< :irc.test MODE iirc :+R",
          "+4s"
        ),
      ],
    });

    expect(played.transcript).not.toContain(">> JOIN");

    play(client, {
      configuration: service,
      transcript: [played.transcript, lines("+1s"), joins],
    });
  });

  it("joins when the bound runs out, with the Ircd silent", () => {
    play(client, {
      configuration: service,
      transcript: [opened, welcomed, lines("+4s"), lines("+1s"), joins],
    });

    expect.assertions(0);
  });

  it("joins nothing for a NOTICE from the service, whatever it says, until the bound", () => {
    const played = play(client, {
      configuration: service,
      transcript: [
        opened,
        welcomed,
        lines(
          "<< :NickServ!s@services. NOTICE iirc :You are now identified for acct.",
          "<< :NickServ!s@services. NOTICE iirc :Password accepted - you are now recognized.",
          "+4s"
        ),
      ],
    });

    expect(played.transcript).not.toContain(">> JOIN");

    play(client, {
      configuration: service,
      transcript: [played.transcript, lines("+1s"), joins],
    });
  });

  it("joins at once when the Credential cannot be filled", () => {
    play(client, {
      configuration: service,
      transcript: [opened, welcomed, lines("== unfilled Missing"), joins],
    });

    expect.assertions(0);
  });

  it("joins at once when a Configured drops the service login", () => {
    play(client, {
      configuration: service,
      transcript: [opened, welcomed, lines("!! configure login=none"), joins],
    });

    expect.assertions(0);
  });

  it("holds a Channel the Owner adds while it waits, and joins it with the rest", () => {
    play(client, {
      configuration: service,
      transcript: [
        opened,
        welcomed,
        lines("!! configure +#more", "+1s"),
        loggedIn,
        lines(">> {JoinWithKey credential=chankey channel=#secret}", ">> JOIN #iirc,#more"),
      ],
    });

    expect.assertions(0);
  });

  it("joins at once, after telling the service, when the bound is 0", () => {
    const now = configured({
      channels: [{ name: "#iirc" }],
      login: {
        _tag: "Service",
        account: "acct",
        credential: CredentialName.make("pw"),
        service: "NickServ",
        wait: 0,
      },
    });

    play(client, {
      configuration: now,
      transcript: [opened, welcomed, lines(">> JOIN #iirc")],
    });

    expect.assertions(0);
  });

  it("tells the service again in a new Session after a reconnect", () => {
    play(client, {
      configuration: service,
      transcript: [
        opened,
        welcomed,
        loggedIn,
        joins,
        lines("== closed Reset", "?? session-ended Closed Reset", "..."),
        lines("!! retry", "-> dial irc.test:6697 tls", "== opened", ">> CAP LS 302"),
        lines(">> NICK iirc", ">> USER iirc 0 * iirc", "<< :irc.test 421 * CAP :Unknown command"),
        welcomed,
        lines("+5s"),
        joins,
      ],
    });

    expect.assertions(0);
  });

  it("asks for no echo-message, which would echo the Credential back to be journaled", () => {
    play(client, {
      configuration: service,
      transcript: [
        registered(service, {
          offered: ["echo-message", "multi-prefix"],
          requested: ["multi-prefix"],
        }),
        joins,
      ],
    });

    expect.assertions(0);
  });

  it("tells nothing, and joins at once, when echo-message is on at 001 since the login was configured while registering", () => {
    const none = configured({
      channels: [{ name: "#iirc" }],
    });

    const played = play(client, {
      configuration: none,
      transcript: [
        lines(
          "!! configure",
          "-> dial irc.test:6697 tls",
          "== opened",
          ">> CAP LS 302",
          ">> NICK iirc",
          ">> USER iirc 0 * iirc",
          "<< :irc.test CAP * LS :echo-message labeled-response batch",
          ">> CAP REQ :batch echo-message labeled-response",
          "<< :irc.test CAP * ACK :batch echo-message labeled-response",
          ">> CAP END",
          "!! configure login=service,NickServ,acct,pw,5",
          "<< :irc.test 001 iirc :Welcome",
          "?? session-began iirc",
          ">> JOIN #iirc"
        ),
      ],
    });

    expect(sentSecrets(played)).toStrictEqual([]);

    // The next Session declines echo-message, so it tells the service.
    play(client, {
      configuration: none,
      transcript: [
        played.transcript,
        lines(
          "== closed Reset",
          "...",
          "!! retry",
          "-> dial irc.test:6697 tls",
          "== opened",
          ">> CAP LS 302",
          ">> NICK iirc",
          ">> USER iirc 0 * iirc",
          "<< :irc.test CAP * LS :echo-message labeled-response batch",
          ">> CAP REQ batch",
          "<< :irc.test CAP * ACK :batch",
          ">> CAP END",
          "<< :irc.test 001 iirc :Welcome",
          "?? session-began iirc",
          ">> {Identify credential=pw account=acct service=NickServ}"
        ),
      ],
    });
  });

  it("tells nothing while a CAP REQ for echo-message is unanswered at 001", () => {
    const none = configured({ channels: [{ name: "#iirc" }] });

    const played = play(client, {
      configuration: none,
      transcript: [
        lines(
          "!! configure",
          "-> dial irc.test:6697 tls",
          "== opened",
          ">> CAP LS 302",
          ">> NICK iirc",
          ">> USER iirc 0 * iirc",
          "<< :irc.test CAP * LS :echo-message labeled-response batch",
          ">> CAP REQ :batch echo-message labeled-response",
          "!! configure login=service,NickServ,acct,pw,5",
          "<< :irc.test 001 iirc :Welcome",
          "?? session-began iirc",
          ">> JOIN #iirc"
        ),
      ],
    });

    expect(sentSecrets(played)).toStrictEqual([]);
  });

  it("keeps matching an echo to its Message when the login is configured while echo-message is on", () => {
    const none = configured();

    const played = play(client, {
      configuration: none,
      transcript: [
        registered(none, { offered: ["batch", "echo-message", "labeled-response"] }),
        joined(none, "#iirc", ["peer"]),
        lines(
          "!! configure login=service,NickServ,acct,pw,5",
          "!! say #iirc :hello",
          "?? message Privmsg iirc #iirc at=ours:t+0s in=channel:#iirc ours=i1 echo :hello",
          ">> @label=l1 PRIVMSG #iirc hello",
          "<< @label=l1 :iirc!u@h PRIVMSG #iirc :hello",
          "?? confirmed i1 :hello"
        ),
      ],
    });

    const said = played.steps.flatMap((step) =>
      step.news.filter((news) => news._tag === "Message")
    );

    expect(said).toHaveLength(1);
  });

  it("is told and answered in the registered prelude", () => {
    const played = play(client, {
      configuration: service,
      transcript: [registered(service), joins],
    });

    expect(played.transcript.indexOf(">> {Identify")).toBeLessThan(
      played.transcript.indexOf(">> JOIN")
    );
  });
});
