/**
 * `account-notify`: the Ircd sends `ACCOUNT <account>` when a User who shares a Channel
 * with Self logs in, or `ACCOUNT *` when they log out, and the same for Self. The core
 * reads nothing from `ACCOUNT`, so this Feature makes it Activity. While it is on, every
 * User's account is kept up to date, and when the cap is deleted, each goes stale.
 *
 * @packageDocumentation
 */
import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import { userSource } from "./user-source.ts";

/** The `account-notify` Feature. */
export const accountNotify: Feature = {
  keeps: ["user.account"],
  meaning: (meant, arrival) => {
    const { line } = arrival;

    if (line.command !== "ACCOUNT") {
      return { value: meant };
    }

    const source = userSource(line);
    const [account] = line.params;

    if (source === undefined || account === undefined || account === "") {
      return {
        value: [{ _tag: "Ignored", reason: { _tag: "Malformed", command: line.command } }],
      };
    }

    const changed: Meant = {
      _tag: "Activity",
      activity: {
        _tag: "AccountChanged",
        account: account === "*" ? null : account,
        nick: source.nick,
      },
      at: arrival.time,
      id: arrival.id,
      live: arrival.live,
    };

    return { value: [...meant, changed] };
  },
  name: FeatureName.make("account-notify"),
  needs: { caps: [CapName.make("account-notify")] },
  own: undefined,
};
