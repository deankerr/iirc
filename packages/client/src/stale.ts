/**
 * Facts going stale. When the last Feature that keeps a fact turns off, the fact is
 * rewritten as stale in State at that moment, so whatever is said of it afterwards is
 * plainly fresh, whatever its instant.
 *
 * @packageDocumentation
 */
import type { Kept } from "./feature.ts";
import type { Instant } from "./ids.ts";
import type { Fact } from "./known.ts";
import type { Run } from "./run.ts";
import { updateOpen } from "./run.ts";
import type { Joined, Member, Seen } from "./state.ts";

/**
 * A fact as stale since an instant: what was known, or known in part, is what it was.
 * @param fact - The fact.
 * @param since - When it stopped being kept up to date.
 * @returns It, stale, or as it was if nothing was known.
 */
const staled = <T>(fact: Fact<T>, since: Instant): Fact<T> => {
  switch (fact._tag) {
    case "Known": {
      return { _tag: "Stale", since, was: fact.value };
    }

    case "Partial": {
      return { _tag: "Stale", since, was: fact.atLeast };
    }

    case "Stale":
    case "Unknown": {
      return fact;
    }

    default: {
      return fact satisfies never;
    }
  }
};

// A member whose prefixes a Feature made complete knows them no longer.
const memberStaled = (member: Member, since: Instant): Member =>
  member.complete
    ? { ...member, complete: false, prefixes: staled(member.prefixes, since) }
    : member;

const membersStaled = (
  members: ReadonlyMap<string, Member>,
  since: Instant
): ReadonlyMap<string, Member> =>
  new Map([...members].map(([key, member]) => [key, memberStaled(member, since)]));

const joinedStaled = (joined: Joined, since: Instant): Joined => ({
  ...joined,
  listing: joined.listing === undefined ? undefined : membersStaled(joined.listing, since),
  members: membersStaled(joined.members, since),
});

const usersStaled = (
  users: ReadonlyMap<string, Seen>,
  change: (seen: Seen) => Seen
): ReadonlyMap<string, Seen> => new Map([...users].map(([key, seen]) => [key, change(seen)]));

/**
 * Rewrites the facts no Feature keeps any longer as stale, from now.
 * @param run - The step.
 * @param facts - The facts gone stale.
 */
export const markStale = (run: Run, facts: readonly Kept[]): void => {
  const since = run.at;

  for (const fact of facts) {
    switch (fact) {
      case "user.away": {
        updateOpen(run, (open) => ({
          ...open,
          users: usersStaled(open.users, (seen) => ({ ...seen, away: staled(seen.away, since) })),
        }));
        break;
      }

      case "user.mask": {
        updateOpen(run, (open) => ({
          ...open,
          presence:
            open.presence._tag === "Session"
              ? { ...open.presence, mask: staled(open.presence.mask, since) }
              : open.presence,
          users: usersStaled(open.users, (seen) => ({ ...seen, mask: staled(seen.mask, since) })),
        }));
        break;
      }

      case "user.account": {
        updateOpen(run, (open) => ({
          ...open,
          presence: { ...open.presence, account: staled(open.presence.account, since) },
        }));
        break;
      }

      case "user.realname": {
        updateOpen(run, (open) => ({
          ...open,
          presence:
            open.presence._tag === "Session"
              ? { ...open.presence, realname: staled(open.presence.realname, since) }
              : open.presence,
        }));
        break;
      }

      case "member.prefixes": {
        run.state = {
          ...run.state,
          channels: new Map(
            [...run.state.channels].map(([key, channel]) => [
              key,
              channel.phase._tag === "Joined"
                ? { ...channel, phase: joinedStaled(channel.phase, since) }
                : channel,
            ])
          ),
        };
        break;
      }

      default: {
        fact satisfies never;
      }
    }
  }
};
