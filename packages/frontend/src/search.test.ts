import { NetworkId, SearchResults, Timeline, TimelineItem } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  capped,
  foundOf,
  initialSearch,
  matchRuns,
  parseQuery,
  reduceSearch,
  searchCap,
  searchWanted,
} from "./search.ts";
import type { Day, QueryContext, Search } from "./search.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const decodeTimeline = Schema.decodeSync(Timeline);
const decodeResults = Schema.decodeSync(SearchResults);
const decodeItem = Schema.decodeSync(TimelineItem);
const networkId = Schema.decodeSync(NetworkId);

const timeline = (
  sequence: number,
  network: string,
  name: string,
  { detached = false, key = name.toLowerCase() }: { detached?: boolean; key?: string | null } = {}
) =>
  decodeTimeline({
    changed: sequence,
    detached,
    head: null,
    id: idOf(sequence),
    key: detached ? null : key,
    kind: name.startsWith("#") ? "Channel" : "Direct",
    latest: null,
    name,
    network,
    read: null,
    unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
  });

/**
 * A day as one number, so a test sees which day the core asked the zone about.
 * @param day - The day.
 * @returns Its year, month, and day as digits, such as 20261110.
 */
const dayStart = ({ day, month, year }: Day) => year * 10_000 + month * 100 + day;

const context: QueryContext = {
  dayStart,
  focused: networkId("libera"),
  networks: [
    {
      network: networkId("libera"),
      timelines: [
        timeline(1, "libera", "#iirc"),
        timeline(2, "libera", "Bob"),
        timeline(3, "libera", "bob", { detached: true }),
        timeline(4, "libera", "#Twice"),
        timeline(5, "libera", "#twice"),
        timeline(8, "libera", "carol", { detached: true }),
        timeline(9, "libera", "carol"),
      ],
    },
    {
      network: networkId("oftc"),
      timelines: [timeline(6, "oftc", "#iirc"), timeline(7, "oftc", "#oftc-only")],
    },
  ],
};

const unfocused: QueryContext = { ...context, focused: undefined };

/**
 * A query's filters, as plain values, or its error.
 * @param query - The query.
 * @param within - What it is read against.
 * @returns What it read as.
 */
const read = (query: string, within = context) => {
  const result = parseQuery(query, within);

  return result._tag === "Invalid" ? result.message : { ...result.value };
};

/** Filters as a test writes them, in plain values, which compare equal to those parsed. */
interface Written {
  readonly text: string;
  readonly from?: string;
  readonly network?: string;
  readonly timeline?: string;
  readonly since?: number;
  readonly until?: number;
}

/**
 * Filters as a test expects them: every one given, the rest left out.
 * @param more - Those given.
 * @returns The filters.
 */
const filters = (more: Written) => ({
  from: undefined,
  network: undefined,
  since: undefined,
  timeline: undefined,
  until: undefined,
  ...more,
});

describe("reading a query", () => {
  it("joins the words that are not filters into one run, and keeps a quoted run whole", () => {
    expect([
      read("hello"),
      read("  hello   world "),
      read('"12:30 sharp" said'),
      read('"from:peer"'),
      read("a 12:30"),
    ]).toStrictEqual([
      filters({ text: "hello" }),
      filters({ text: "hello world" }),
      filters({ text: "12:30 sharp said" }),
      filters({ text: "from:peer" }),
      filters({ text: "a 12:30" }),
    ]);
  });

  it("reads each filter, in any ASCII case, its value quoted or not", () => {
    expect([
      read("word FROM:peer"),
      read("word network:oftc"),
      read('word in:"#iirc" network:oftc'),
      read("word in:#iirc"),
    ]).toStrictEqual([
      filters({ from: "peer", text: "word" }),
      filters({ network: "oftc", text: "word" }),
      filters({ network: "oftc", text: "word", timeline: idOf(6) }),
      filters({ text: "word", timeline: idOf(1) }),
    ]);
  });

  it("finds in: by exact name, then by the Daemon's key, never guessing past ASCII", () => {
    expect([
      read("word in:#IIRC"),
      read("word in:BOB"),
      read("word in:bob"),
      read("word in:#oftc-only"),
      read("word in:#iirc", unfocused),
      read("word in:#oftc-only", unfocused),
      read("word in:#TWICE"),
      read("word in:#nowhere network:oftc"),
      read("word in:carol"),
    ]).toStrictEqual([
      filters({ text: "word", timeline: idOf(1) }),
      // No name is `BOB`: Bob's key is `bob`, and the detached `bob`, which has none, is not.
      filters({ text: "word", timeline: idOf(2) }),
      // Exactly the detached one's name, which comes before any key.
      filters({ text: "word", timeline: idOf(3) }),
      "libera has no Timeline called #oftc-only.",
      "#iirc names Timelines on libera and oftc. Say which with network:<id>.",
      filters({ text: "word", timeline: idOf(7) }),
      "#TWICE names more than one Timeline on libera.",
      "oftc has no Timeline called #nowhere.",
      // Two are called carol: the detached one is found only when nothing else is.
      filters({ text: "word", timeline: idOf(9) }),
    ]);
  });

  it("reads since: and until: as days in the Owner's zone, until: taking the whole day", () => {
    expect([
      read("word since:2026-11-10"),
      read("word until:2026-11-10"),
      read("word until:2026-12-31"),
      read("word until:2028-02-28"),
      read("word until:2027-02-28"),
      read("word since:2026-11-10T09:30Z"),
      read("word since:2026-11-10t09:30:15.25+01:00"),
      read("word until:1969-12-31T23:59-05:30"),
      read("word since:2026-11-10T09:30-23:59"),
    ]).toStrictEqual([
      filters({ since: 20_261_110, text: "word" }),
      filters({ text: "word", until: 20_261_111 }),
      filters({ text: "word", until: 20_270_101 }),
      filters({ text: "word", until: 20_280_229 }),
      filters({ text: "word", until: 20_270_301 }),
      filters({ since: 1_794_303_000_000, text: "word" }),
      filters({ since: 1_794_299_415_250, text: "word" }),
      filters({ text: "word", until: 19_740_000 }),
      // The furthest offset RFC 3339 allows: 09:30 at -23:59 is 09:29 the next day in UTC.
      filters({ since: 1_794_389_340_000, text: "word" }),
    ]);
  });

  it("says in words why a query cannot be searched", () => {
    expect([
      read("hi"),
      read("from:peer"),
      read(""),
      read("x".repeat(511)),
      read("word sender:peer"),
      read("http://example.com"),
      read("word from:a from:b"),
      read("word from:"),
      read('word from:"a b"'),
      read('word "open'),
      read("word network:nowhere"),
      read("word since:2026-02-30"),
      read("word since:yesterday"),
      read("word since:2026-11-10T09:30"),
      read("word since:2026-11-10T24:00Z"),
      read("word since:2026-11-11 until:2026-11-10"),
      read("word since:2026-11-10T09:30+99:99"),
      read("word since:2026-11-10T09:30+01:60"),
      read("word since:2026-11-10T09:30-24:00"),
      read("word since:2026-11-10T09:60Z"),
      read("word since:2026-11-10T09:30:60Z"),
    ]).toStrictEqual([
      "Search for at least 3 characters.",
      "Say what to search for: at least 3 characters, with from:, in:, network:, since:, or until: to narrow it.",
      "Say what to search for: at least 3 characters, with from:, in:, network:, since:, or until: to narrow it.",
      "Search for at most 510 characters.",
      'There is no filter sender:. A search takes from:, in:, network:, since:, and until:. Put text with a colon in quotes, such as "sender:peer".',
      'There is no filter http:. A search takes from:, in:, network:, since:, and until:. Put text with a colon in quotes, such as "http://example.com".',
      "from: is given twice.",
      "from: needs a value after it.",
      "from: takes one nick, with no space in it.",
      'A quote is not closed. Close it with another ".',
      "No Network is called nowhere.",
      "2026-02-30 is no day of the calendar. since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
      "since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
      "2026-11-10T09:30 needs its zone, such as Z or +01:00, or a date alone. since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
      "2026-11-10T24:00Z is no time of the calendar. since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
      "since: must come before until:.",
      "+99:99 is no zone's offset. since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
      "+01:60 is no zone's offset. since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
      "-24:00 is no zone's offset. since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
      "2026-11-10T09:60Z is no time of the calendar. since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
      "2026-11-10T09:30:60Z is no time of the calendar. since: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.",
    ]);
  });

  it("counts characters once folded, as the Daemon does: three astral characters are enough", () => {
    expect([read("\u{1F600}\u{1F600}\u{1F600}"), read("e\u0301")]).toStrictEqual([
      filters({ text: "\u{1F600}\u{1F600}\u{1F600}" }),
      "Search for at least 3 characters.",
    ]);
  });
});

// The search.

const message = (sequence: number, text: string, sender = "peer") =>
  decodeItem({
    changed: sequence,
    content: {
      _tag: "Message",
      at: { _tag: "Unknown" },
      id: { _tag: "Unknown" },
      kind: "Privmsg",
      live: true,
      ours: null,
      sender,
      tags: [],
      target: "#iirc",
      text,
    },
    level: "Message",
    network: "libera",
    position: cursor(sequence * 10, sequence),
    sequence,
    timeline: idOf(1),
  });

const page = (from: number, to: number, more: boolean, version = 1) =>
  decodeResults({
    items: Array.from({ length: from - to + 1 }, (_, index) =>
      Schema.encodeSync(TimelineItem)(message(from - index, `word ${from - index}`))
    ),
    more,
    next: more ? `${cursor(to * 10, to)}.${idOf(1)}` : null,
    through: 900,
    version,
  });

const searched = (query = "word") => {
  const parsed = parseQuery(query, context);

  return reduceSearch(initialSearch, { _tag: "Submitted", parsed, query });
};

/**
 * A search with its wanted page started and answered.
 * @param search - The search.
 * @param answer - The page.
 * @returns The search.
 */
const answered = (search: Search, answer: ReturnType<typeof page>) => {
  const request = searchWanted(search);

  if (request === undefined) {
    throw new Error("no page wanted");
  }

  const started = reduceSearch(search, { _tag: "Started", read: request });

  return reduceSearch(started, { _tag: "Read", page: answer, read: request });
};

const sequences = (search: Search) => search.results.map((item) => item.sequence);

describe("the search", () => {
  it("reads the first page, then the next from where it ended, once more is wanted", () => {
    const first = answered(searched(), page(900, 801, true));
    const asked = searchWanted(first);
    const more = reduceSearch(first, { _tag: "More" });
    const next = searchWanted(more);

    const second = answered(more, page(800, 790, false));

    expect({
      after: next?.after?.position.sequence,
      asked,
      first: [sequences(first).length, first.more],
      generation: next?.generation,
      second: [sequences(second).length, second.more, second.next],
      stillMore: searchWanted(reduceSearch(second, { _tag: "More" })),
    }).toStrictEqual({
      after: 801,
      asked: undefined,
      first: [100, true],
      generation: 1,
      second: [111, false, undefined],
      stillMore: undefined,
    });
  });

  it("begins again on a new query, taking no answer of the search before", () => {
    const old = searched("word");
    const request = searchWanted(old);

    if (request === undefined) {
      throw new Error("no page wanted");
    }

    let search = reduceSearch(old, { _tag: "Started", read: request });

    search = reduceSearch(search, {
      _tag: "Submitted",
      parsed: parseQuery("other", context),
      query: "other",
    });
    search = reduceSearch(search, { _tag: "Read", page: page(900, 801, true), read: request });

    expect({
      generation: search.generation,
      results: search.results.length,
      wanted: searchWanted(search)?.filters.text,
    }).toStrictEqual({ generation: 2, results: 0, wanted: "other" });
  });

  it("begins again from the first page when restarted, as a merge asks, or a page of another version", () => {
    const first = answered(searched(), page(900, 801, true));
    const restarted = reduceSearch(first, { _tag: "Restarted" });
    const more = reduceSearch(first, { _tag: "More" });
    const otherVersion = answered(more, page(800, 701, true, 2));

    expect({
      otherVersion: [
        otherVersion.results.length,
        searchWanted(otherVersion)?.after,
        otherVersion.attempt,
      ],
      restarted: [restarted.results.length, searchWanted(restarted)?.after, restarted.query],
      unsearched: reduceSearch(initialSearch, { _tag: "Restarted" }),
    }).toStrictEqual({
      otherVersion: [0, undefined, 1],
      restarted: [0, undefined, "word"],
      unsearched: initialSearch,
    });
  });

  it("holds at most the cap, and asks for no more past it", () => {
    let search = answered(searched(), page(1000, 901, true));

    for (let from = 900; from > 500; from -= 100) {
      search = answered(reduceSearch(search, { _tag: "More" }), page(from, from - 99, true));
    }

    expect({
      capped: capped(search),
      held: search.results.length,
      more: searchWanted(reduceSearch(search, { _tag: "More" })),
    }).toStrictEqual({ capped: true, held: searchCap, more: undefined });
  });

  it("says a failure in words, and a query it cannot read, searching nothing", () => {
    const search = searched();
    const request = searchWanted(search);

    if (request === undefined) {
      throw new Error("no page wanted");
    }

    const failed = reduceSearch(reduceSearch(search, { _tag: "Started", read: request }), {
      _tag: "Failed",
      message: "No Timeline has that id.",
      read: request,
    });

    const bad = searched("hi");

    expect({
      bad: [bad.error, searchWanted(bad), bad.query],
      failed: [failed.error, failed.reading, searchWanted(reduceSearch(failed, { _tag: "More" }))],
    }).toStrictEqual({
      bad: ["Search for at least 3 characters.", undefined, "hi"],
      failed: ["No Timeline has that id.", false, undefined],
    });
  });

  it("keeps the selection among the results", () => {
    const search = answered(searched(), page(900, 891, false));

    expect([
      reduceSearch(search, { _tag: "Selected", index: 4 }).selected,
      reduceSearch(search, { _tag: "Selected", index: 40 }).selected,
      reduceSearch(search, { _tag: "Selected", index: -1 }).selected,
    ]).toStrictEqual([4, 9, 0]);
  });

  it("holds only plain data, which survives structuredClone", () => {
    const search = answered(searched("word from:peer in:#iirc"), page(900, 801, true));

    expect(structuredClone(search)).toStrictEqual(search);
  });
});

describe("marking what was found", () => {
  it("marks each run that holds what was searched for, folded as the Daemon folds it", () => {
    expect([
      matchRuns("Hello WORLD, hello world", "hello"),
      matchRuns("\u0130STANBUL and istanbul", "istanbul"),
      matchRuns("nothing here", "word"),
      matchRuns("aaaa", "aa"),
    ]).toStrictEqual([
      [
        { match: true, text: "Hello" },
        { match: false, text: " WORLD, " },
        { match: true, text: "hello" },
        { match: false, text: " world" },
      ],
      [
        { match: true, text: "\u0130STANBUL" },
        { match: false, text: " and " },
        { match: true, text: "istanbul" },
      ],
      [{ match: false, text: "nothing here" }],
      [{ match: true, text: "aaaa" }],
    ]);
  });

  it("marks hostile text as plain text: formatting stripped, controls dropped, markup kept as text", () => {
    const found = foundOf(
      message(1, "\u202Eevil\u202C <b>\u0002WoRd\u0002</b> \u0007<img src=x onerror=alert(1)>"),
      "word"
    );

    expect({
      nick: found?.nick,
      runs: found?.runs,
    }).toStrictEqual({
      nick: "peer",
      runs: [
        { match: false, text: "evil <b>" },
        { match: true, text: "WoRd" },
        { match: false, text: "</b> <img src=x onerror=alert(1)>" },
      ],
    });
  });

  it("shows a sender as plain text, a bidirectional override dropped", () => {
    const hostile = foundOf(message(2, "a word", "pe\u202Eer"), "word");

    expect(hostile?.nick).toBe("peer");
  });
});
