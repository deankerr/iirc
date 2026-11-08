import { describe, expect, it } from "vitest";

import { ConnectionId, Instant, TimerId } from "./ids.ts";
import { timers } from "./output.ts";

const keepalive = TimerId.make("keepalive");
const backoff = TimerId.make("backoff");

describe("the timer table", () => {
  it("holds the last Wake for each timer", () => {
    const table = timers(new Map(), [
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
    const set = timers(new Map(), [{ _tag: "Wake", at: Instant.make(1000), timer: keepalive }]);

    const table = timers(set, [
      { _tag: "Wake", at: null, timer: keepalive },
      { _tag: "Wake", at: null, timer: backoff },
      { _tag: "Hangup", connection: ConnectionId.make(1) },
    ]);

    expect(table).toStrictEqual(new Map());
    expect(set).toStrictEqual(new Map([[keepalive, 1000]]));
  });
});
