/**
 * `extended-join`: a `JOIN` also says the account of whoever joined, or `*` for none, and
 * their realname: `JOIN #chan account :Real Name`. The core reads the join as it reads
 * any, and this Feature adds what the Line said of the User.
 *
 * @packageDocumentation
 */
import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import { userSource } from "./user-source.ts";

/** The `extended-join` Feature. */
export const extendedJoin: Feature = {
  keeps: ["user.account.joined", "user.realname"],
  meaning: (meant, arrival) => {
    const { line } = arrival;
    const source = userSource(line);
    const [, account, realname] = line.params;

    // A `JOIN` that holds no account and realname is the plain form, and says nothing more.
    if (
      line.command !== "JOIN" ||
      source === undefined ||
      account === undefined ||
      account === "" ||
      realname === undefined ||
      !meant.some((each) => each._tag === "Activity" && each.activity._tag === "Joined")
    ) {
      return { value: meant };
    }

    const described: Meant = {
      _tag: "Described",
      account: account === "*" ? null : account,
      nick: source.nick,
      realname,
    };

    return { value: [...meant, described] };
  },
  name: FeatureName.make("extended-join"),
  needs: { caps: [CapName.make("extended-join")] },
  own: undefined,
};
