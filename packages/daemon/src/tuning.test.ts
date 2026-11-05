import { assert, describe, it } from "@effect/vitest";
import { defaultTuning } from "@iirc/lifecycle/tuning";

import { tuningOf } from "./tuning.ts";

describe("the Tuning a Network runs with (CONF-3)", () => {
  it("is the spec's defaults when it overrides nothing", () => {
    assert.deepStrictEqual(tuningOf({}), defaultTuning);
  });

  it("is what it overrides, over the defaults", () => {
    const overrides = { floodBurst: 2, lagCheckMillis: 1000, silenceMillis: 5000 };

    assert.deepStrictEqual(tuningOf(overrides), { ...defaultTuning, ...overrides });
  });
});

describe("the spec's numbers", () => {
  it("are the defaults, each pinned where the spec gives it", () => {
    assert.deepStrictEqual(
      {
        joinRetryMillis: defaultTuning.joinRetryMillis,
        kickRejoinMillis: defaultTuning.kickRejoinMillis,
        lagCheckMillis: defaultTuning.lagCheckMillis,
        laneLimit: defaultTuning.laneLimit,
        reconnectInitialMillis: defaultTuning.reconnectInitialMillis,
        reconnectMaxMillis: defaultTuning.reconnectMaxMillis,
        silenceMillis: defaultTuning.silenceMillis,
        stableAfterMillis: defaultTuning.stableAfterMillis,
      },
      {
        // LIVE-7, LIVE-8
        joinRetryMillis: 60_000,
        kickRejoinMillis: 10_000,
        // LIVE-3
        lagCheckMillis: 60_000,
        // SEND-3
        laneLimit: 1000,
        // LIVE-4: from 5 seconds to 5 minutes, reset after 5 minutes
        reconnectInitialMillis: 5000,
        reconnectMaxMillis: 300_000,
        // LIVE-2
        silenceMillis: 90_000,
        stableAfterMillis: 300_000,
      }
    );
  });
});
