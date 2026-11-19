/**
 * `chghost`: the Ircd sends `CHGHOST <user> <host>` when a User who shares a Channel with
 * Self changes their user or host, and the same for Self, with no `QUIT` or `JOIN` to
 * fake it. The core reads nothing from `CHGHOST`, so this Feature makes it Activity, and
 * a User's mask is kept up to date: the Line's source is the mask they had, and its
 * parameters the one they have. When the cap is deleted, each mask goes stale.
 *
 * @packageDocumentation
 */
import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import { maskOf, userSource } from "./user-source.ts";

/** The `chghost` Feature. */
export const chghost: Feature = {
  keeps: ["user.mask"],
  meaning: (meant, arrival) => {
    const { line } = arrival;

    if (line.command !== "CHGHOST") {
      return { value: meant };
    }

    const source = userSource(line);
    const [user, host, ...more] = line.params;

    const mask =
      source === undefined || user === undefined || host === undefined || more.length > 0
        ? undefined
        : maskOf(source.nick, user, host);

    if (source === undefined || mask === undefined) {
      return {
        value: [{ _tag: "Ignored", reason: { _tag: "Malformed", command: line.command } }],
      };
    }

    const changed: Meant = {
      _tag: "Activity",
      activity: { _tag: "HostChanged", host: mask.host, nick: source.nick, user: mask.user },
      at: arrival.time,
      id: arrival.id,
      live: arrival.live,
    };

    return { value: [...meant, changed] };
  },
  name: FeatureName.make("chghost"),
  needs: { caps: [CapName.make("chghost")] },
  own: undefined,
};
