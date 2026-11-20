/**
 * `invite-notify`: the Ircd tells the members of a Channel when a User invites another to
 * it, with the same `INVITE <nick> <channel>` it sends whoever is invited. The core reads an
 * `INVITE` that names Self, and nothing from one that names another User, so this Feature
 * makes that one Activity in the Channel's Timeline. An `INVITE` naming Self it leaves as
 * the core read it.
 *
 * @packageDocumentation
 */
import { casefold } from "@iirc/protocol/casemapping";

import type { Context, Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import { namingOf, parseChannel, parseNick } from "../names.ts";
import { wholeSource } from "./user-source.ts";

// The naming rules ISUPPORT gives now, from the tokens that make them.
const namingNow = (context: Context<undefined>) =>
  namingOf(
    new Map(
      ["CHANTYPES", "PREFIX", "STATUSMSG"].flatMap((name) => {
        const value = context.token(name);

        return value === undefined ? [] : [[name, value] as const];
      })
    )
  );

/** The `invite-notify` Feature. */
export const inviteNotify: Feature = {
  meaning: (meant, arrival, context) => {
    const { line } = arrival;
    const { self, casemapping } = context.known;
    const [named, name, ...more] = line.params;

    // Before a Session there is no Self to tell another User from, and an invitation of
    // Self is the core's.
    if (
      line.command !== "INVITE" ||
      self === undefined ||
      (named !== undefined && casefold(casemapping, named) === casefold(casemapping, self.nick))
    ) {
      return { value: meant };
    }

    const naming = namingNow(context);
    const source = wholeSource(line);
    const by = source === undefined ? undefined : parseNick(naming, source.nick);
    const nick = named === undefined ? undefined : parseNick(naming, named);
    const channel = name === undefined ? undefined : parseChannel(naming, name);

    if (by === undefined || nick === undefined || channel === undefined || more.length > 0) {
      return {
        value: [{ _tag: "Ignored", reason: { _tag: "Malformed", command: line.command } }],
      };
    }

    const invited: Meant = {
      _tag: "Activity",
      activity: { _tag: "UserInvited", by, channel, nick },
      at: arrival.time,
      id: arrival.id,
      live: arrival.live,
    };

    return { value: [invited] };
  },
  name: FeatureName.make("invite-notify"),
  needs: { caps: [CapName.make("invite-notify")] },
  own: undefined,
};
