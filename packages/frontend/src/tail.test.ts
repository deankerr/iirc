import { TailDaemon, TailLine, TailRead } from "@iirc/api";
import type { TailLevel } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { lastNumber, leastShown, linesShown, reduceTail, tailCap } from "./tail.ts";
import type { HeldTail } from "./tail.ts";

const started = 1_700_000_000_000;

/**
 * A line, by its number and level.
 * @param n - Its number.
 * @param level - Its level.
 * @returns The line.
 */
const line = (n: number, level: TailLevel = "Info") =>
  Schema.decodeSync(TailLine)({
    annotations: {},
    at: started + n,
    level,
    message: `line ${n}`,
    n,
  });

/**
 * The Tail read whole, of the Daemon that started at `at`.
 * @param lines - Its lines' numbers.
 * @param at - When its Daemon started.
 * @returns The Tail held.
 */
const read = (lines: readonly number[], at = started): HeldTail | undefined =>
  reduceTail(undefined, {
    _tag: "Read",
    read: Schema.decodeSync(TailRead)({
      lines: lines.map((n) => Schema.encodeSync(TailLine)(line(n))),
      started: at,
      version: "0.0.0",
    }),
  });

const numbers = (held: HeldTail | undefined) => held?.lines.map((one) => one.n);

describe("the Tail held", () => {
  it("takes each line past the last held, once, and lets go of the oldest past the cap", () => {
    const held = read([1, 2]);
    const again = reduceTail(held, { _tag: "Logged", line: line(2) });
    const next = reduceTail(again, { _tag: "Logged", line: line(3) });

    // One past the cap, after the two read.
    let full = held;

    for (let n = 3; n <= tailCap + 1; n += 1) {
      full = reduceTail(full, { _tag: "Logged", line: line(n) });
    }

    expect({
      again: numbers(again),
      full: [full?.lines.length, full?.lines[0]?.n, full === undefined ? 0 : lastNumber(full)],
      next: numbers(next),
    }).toStrictEqual({
      again: [1, 2],
      full: [tailCap, 2, tailCap + 1],
      next: [1, 2, 3],
    });
  });

  it("lets go of the Tail held when the stream is of a daemon that started anew, and keeps it for the same", () => {
    const held = read([1, 2]);

    const opened = (at: number) =>
      reduceTail(held, {
        _tag: "Opened",
        daemon: Schema.decodeSync(TailDaemon)({ started: at, version: "0.0.0" }),
      });

    expect({
      another: opened(started + 1),
      same: numbers(opened(started)),
    }).toStrictEqual({ another: undefined, same: [1, 2] });
  });

  it("shows the lines at the least level and above, oldest first", () => {
    const held = reduceTail(undefined, {
      _tag: "Read",
      read: Schema.decodeSync(TailRead)({
        lines: (["Debug", "Info", "Warn", "Error", "Fatal"] as const).map((level, index) =>
          Schema.encodeSync(TailLine)(line(index + 1, level))
        ),
        started,
        version: "0.0.0",
      }),
    });

    expect(
      held === undefined
        ? []
        : (["Debug", "Info", "Warn"] as const).map((least) =>
            linesShown(held, least).map((one) => one.level)
          )
    ).toStrictEqual([
      ["Debug", "Info", "Warn", "Error", "Fatal"],
      ["Info", "Warn", "Error", "Fatal"],
      ["Warn", "Error", "Fatal"],
    ]);
  });

  // Regression: a `ui.tail` value names the wrong level, so the view shows too much or too little.
  it("takes each ui.tail value as the least level it names", () => {
    expect(
      (["debug", "info", "warning", "error"] as const).map((tail) => [tail, leastShown(tail)])
    ).toStrictEqual([
      ["debug", "Debug"],
      ["info", "Info"],
      ["warning", "Warn"],
      ["error", "Error"],
    ]);
  });
});
