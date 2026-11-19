/**
 * A ban by account: where the Ircd's `EXTBAN` and `ACCOUNTEXTBAN` say how a ban names an
 * account, the Client resolves a nick to the account it knows and sends the `MODE` `+b` of
 * that mask, or refuses with the reason. A token that is missing or malformed offers
 * nothing, and a mask is never guessed.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const accounts = ["account-tag"];

const long = [...floorIsupport, "EXTBAN=~,a", "ACCOUNTEXTBAN=account,a"];

const inChannel = (isupport: readonly string[] = long, offered: readonly string[] = accounts) => [
  registered(base, { isupport: [...isupport], offered: [...offered] }),
  joined(base, "#iirc", ["peer", "other"]),
];

// `peer` has been seen logged in to `bob`, and `other` logged out, by their Messages' tags.
const known = (isupport?: readonly string[]) => [
  ...inChannel(isupport),
  lines("<< @account=bob :peer!u@h PRIVMSG #iirc :hi", "<< :other!u@h PRIVMSG #iirc :hi"),
];

const refused = (reason: string) => lines(`?? refused i1 ${reason} mode=#iirc:+b in=channel:#iirc`);

describe("a ban by account", () => {
  it("sends the MODE +b of the first name ACCOUNTEXTBAN gives, behind EXTBAN's prefix", () => {
    play(client, {
      configuration: base,
      transcript: [...known(), lines("!! ban-account peer #iirc", ">> MODE #iirc +b ~account:bob")],
    });

    expect.assertions(0);
  });

  it("writes the short type's mask for the spec's example", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...known([...floorIsupport, "EXTBAN=$,ARar", "ACCOUNTEXTBAN=R"]),
        lines("!! ban-account peer #iirc", ">> MODE #iirc +b $R:bob"),
      ],
    });

    expect.assertions(0);
  });

  it("finds the nick by the Network's casemapping", () => {
    play(client, {
      configuration: base,
      transcript: [...known(), lines("!! ban-account PEER #iirc", ">> MODE #iirc +b ~account:bob")],
    });

    expect.assertions(0);
  });

  it("is tied to the Ircd's error, which says where it belongs", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...known(),
        lines(
          "!! ban-account peer #iirc",
          ">> MODE #iirc +b ~account:bob",
          "<< :irc.test 482 iirc #iirc :You're not channel operator",
          "?? refused i1 Rejected 482 mode=#iirc:+b in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is refused as AccountUnknown when the Client does not know the User's account", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel(long, []),
        lines(
          "!! ban-account peer #iirc",
          "?? refused i1 AccountUnknown mode=#iirc:+b in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is refused as AccountUnknown for a nick the Client knows nothing of", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...known(),
        lines(
          "!! ban-account stranger #iirc",
          "?? refused i1 AccountUnknown mode=#iirc:+b in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is refused as NoAccount for a User known to be logged out, never a mask of their nick", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...known(),
        lines(
          "!! ban-account other #iirc",
          "?? refused i1 NoAccount mode=#iirc:+b in=channel:#iirc"
        ),
      ],
    });

    expect.assertions(0);
  });

  it.each([
    ["no ACCOUNTEXTBAN", [...floorIsupport, "EXTBAN=~,a"]],
    ["no EXTBAN", [...floorIsupport, "ACCOUNTEXTBAN=account"]],
    ["an EXTBAN with no comma", [...floorIsupport, "EXTBAN=~a", "ACCOUNTEXTBAN=account"]],
    ["a bad name in ACCOUNTEXTBAN", [...floorIsupport, "EXTBAN=~,a", "ACCOUNTEXTBAN=account,"]],
    ["no ban list in CHANMODES", [...long, "CHANMODES=eI,k,l,imnst"]],
  ])("is refused as Unsendable, and nothing is sent, with %s", (_why, isupport) => {
    play(client, {
      configuration: base,
      transcript: [...known(isupport), lines("!! ban-account peer #iirc", refused("Unsendable"))],
    });

    expect.assertions(0);
  });

  it.each([
    ["everyone", "*"],
    ["a wildcard", "b?b"],
    ["a comma", "a,b"],
  ])("is refused as Unsendable for an account that would ban %s", (_why, account) => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannel(),
        lines(`<< @account=${account} :peer!u@h PRIVMSG #iirc :hi`),
        lines("!! ban-account peer #iirc", refused("Unsendable")),
      ],
    });

    expect.assertions(0);
  });

  it("is refused as Offline without a Session", () => {
    play(client, {
      configuration: base,
      transcript: [
        lines(
          "!! configure",
          "-> dial irc.test:6697 tls",
          "!! ban-account peer #iirc",
          "?? refused i1 Offline mode=#iirc:+b in=network"
        ),
      ],
    });

    expect.assertions(0);
  });
});

const viewOffering = (isupport: readonly string[]) =>
  client.channel(
    play(client, { configuration: base, transcript: inChannel(isupport) }).state,
    "#iirc"
  )?.accountExtban;

describe("a Channel's view", () => {
  it("offers a ban by account only while the Network's tokens say how", () => {
    expect(viewOffering(long)).toStrictEqual({ names: ["account", "a"], prefix: "~" });
    expect(viewOffering([...floorIsupport, "EXTBAN=~,a"])).toBeUndefined();
    expect(viewOffering(floorIsupport)).toBeUndefined();
    expect(viewOffering([...long, "CHANMODES=eI,k,l,imnst"])).toBeUndefined();
  });
});
