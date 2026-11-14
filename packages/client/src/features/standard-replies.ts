/**
 * `standard-replies`: the Ircd may send any well-formed `FAIL`, `WARN`, or `NOTE`, not
 * only those a specification enables, and asking for it tells it we read them all. The
 * core reads every standard reply whichever way it came, so this Feature has no hooks:
 * it only asks.
 *
 * @packageDocumentation
 */
import type { Feature } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";

/** The `standard-replies` Feature. */
export const standardReplies: Feature = {
  name: FeatureName.make("standard-replies"),
  needs: { caps: [CapName.make("standard-replies")] },
  own: undefined,
};
