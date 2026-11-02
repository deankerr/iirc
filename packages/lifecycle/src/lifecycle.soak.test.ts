import { describe, expect, it } from "vitest";

import { deadline, fold, phase, step } from "./lifecycle.ts";
import type { NetworkEvent, NetworkInput, NetworkSnapshot } from "./lifecycle.ts";
import { defaultTuning } from "./tuning.ts";

const input: NetworkInput = {
  realname: "Claude Code",
  tuning: defaultTuning,
  username: "cc",
};

const warmupSteps = 20_000;
const measuredSteps = 200_000;
const batchSteps = 1000;
const budgetMillis = 30_000;
const batches = measuredSteps / batchSteps;
const windowBatches = batches / 10;

// Stamps stay the same width throughout, so a change in the snapshot's size is growth.
const startAt = 1_000_000_000_000;
const token = new TextEncoder().encode("token");

// A quarter of the Lines are `PING`, which takes a transition and answers, a quarter
// cannot be read, and the rest matter to nothing. Every one moves the silence deadline,
// so that is the cost measured here. Each is a fresh object, as a real Entry would be.
const eventAt = (at: number): NetworkEvent => {
  if (at % 4 === 0) {
    return { at, token, type: "PING" };
  }

  return at % 4 === 1
    ? { at, type: "HEARD" }
    : { at, command: "PRIVMSG", params: ["#first", "hello"], type: "LINE" };
};

const median = (values: readonly number[]) =>
  values.toSorted((one, other) => one - other)[Math.floor(values.length / 2)] ?? Number.NaN;

const stepMicros = (window: readonly number[]) => (median(window) / batchSteps) * 1000;

describe("a long chain of steps", () => {
  // Compares medians of small batches, so one garbage collection in the last window
  // cannot fail the gate, while growth, which moves every batch, still does.
  it("costs the same per step at the end as at the start", { timeout: 60_000 }, () => {
    let snapshot: NetworkSnapshot = fold(
      [
        { at: startAt, nicks: ["claude"], type: "ATTEMPT" },
        { at: startAt, type: "OPENED" },
        { at: startAt, command: "001", params: ["claude", "Welcome"], type: "LINE" },
        { at: startAt, command: "376", params: ["claude", "End"], type: "LINE" },
      ],
      input
    );

    const sizeBefore = JSON.stringify(snapshot).length;

    let lines = 0;
    let lagChecks = 0;
    let pongs = 0;
    let at = startAt;

    const apply = (event: NetworkEvent) => {
      const stepped = step(snapshot, event);

      for (const { type } of stepped.commands) {
        pongs += type === "sendPong" ? 1 : 0;
        lagChecks += type === "sendLine" ? 1 : 0;
      }

      snapshot = stepped.next;
    };

    // Takes each deadline as a host would, which the lag check needs, and which would
    // close the Connection here if a Line ever failed to move the silence deadline.
    const advance = (steps: number) => {
      const startedAt = performance.now();

      for (let done = 0; done < steps; done += 1) {
        at += 1;
        lines += 1;
        apply(eventAt(at));

        const due = deadline(snapshot);

        if (due !== undefined && due.at <= at) {
          apply({ at, name: due.name, type: "DEADLINE" });
        }
      }

      return performance.now() - startedAt;
    };

    // Warming up on the same chain keeps the JIT out of the first window, where a
    // slow start would hide growth, and any growth carries on into the measurement.
    advance(warmupSteps);

    // Vitest cannot time out a synchronous loop, so real growth has to stop itself
    // here, or the gate would hang instead of failing.
    const giveUpAt = performance.now() + budgetMillis;
    const timings: number[] = [];

    while (timings.length < batches && performance.now() < giveUpAt) {
      timings.push(advance(batchSteps));
    }

    const first = stepMicros(timings.slice(0, windowBatches));
    const last = stepMicros(timings.slice(-windowBatches));
    const growth = last / first;

    console.info(
      `soak: ${lines} Lines, ${first.toFixed(2)} µs per step at the start, ` +
        `${last.toFixed(2)} µs at the end, growth ${growth.toFixed(3)}`
    );

    expect(timings).toHaveLength(batches);
    expect({ lagChecks, lines, pongs }).toStrictEqual({
      lagChecks: Math.floor((warmupSteps + measuredSteps) / defaultTuning.lagCheckMillis),
      lines: warmupSteps + measuredSteps,
      pongs: Math.floor((warmupSteps + measuredSteps) / 4),
    });
    expect(phase(snapshot)).toBe("session");
    expect(JSON.stringify(snapshot)).toHaveLength(sizeBefore);
    expect(growth).toBeLessThan(1.5);
  });
});
