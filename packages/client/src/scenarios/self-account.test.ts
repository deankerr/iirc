/**
 * Self's account by `account-notify`: an `ACCOUNT` that names an account for Self ends a
 * service login's wait as a `900` does, and Self's account goes stale with every other
 * User's when the cap is deleted.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, play, registered } from "../testing/index.ts";

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const service = configured({
  channels: [{ name: "#iirc" }],
  commands: ["PRIVMSG HostServ :ON"],
  login: {
    _tag: "Service",
    account: "acct",
    password: CredentialName.make("pw"),
    service: "NickServ",
    wait: 5,
  },
});

// Registered with `account-notify`, the service told, and the Channels waiting.
const waiting = lines(
  "!! configure",
  "-> dial irc.test:6697 tls",
  "== opened",
  ">> CAP LS 302",
  ">> NICK iirc",
  ">> USER iirc 0 * iirc",
  "<< :irc.test CAP * LS :account-notify",
  ">> CAP REQ account-notify",
  "<< :irc.test CAP * ACK :account-notify",
  ">> CAP END",
  "<< :irc.test 001 iirc :Welcome",
  "?? session-began iirc",
  ">> {Identify credential=pw account=acct service=NickServ}"
);

// The Owner's own start, then the Channels, once the wait ends.
const joins = lines(">> PRIVMSG HostServ ON", ">> JOIN #iirc");

describe("an ACCOUNT for Self while a service login waits", () => {
  // Catches a Network whose service answers only with a NOTICE holding every Channel for
  // the whole bound, though the Ircd said Self is logged in.
  it("joins at once when it names an account, with no 900, and once only when a 900 follows", () => {
    play(client, {
      configuration: service,
      transcript: [
        waiting,
        lines("+1s", "<< :iirc!~iirc@iirc.test ACCOUNT Acct"),
        joins,
        lines("<< :irc.test 900 iirc iirc!~iirc@iirc.test acct :You are now logged in", "+5s"),
        lines("!! configure +#more", ">> JOIN #more"),
      ],
    });

    expect.assertions(0);
  });

  it("joins nothing for ACCOUNT *, until the bound", () => {
    play(client, {
      configuration: service,
      transcript: [
        waiting,
        lines("<< :iirc!~iirc@iirc.test ACCOUNT *", "+4s"),
        lines("+1s"),
        joins,
      ],
    });

    expect.assertions(0);
  });

  it("joins nothing for an ACCOUNT for another User, until the bound", () => {
    play(client, {
      configuration: service,
      transcript: [waiting, lines("<< :peer!u@h ACCOUNT acct", "+4s"), lines("+1s"), joins],
    });

    expect.assertions(0);
  });
});

describe("Self's account going stale when account-notify is deleted", () => {
  const base = configured();

  const prelude = [
    registered(base, { offered: ["cap-notify", "account-notify"] }),
    lines(
      "!! configure +#iirc",
      ">> JOIN #iirc",
      "<< :iirc!~iirc@iirc.test JOIN #iirc",
      ">> MODE #iirc",
      "<< :irc.test 353 iirc = #iirc :peer",
      "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
      "<< :iirc!~iirc@iirc.test ACCOUNT acct"
    ),
  ];

  const deleted = lines("<< :irc.test CAP iirc DEL :account-notify");

  // Catches an open members list that keeps showing Self's account after the cap goes.
  it("reports the Channels Self is in as changed", () => {
    const before = play(client, { configuration: base, transcript: prelude });
    const after = play(client, { configuration: base, transcript: [...prelude, deleted] });

    const learned = after.steps
      .slice(before.steps.length)
      .flatMap((step) => step.news)
      .flatMap((news) => (news._tag === "ChannelLearned" ? [news.channel.key] : []));

    expect(learned).toStrictEqual(["#iirc"]);
  });
});
