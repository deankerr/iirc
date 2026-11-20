/**
 * `account-tag`: a Message or an Activity a User caused carries an `account` tag naming
 * the account they are logged in to. The Ircd leaves the tag off for one who is not, so a
 * User's Line without it says they are logged out. A tag with no value says nothing.
 *
 * @packageDocumentation
 */
import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import { afterwards, userSource } from "./user-source.ts";

/** The `account-tag` Feature. */
export const accountTag: Feature = {
  keeps: ["user.account.tagged"],
  meaning: (meant, arrival) => {
    const source = userSource(arrival.line);
    const tag = arrival.line.tags.get("account");

    // A tag that is there with no value names no account, and does not say there is none.
    if (
      source === undefined ||
      tag === "" ||
      !meant.some((each) => each._tag === "Message" || each._tag === "Activity")
    ) {
      return { value: meant };
    }

    const described: Meant = {
      _tag: "Described",
      account: tag ?? null,
      nick: afterwards(meant, source.nick),
    };

    return { value: [...meant, described] };
  },
  name: FeatureName.make("account-tag"),
  needs: { caps: [CapName.make("account-tag")] },
  own: undefined,
};
