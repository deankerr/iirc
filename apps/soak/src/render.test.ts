import { describe, expect, it } from "vitest";

import { ranges, reportLine, summaryLine, unableLine } from "./render.ts";
import { defaultTolerances, judge } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";

const pair = { receiver: "floor", sender: "floor", target: "#soak" };
const minute = 60_000;
const now = 1_000_000_000_000;

// Numbers are Unix minutes, so the one message of this run is the minute 3 before `now`.
const sentMinute = now / minute - 3;

const sound = judge({
  gaps: { receiver: [], sender: [] },
  now,
  receipts: [{ at: now - 3 * minute, millis: now - 3 * minute, n: sentMinute, sequence: 5 }],
  sends: [
    {
      at: now - 3 * minute,
      millis: now - 3 * minute,
      n: sentMinute,
      outcome: { _tag: "Written" },
      sequence: 4,
    },
  ],
  tolerances: { ...defaultTolerances, silenceMillis: 10 * minute },
});

const failing: Verdict = {
  ...sound,
  duplicates: [2],
  explained: [
    { n: 5, reason: "receiver Gap at Entry 9: the Daemon was killed" },
    { n: 6, reason: "receiver Gap at Entry 9: the Daemon was killed" },
    { n: 8, reason: "Dropped: write timed out" },
  ],
  neverSent: [40],
  ok: false,
  unexplained: [11, 12, 13, 20],
};

describe("PROOF-5: what a check says", () => {
  it("PROOF-5: writes numbers as ranges", () => {
    expect(ranges([])).toBe("");
    expect(ranges([4])).toBe("4");
    expect(ranges([7, 1, 2, 3, 9, 8])).toBe("1-3,7-9");
  });

  it("PROOF-5: a sound pair is one OK line with its counts", () => {
    expect(summaryLine(pair, sound, now)).toBe(
      "soak floor:floor=#soak OK: sent 1; delivered 1; last sent 3 min ago"
    );
  });

  it("PROOF-5: a failing pair is one FAILED line naming every kind of failure and its numbers", () => {
    const line = summaryLine(pair, failing, now);

    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("FAILED");
    expect(line).toContain("UNEXPLAINED in minutes 4 (11-13,20)");
    expect(line).toContain("DUPLICATED in minutes 1 (2)");
    expect(line).toContain("RECEIVED BUT NEVER SENT in minutes 1 (40)");
  });

  it("PROOF-5: a failing pair's explained misses are grouped by reason, with their numbers", () => {
    const line = summaryLine(pair, failing, now);

    expect(line).toContain("explained 2 (5-6) by receiver Gap at Entry 9: the Daemon was killed");
    expect(line).toContain("explained 1 (8) by Dropped: write timed out");
  });

  it("PROOF-5: a silent sender says how long it has been quiet", () => {
    const line = summaryLine(pair, { ...sound, ok: false, silent: true }, now + 20 * minute);

    expect(line).toContain("SENDER SILENT (last sent 23 min ago)");
  });

  it("PROOF-5: a sender that stopped for a while names the minutes it did not run, in the summary and the report", () => {
    const stopped: Verdict = {
      ...sound,
      ok: false,
      silences: [
        { from: 29_000_006, to: 29_000_045 },
        { from: 29_000_100, to: 29_000_100 },
      ],
      silent: true,
    };

    expect(summaryLine(pair, stopped, now)).toContain(
      "SENDER SILENT (no send in minutes 29000006-29000045,29000100)"
    );
    expect(JSON.parse(reportLine(now, [[pair, stopped]]))).toHaveProperty(
      "pairs.0.silences",
      "29000006-29000045,29000100"
    );
  });

  it("PROOF-5: a repeated minute is told in the summary and the report, and is no failure", () => {
    const repeated: Verdict = { ...sound, repeated: [29_000_008, 29_000_009, 29_000_020] };

    expect(summaryLine(pair, repeated, now)).toMatch(
      /^soak floor:floor=#soak OK: .*repeated minutes 3 \(29000008-29000009,29000020\)/u
    );
    expect(JSON.parse(reportLine(now, [[pair, repeated]]))).toMatchObject({
      ok: true,
      pairs: [{ repeated: "29000008-29000009,29000020" }],
    });
  });

  it("PROOF-5: a sender that never sent says so", () => {
    const line = summaryLine(
      pair,
      { ...sound, lastSentAt: undefined, ok: false, sent: 0, silent: true },
      now
    );

    expect(line).toContain("SENDER SILENT (nothing sent yet)");
  });

  it("PROOF-5: the report line is JSON with the time, per-pair counts, failing numbers, and explained misses with their reasons", () => {
    const parsed: unknown = JSON.parse(reportLine(now, [[pair, failing]]));

    expect(parsed).toStrictEqual({
      at: new Date(now).toISOString(),
      ok: false,
      pairs: [
        {
          delivered: 1,
          duplicates: "2",
          explained: [
            { count: 2, numbers: "5-6", reason: "receiver Gap at Entry 9: the Daemon was killed" },
            { count: 1, numbers: "8", reason: "Dropped: write timed out" },
          ],
          lastSentAgoMillis: 3 * minute,
          neverSent: "40",
          ok: false,
          pair: "floor:floor=#soak",
          pendingMinutes: 0,
          repeated: "",
          sent: 1,
          silences: "",
          silent: false,
          unexplained: "11-13,20",
        },
      ],
    });
  });

  it("PROOF-5: a run that could not read a Log is a line of its own, so the file records it", () => {
    expect(JSON.parse(unableLine(now, "could not reach the Daemon"))).toStrictEqual({
      at: new Date(now).toISOString(),
      error: "could not reach the Daemon",
      ok: false,
    });
  });
});
