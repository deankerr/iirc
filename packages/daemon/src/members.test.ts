import { Instant } from "@iirc/client";
import type { ChannelView, Fact, MemberKnowledge } from "@iirc/client/known";
import { describe, expect, it } from "vitest";

import { comparePlaces, inRankOrder, membersPage, rankOf } from "./members.ts";

const at = Instant.make(0);

const known = (...modes: readonly string[]): Fact<ReadonlySet<string>> => ({
  _tag: "Known",
  at,
  from: "ircd",
  value: new Set(modes),
});

// Folds a nick as `rfc1459` does, for the ASCII nicks here.
const fold = (nick: string) =>
  nick.toLowerCase().replaceAll("[", "{").replaceAll("]", "}").replaceAll("\\", "|");

/**
 * A Channel of the members given, keyed as `rfc1459` folds them, with `PREFIX=(qov)~@+`.
 * @param members - Each member's nick and prefixes.
 * @returns The Channel.
 */
const channelOf = (
  members: readonly (readonly [string, Fact<ReadonlySet<string>>])[]
): ChannelView => ({
  accountExtban: undefined,
  casemapping: "rfc1459",
  chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
  channel: {
    members: new Map(
      members.map(([nick, prefixes]): [string, MemberKnowledge] => [fold(nick), { nick, prefixes }])
    ),
    modes: { _tag: "Unknown" },
    name: "#iirc",
    standing: "Joined",
    topic: { _tag: "Unknown" },
    wanted: true,
  },
  chantypes: "#&",
  held: undefined,
  key: "#iirc",
  lists: { Bans: "b", Exceptions: undefined, Invitations: undefined },
  ranks: [
    { mode: "q", symbol: "~" },
    { mode: "o", symbol: "@" },
    { mode: "v", symbol: "+" },
  ],
  users: new Map(),
});

const order = new Map([
  ["q", 0],
  ["o", 1],
  ["v", 2],
]);

// A User known by their account, and whether they are a bot, alone, keyed by their nick.
const unknownBot: Fact<boolean> = { _tag: "Unknown" };

const user = (nick: string, account: Fact<string | null>, bot: Fact<boolean> = unknownBot) =>
  [
    nick,
    {
      account,
      away: { _tag: "Unknown" },
      bot,
      mask: { _tag: "Unknown" },
      nick,
      realname: { _tag: "Unknown" },
    },
  ] as const;

const nicks = (view: ChannelView, query: Parameters<typeof membersPage>[1]) =>
  membersPage(view, query).members.map(({ member }) => member.nick);

describe("members", () => {
  it("ranks a member by the highest prefix anything says they hold, and none last", () => {
    expect([
      rankOf(known("v", "o"), order),
      rankOf({ _tag: "Partial", at, atLeast: new Set(["v"]), from: "ircd" }, order),
      rankOf({ _tag: "Stale", since: at, was: new Set(["q"]) }, order),
      rankOf({ _tag: "Unknown" }, order),
      rankOf(known(), order),
      rankOf(known("y"), order),
    ]).toStrictEqual([1, 2, 0, 3, 3, 3]);
  });

  it("lists a member's prefixes in the order of PREFIX, and those it does not name after", () => {
    expect(inRankOrder(["v", "y", "q", "b"], order)).toStrictEqual(["q", "v", "b", "y"]);
  });

  it("orders by rank, then by folded nick by code unit, whatever the locale", () => {
    const view = channelOf([
      ["b", known()],
      ["Ä", known()],
      ["a", known()],
      ["Z", known("v")],
      ["op", known("o")],
    ]);

    expect(nicks(view, { limit: 10 })).toStrictEqual(["op", "Z", "a", "b", "Ä"]);
    expect(comparePlaces({ key: "a", rank: 0 }, { key: "a", rank: 0 })).toBe(0);
  });

  it("filters by the start of the folded nick, and pages after a place", () => {
    const view = channelOf([
      ["[a]", known()],
      ["{A}b", known("v")],
      ["ab", known()],
    ]);

    const first = membersPage(view, { limit: 1, prefix: "[A" });

    expect([
      first.members.map(({ member }) => member.nick),
      first.next,
      nicks(view, { after: first.next, limit: 5, prefix: "[A" }),
      membersPage(view, { after: first.next, limit: 1, prefix: "[A" }).next,
    ]).toStrictEqual([["{A}b"], { key: "{a}b", rank: 2 }, ["[a]"], undefined]);
  });

  it("places each member's account from their User, and Unknown where none is known", () => {
    const loggedIn: Fact<string | null> = { _tag: "Known", at, from: "ircd", value: "bobby" };
    const loggedOut: Fact<string | null> = { _tag: "Known", at, from: "ircd", value: null };

    const view = channelOf([
      ["bob", known()],
      ["carol", known()],
      ["dave", known()],
    ]);

    const placed = membersPage(
      { ...view, users: new Map([user("bob", loggedIn), user("carol", loggedOut)]) },
      { limit: 10 }
    ).members.map(({ account, member }) => [member.nick, account]);

    expect(placed).toStrictEqual([
      ["bob", loggedIn],
      ["carol", loggedOut],
      ["dave", { _tag: "Unknown" }],
    ]);
  });

  it("places whether each member is a bot from their User, and Unknown where none is known", () => {
    const bot: Fact<boolean> = { _tag: "Known", at, from: "ircd", value: true };
    const human: Fact<boolean> = { _tag: "Known", at, from: "replied", value: false };
    const unknown: Fact<string | null> = { _tag: "Unknown" };

    const view = channelOf([
      ["bob", known()],
      ["carol", known()],
      ["dave", known()],
    ]);

    const placed = membersPage(
      { ...view, users: new Map([user("bob", unknown, bot), user("carol", unknown, human)]) },
      { limit: 10 }
    ).members.map(({ bot: mark, member }) => [member.nick, mark]);

    expect(placed).toStrictEqual([
      ["bob", bot],
      ["carol", human],
      ["dave", { _tag: "Unknown" }],
    ]);
  });
});
