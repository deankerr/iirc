/**
 * `away-notify`: the Ircd sends `AWAY` when a User who shares a Channel with Self goes
 * away or comes back. The core already reads `AWAY` Lines, so what this Feature changes
 * is that away status is kept up to date: when the cap is deleted, every away fact goes
 * stale.
 *
 * @packageDocumentation
 */
import type { Feature } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";

/** The `away-notify` Feature. */
export const awayNotify: Feature = {
  keeps: ["user.away"],
  name: FeatureName.make("away-notify"),
  needs: { caps: [CapName.make("away-notify")] },
  own: undefined,
};
