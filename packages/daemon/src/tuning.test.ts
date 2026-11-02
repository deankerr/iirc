import { assert, describe, it } from "@effect/vitest";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { Exit, Schema } from "effect";

import { tuningOf, TuningOverrides } from "./tuning.ts";

const parse = Schema.decodeUnknownExit(TuningOverrides);

// JSON, because that is what the Owner sends, and what the Log stores.
const refusal = (json: string) => {
  const parsed = parse(JSON.parse(json));

  return Exit.isFailure(parsed) ? String(parsed.cause) : undefined;
};

describe("a Network's Tuning overrides (CONF-3)", () => {
  it("leaves the spec's defaults alone when given nothing", () => {
    assert.deepStrictEqual(parse({}), Exit.succeed({}));
    assert.deepStrictEqual(tuningOf({}), defaultTuning);
  });

  it("keeps only what it is given, over the defaults", () => {
    const overrides = { floodBurst: 2, lagCheckMillis: 1000, silenceMillis: 5000 };

    assert.deepStrictEqual(parse(overrides), Exit.succeed(overrides));
    assert.deepStrictEqual(tuningOf(overrides), { ...defaultTuning, ...overrides });
  });

  it("names a key that is not a Tuning number", () => {
    assert.include(refusal('{"silenceMilis":5000}'), "not a Tuning key: silenceMilis");
  });

  it("refuses anything that is not a whole number in range, and says where", () => {
    assert.include(refusal('{"silenceMillis":-1}'), "silenceMillis");
    assert.include(refusal('{"silenceMillis":0}'), "silenceMillis");
    assert.include(refusal('{"silenceMillis":1.5}'), "silenceMillis");
    assert.include(refusal('{"silenceMillis":"soon"}'), "silenceMillis");
    assert.include(refusal('{"refusalBackoffMillis":2147483648}'), "refusalBackoffMillis");
  });

  it("allows 0 only where nothing is paced by it", () => {
    assert.isUndefined(refusal('{"drainMillis":0}'));
    assert.isDefined(refusal('{"floodIntervalMillis":0}'));
    assert.isDefined(refusal('{"reconnectInitialMillis":0}'));
  });

  it("LIVE-9: refuses a QUIT wait of 0, which would drop the QUIT", () => {
    assert.include(refusal('{"quitWaitMillis":0}'), "quitWaitMillis");
    assert.isUndefined(refusal('{"quitWaitMillis":1}'));
  });

  it("RUN-3: refuses a QUIT wait past 10 seconds, so that a stop stays prompt", () => {
    assert.isUndefined(refusal('{"quitWaitMillis":10000}'));
    assert.include(refusal('{"quitWaitMillis":10001}'), "quitWaitMillis");
  });

  it("names a key the prototype has, which is still not a Tuning number", () => {
    assert.include(refusal('{"toString":5}'), "not a Tuning key: toString");
    assert.include(refusal('{"constructor":5}'), "not a Tuning key: constructor");
    assert.include(refusal('{"hasOwnProperty":5}'), "not a Tuning key: hasOwnProperty");
  });

  it("LIVE-2: refuses a silence no longer than the lag check that keeps an Ircd talking", () => {
    assert.include(
      refusal('{"silenceMillis":60000}'),
      "silenceMillis must be above lagCheckMillis"
    );
    assert.isDefined(refusal('{"lagCheckMillis":5000,"silenceMillis":4000}'));
    assert.isUndefined(refusal('{"lagCheckMillis":5000,"silenceMillis":5001}'));
  });

  it("LIVE-3: keeps lag checks at least 100 ms apart, past flood control as they are", () => {
    assert.include(refusal('{"lagCheckMillis":99}'), "lagCheckMillis");
    assert.isUndefined(refusal('{"lagCheckMillis":100}'));
  });

  it("refuses a first delay above the longest, against the defaults too", () => {
    assert.isDefined(refusal('{"reconnectInitialMillis":300001}'));
    assert.isDefined(refusal('{"reconnectMaxMillis":4999}'));
    assert.isUndefined(refusal('{"reconnectInitialMillis":1,"reconnectMaxMillis":1}'));
  });

  it("refuses what is not an object", () => {
    assert.isDefined(refusal('"silenceMillis=5"'));
    assert.isDefined(refusal("[]"));
    assert.isDefined(refusal("5"));
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
        refusalBackoffMillis: defaultTuning.refusalBackoffMillis,
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
        // LIVE-5
        refusalBackoffMillis: 1_800_000,
        // LIVE-2
        silenceMillis: 90_000,
        stableAfterMillis: 300_000,
      }
    );
  });
});
