/**
 * What a search looks for, and what an item is found by.
 */
import { Instant, IntentId } from "@iirc/client";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { Content } from "./content.ts";
import { cursorOf, cursorsFrom } from "./position.ts";
import {
  SearchText,
  foldForSearch,
  foldSenderForSearch,
  searchTextMaximum,
  searchableOf,
} from "./search.ts";

const t0 = Instant.make(1_762_560_000_000);
const isSearchText = Schema.is(SearchText);
const at = (ms: number) => Instant.make(t0 + ms);

const message = (
  text: string,
  ours?: Extract<Content, { _tag: "Message" }>["ours"],
  sender = "PeerÄ"
): Content => ({
  _tag: "Message",
  answers: undefined,
  at: { _tag: "Known", at: t0, from: "ircd", value: t0 },
  bot: false,
  context: undefined,
  id: { _tag: "Unknown" },
  kind: "Privmsg",
  live: true,
  nicks: [],
  ours,
  prefix: undefined,
  sender,
  tags: [],
  target: "#a",
  text,
});

describe("the text a search looks for", () => {
  it.each<readonly [string, string, boolean]>([
    ["three letters", "iir", true],
    ["two", "ab", false],
    ["two astral characters, four code units", "\u{1F600}\u{1F600}", false],
    ["a composed letter and one more, two code points", "\u00E1a", false],
    [
      "a letter, its combining accent, and one more, two once the accent is dropped",
      "a\u0301a",
      false,
    ],
    ["a sharp s and one more, three once the sharp s expands", "\u00DFa", true],
    ["two dotted capital Is, which fold to two code points", "\u0130\u0130", false],
    ["510 letters", "a".repeat(searchTextMaximum), true],
    ["511 letters", "a".repeat(searchTextMaximum + 1), false],
    ["510 astral characters, 1020 code units", "\u{1F600}".repeat(searchTextMaximum), true],
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
  it.each<readonly [string, string, string]>([
    [
      "lower-cases beyond ASCII",
      "HeLLo \u03A3\u039F\u03A3 \u{10400}",
      "hello \u03C3\u03BF\u03C3 \u{10428}",
    ],
    ["a dotted capital I to i", "\u0130", "i"],
    ["a composed caf\u00E9", "caf\u00E9", "cafe"],
    ["a decomposed caf\u00E9", "cafe\u0301", "cafe"],
    ["CAF\u00C9", "CAF\u00C9", "cafe"],
    ["\u00C5ngstr\u00F6m, and an Angstrom sign", "\u00C5ngstr\u00F6m \u212B", "angstrom a"],
    ["a letter under two marks", "\u1EC7", "e"],
    [
      "letters with a stroke, and a dotless i",
      "\u00F8\u00D8 \u0142\u0141 \u0111\u0110 \u0127\u0126 \u0131",
      "oo ll dd hh i",
    ],
    ["\u00E6 and \u00C6 to ae", "\u00E6\u00C6", "aeae"],
    ["\u0153 and \u0152 to oe", "\u0153\u0152", "oeoe"],
    ["\u00DF and \u1E9E to ss", "\u00DF\u1E9E", "ssss"],
    ["a ligature under an accent", "\u01FD \u01FF", "ae o"],
    ["a Devanagari vowel sign, kept", "\u0915\u093F", "\u0915\u093F"],
    ["a Devanagari nukta, kept as its base decomposes", "\u0958", "\u0915\u093C"],
    ["a Japanese voicing mark, kept as its base decomposes", "\u304C", "\u304B\u3099"],
    ["\uFB01, by no compatibility decomposition", "\uFB01", "\uFB01"],
    ["a fullwidth A, lower-cased only", "\uFF21", "\uFF41"],
    ["a Hangul syllable, whole", "\uD55C", "\uD55C"],
    ["an eth, which is no stroke", "\u00F0", "\u00F0"],
  ])("folds %s", (_, text, folded) => {
    expect(foldForSearch(text)).toBe(folded);
  });

  it("finds r\u00E9sum\u00E9 and resume alike", () => {
    expect(foldForSearch("R\u00C9SUM\u00C9")).toBe(foldForSearch("resume"));
  });

  it("finds a Message by its text and sender, folded, and anything else by nothing", () => {
    expect(searchableOf(message("Hi There"))).toStrictEqual({ sender: "peera", text: "hi there" });
    expect(searchableOf({ _tag: "SessionBegan", at: t0, nick: "iirc" })).toBeUndefined();
  });

  it("folds a sender, and a from, as rfc1459 compares nicks, after the search fold", () => {
    expect(
      ["[a]\\^", "{A}|~", "\u00C9[", "e{"].map((nick) => [
        searchableOf(message("hi", undefined, nick))?.sender,
        foldSenderForSearch(nick),
      ])
    ).toStrictEqual([
      ["{a}|^", "{a}|^"],
      ["{a}|^", "{a}|^"],
      ["e{", "e{"],
      ["e{", "e{"],
    ]);
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
          nicks: [],
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
