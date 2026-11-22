/**
 * Facts going stale. When the last Feature that keeps a fact turns off, the fact is
 * rewritten as stale in State at that moment, so whatever is said of it afterwards is
 * plainly fresh, whatever its instant.
 *
 * @packageDocumentation
 */
import { shares } from "./channels.ts";
import type { Kept } from "./feature.ts";
import type { Instant } from "./ids.ts";
import type { Fact } from "./known.ts";
import { changeListing } from "./members.ts";
import type { Run } from "./run.ts";
import { folder, updateOpen } from "./run.ts";
import type { Joined, Member, Seen, State } from "./state.ts";
import { mapUsers, noUsers, userIn } from "./users.ts";
import type { Users } from "./users.ts";
import { openOf, sessionOf } from "./views.ts";
import { named } from "./where.ts";

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
  listing:
    joined.listing === undefined
      ? undefined
      : changeListing(joined.listing, (members) => membersStaled(members, since)),
  members: membersStaled(joined.members, since),
});

const usersStaled = (users: Users, change: (seen: Seen) => Seen): Users => mapUsers(users, change);

// What a member's facts are, by kind alone: staling only turns a fact known, or known in
// part, stale, so a fact went stale where its kind changed. Self's are the Session's own.
const kindsOf = (state: State, key: string, member: Member): string => {
  const self = sessionOf(state);

  const seen =
    self !== undefined && folder(state)(self.nick) === key
      ? self
      : userIn(openOf(state)?.users ?? noUsers, key);

  return [
    seen?.account._tag,
    seen?.away._tag,
    seen?.bot._tag,
    seen?.mask._tag,
    seen?.realname._tag,
    member.prefixes._tag,
  ].join(" ");
};

// Each Channel Self is joined to in which some member's facts changed between two States.
const changedIn = (before: State, after: State): readonly string[] =>
  [...after.channels].flatMap(([key, { name, phase }]) => {
    const was = before.channels.get(key)?.phase;

    return phase._tag === "Joined" &&
      was?._tag === "Joined" &&
      [...phase.members].some(([nick, member]) => {
        const old = was.members.get(nick);

        return old !== undefined && kindsOf(before, nick, old) !== kindsOf(after, nick, member);
      })
      ? [name]
      : [];
  });

// Rewrites the facts no Feature keeps any longer as stale, from now.
const rewrite = (run: Run, facts: readonly Kept[]): void => {
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

      case "user.account":
      case "user.account.tagged":
      case "user.account.joined": {
        updateOpen(run, (open) => ({
          ...open,
          users: usersStaled(open.users, (seen) => ({
            ...seen,
            account: staled(seen.account, since),
          })),
        }));
        break;
      }

      case "user.realname": {
        updateOpen(run, (open) => ({
          ...open,
          users: usersStaled(open.users, (seen) => ({
            ...seen,
            realname: staled(seen.realname, since),
          })),
        }));
        break;
      }

      case "user.bot": {
        updateOpen(run, (open) => ({
          ...open,
          presence:
            open.presence._tag === "Session"
              ? { ...open.presence, bot: staled(open.presence.bot, since) }
              : open.presence,
          users: usersStaled(open.users, (seen) => ({ ...seen, bot: staled(seen.bot, since) })),
        }));
        break;
      }

      // Each fact of a User kept only because `MONITOR` says they are online.
      case "user.monitored": {
        updateOpen(run, (open) => ({
          ...open,
          users: usersStaled(open.users, (seen) =>
            shares(run.state, folder(run.state)(seen.nick))
              ? seen
              : {
                  ...seen,
                  account: staled(seen.account, since),
                  away: staled(seen.away, since),
                  bot: staled(seen.bot, since),
                  mask: staled(seen.mask, since),
                  realname: staled(seen.realname, since),
                }
          ),
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

/**
 * Rewrites the facts no Feature keeps any longer as stale, from now. No Activity says so,
 * so each Channel Self is joined to in which a member's fact went stale is reported
 * learned, once, for a Frontend to read its members again.
 * @param run - The step.
 * @param facts - The facts gone stale.
 */
export const markStale = (run: Run, facts: readonly Kept[]): void => {
  if (facts.length === 0) {
    return;
  }

  const before = run.state;

  rewrite(run, facts);

  for (const channel of changedIn(before, run.state)) {
    run.news.push({ _tag: "ChannelLearned", channel: named(run, channel) });
  }
};
