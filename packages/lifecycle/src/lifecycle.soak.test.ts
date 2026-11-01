import { describe, expect, it } from "vitest";

import { fold, step } from "./lifecycle.ts";
import type { NetworkEvent, NetworkInput, NetworkSnapshot } from "./lifecycle.ts";

const input: NetworkInput = {
  channels: ["#first", "#second"],
  nick: "claude",
  realname: "Claude Code",
  username: "cc",
};

const warmupSteps = 20_000;
const measuredSteps = 200_000;
const batchSteps = 1000;
const budgetMillis = 30_000;
const batches = measuredSteps / batchSteps;
const windowBatches = batches / 10;

// Half the Lines are `PING`, which takes a transition, and half are `PRIVMSG`,
// which matters to nothing. Each is a fresh object, as a real Entry would be.
const eventAt = (at: number): NetworkEvent =>
  at % 2 === 0
    ? { at, command: "PING", params: ["token"], type: "LINE" }
    : { at, command: "PRIVMSG", params: ["#first", "hello"], type: "LINE" };

const median = (values: readonly number[]) =>
  values.toSorted((one, other) => one - other)[Math.floor(values.length / 2)] ?? Number.NaN;

const stepMicros = (window: readonly number[]) => (median(window) / batchSteps) * 1000;

describe("a long chain of steps", () => {
  // Compares medians of small batches, so one garbage collection in the last window
  // cannot fail the gate, while growth, which moves every batch, still does.
  it("costs the same per step at the end as at the start", { timeout: 60_000 }, () => {
    let snapshot: NetworkSnapshot = fold(
      [
        { at: 0, type: "ATTEMPT" },
        { at: 0, type: "OPENED" },
        { at: 0, command: "001", params: ["claude", "Welcome"], type: "LINE" },
      ],
      input
    );

    const sizeBefore = JSON.stringify(snapshot).length;

    let pongs = 0;
    let at = 0;

    const advance = (steps: number) => {
      const startedAt = performance.now();

      for (let done = 0; done < steps; done += 1) {
        at += 1;
        const stepped = step(snapshot, eventAt(at));
        pongs += stepped.commands.length;
        snapshot = stepped.next;
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
      `soak: ${at} steps, ${first.toFixed(2)} µs per step at the start, ` +
        `${last.toFixed(2)} µs at the end, growth ${growth.toFixed(3)}`
    );

    expect(timings).toHaveLength(batches);
    expect(pongs).toBe(at / 2);
    expect(JSON.stringify(snapshot)).toHaveLength(sizeBefore);
    expect(growth).toBeLessThan(1.5);
  });
});
