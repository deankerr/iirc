/**
 * `userhost-in-names`: each name of a `NAMES` listing may be `<prefixes>nick!user@host`,
 * so every member's mask is known from the moment Self joins. The core reads such a name
 * as a nick, so this Feature gives each member their bare nick, and says their mask. A
 * name that holds a `!` or an `@` but does not split into a nick, a user, and a host adds
 * no member, and no mask. A name with neither is a plain nick, as without the cap.
 *
 * It runs after `multi-prefix`, which reads the raw names and finds each member by the
 * name the core gave it.
 *
 * @packageDocumentation
 */
import { parseSource } from "@iirc/protocol/line";

import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import type { MemberKnowledge } from "../known.ts";
import { maskOf } from "./user-source.ts";

/** A name of a listing read: the member with a bare nick, and the mask the name carried, if any. */
interface Read {
  readonly member: MemberKnowledge;
  readonly mask: { readonly user: string; readonly host: string } | undefined;
}

// A plain nick is itself. One with a `!` or an `@` is a mask or nothing: a name that does not
// split into a non-empty nick, user, and host is `undefined`, and adds no member.
const read = (member: MemberKnowledge): Read | undefined => {
  if (!member.nick.includes("!") && !member.nick.includes("@")) {
    return { mask: undefined, member };
  }

  const { nick, user, host } = parseSource(member.nick);

  const mask =
    nick === "" || user === undefined || host === undefined ? undefined : maskOf(nick, user, host);

  return mask === undefined ? undefined : { mask, member: { ...member, nick } };
};

/** The `userhost-in-names` Feature. */
export const userhostInNames: Feature = {
  meaning: (meant) => ({
    value: meant.flatMap((each): readonly Meant[] => {
      if (each._tag !== "Listed") {
        return [each];
      }

      const names = each.members.map(read).filter((name) => name !== undefined);

      const described = names.flatMap((name): readonly Meant[] =>
        name.mask === undefined
          ? []
          : [{ _tag: "Described", mask: name.mask, nick: name.member.nick }]
      );

      return [{ ...each, members: names.map((name) => name.member) }, ...described];
    }),
  }),
  name: FeatureName.make("userhost-in-names"),
  needs: { caps: [CapName.make("userhost-in-names")] },
  own: undefined,
};
