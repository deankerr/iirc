/**
 * `MONITOR`: where an Ircd offers it in ISUPPORT, the Client monitors the nick Self wants
 * back and each open Direct Message partner, and is told when their holders come and go.
 *
 * The list is derived, never kept: the nick Self wants back first, then the partners,
 * most recently messaged first, cut to `MONITOR`'s limit, less what a `734` refused on
 * this Connection. The Connection keeps only what it sent, so after a step that may change
 * the list, the difference is sent: `MONITOR -`, then `MONITOR +`. Each Session starts
 * with nothing sent, so the whole list goes out as the `005` that offers `MONITOR` comes.
 *
 * The partners are folded from the Client's own News, as a projection folds Timelines.
 *
 * @packageDocumentation
 */
import { casefold } from "@iirc/protocol/casemapping";
import { targetLimitsOf } from "@iirc/protocol/isupport";
import {
  isRejected,
  monitor,
  nick as nickLine,
  parseSource,
  upperCaseAscii,
} from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import { online } from "./acts.ts";
import { pruneUsers, see } from "./channels.ts";
import type { Arrival } from "./feature.ts";
import type { Fact } from "./known.ts";
import type { Activity, Closable, News, Where } from "./news.ts";
import { reclaim, wantedBack } from "./reclaim.ts";
import type { Run } from "./run.ts";
import { folder, ignore, send, updateOpen } from "./run.ts";
import type { Monitoring, State, Watched } from "./state.ts";
import { maxPartners, unmonitored } from "./state.ts";
import { openOf, partnerHere, sessionOf } from "./views.ts";
import { named, routeActivity } from "./where.ts";

// Partners

// A partner is moved to most recent, or added, by a Message in their Timeline.
const messaged = (partners: Map<string, string>, key: string, name: string): void => {
  partners.delete(key);
  partners.set(key, name);
};

// Each key mapped by `change`, in order, where the first of any that meet is kept.
const rekeyed = (
  partners: ReadonlyMap<string, string>,
  change: (key: string, name: string) => readonly [string, string]
): Map<string, string> => {
  const next = new Map<string, string>();

  for (const [key, name] of partners) {
    const [to, as] = change(key, name);

    if (!next.has(to)) {
      next.set(to, as);
    }
  }

  return next;
};

// A Message that opens a partner's Timeline adds them, or makes them most recent.
const afterMessage = (
  partners: ReadonlyMap<string, string>,
  where: readonly Where[]
): Map<string, string> | undefined => {
  const opened = where.flatMap((each) => (each._tag === "Direct" && !each.existing ? [each] : []));

  if (opened.length === 0) {
    return undefined;
  }

  const next = new Map(partners);

  for (const { key, name } of opened) {
    messaged(next, key, name);
  }

  return next;
};

// A live rename moves a partner's Timeline to their new nick, where it keeps its place.
// As in the projection, a partner already keyed by the new nick is detached, and the one
// who renamed takes the key.
const afterRename = (
  partners: ReadonlyMap<string, string>,
  where: readonly Where[]
): Map<string, string> | undefined => {
  let next: Map<string, string> | undefined;

  for (const each of where) {
    const from = next ?? partners;

    if (each._tag === "DirectRenamed" && from.has(each.key)) {
      const detached = new Map(from);

      if (each.to.key !== each.key) {
        detached.delete(each.to.key);
      }

      next = rekeyed(detached, (key, name) =>
        key === each.key ? [each.to.key, each.to.name] : [key, name]
      );
    }
  }

  return next;
};

// Closing a partner's Timeline removes them.
const afterClose = (
  partners: ReadonlyMap<string, string>,
  where: Closable
): Map<string, string> | undefined => {
  if (where._tag !== "Direct" || !partners.has(where.key)) {
    return undefined;
  }

  const next = new Map(partners);

  next.delete(where.key);

  return next;
};

// One News folded into the partners, as a projection folds it into Timelines, or
// `undefined` when it changes none of them.
const partnersAfter = (
  partners: ReadonlyMap<string, string>,
  news: News
): Map<string, string> | undefined => {
  if (news._tag === "Message") {
    return afterMessage(partners, news.where);
  }

  if (news._tag === "Activity") {
    return afterRename(partners, news.where);
  }

  if (news._tag === "TimelineClosed") {
    return afterClose(partners, news.where);
  }

  if (news._tag === "Refolded") {
    return rekeyed(partners, (_key, name) => [casefold(news.casemapping, name), name]);
  }

  return news._tag === "NetworkRemoved" ? new Map() : undefined;
};

/**
 * Folds the step's News into the open Direct Message partners: a Message that opens a
 * partner's Timeline adds them or makes them most recent, a rename moves them, closing
 * their Timeline removes them, a new casemapping folds their keys again, and removing
 * the Network clears them. Past the bound, the least recently messaged are dropped.
 * @param run - The step, with its News gathered.
 */
const followPartners = (run: Run): void => {
  let partners: ReadonlyMap<string, string> = run.state.partners;

  for (const news of run.news) {
    partners = partnersAfter(partners, news) ?? partners;
  }

  if (partners === run.state.partners) {
    return;
  }

  const kept = [...partners].slice(-maxPartners);

  run.state = {
    ...run.state,
    partners: kept.length === partners.size ? partners : new Map(kept),
  };
};

// The list

// `MONITOR`'s limit, or `undefined` for none: the token with no value has none.
const limitOf = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d{1,9}$/u.test(value) ? Number(value) : undefined;

/**
 * The nicks to monitor now, by folded nick, in the stated order: the nick Self wants
 * back, then the partners, most recently messaged first, cut to `MONITOR`'s limit, less
 * those a `734` refused on this Connection. Self, and a name that is no nick, are left out.
 * @param state - The State.
 * @param refused - What a `734` refused on this Connection.
 * @param limit - `MONITOR`'s limit, or `undefined` for none.
 * @returns The nicks, as sent, by folded nick.
 */
const listOf = (
  state: State,
  refused: ReadonlySet<string>,
  limit: number | undefined
): ReadonlyMap<string, string> => {
  const fold = folder(state);
  const self = sessionOf(state)?.nick;
  const back = wantedBack(state);
  const list = new Map<string, string>();

  const nicks = [
    ...(back === undefined ? [] : [back]),
    ...[...state.partners.values()].toReversed(),
  ];

  for (const nick of nicks) {
    const key = fold(nick);

    if (list.size >= (limit ?? Infinity)) {
      break;
    }

    if (
      !list.has(key) &&
      key !== (self === undefined ? undefined : fold(self)) &&
      !isRejected(nickLine(nick))
    ) {
      list.set(key, nick);
    }
  }

  return new Map([...list].filter(([key]) => !refused.has(key)));
};

// Sends the nicks with one modifier, as few to a Line as fit, and no more than `TARGMAX` says.
const sendAll = (
  run: Run,
  modifier: "+" | "-",
  nicks: readonly string[],
  most: number | undefined
): void => {
  let line: readonly string[] = [];

  const flush = () => {
    if (line.length > 0) {
      send(run, monitor(modifier, line), "MONITOR");
    }
  };

  for (const nick of nicks) {
    const longer = [...line, nick];
    const built = monitor(modifier, longer);

    const full =
      longer.length > (most ?? Infinity) || (isRejected(built) && built.reason === "TooLong");

    if (full && line.length > 0) {
      flush();
      line = [nick];
    } else {
      line = longer;
    }
  }

  flush();
};

const changeMonitoring = (run: Run, change: (monitoring: Monitoring) => Monitoring): void => {
  updateOpen(run, (open) => ({ ...open, monitoring: change(open.monitoring) }));
};

// Folds what was sent and refused by the Connection's casemapping again, keeping the first.
const refolded = (run: Run): void => {
  const fold = folder(run.state);

  changeMonitoring(run, (monitoring) => {
    const watched = new Map<string, Watched>();

    for (const each of monitoring.watched.values()) {
      if (!watched.has(fold(each.nick))) {
        watched.set(fold(each.nick), each);
      }
    }

    return { ...monitoring, refused: new Set([...monitoring.refused].map(fold)), watched };
  });
};

// Sends the difference between what is wanted and what was sent.
const reconcile = (run: Run): void => {
  const open = openOf(run.state);

  if (open === undefined || !online(run) || open.monitoring.off || !open.isupport.has("MONITOR")) {
    return;
  }

  const { refused, watched } = open.monitoring;
  const wanted = listOf(run.state, refused, limitOf(open.isupport.get("MONITOR")));
  const most = targetLimitsOf(open.isupport.get("TARGMAX")).get("MONITOR");
  const dropped = [...watched].filter(([key]) => !wanted.has(key));
  const added = [...wanted].filter(([key]) => !watched.has(key));

  if (dropped.length === 0 && added.length === 0) {
    return;
  }

  sendAll(
    run,
    "-",
    dropped.map(([, each]) => each.nick),
    most
  );
  sendAll(
    run,
    "+",
    added.map(([, nick]) => nick),
    most
  );

  const next = new Map(watched);

  for (const [key] of dropped) {
    next.delete(key);
  }

  for (const [key, nick] of added) {
    next.set(key, { here: { _tag: "Unknown" }, nick });
  }

  changeMonitoring(run, (monitoring) => ({ ...monitoring, watched: next }));
  pruneUsers(
    run,
    dropped.map(([key]) => key)
  );
};

// Whether a step may have changed the list: the partners, Self's nick or the Owner's
// choice of it, the Configuration, ISUPPORT, the casemapping, what was refused, or the
// Connection or Session itself. Each is compared by reference, so this costs nothing.
// Whether the Session, or Self's nick or what Self may take back in it, changed.
const sessionChanged = (before: State, after: State): boolean => {
  const wasSession = sessionOf(before);
  const nowSession = sessionOf(after);

  return (
    wasSession?.nick !== nowSession?.nick ||
    wasSession?.chosen !== nowSession?.chosen ||
    wasSession?.yielded !== nowSession?.yielded ||
    (wasSession === undefined) !== (nowSession === undefined)
  );
};

const mayChange = (before: State, after: State): boolean => {
  const was = openOf(before);
  const now = openOf(after);

  return (
    sessionChanged(before, after) ||
    before.partners !== after.partners ||
    before.configuration !== after.configuration ||
    before.casemapping !== after.casemapping ||
    was?.isupport !== now?.isupport ||
    was?.monitoring.refused !== now?.monitoring.refused ||
    was?.monitoring.off !== now?.monitoring.off
  );
};

// Whether two facts of whether a partner is here say the same, the time they were known aside.
const sameHere = (left: Fact<boolean>, right: Fact<boolean>): boolean =>
  left._tag === right._tag &&
  (left._tag !== "Known" || (right._tag === "Known" && left.value === right.value));

// The nicks an Activity names whose membership it may change.
const membersNamed = (activity: Activity): readonly string[] => {
  if (activity._tag === "NickChanged") {
    return [activity.from, activity.to];
  }

  return activity._tag === "Joined" ||
    activity._tag === "Parted" ||
    activity._tag === "Kicked" ||
    activity._tag === "Quit"
    ? [activity.nick]
    : [];
};

// The nicks whose `MONITOR` entry the step changed, added, or took off.
const watchedChanged = (run: Run): readonly string[] => {
  const was = openOf(run.before)?.monitoring.watched ?? new Map<string, Watched>();
  const now = openOf(run.state)?.monitoring.watched ?? new Map<string, Watched>();

  if (was === now) {
    return [];
  }

  return [
    ...[...now].flatMap(([key, watched]) => (was.get(key) === watched ? [] : [watched.nick])),
    ...[...was].flatMap(([key, watched]) => (now.has(key) ? [] : [watched.nick])),
  ];
};

/**
 * The partners whose presence the step may have changed, by key, or `undefined` for
 * every one: when the Session came or went, the casemapping changed, a Channel's members
 * were replaced, or Self joined or left a Channel. Otherwise only the nicks the step's
 * Activities named, and those whose `MONITOR` entry changed, so a step costs what its
 * Line touches.
 * @param run - The step, with its partners followed.
 * @returns The keys, or `undefined` for all.
 */
const touchedPartners = (run: Run): ReadonlySet<string> | undefined => {
  const { before, state } = run;

  if (
    (sessionOf(before) === undefined) !== (sessionOf(state) === undefined) ||
    before.casemapping !== state.casemapping ||
    before.declared !== state.declared
  ) {
    return undefined;
  }

  if (
    before.channels === state.channels &&
    openOf(before)?.monitoring.watched === openOf(state)?.monitoring.watched
  ) {
    return new Set();
  }

  const fold = folder(state);

  const selves = new Set(
    [sessionOf(before)?.nick, sessionOf(state)?.nick].flatMap((nick) =>
      nick === undefined ? [] : [fold(nick)]
    )
  );

  const nicks = [...watchedChanged(run)];

  for (const news of run.news) {
    if (news._tag === "ChannelLearned") {
      return undefined;
    }

    if (news._tag === "Activity") {
      const members = membersNamed(news.activity);

      if (news.activity._tag !== "NickChanged" && members.some((nick) => selves.has(fold(nick)))) {
        return undefined;
      }

      nicks.push(...members);
    }
  }

  return new Set(nicks.map((nick) => named(run, nick).key));
};

/**
 * Tells of each partner who was one before the step and whether they are here changed in
 * it, unless the step's News already says so in their Timeline: an Activity there. Nothing
 * else tells a Frontend, as the first status `MONITOR` gives is learned silently. Only the
 * partners the step may have touched are compared.
 * @param run - The step, with its partners followed.
 */
const partnersLearned = (run: Run): void => {
  if (run.before.partners.size === 0 || run.state.partners.size === 0) {
    return;
  }

  const touched = touchedPartners(run);

  if (touched?.size === 0) {
    return;
  }

  const reported = new Set(
    run.news.flatMap((one) =>
      one._tag === "Activity"
        ? one.where.flatMap((where) => (where._tag === "Direct" ? [where.key] : []))
        : []
    )
  );

  const keys = touched ?? new Set(run.state.partners.keys());
  const foldBefore = folder(run.before);
  const foldNow = folder(run.state);

  for (const key of keys) {
    const was = run.before.partners.get(key);
    const nick = run.state.partners.get(key);

    if (
      was !== undefined &&
      nick !== undefined &&
      !reported.has(key) &&
      !sameHere(partnerHere(run.before, foldBefore, was), partnerHere(run.state, foldNow, nick))
    ) {
      run.news.push({ _tag: "PartnerLearned", partner: { key, name: nick } });
    }
  }
};

/**
 * After a step, follows the partners from its News, tells of those whose presence changed
 * with nothing else saying so, and when the list may have changed, sends the difference.
 * Without `MONITOR` in ISUPPORT, nothing is sent.
 * @param run - The step, with its News gathered.
 */
export const monitorAfter = (run: Run): void => {
  followPartners(run);
  partnersLearned(run);

  if (!mayChange(run.before, run.state)) {
    return;
  }

  if (run.before.casemapping !== run.state.casemapping) {
    refolded(run);
  }

  reconcile(run);
};

// What the Ircd tells

/** The numerics that tell of the monitor list: `730` online, `731` offline, and `734` full. */
const replies: ReadonlySet<string> = new Set(["730", "731", "734"]);

/**
 * Whether a command is a numeric that tells of the monitor list, which answers no Lookup
 * or action, whatever nick it names.
 * @param command - The command.
 * @returns Whether it is.
 */
export const isMonitorReply = (command: string): boolean => replies.has(command);

const targetsOf = (list: string): readonly string[] =>
  list.split(",").filter((target) => target !== "");

// A partner came or went, told in their Timeline, at the time of the Line that said so.
const told = (run: Run, arrival: Arrival, nick: string, here: boolean): void => {
  if (!run.state.partners.has(named(run, nick).key)) {
    return;
  }

  run.news.push(
    routeActivity(run, {
      _tag: "Activity",
      activity: { _tag: here ? "CameOnline" : "WentOffline", nick },
      at: arrival.time,
      id: { _tag: "Unknown" },
      live: true,
    })
  );
};

const watchedOf = (run: Run, nick: string): readonly [string, Watched] | undefined => {
  const key = folder(run.state)(nick);
  const watched = openOf(run.state)?.monitoring.watched.get(key);

  return watched === undefined ? undefined : [key, watched];
};

const setHere = (run: Run, key: string, watched: Watched, here: boolean): void => {
  changeMonitoring(run, (monitoring) => ({
    ...monitoring,
    watched: new Map(monitoring.watched).set(key, {
      ...watched,
      here: { _tag: "Known", at: run.at, from: "ircd", value: here },
    }),
  }));
};

const isOffline = (watched: Watched): boolean =>
  watched.here._tag === "Known" && !watched.here.value;

// `730`: a monitored nick is online, with its mask when the Ircd gives one.
const cameOnline = (run: Run, arrival: Arrival, target: string): void => {
  const source = parseSource(target);
  const found = watchedOf(run, source.nick);

  if (found === undefined) {
    return;
  }

  const [key, watched] = found;

  setHere(run, key, watched, true);

  if (isOffline(watched)) {
    told(run, arrival, source.nick, true);
  }

  const { user, host } = source;

  if (user !== undefined && host !== undefined) {
    see(run, source.nick, (seen) => ({
      ...seen,
      mask: { _tag: "Known", at: run.at, from: "ircd", value: { host, user } },
    }));
  }
};

// `731`: a monitored nick is offline. The first time the Connection hears so, or a change
// from online, frees it, so Self asks for it when it is the nick Self wants back.
const wentOffline = (run: Run, arrival: Arrival, target: string): void => {
  const { nick } = parseSource(target);
  const found = watchedOf(run, nick);

  if (found === undefined) {
    return;
  }

  const [key, watched] = found;

  if (isOffline(watched)) {
    return;
  }

  setHere(run, key, watched, false);

  if (watched.here._tag === "Known") {
    told(run, arrival, nick, false);
  }

  pruneUsers(run, [key]);
  reclaim(run, nick);
};

// `734 <client> <limit> <targets>`: the list is full, and these were not added. They are
// not sent again on this Connection.
const listFull = (run: Run, targets: readonly string[]): void => {
  const fold = folder(run.state);
  const keys = targets.map((target) => fold(target));

  changeMonitoring(run, (monitoring) => {
    const watched = new Map(monitoring.watched);
    const refused = new Set(monitoring.refused);

    for (const key of keys) {
      if (watched.delete(key)) {
        refused.add(key);
      }
    }

    return { ...monitoring, refused, watched };
  });
  pruneUsers(run, keys);
};

/**
 * Reads a live `730`, `731`, or `734`. Only what tells of a nick on the list counts:
 * the first status after `MONITOR +` is learned silently, and only a change from what the
 * Connection knew is told in a partner's Timeline.
 * @param run - The step.
 * @param arrival - The Line, live.
 */
export const monitorReply = (run: Run, arrival: Arrival): void => {
  const { line } = arrival;
  const [, second, third] = line.params;
  const list = line.command === "734" ? third : second;

  if (list === undefined) {
    ignore(run, { _tag: "Malformed", command: line.command });

    return;
  }

  const targets = targetsOf(list);

  switch (line.command) {
    case "730": {
      for (const target of targets) {
        cameOnline(run, arrival, target);
      }

      break;
    }

    case "731": {
      for (const target of targets) {
        wentOffline(run, arrival, target);
      }

      break;
    }

    default: {
      listFull(run, targets);
    }
  }
};

/**
 * A live Line that refuses the command itself, by structure: a `421` or `461` naming
 * `MONITOR`, or a `FAIL MONITOR`. Monitoring is off for the rest of the Connection, and
 * nothing is known of the nicks it watched.
 * @param run - The step.
 * @param line - The Line.
 */
export const monitorRefused = (run: Run, line: Line): void => {
  const [first, second] = line.params;
  const named = line.command === "FAIL" ? first : second;

  const refuses =
    (line.command === "421" || line.command === "461" || line.command === "FAIL") &&
    named !== undefined &&
    upperCaseAscii(named) === "MONITOR";

  const watched = openOf(run.state)?.monitoring.watched;

  if (!refuses || watched === undefined) {
    return;
  }

  changeMonitoring(run, () => ({ ...unmonitored, off: true }));
  pruneUsers(run, [...watched.keys()]);
};

/**
 * A User was seen to leave a nick in a shared Channel, by `QUIT` or a rename: a monitored
 * nick is offline from now, so the `731` that follows tells nothing again.
 * @param run - The step.
 * @param nick - The nick left.
 * @returns Whether the leave is news, rather than one `MONITOR` already told of.
 */
export const left = (run: Run, nick: string): boolean => {
  const found = watchedOf(run, nick);

  if (found === undefined) {
    return true;
  }

  const [key, watched] = found;

  if (isOffline(watched)) {
    return false;
  }

  setHere(run, key, watched, false);

  return true;
};
