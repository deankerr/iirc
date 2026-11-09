import { describe, expect, it } from "vitest";

import { ConnectionId, Instant, TimerId } from "./ids.ts";
import type { Input } from "./input.ts";
import { timers } from "./output.ts";
import type { TimerTable } from "./output.ts";

const keepalive = TimerId.make("keepalive");
const backoff = TimerId.make("backoff");
const at = Instant.make(0);
const retry: Input = { _tag: "Retry", at };

const fired = (timer: TimerId, due: number): Input => ({
  _tag: "Fired",
  at: Instant.make(due),
  due: Instant.make(due),
  timer,
});

const set: TimerTable = new Map([
  [keepalive, Instant.make(1000)],
  [backoff, Instant.make(5000)],
]);

describe("the timer table", () => {
  it("holds the last Wake for each timer", () => {
    const table = timers(new Map(), retry, [
      { _tag: "Wake", at: Instant.make(1000), timer: keepalive },
      { _tag: "Wake", at: Instant.make(5000), timer: backoff },
      { _tag: "Wake", at: Instant.make(2000), timer: keepalive },
    ]);

    expect(table).toStrictEqual(
      new Map([
        [keepalive, 2000],
        [backoff, 5000],
      ])
    );
  });

  it("forgets a timer woken with null, and ignores other outputs", () => {
    const table = timers(set, retry, [
      { _tag: "Wake", at: null, timer: keepalive },
      { _tag: "Wake", at: null, timer: backoff },
      { _tag: "Hangup", connection: ConnectionId.make(1) },
    ]);

    expect(table).toStrictEqual(new Map());
    expect(set.size).toBe(2);
  });

  it("drops a timer once a Fired with its due is stepped", () => {
    expect(timers(set, fired(keepalive, 1000), [])).toStrictEqual(new Map([[backoff, 5000]]));
  });

  it("keeps a timer that the step that fired it sets again", () => {
    expect(
      timers(set, fired(keepalive, 1000), [
        { _tag: "Wake", at: Instant.make(61_000), timer: keepalive },
      ])
    ).toStrictEqual(
      new Map([
        [keepalive, 61_000],
        [backoff, 5000],
      ])
    );
  });

  it("keeps a timer whose Fired is stale", () => {
    expect(timers(set, fired(keepalive, 500), [])).toStrictEqual(set);
  });
});
