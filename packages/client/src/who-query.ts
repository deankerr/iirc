/**
 * Learning who is in a Channel. A User who was there before Self says nothing of their
 * away status or account until they act, so the Client asks once for each Channel in a
 * Session, with `WHO <channel>`, and folds each User its answer describes.
 *
 * It asks once the `366` that ends the Channel's first `NAMES` listing has come, so its
 * members are the Channel's, and a User the answer describes is one the Client keeps.
 * One query waits on a Connection at a time, independent of the `MODE` query. The next
 * Channel is asked when the last is answered, or when it has waited {@link whoQueryTime},
 * so the Owner's Lines never queue behind a hundred of them, and an answer that never
 * comes holds nothing up. A Channel asked in a Session is not asked again in it, even
 * after Self parts and joins it again.
 *
 * With `WHOX` in ISUPPORT, it asks for the token, Channel, username, host, nick, flags,
 * account, and realname, and reads only a `354` whose first field is its own token. On
 * the floor, it reads a `352`. Either is read only while the query waits and names its
 * Channel, so an answer to a query that timed out, or to the Owner's own `WHO`, changes
 * nothing. A `315` of its Channel ends it, and so do an error numeric that names its
 * Channel second, a `421` or `461` that names `WHO`, and a `FAIL` about `WHO`, whichever
 * of the Lines awaiting an answer was sent first, as for the `MODE` query.
 *
 * @packageDocumentation
 */
import { upperCaseAscii, who } from "@iirc/protocol/line";
import type { Line, OutboundLine } from "@iirc/protocol/line";

import { see } from "./channels.ts";
import { Instant } from "./ids.ts";
import type { Fact } from "./known.ts";
import type { Run } from "./run.ts";
import { folder, linkOf, send, updateOpen } from "./run.ts";
import type { Seen, WhoQuery } from "./state.ts";
import { maxWhoAsked } from "./state.ts";
import { whoQueryTime } from "./timers.ts";
import { openOf, sessionOf } from "./views.ts";
import { named } from "./where.ts";

/**
 * The Client's own WHOX token, which marks a `354` as the answer to its query. The spec
 * allows at most three digits.
 */
export const whoToken = "152";

/**
 * The WHOX fields asked for: token, Channel, username, host, nick, flags, account, and
 * realname. The reply gives them in the spec's fixed order, which is this one.
 */
const whoxFields = `%tcuhnfar,${whoToken}`;

/**
 * Asks who is in the first Channel Self is in whose `NAMES` listing has ended and that was
 * not yet asked in this Session, unless a query already waits or the Configuration says
 * not to ask.
 * @param run - The step.
 */
export const askWho = (run: Run): void => {
  const open = openOf(run.state);

  if (
    open === undefined ||
    open.whoQuery !== undefined ||
    run.state.configuration?.whoOnJoin !== true ||
    sessionOf(run.state) === undefined ||
    linkOf(run)?.closing !== undefined
  ) {
    return;
  }

  const whox = open.isupport.has("WHOX");

  for (const [key, { name, phase }] of run.state.channels) {
    if (phase._tag !== "Joined" || !phase.synced || open.whoAsked.has(key)) {
      continue;
    }

    updateOpen(run, (each) => {
      const asked = new Map(each.whoAsked).set(key, name);
      const [oldest] = asked.keys();

      // Past the bound, the Channel asked longest ago may be asked again if Self rejoins it.
      if (asked.size > maxWhoAsked && oldest !== undefined) {
        asked.delete(oldest);
      }

      return { ...each, whoAsked: asked };
    });

    // One that cannot be sent, or a Feature refused at egress, was reported: the next is asked.
    if (send(run, whox ? who(name, whoxFields) : who(name), "WHO") === undefined) {
      continue;
    }

    updateOpen(run, (each) => ({
      ...each,
      awaited: each.awaited + 1,
      whoQuery: {
        channel: name,
        deadline: Instant.make(run.at + whoQueryTime),
        order: each.awaited,
        replied: false,
      },
    }));

    return;
  }
};

/**
 * The query a Line ends, by its structure alone: a `315` of its Channel, an error numeric
 * that names its Channel second, or a `421` or `461` that names `WHO`.
 * @param run - The step.
 * @param line - The Line, live, and tied to nothing by label.
 * @returns The query, or `undefined` if it ends none.
 */
export const whoAnswered = (run: Run, line: Line): WhoQuery | undefined => {
  const query = openOf(run.state)?.whoQuery;
  const [, named] = line.params;
  const { command } = line;

  if (query === undefined || named === undefined) {
    return undefined;
  }

  if (command === "421" || command === "461") {
    return upperCaseAscii(named) === "WHO" ? query : undefined;
  }

  const fold = folder(run.state);

  return (command === "315" || /^[45]\d\d$/u.test(command)) && fold(named) === fold(query.channel)
    ? query
    : undefined;
};

/**
 * The query waiting, when a standard reply names `WHO` as the command it is about,
 * compared without regard to ASCII case.
 * @param run - The step.
 * @param command - The command the reply names.
 * @returns The query, or `undefined` for none.
 */
export const whoByCommand = (run: Run, command: string): WhoQuery | undefined =>
  upperCaseAscii(command) === "WHO" ? openOf(run.state)?.whoQuery : undefined;

/**
 * The query waiting is over, answered or not. When a reply described anyone, the Channel
 * is reported learned, and the next Channel is asked.
 * @param run - The step.
 */
export const whoQueryOver = (run: Run): void => {
  const query = openOf(run.state)?.whoQuery;

  updateOpen(run, (open) => ({ ...open, whoQuery: undefined }));

  if (
    query?.replied === true &&
    run.state.channels.get(folder(run.state)(query.channel))?.phase._tag === "Joined"
  ) {
    run.news.push({ _tag: "ChannelLearned", channel: named(run, query.channel) });
  }

  askWho(run);
};

/**
 * Lines that never left: when the query's `WHO` is among them, it awaits nothing more.
 * Its Connection is ending, so nothing else is asked.
 * @param run - The step.
 * @param lines - The Lines, as they were output.
 */
export const whoUnsent = (run: Run, lines: readonly OutboundLine[]): void => {
  const query = openOf(run.state)?.whoQuery;

  if (
    query !== undefined &&
    lines.some((line) => line.command === "WHO" && line.params[0] === query.channel)
  ) {
    updateOpen(run, (open) => ({ ...open, whoQuery: undefined }));
  }
};

/** What one reply says of a User: each fact it gave, or `undefined` for one it did not. */
interface Described {
  readonly channel: string;
  readonly nick: string;
  readonly user: string;
  readonly host: string;
  readonly flags: string;
  /** `undefined` from a plain `WHO`, which gives no account. */
  readonly account: string | null | undefined;
  readonly realname: string | undefined;
}

/**
 * Whether a User is away, by the first of their flags: `H` here, `G` gone.
 * @param flags - The flags.
 * @returns Away, or `undefined` for flags that say neither.
 */
const awayOf = (flags: string): boolean | undefined => {
  if (flags.startsWith("G")) {
    return true;
  }

  return flags.startsWith("H") ? false : undefined;
};

// WHO gives no away message, so an away User keeps the message already known, or none.
const messageOf = (was: Fact<{ readonly message: string } | null>): string => {
  if (was._tag === "Known" && was.value !== null) {
    return was.value.message;
  }

  return was._tag === "Stale" && was.was !== null ? was.was.message : "";
};

/**
 * Folds what one reply says of a User the Client keeps, while the query waits and the
 * reply names its Channel. Each reply is the latest word on its User as it arrives, so it
 * undoes nothing said before it. Self is left to the Ircd's own replies to Self.
 * @param run - The step.
 * @param described - What the reply says.
 */
const describe = (run: Run, described: Described): void => {
  const query = openOf(run.state)?.whoQuery;
  const fold = folder(run.state);

  if (query === undefined || fold(described.channel) !== fold(query.channel)) {
    return;
  }

  updateOpen(run, (open) =>
    open.whoQuery === undefined ? open : { ...open, whoQuery: { ...open.whoQuery, replied: true } }
  );

  const { account, flags, host, realname, user } = described;
  const away = awayOf(flags);

  const known = <T>(value: T): Fact<T> => ({
    _tag: "Known",
    at: run.at,
    from: "replied",
    value,
  });

  see(run, described.nick, (seen): Seen => {
    const awayNow = away === true ? { message: messageOf(seen.away) } : null;

    return {
      ...seen,
      account: account === undefined ? seen.account : known(account),
      away: away === undefined ? seen.away : known(awayNow),
      mask: known({ host, user }),
      realname: realname === undefined ? seen.realname : known(realname),
    };
  });
};

/**
 * `352 <client> <channel> <user> <host> <server> <nick> <flags> :<hopcount> <realname>`:
 * one User, from a plain `WHO`. The realname follows the hop count and its first space.
 * @param run - The step.
 * @param line - The Line, live.
 */
export const whoReply = (run: Run, line: Line): void => {
  const [, channel, user, host, , nick, flags, last] = line.params;

  if (
    channel === undefined ||
    user === undefined ||
    host === undefined ||
    nick === undefined ||
    flags === undefined
  ) {
    return;
  }

  const space = last?.indexOf(" ") ?? -1;

  describe(run, {
    account: undefined,
    channel,
    flags,
    host,
    nick,
    realname: last === undefined || space === -1 ? undefined : last.slice(space + 1),
    user,
  });
};

/**
 * `354 <client> <token> <channel> <user> <host> <nick> <flags> <account> :<realname>`:
 * one User, from the WHOX query, read only when it carries the Client's own token. An
 * account of `0` means logged out.
 * @param run - The step.
 * @param line - The Line, live.
 */
export const whoxReply = (run: Run, line: Line): void => {
  const [, token, channel, user, host, nick, flags, account, realname] = line.params;

  if (
    token !== whoToken ||
    channel === undefined ||
    user === undefined ||
    host === undefined ||
    nick === undefined ||
    flags === undefined ||
    account === undefined ||
    realname === undefined
  ) {
    return;
  }

  describe(run, {
    account: account === "0" ? null : account,
    channel,
    flags,
    host,
    nick,
    realname,
    user,
  });
};
