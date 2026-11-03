import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning } from "@iirc/lifecycle/tuning";

/**
 * The whole Tuning a Network runs with: the spec's defaults, under what it overrides
 * (CONF-3). The API's `TuningSettings` held the overrides to its rules when they were
 * accepted, and they are run as recorded whatever those rules are now.
 * @param overrides - What the Owner changed.
 * @returns Every number.
 */
export const tuningOf = (overrides: Partial<Tuning>): Tuning => ({
  ...defaultTuning,
  ...overrides,
});
