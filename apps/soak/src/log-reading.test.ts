import type { LogEntry } from "@iirc/api";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { RawGap } from "./folding.ts";
import { pageStream, readLog } from "./log-reading.ts";
import type { LogSource } from "./log-reading.ts";

describe("PROOF-5: reading a Log in pages", () => {
  // The Log's reader stops a page at about 256 KiB of rows (LOG-11), so a page shorter than
  // the limit asked for is not the last. These are such pages, then an empty one.
  const rows = Array.from({ length: 10 }, (_, index) => ({ sequence: index + 1 }));

  const readerCuttingAt = (sizes: readonly number[]) => {
    const asked: number[] = [];

    const fetch = (after: number) => {
      asked.push(after);

      const size = sizes[asked.length - 1] ?? 0;

      return Effect.succeed(rows.filter(({ sequence }) => sequence > after).slice(0, size));
    };

    return { asked, fetch };
  };

  const readAll = async (fetch: ReturnType<typeof readerCuttingAt>["fetch"]) => {
    const items = await Effect.runPromise(
      Stream.runCollect(pageStream(0, fetch, ({ sequence }) => sequence))
    );

    return items;
  };

  it("PROOF-5: goes on past a page shorter than the limit, until an empty page", async () => {
    const reader = readerCuttingAt([3, 2, 4, 1]);
    const all = await readAll(reader.fetch);

    expect(all.map(({ sequence }) => sequence)).toStrictEqual(rows.map(({ sequence }) => sequence));
    expect(reader.asked).toStrictEqual([0, 3, 5, 9, 10]);
  });

  it("PROOF-5: reads nothing from a Log with nothing in it", async () => {
    const reader = readerCuttingAt([]);

    await expect(readAll(reader.fetch)).resolves.toStrictEqual([]);
    expect(reader.asked).toStrictEqual([0]);
  });
});

const line = (sequence: number, text: string): LogEntry => ({
  _tag: "Line",
  at: sequence * 10,
  bytes: new TextEncoder().encode(text),
  connection: 1,
  direction: "inbound",
  network: "floor",
  sequence,
  text,
});

const gap = (sequence: number, endedSequence?: number): RawGap => ({
  at: sequence * 10,
  endedAt: endedSequence === undefined ? undefined : endedSequence * 10,
  endedSequence,
  reason: "closed",
  sequence,
});

// A Log whose head is 30 when it is read, and which then goes on: a Gap is recorded, a
// Gap that was open ends, and Self's JOIN comes back, all while the read is under way.
const growing = () => {
  const entries: LogEntry[] = [
    line(1, ":ircd 001 soak-b :Welcome"),
    line(5, "PING :x"),
    line(21, ":ircd 001 soak-b :Welcome"),
  ];

  const gaps: RawGap[] = [gap(10, 21), gap(25)];

  const source: LogSource<never> = {
    entries: (after) => Effect.sync(() => entries.filter(({ sequence }) => sequence > after)),
    gaps: Effect.sync(() => [...gaps]),
    head: Effect.sync(() => {
      // Recorded just after the head was read.
      gaps.splice(0, gaps.length, gap(10, 21), gap(25, 33), gap(35));
      entries.push(line(34, ":soak-b!u@h JOIN :#soak"), line(40, "PING :late"));

      return 30;
    }),
  };

  return source;
};

describe("PROOF-5: reading a Log from one moment", () => {
  it("PROOF-5: sees nothing recorded after the head, so a Gap recorded between the reads is left for the next run", async () => {
    const folded = await Effect.runPromise(readLog(growing(), "#soak"));

    expect(folded.gaps.map(({ sequence }) => sequence)).toStrictEqual([10, 25]);
  });

  it("PROOF-5: keeps a Gap's window open when the evidence that closes it came after the head", async () => {
    const folded = await Effect.runPromise(readLog(growing(), "#soak"));
    const [, second] = folded.gaps;

    expect(second?.endedAt).toBeUndefined();
    expect(second?.listeningAgainAt).toBeUndefined();
    // And no Line past the head moved when the Daemon last heard.
    expect(second?.lastHeardAt).toBe(210);
  });

  it("PROOF-5: fails a Log that cannot be read, and reads nothing", async () => {
    const unreadable: LogSource<never> = { ...growing(), head: Effect.succeed(null) };
    const failure = await Effect.runPromise(Effect.flip(readLog(unreadable, "#soak")));

    expect(failure._tag).toBe("LogUnavailable");
  });
});
