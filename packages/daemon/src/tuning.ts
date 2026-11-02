import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { Result, Schema, SchemaGetter, Struct } from "effect";

// What a timer can wait for: past this, one fires at once, so a mistyped refusal wait
// would turn into a redial loop.
const longestWait = 2_147_483_647;

const atLeast = (minimum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum: longestWait, minimum }));

// LIVE-3: a lag check bypasses flood control, so a tiny interval would flood the Ircd.
const shortestLagCheck = 100;

// Every host waits this long at most for its `QUIT` when it stops, and the Daemon stops them
// all at once, so this bounds how long a stop takes whatever the Owner tuned (RUN-3). It is
// well inside the 90 seconds a service manager gives a stop by default.
const longestQuitWait = 10_000;

// One entry for every key of `Tuning`, so a new number cannot go without a rule. A wait
// that gives something time to happen can be 0, and one that paces anything cannot. A
// `QUIT` wait of 0 drops the `QUIT` itself (LIVE-9).
const rules = {
  burstMillis: atLeast(0),
  connectTimeoutMillis: atLeast(1),
  controlLaneLimit: atLeast(1),
  drainMillis: atLeast(0),
  firstContactNickLimit: atLeast(1),
  floodBurst: atLeast(1),
  floodIntervalMillis: atLeast(1),
  joinRetryMillis: atLeast(1),
  kickRejoinMillis: atLeast(0),
  lagCheckMillis: atLeast(shortestLagCheck),
  laneLimit: atLeast(1),
  loginWaitMillis: atLeast(0),
  quitWaitMillis: Schema.Int.check(Schema.isBetween({ maximum: longestQuitWait, minimum: 1 })),
  reconnectInitialMillis: atLeast(1),
  reconnectMaxMillis: atLeast(1),
  refusalBackoffMillis: atLeast(1),
  registrationTimeoutMillis: atLeast(1),
  rejoinSettleMillis: atLeast(0),
  sendWaitMillis: atLeast(0),
  silenceMillis: atLeast(1),
  stableAfterMillis: atLeast(0),
  writeTimeoutMillis: atLeast(1),
} satisfies Record<keyof Tuning, Schema.Top>;

// A Struct drops a key it does not know, which would make a misspelt one do nothing. Only
// the record's own keys count, or `toString` and `constructor` would pass for Tuning.
const KnownKeys = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter((overrides) => {
    const unknown = Object.keys(overrides).filter((key) => !Object.hasOwn(rules, key));

    return unknown.length === 0 || `not a Tuning key: ${unknown.join(", ")}`;
  })
);

const Overrides = KnownKeys.pipe(
  Schema.decodeTo(Schema.Struct(rules).mapFields(Struct.map(Schema.optionalKey)), {
    decode: SchemaGetter.passthrough({ strict: false }),
    encode: SchemaGetter.passthrough({ strict: false }),
  })
);

// Each number is fine alone and wrong beside another. A silence no longer than the lag
// check kills a quiet Ircd every Session, because the check is what makes it speak (LIVE-2).
const Tuned = Schema.Struct(rules).check(
  Schema.makeFilter(
    ({ reconnectInitialMillis, reconnectMaxMillis }) =>
      reconnectInitialMillis <= reconnectMaxMillis ||
      "reconnectInitialMillis must not be above reconnectMaxMillis"
  ),
  Schema.makeFilter(
    ({ lagCheckMillis, silenceMillis }) =>
      silenceMillis > lagCheckMillis || "silenceMillis must be above lagCheckMillis"
  )
);

const decodeTuned = Schema.decodeUnknownResult(Tuned);

/**
 * The Tuning numbers one Network overrides, by name (CONF-3). A name that is not one, a
 * value out of bounds, or a value that clashes with the spec's defaults or another
 * override fails to decode, saying which.
 */
export const TuningOverrides = Overrides.check(
  Schema.makeFilter((overrides) =>
    Result.match(decodeTuned({ ...defaultTuning, ...overrides }), {
      onFailure: ({ issue }) => issue,
      onSuccess: () => true,
    })
  )
);

/**
 * The whole Tuning a Network runs with: the spec's defaults, under what it overrides.
 * @param overrides - What the Owner changed, which {@link TuningOverrides} has checked.
 * @returns Every number.
 */
export const tuningOf = (overrides: Partial<Tuning>): Tuning => ({
  ...defaultTuning,
  ...overrides,
});
