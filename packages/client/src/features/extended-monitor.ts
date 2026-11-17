/**
 * `extended-monitor`: the Ircd tells of a monitored User's away state, account, host, and
 * real name as it tells of a User who shares a Channel with Self, by `AWAY`, `ACCOUNT`,
 * `CHGHOST`, and `SETNAME`, for each of those caps that is also on. The core already reads
 * those Lines for Users it keeps, so what this Feature changes is that a monitored User
 * who is online is kept too. When the cap is deleted, what was seen of such a User goes
 * stale.
 *
 * @packageDocumentation
 */
import type { Feature } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";

/** The `extended-monitor` Feature. */
export const extendedMonitor: Feature = {
  keeps: ["user.monitored"],
  name: FeatureName.make("extended-monitor"),
  needs: { caps: [CapName.make("extended-monitor")] },
  own: undefined,
};
