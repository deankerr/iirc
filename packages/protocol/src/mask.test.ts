import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { canonicalMask, IgnoreMask, matches } from "./mask.ts";

const parse = Schema.decodeUnknownResult(IgnoreMask);
const mask = (text: string) => IgnoreMask.make(text);

describe("an ignore mask", () => {
  it.each([
    "nick!user@host",
    "*!*@*",
    "spam*!*@*.example.test",
    "n?ck!~u@2001:db8::1",
    "[x]!a@b",
    "a!b@c".padEnd(255, "d"),
  ])("takes %s", (text) => {
    expect(Result.isSuccess(parse(text))).toBeTruthy();
  });

  it.each([
    ["no !", "nick@host"],
    ["no @", "nick!user"],
    ["@ before !", "nick@host!user"],
    ["a second !", "a!b!c@d"],
    ["a second @", "a!b@c@d"],
    ["an empty nick", "!u@h"],
    ["an empty user", "n!@h"],
    ["an empty host", "n!u@"],
    ["empty", ""],
    ["a space", "n!u@ho st"],
    ["a comma", "n!u@a,b"],
    ["NUL", "n!u@h\0"],
    ["CR", "n!u@h\r"],
    ["LF", "n!u@h\n"],
    ["a control", "n!u\u0007@h"],
    ["DEL", "n!u@h\u007F"],
    ["256 characters", "a!b@c".padEnd(256, "d")],
  ])("refuses one with %s", (_why, text) => {
    expect(Result.isFailure(parse(text))).toBeTruthy();
  });
});

describe(canonicalMask, () => {
  it("folds by the casemapping", () => {
    expect([
      canonicalMask("rfc1459", mask("[Foo]!U~\\@Host")),
      canonicalMask("ascii", mask("[Foo]!U~\\@Host")),
      canonicalMask("rfc1459-strict", mask("[Foo]!U~\\@Host")),
    ]).toStrictEqual(["{foo}!u^|@host", "[foo]!u~\\@host", "{foo}!u~|@host"]);
  });

  it("keeps wildcards", () => {
    expect(canonicalMask("rfc1459", mask("A*!?@*"))).toBe("a*!?@*");
  });
});

describe(matches, () => {
  const who = { host: "Host.Example.test", nick: "Peer", user: "~user" };

  it("matches the whole of nick!user@host, and not a part", () => {
    expect([
      matches("rfc1459", mask("peer!~user@host.example.test"), who),
      matches("rfc1459", mask("pee!~user@host.example.test"), who),
      matches("rfc1459", mask("peer!~user@host.example.tes"), who),
      matches("rfc1459", mask("eer!~user@host.example.test"), who),
    ]).toStrictEqual([true, false, false, false]);
  });

  it("lets * stand for any run of characters, none included", () => {
    expect([
      matches("rfc1459", mask("*!*@*"), who),
      matches("rfc1459", mask("p*r!*@*.test"), who),
      matches("rfc1459", mask("peer*!~user@host*"), who),
      matches("rfc1459", mask("*!*@*.example.org"), who),
      matches("rfc1459", mask("pe*er!*@*"), who),
      matches("rfc1459", mask("*e*e*!*@*"), who),
    ]).toStrictEqual([true, true, true, false, true, true]);
  });

  it("lets * cross the ! and the @, as an Ircd's masks do", () => {
    expect(matches("rfc1459", mask("*r!~u*@*.test"), who)).toBeTruthy();
  });

  it("lets ? stand for exactly one character", () => {
    expect([
      matches("rfc1459", mask("pee?!*@*"), who),
      matches("rfc1459", mask("pe?!*@*"), who),
      matches("rfc1459", mask("peer?!*@*"), who),
      matches("rfc1459", mask("????!*@*"), { host: "h", nick: "abcd", user: "u" }),
      matches("rfc1459", mask("?!*@*"), { host: "h", nick: "😀", user: "u" }),
    ]).toStrictEqual([true, false, false, true, true]);
  });

  it("folds both sides by the casemapping", () => {
    const bracketed = { host: "h", nick: "[Foo]", user: "u" };

    expect([
      matches("rfc1459", mask("{foo}!u@h"), bracketed),
      matches("rfc1459", mask("[FOO]!u@h"), bracketed),
      matches("rfc1459", mask("\\foo~!u@h"), { host: "h", nick: "|FOO^", user: "u" }),
      matches("rfc1459", mask("|foo^!u@h"), { host: "h", nick: "\\Foo~", user: "u" }),
      matches("ascii", mask("{foo}!u@h"), bracketed),
      matches("ascii", mask("[foo]!u@h"), bracketed),
      matches("rfc1459-strict", mask("^!u@h"), { host: "h", nick: "~", user: "u" }),
      matches("rfc1459", mask("^!u@h"), { host: "h", nick: "~", user: "u" }),
    ]).toStrictEqual([true, true, true, true, false, true, false, true]);
  });

  it("reads a missing user or host as empty", () => {
    expect([
      matches("rfc1459", mask("peer!*@*"), { host: undefined, nick: "peer", user: undefined }),
      matches("rfc1459", mask("peer!?*@*"), { host: undefined, nick: "peer", user: undefined }),
      matches("rfc1459", mask("peer!*@?*"), { host: undefined, nick: "peer", user: "u" }),
      matches("rfc1459", mask("*!*@*"), { host: undefined, nick: "irc.test", user: undefined }),
    ]).toStrictEqual([true, false, false, true]);
  });

  it("stays fast on a pattern built to backtrack", () => {
    const pattern = mask(`${"*a".repeat(60)}*b!*@*`);

    // A walk that backtracks without bound never ends on this, and the test with it.
    expect(
      matches("rfc1459", pattern, { host: "h", nick: "a".repeat(400), user: "u" })
    ).toBeFalsy();
  });
});
