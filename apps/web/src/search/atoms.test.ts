import type { Timeline, TimelineChangesEvent, TimelineItem } from "@iirc/api";
import { mainOf } from "@iirc/frontend/timelines";
import { describe, expect, it } from "vitest";

import { perform } from "../composer/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import { eventually, fakeDaemon, registryFor, run, until } from "../testing/fake-daemon.ts";
import type { FakeTimeline } from "../testing/fake-daemon.ts";
import { openTimeline, sync, timelinesState } from "../timelines/atoms.ts";
import { jumpTo, moreResults, resultRows, searchState } from "./atoms.ts";

const hex = (value: bigint, digits: number) => value.toString(16).padStart(digits, "0");

const cursor = (at: number, sequence: number) =>
  `${hex(BigInt(at) + 2n ** 53n, 14)}-${hex(BigInt(sequence), 14)}-${hex(0n, 8)}`;

const idOf = (sequence: number) => `${hex(BigInt(sequence), 14)}-00000000-00000000`;

const own = idOf(1);
const channel = idOf(2);
const other = idOf(3);

const describeTimeline = (
  id: string,
  name: string,
  kind: "Network" | "Channel"
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

const message = (
  sequence: number,
  text: string,
  sender = "peer",
  timeline = channel
): typeof TimelineItem.Encoded => ({
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
  position: cursor(sequence * 1000, sequence),
  sequence,
  timeline,
});

/**
 * A Daemon with one Network, `#iirc` holding 150 Messages, each fifth by `pat` and the rest
 * by `peer`, all saying `word`, and `#other` holding one, and a browser following it.
 * @returns The fake, and the registry.
 */
const following = async () => {
  const fake = fakeDaemon();

  const iirc: FakeTimeline = {
    gaps: [],
    items: Array.from({ length: 150 }, (_, index) =>
      message(index + 1, `a word ${index + 1}`, (index + 1) % 5 === 0 ? "pat" : "peer")
    ),
    timeline: describeTimeline(channel, "#iirc", "Channel"),
  };

  fake.daemon.signedIn = true;
  fake.daemon.through = 200;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(own, "libera", "Network") },
    iirc,
    {
      gaps: [],
      items: [message(160, "other word", "peer", other)],
      timeline: describeTimeline(other, "#other", "Channel"),
    },
  ]);

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  await eventually(() => fake.daemon.followers.length === 1);

  return { ...fake, registry };
};

const merged = (sequence: number): typeof TimelineChangesEvent.Encoded => ({
  data: JSON.stringify({
    gaps: [],
    items: [],
    merged: [{ changed: sequence, id: other, into: channel, network: "libera" }],
    sequence,
    timelines: [],
  }),
  event: "changed",
  id: `1.${sequence}`,
});

/**
 * A page of the search as the fake was asked for it.
 * @param search - The query, as the URL had it.
 * @returns What the test compares: its text, sender, Timeline, and where it began.
 */
const asked = (search: string) => {
  const query = new URLSearchParams(search);

  return {
    after: query.get("after")?.split("-")[1],
    from: query.get("from"),
    text: query.get("text"),
    timeline: query.get("timeline"),
  };
};

describe("searching", () => {
  it("searches from /search, newest first, a page at a time, and narrows by from:", async () => {
    const { daemon, registry } = await following();

    registry.set(perform, [{ _tag: "Search", query: "word" }]);
    const first = await until(registry, searchState, (search) => search.results.length === 100);

    registry.set(moreResults, undefined);
    const all = await until(registry, searchState, (search) => search.results.length === 151);

    registry.set(perform, [{ _tag: "Search", query: "word from:pat in:#iirc" }]);

    const narrowed = await until(
      registry,
      searchState,
      (search) => search.results.length === 30 && !search.reading
    );

    expect({
      all: [all.more, all.results.at(-1)?.sequence],
      asked: daemon.searchesRead.map(asked),
      first: first.results.slice(0, 3).map((item) => item.sequence),
      main: mainOf(registry.get(timelinesState))._tag,
      narrowed: narrowed.results.slice(0, 2).map((item) => item.sequence),
      shown: registry.get(resultRows)[0]?.found.runs,
    }).toStrictEqual({
      all: [false, 1],
      asked: [
        { after: undefined, from: null, text: "word", timeline: null },
        { after: hex(52n, 14), from: null, text: "word", timeline: null },
        { after: undefined, from: "pat", text: "word", timeline: channel },
      ],
      // #other's at step 160 is the newest.
      first: [160, 150, 149],
      main: "Search",
      narrowed: [150, 145],
      shown: [
        { match: false, text: "a " },
        { match: true, text: "word" },
        { match: false, text: " 150" },
      ],
    });
  });

  it("begins again from the first page when the changes report a merge", async () => {
    const { daemon, registry, send } = await following();

    registry.set(perform, [{ _tag: "Search", query: "word" }]);
    await until(registry, searchState, (search) => search.results.length === 100);

    send(merged(201));
    await eventually(() => daemon.searchesRead.length === 2);
    await until(registry, searchState, (search) => search.results.length === 100);

    expect(daemon.searchesRead.map((one) => asked(one).after)).toStrictEqual([
      undefined,
      undefined,
    ]);
  });

  it("says in words why a query cannot be searched, or why the Daemon refused it", async () => {
    const { daemon, registry } = await following();

    registry.set(perform, [{ _tag: "Search", query: "hi" }]);
    const short = await until(registry, searchState, (search) => search.error !== undefined);

    // #other is gone from the Daemon, though the page still lists it.
    daemon.timelines.set(
      "libera",
      (daemon.timelines.get("libera") ?? []).filter((held) => held.timeline.id !== other)
    );
    registry.set(perform, [{ _tag: "Search", query: "word in:#other" }]);

    const gone = await until(
      registry,
      searchState,
      (search) => search.error !== undefined && search.error !== short.error
    );

    expect({
      gone: gone.error,
      reads: daemon.searchesRead.length,
      short: short.error,
    }).toStrictEqual({
      gone: "That Timeline is gone, so nothing was searched.",
      reads: 1,
      short: "Search for at least 3 characters.",
    });
  });

  it("jumps to a result: its Timeline read around it, never following, and marked", async () => {
    const { daemon, registry } = await following();

    registry.set(perform, [{ _tag: "Search", query: "word 20" }]);
    const search = await until(registry, searchState, (one) => one.results.length > 0);
    const result = search.results.find((item) => item.sequence === 20);

    if (result === undefined) {
      throw new Error("no result at step 20");
    }

    registry.set(jumpTo, result);
    const shown = await until(registry, openTimeline, (one) => one._tag === "Shown");
    const window = shown._tag === "Shown" ? shown.window : undefined;

    expect({
      around: daemon.windowsRead.map(
        (one) => new URLSearchParams(one).get("around")?.split("-")[1]
      ),
      main: mainOf(registry.get(timelinesState))._tag,
      window: [
        window?.following,
        window?.target?.sequence,
        window?.items[0]?.sequence,
        window?.items.at(-1)?.sequence,
        window?.later,
        window?.seen,
      ],
    }).toStrictEqual({
      around: [hex(20n, 14)],
      main: "Timeline",
      // Nineteen lie before it, so the rest of a hundred come from it on.
      window: [false, 20, 1, 100, true, undefined],
    });
  });
});
