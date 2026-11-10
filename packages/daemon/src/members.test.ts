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
  casemapping: "rfc1459",
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
  key: "#iirc",
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

// Some ops, some voiced, and the rest.
const prefixesOf = (n: number) => {
  if (n % 50 === 0) {
    return known("o");
  }

  return n % 7 === 0 ? known("v") : known();
};

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

  it("pages 10,000 members quickly", () => {
    const view = channelOf(Array.from({ length: 10_000 }, (_, n) => [`user${n}`, prefixesOf(n)]));

    const timings: number[] = [];
    let page = membersPage(view, { limit: 100 });

    for (let read = 0; read < 20; read += 1) {
      const started = performance.now();

      page = membersPage(view, { after: page.next, limit: 100 });
      timings.push(performance.now() - started);
    }

    // A generous bound, for a loaded machine. Each page sorts the Channel's members.
    expect(page.members).toHaveLength(100);
    expect(timings.toSorted((left, right) => left - right)[10]).toBeLessThan(100);
  });
});
