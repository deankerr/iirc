/**
 * `cap-notify`: the Ircd says when caps are added or removed mid-Session, with `CAP NEW`
 * and `CAP DEL`. `CAP LS 302` turns it on implicitly, and asking for it as well tells an
 * Ircd that keeps to the older rules. The core reads `NEW` and `DEL` whichever way it
 * came, so this Feature has no hooks: it only asks.
 *
 * @packageDocumentation
 */
import type { Feature } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";

/** The `cap-notify` Feature. */
export const capNotify: Feature = {
  name: FeatureName.make("cap-notify"),
  needs: { caps: [CapName.make("cap-notify")] },
  own: undefined,
};
