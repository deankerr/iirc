/**
 * What a search looks for, and what an item is found by.
 */
import { Instant, IntentId } from "@iirc/client";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { Content } from "./content.ts";
import { cursorOf, cursorsFrom } from "./position.ts";
import { SearchText, foldForSearch, searchTextMaximum, searchableOf } from "./search.ts";

const t0 = Instant.make(1_762_560_000_000);
const isSearchText = Schema.is(SearchText);
const at = (ms: number) => Instant.make(t0 + ms);

const message = (text: string, ours?: Extract<Content, { _tag: "Message" }>["ours"]): Content => ({
  _tag: "Message",
  at: { _tag: "Known", at: t0, from: "ircd", value: t0 },
  id: { _tag: "Unknown" },
  kind: "Privmsg",
  live: true,
  ours,
  sender: "PeerÄ",
  tags: [],
  target: "#a",
  text,
});

describe("the text a search looks for", () => {
  it.each<readonly [string, string, boolean]>([
    ["three letters", "iir", true],
    ["two", "ab", false],
    ["none", "", false],
    ["three ideographs", "\u65E5\u672C\u8A9E", true],
    ["two astral characters, four code units", "\u{1F600}\u{1F600}", false],
    ["three astral characters", "\u{1F600}\u{1F600}\u{1F600}", true],
    ["a composed letter and one more, two code points", "\u00E1a", false],
    ["a letter, its combining accent, and one more, three code points", "a\u0301a", true],
    ["two dotted capital Is, which fold to two code points", "\u0130\u0130", false],
    ["three dotted capital Is", "\u0130\u0130\u0130", true],
    ["510 letters", "a".repeat(searchTextMaximum), true],
    ["511 letters", "a".repeat(searchTextMaximum + 1), false],
    ["510 astral characters, 1020 code units", "\u{1F600}".repeat(searchTextMaximum), true],
    ["511 astral characters", "\u{1F600}".repeat(searchTextMaximum + 1), false],
    ["510 dotted capital Is", "\u0130".repeat(searchTextMaximum), true],
  ])("counts %s by code point once folded", (_, text, valid) => {
    expect(isSearchText(text)).toBe(valid);
  });

  it("holds no line break, NUL, or lone surrogate, which no Message can", () => {
    expect(["a\0bc", "ab\rc", "ab\nc", "ab\uD800c", 'a"*^:'].map(isSearchText)).toStrictEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("folding", () => {
  it("lower-cases beyond ASCII, one code point to one, and keeps diacritics", () => {
    expect(
      ["HeLLo \u00DCBER", "\u0130", "\u03A3\u039F\u03A3", "\u{10400}", "\u1E9E"].map(foldForSearch)
    ).toStrictEqual(["hello \u00FCber", "i", "\u03C3\u03BF\u03C3", "\u{10428}", "\u00DF"]);
    expect(foldForSearch("caf\u00E9")).not.toBe(foldForSearch("cafe"));
  });

  it("composes nothing, so a composed letter and a decomposed one differ", () => {
    expect(foldForSearch("\u00C9")).toBe("\u00E9");
    expect(foldForSearch("E\u0301")).toBe("e\u0301");
  });

  it("finds a Message by its text and sender, folded, and anything else by nothing", () => {
    expect(searchableOf(message("Hi There"))).toStrictEqual({ sender: "peerä", text: "hi there" });
    expect(searchableOf({ _tag: "SessionBegan", at: t0, nick: "iirc" })).toBeUndefined();
  });

  it("finds one of ours by the text the Ircd confirmed, once it did", () => {
    const intent = IntentId.make("i");

    expect(
      [
        { _tag: "Pending" } as const,
        {
          _tag: "Confirmed",
          at: { _tag: "Unknown" },
          id: { _tag: "Unknown" },
          text: "HELLO",
        } as const,
      ].map((delivery) => searchableOf(message("helo", { delivery, intent }))?.text)
    ).toStrictEqual(["helo", "hello"]);
  });
});

describe("a range of time by cursor", () => {
  it("puts every cursor at or after an instant at or above the bound, and the rest below", () => {
    const bound = cursorsFrom(at(10));

    expect(
      [
        { at: at(9), n: 99, sequence: 99 },
        { at: at(10), n: 0, sequence: 1 },
        { at: at(11), n: 0, sequence: 1 },
      ].map((position) => cursorOf(position) >= bound)
    ).toStrictEqual([false, true, true]);
  });
});
