/**
 * `setname`: the Ircd sends `SETNAME :<realname>` when a User who shares a Channel with
 * Self changes their realname, and the same for Self. The core reads nothing from
 * `SETNAME`, so this Feature makes it Activity. A User's realname is kept up to date, and
 * goes stale when the cap is deleted. The Owner's `Setname` is refused without it.
 *
 * @packageDocumentation
 */
import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import { wholeSource } from "./user-source.ts";

/** The `setname` Feature. */
export const setname: Feature = {
  keeps: ["user.realname"],
  meaning: (meant, arrival) => {
    const { line } = arrival;

    if (line.command !== "SETNAME") {
      return { value: meant };
    }

    const source = wholeSource(line);
    const [realname, ...more] = line.params;

    if (source === undefined || realname === undefined || realname === "" || more.length > 0) {
      return {
        value: [{ _tag: "Ignored", reason: { _tag: "Malformed", command: line.command } }],
      };
    }

    const changed: Meant = {
      _tag: "Activity",
      activity: { _tag: "RealnameChanged", nick: source.nick, realname },
      at: arrival.time,
      id: arrival.id,
      live: arrival.live,
    };

    return { value: [...meant, changed] };
  },
  name: FeatureName.make("setname"),
  needs: { caps: [CapName.make("setname")] },
  own: undefined,
};
