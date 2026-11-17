/**
 * Learning who is in a Channel. A User who was there before Self says nothing of their
 * away status or account until they act, so the Client asks once for each Channel in a
 * Session, with `WHO <channel>`, and folds each User its answer describes.
 *
 * It asks once the `366` that ends the Channel's first `NAMES` listing has come, so its
 * members are the Channel's, and a User the answer describes is one the Client keeps.
 * One query holds the slot at a time, independent of the `MODE` query. The next Channel is
 * asked when its answer ends, or when it has waited {@link whoQueryTime}, so the Owner's
 * Lines never queue behind a hundred of them, and an answer that never comes holds
 * nothing up. A Channel asked in a Session is not asked again in it, even after Self parts
 * and joins it again.
 *
 * The query waits among no other Lines, since the Runtime may send it after Lines the Owner
 * asked for later. It takes only what is its own by structure: a `354` with its own token,
 * a `352` or `315` naming a Channel whose answer has not ended, a `421` or `461` naming
 * `WHO`, and a `FAIL` of `WHO`. An error numeric that names its Channel is left to the
 * Owner's actions, Lookups, and the `MODE` query. An answer is read after its deadline,
 * until its own `315`, or the Session's end.
 *
 * With `WHOX` in ISUPPORT, it asks for the token, Channel, username, host, nick, flags,
 * account, and realname. On the floor, it reads a `352`.
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
import type { Open, Seen, WhoAsked } from "./state.ts";
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
 * The Channels asked with one more, oldest first. Past the bound, the Channel asked
 * longest ago is forgotten, and may be asked again if Self rejoins it.
 * @param open - The Connection.
 * @param key - The Channel's folded name.
 * @param asked - Its record.
 * @returns The Connection after.
 */
const withAsked = (open: Open, key: string, asked: WhoAsked): Open => {
  const next = new Map(open.whoAsked).set(key, asked);
  const [oldest] = next.keys();

  if (next.size > maxWhoAsked && oldest !== undefined) {
    next.delete(oldest);
  }

  return { ...open, whoAsked: next };
};

/**
 * Asks who is in the first Channel Self is in whose `NAMES` listing has ended and that was
 * not yet asked in this Session, unless a query holds the slot or the Configuration says
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

    // One that cannot be sent, or a Feature refused at egress, was reported, and ends as
    // asked: the next is asked.
    const sent = send(run, whox ? who(name, whoxFields) : who(name), "WHO") !== undefined;

    updateOpen(run, (each) => ({
      ...withAsked(each, key, { ended: !sent, name, replied: false }),
      whoQuery: sent
        ? { channel: name, deadline: Instant.make(run.at + whoQueryTime) }
        : each.whoQuery,
    }));

    if (sent) {
      return;
    }
  }
};

/**
 * A Channel's answer has ended: nothing more of it is read. When it described anyone, the
 * Channel is reported learned. When its query held the slot, the next Channel is asked.
 * @param run - The step.
 * @param key - The Channel's folded name.
 */
const ended = (run: Run, key: string): void => {
  const open = openOf(run.state);
  const asked = open?.whoAsked.get(key);

  if (open === undefined || asked === undefined || asked.ended) {
    return;
  }

  const holding = open.whoQuery !== undefined && folder(run.state)(open.whoQuery.channel) === key;

  updateOpen(run, (each) => ({
    ...withAsked(each, key, { ...asked, ended: true }),
    whoQuery: holding ? undefined : each.whoQuery,
  }));

  if (asked.replied && run.state.channels.get(key)?.phase._tag === "Joined") {
    run.news.push({ _tag: "ChannelLearned", channel: named(run, asked.name) });
  }

  if (holding) {
    askWho(run);
  }
};

/**
 * `315 <client> <channel>`: the answer of a Channel asked ends.
 * @param run - The step.
 * @param line - The Line, live.
 */
export const whoEnded = (run: Run, line: Line): void => {
  const [, channel] = line.params;

  if (channel !== undefined) {
    ended(run, folder(run.state)(channel));
  }
};

/**
 * Whether a numeric refuses the `WHO` command itself, a `421` or `461` that names it,
 * while a query holds the slot.
 * @param run - The step.
 * @param line - The Line, live, and tied to nothing by label.
 * @returns Whether it does.
 */
export const whoRefused = (run: Run, line: Line): boolean =>
  (line.command === "421" || line.command === "461") &&
  upperCaseAscii(line.params[1] ?? "") === "WHO" &&
  openOf(run.state)?.whoQuery !== undefined;

/**
 * Whether a standard reply names `WHO`, while a query holds the slot.
 * @param run - The step.
 * @param command - The command the reply names.
 * @returns Whether it does.
 */
export const whoNamed = (run: Run, command: string): boolean =>
  upperCaseAscii(command) === "WHO" && openOf(run.state)?.whoQuery !== undefined;

/**
 * The query holding the slot is refused: its answer ends.
 * @param run - The step.
 */
export const whoQueryOver = (run: Run): void => {
  const query = openOf(run.state)?.whoQuery;

  if (query !== undefined) {
    ended(run, folder(run.state)(query.channel));
  }
};

/**
 * The query's deadline passed: the slot is free, and the next Channel is asked. Its answer
 * is still read, until its `315`.
 * @param run - The step.
 */
export const whoQueryExpired = (run: Run): void => {
  updateOpen(run, (open) => ({ ...open, whoQuery: undefined }));
  askWho(run);
};

/**
 * Lines that never left: a `WHO` among them has no answer to read. Its Connection is
 * ending, so nothing else is asked.
 * @param run - The step.
 * @param lines - The Lines, as they were output.
 */
export const whoUnsent = (run: Run, lines: readonly OutboundLine[]): void => {
  const asked = openOf(run.state)?.whoAsked ?? new Map<string, WhoAsked>();
  const unsent = new Set(lines.flatMap((line) => (line.command === "WHO" ? [line.params[0]] : [])));

  // Each Channel waiting on its answer, matched by its name exactly as it was sent.
  for (const [key, each] of asked) {
    if (!each.ended && unsent.has(each.name)) {
      updateOpen(run, (open) => ({
        ...withAsked(open, key, { ...each, ended: true }),
        whoQuery: open.whoQuery?.channel === each.name ? undefined : open.whoQuery,
      }));
    }
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
 * Folds what one reply says of a User the Client keeps, when it names a Channel whose
 * answer has not ended. Each reply is the latest word on its User as it arrives, so it
 * undoes nothing said before it. Self is left to the Ircd's own replies to Self.
 * @param run - The step.
 * @param described - What the reply says.
 */
const describe = (run: Run, described: Described): void => {
  const key = folder(run.state)(described.channel);
  const asked = openOf(run.state)?.whoAsked.get(key);

  if (asked === undefined || asked.ended) {
    return;
  }

  if (!asked.replied) {
    updateOpen(run, (open) => withAsked(open, key, { ...asked, replied: true }));
  }

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
