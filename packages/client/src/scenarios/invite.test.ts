/**
 * An invitation: a User's `INVITE` that names Self is Activity in the Network's own
 * Timeline, holding who invited and to which Channel. With `invite-notify`, one that names
 * another User is Activity in that Channel's Timeline, holding who invited whom.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { News } from "../news.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

describe("an INVITE", () => {
  it("naming Self is an Invited Activity in the Network's own Timeline", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :peer!u@h INVITE iirc #elsewhere",
          "?? activity Invited #elsewhere by=peer in=network"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("names Self by the Network's casemapping", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :peer!u@h INVITE IIRC #Elsewhere",
          "?? activity Invited #Elsewhere by=peer in=network"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("naming another User is reported nowhere", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base), lines("<< :peer!u@h INVITE other #elsewhere")],
    });

    const activities = played.steps.flatMap((step) =>
      step.news.filter((news) => news._tag === "Activity" && news.activity._tag !== "Numeric")
    );

    expect(activities).toStrictEqual([]);
  });

  it("to a name that is no Channel's is ignored", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("<< :peer!u@h INVITE iirc nowhere", "?? ignored Malformed INVITE"),
      ],
    });

    expect.assertions(0);
  });

  it.each([
    ["no Channel", "<< :peer!u@h INVITE iirc"],
    ["no source", "<< INVITE iirc #elsewhere"],
  ])("with %s is ignored", (_name, line) => {
    play(client, {
      configuration: base,
      transcript: [registered(base), lines(line, "?? ignored Malformed INVITE")],
    });

    expect.assertions(0);
  });

  it("leaves the reply to Self's own invite alone", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("<< :irc.test 341 iirc peer #elsewhere", "<< :peer!u@h INVITE iirc #there"),
      ],
    });

    expect.assertions(0);
  });
});

const inChannel = (offered: readonly string[]) => [
  registered(base, { offered: [...offered] }),
  joined(base, "#iirc", ["peer", "other"]),
];

// What the last step made, with the ids and times every run makes alike.
const newsOf = (offered: readonly string[], line: string): readonly News[] =>
  play(client, {
    configuration: base,
    transcript: [...inChannel(offered), lines(line)],
  }).steps.at(-1)?.news ?? [];

describe("invite-notify", () => {
  it("is asked for when offered, and on once acknowledged", () => {
    const played = play(client, {
      configuration: base,
      transcript: [registered(base, { offered: ["invite-notify"] })],
    });

    expect(client.inspect(played.state).features).toContain("invite-notify");
  });

  it("leaves registration as it was where the Ircd does not offer it", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, {
          offered: ["multi-prefix", "account-extban"],
          requested: ["multi-prefix"],
        }),
      ],
    });

    expect.assertions(0);
  });

  it("makes an INVITE naming another User Activity in that Channel's Timeline", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel(["invite-notify"]),
        lines(
          "<< :peer!u@h INVITE friend #iirc",
          "?? activity UserInvited #iirc friend by=peer in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("leaves an INVITE naming Self as it is without the cap", () => {
    const line = "<< :peer!u@h INVITE iirc #elsewhere";

    expect(newsOf(["invite-notify"], line)).toStrictEqual(newsOf([], line));
  });

  it.each([
    ["no source", "<< INVITE friend #iirc"],
    ["the Ircd as its source", "<< :irc.test INVITE friend #iirc"],
    ["no Channel", "<< :peer!u@h INVITE friend"],
    ["a name that is no Channel's", "<< :peer!u@h INVITE friend iirc"],
    ["a name that is no nick", "<< :peer!u@h INVITE #friend #iirc"],
    ["an empty nick", "<< :peer!u@h INVITE  #iirc"],
    ["a parameter too many", "<< :peer!u@h INVITE friend #iirc :extra"],
  ])("ignores an INVITE of another User with %s", (_name, line) => {
    play(client, {
      configuration: base,
      transcript: [...inChannel(["invite-notify"]), lines(line, "?? ignored Malformed INVITE")],
    });

    expect.assertions(0);
  });
});
