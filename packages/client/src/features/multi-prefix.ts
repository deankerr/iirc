/**
 * `multi-prefix`: a `NAMES` listing shows every prefix a member holds, not only the
 * highest, so the core's partial prefixes are complete. A symbol `PREFIX` does not name
 * still stands for a prefix that cannot be named, so that member's stay partial. When
 * the cap is deleted, the prefixes a listing made complete go stale.
 *
 * @packageDocumentation
 */
import { channelModesOf, defaultPrefix, prefixOf } from "@iirc/protocol/isupport";

import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import type { MemberKnowledge } from "../known.ts";
import { hasUnnamedPrefix, readListed } from "../modes.ts";
import type { ModeRules } from "../modes.ts";

const complete = (member: MemberKnowledge): MemberKnowledge =>
  member.prefixes._tag === "Partial"
    ? {
        ...member,
        prefixes: {
          _tag: "Known",
          at: member.prefixes.at,
          from: member.prefixes.from,
          value: member.prefixes.atLeast,
        },
      }
    : member;

/** The `multi-prefix` Feature. */
export const multiPrefix: Feature = {
  keeps: ["member.prefixes"],
  meaning: (meant, arrival, context) => {
    if (!meant.some((each) => each._tag === "Listed")) {
      return { value: meant };
    }

    const rules: ModeRules = {
      channel: channelModesOf(context.token("CHANMODES")),
      prefix: prefixOf(context.token("PREFIX")) ?? defaultPrefix,
    };

    const names = (arrival.line.params.at(-1) ?? "").split(" ");

    // Members whose listing shows a symbol that names no prefix stay partial.
    const unnamed = new Set(
      names.flatMap((name) => {
        const nick = hasUnnamedPrefix(name, rules)
          ? readListed(name, rules, context.at)?.nick
          : undefined;

        return nick === undefined ? [] : [nick];
      })
    );

    return {
      value: meant.map((each): Meant =>
        each._tag === "Listed"
          ? {
              ...each,
              members: each.members.map((member) =>
                unnamed.has(member.nick) ? member : complete(member)
              ),
            }
          : each
      ),
    };
  },
  name: FeatureName.make("multi-prefix"),
  needs: { caps: [CapName.make("multi-prefix")] },
  own: undefined,
};
