/**
 * Lookups: the Owner asks the Network for information, and the Client collects the reply,
 * which may span many Lines, into one result for the intent. The reply is tied to the
 * Lookup only by structure: by label, where `labeled-response` ties it, and otherwise by
 * the numerics that name the nick looked up, oldest Lookup first, since an Ircd answers a
 * Connection's commands in the order they came. It ends at its end numeric, `318` or
 * `369`, at the end of its labelled answer, when its time runs out, or when its
 * Connection ends, and is reported once, as `LookedUp`.
 *
 * @packageDocumentation
 */
import { whois, whowas } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import { fits, online } from "./acts.ts";
import { see } from "./channels.ts";
import type { Arrival } from "./feature.ts";
import { Instant } from "./ids.ts";
import type { IntentId } from "./ids.ts";
import type { Input, Lookup } from "./input.ts";
import type { Fact } from "./known.ts";
import { isSelf, namingNow, rulesNow } from "./meaning.ts";
import { parseChannel, parseNick } from "./names.ts";
import type { LookResult, PartialReason, Profile, ProfileChannel } from "./news.ts";
import type { Run } from "./run.ts";
import { folder, ignore, send, updateOpen } from "./run.ts";
import type { Link, Looking, Refreshed } from "./state.ts";
import { maxLookupLines, maxLookups } from "./state.ts";
import { lookupTime } from "./timers.ts";
import { openOf } from "./views.ts";

/** The numerics that end a reply, by the Lookup they end. */
const ends: Readonly<Record<Lookup["_tag"], string>> = { Whois: "318", Whowas: "369" };

/** The error numerics that say there is no such User, by the Lookup they answer. */
const missing: Readonly<Record<Lookup["_tag"], string>> = { Whois: "401", Whowas: "406" };

/** The numerics only a `WHOIS` reply holds, and only a `WHOWAS` reply. `312` is in both. */
const only: Readonly<Record<Lookup["_tag"], ReadonlySet<string>>> = {
  Whois: new Set(["301", "311", "313", "317", "318", "319", "330", "401", "671"]),
  Whowas: new Set(["314", "369", "406"]),
};

/**
 * Reply numerics the Client reads for something else, which name a nick second as a
 * Lookup's reply does, so none is taken for part of one.
 */
const readElsewhere: ReadonlySet<string> = new Set(["341", "353"]);

/** Error numerics that answer a Lookup by naming its nick, or naming nothing, as `431` does. */
const errors: ReadonlySet<string> = new Set(["401", "402", "406", "431"]);

const isNumeric = (command: string): boolean => /^\d{3}$/u.test(command);

const isError = (command: string): boolean => /^[45]\d\d$/u.test(command);

const report = (run: Run, looking: Looking, result: LookResult): void => {
  run.news.push({ _tag: "LookedUp", intent: looking.intent, lookup: looking.lookup, result });
};

const refuse = (
  run: Run,
  input: Input & { readonly _tag: "Look" },
  reason: "Offline" | "Unsendable" | "Busy"
): void => {
  run.news.push({
    _tag: "LookedUp",
    intent: input.intent,
    lookup: input.lookup,
    result: { _tag: "Refused", reason },
  });
};

/**
 * The Owner looks something up. It needs a Session, and its nick must be a nick by the
 * Network's rules, sent whole. At most {@link maxLookups} await their replies on a
 * Connection at once.
 * @param run - The step.
 * @param input - The Lookup.
 */
export const look = (run: Run, input: Input & { readonly _tag: "Look" }): void => {
  const open = openOf(run.state);
  const { lookup } = input;

  if (open === undefined || !online(run)) {
    refuse(run, input, "Offline");

    return;
  }

  const line = lookup._tag === "Whois" ? whois(lookup.nick) : whowas(lookup.nick);

  if (parseNick(namingNow(run), lookup.nick) === undefined || !fits(run, line)) {
    refuse(run, input, "Unsendable");

    return;
  }

  if (open.lookups.length >= maxLookups) {
    refuse(run, input, "Busy");

    return;
  }

  const sent = send(run, line, line.command, { _tag: "Looked", intent: input.intent });

  // A Feature refused it at egress.
  if (sent === undefined) {
    refuse(run, input, "Unsendable");

    return;
  }

  updateOpen(run, (phase) => {
    const looking: Looking = {
      bounded: false,
      deadline: Instant.make(run.at + lookupTime),
      ended: false,
      error: undefined,
      heard: new Map(),
      intent: input.intent,
      labelled: sent.echo,
      lines: 0,
      lookup,
      order: phase.awaited,
      profiles: [],
    };

    return { ...phase, awaited: phase.awaited + 1, lookups: [...phase.lookups, looking] };
  });
};

const profileOf = (nick: string): Profile => ({
  account: undefined,
  away: undefined,
  channels: [],
  host: undefined,
  idle: undefined,
  nick,
  operator: false,
  other: [],
  realname: undefined,
  secure: false,
  server: undefined,
  signon: undefined,
  user: undefined,
});

// Changes the last User described, or one begun for this nick when none was yet.
const changeLast = (
  profiles: readonly Profile[],
  nick: string,
  change: (profile: Profile) => Profile
): readonly Profile[] => {
  const last = profiles.at(-1);

  return last === undefined ? [change(profileOf(nick))] : [...profiles.slice(0, -1), change(last)];
};

const digits = /^\d{1,12}$/u;

// `319`'s list: each a Channel's name after any prefixes `PREFIX` names, read as modes.
const channelsOf = (run: Run, list: string): readonly ProfileChannel[] | undefined => {
  const { prefix } = rulesNow(run);
  const naming = namingNow(run);
  const read: ProfileChannel[] = [];

  for (const item of list.split(" ")) {
    if (item === "") {
      continue;
    }

    const prefixes: string[] = [];
    let rest = item;

    for (let symbol = rest.charAt(0); symbol !== ""; symbol = rest.charAt(0)) {
      const membership = prefix.find((each) => each.symbol === symbol);

      if (membership === undefined || parseChannel(naming, rest) !== undefined) {
        break;
      }

      prefixes.push(membership.mode);
      rest = rest.slice(1);
    }

    const name = parseChannel(naming, rest);

    if (name === undefined) {
      return undefined;
    }

    read.push({ name, prefixes });
  }

  return read;
};

/**
 * What one Line of a reply says of a User, read from its parameters after the nick, as a
 * change to them, or `undefined` when they do not fit.
 */
type Reader = (said: readonly string[], run: Run) => ((profile: Profile) => Profile) | undefined;

// `311` and `314 <client> <nick> <user> <host> * :<realname>`.
const readUser: Reader = ([user, host, , realname]) =>
  user === undefined || host === undefined || realname === undefined
    ? undefined
    : (profile) => ({ ...profile, host, realname, user });

// `317 <client> <nick> <secs> [<signon>] :seconds idle`. A signon is only before the text.
const readIdle: Reader = (said) => {
  const [idle, signon] = said;

  const since =
    signon !== undefined && said.length > 2 && digits.test(signon)
      ? Instant.make(Number(signon) * 1000)
      : undefined;

  return idle === undefined || !digits.test(idle)
    ? undefined
    : (profile) => ({ ...profile, idle: Number(idle), signon: since });
};

// `319 <client> <nick> :{[prefix]<channel>{ }}`, over as many Lines as it takes.
const readChannels: Reader = (said, run) => {
  const [list] = said;
  const channels = list === undefined ? undefined : channelsOf(run, said.at(-1) ?? list);

  return channels === undefined
    ? undefined
    : (profile) => ({ ...profile, channels: [...profile.channels, ...channels] });
};

/** What each numeric the Client models says, by the numeric. */
const readers: ReadonlyMap<string, Reader> = new Map<string, Reader>([
  // `301 <client> <nick> :<message>`
  [
    "301",
    ([message]) =>
      (profile) => ({ ...profile, away: message ?? "" }),
  ],
  ["311", readUser],
  // `312 <client> <nick> <server> :<server info>`
  [
    "312",
    ([name, info]) =>
      name === undefined
        ? undefined
        : (profile) => ({ ...profile, server: { info: info ?? "", name } }),
  ],
  // `313 <client> <nick> :is an IRC operator`
  ["313", () => (profile) => ({ ...profile, operator: true })],
  ["314", readUser],
  ["317", readIdle],
  ["319", readChannels],
  // `330 <client> <nick> <account> :is logged in as`
  [
    "330",
    ([account, text]) =>
      account === undefined || text === undefined
        ? undefined
        : (profile) => ({ ...profile, account }),
  ],
  // `671 <client> <nick> :is using a secure connection`
  ["671", () => (profile) => ({ ...profile, secure: true })],
]);

// Any other numeric of a reply, kept as it came, after the parameter that names Self.
const keepOther = (line: Line) => (profile: Profile) => ({
  ...profile,
  other: [...profile.other, { numeric: line.command, params: line.params.slice(1) }],
});

/**
 * What one Line of a reply says of the Users described: the profiles after it, or
 * `undefined` when its parameters do not fit its numeric. A `314` begins each entry of a
 * `WHOWAS`, and every other Line changes the last User described.
 * @param run - The step.
 * @param looking - The Lookup.
 * @param line - A reply Line, not an end or an error.
 * @returns The profiles after it, or `undefined` for a Line that does not fit.
 */
const described = (run: Run, looking: Looking, line: Line): readonly Profile[] | undefined => {
  const { command, params } = line;
  const [, nick, ...said] = params;
  const { profiles } = looking;
  const reader = readers.get(command);
  const apply = reader === undefined ? keepOther(line) : reader(said, run);

  if (nick === undefined || apply === undefined) {
    return undefined;
  }

  return command === "314"
    ? [...profiles, apply(profileOf(nick))]
    : changeLast(profiles, nick, apply);
};

/** The facts each numeric of a `WHOIS` speaks of, which a reply found whole refreshes. */
const speaksOf: ReadonlyMap<string, readonly Refreshed[]> = new Map<string, readonly Refreshed[]>([
  ["301", ["away"]],
  ["311", ["mask", "realname"]],
  ["330", ["account"]],
]);

/** What Knowledge holds of a User it keeps nothing of: one value, so it compares as the same while that lasts. */
const unknown: Fact<unknown> = { _tag: "Unknown" };

/**
 * A fact of a User as Knowledge holds it now: Self's, or another User's while they share
 * a Channel with Self, or `Unknown`.
 * @param run - The step.
 * @param nick - The User.
 * @param field - Which fact.
 * @returns The fact, as State holds it.
 */
const factOf = (run: Run, nick: string, field: Refreshed): Fact<unknown> => {
  const open = openOf(run.state);
  const presence = open?.presence._tag === "Session" ? open.presence : undefined;

  if (presence !== undefined && isSelf(run, nick)) {
    return presence[field];
  }

  const seen = open?.users.get(folder(run.state)(nick));

  return seen === undefined || field === "account" || field === "realname" ? unknown : seen[field];
};

// What a reply says of a User the Client already models, as `replied`, as of the Line
// that said it: Self's mask, realname, account, and away, and another User's mask and
// away, while they share a Channel with Self. Each is refreshed only when Knowledge holds
// the very fact it held when that Line came: State is never changed in place, so any
// word on it since, such as a `305`, replaced that fact, and is never undone.
// Away is set only by a `301`: the protocol does not say a reply without one means the
// User is back.
const learn = (run: Run, looking: Looking, profile: Profile): void => {
  const fresh = (field: Refreshed): Instant | undefined => {
    const heard = looking.heard.get(field);

    return heard !== undefined && factOf(run, profile.nick, field) === heard.was
      ? heard.at
      : undefined;
  };

  const replied = <T>(field: Refreshed, value: T | undefined, was: Fact<T>): Fact<T> => {
    const at = value === undefined ? undefined : fresh(field);

    return at === undefined || value === undefined
      ? was
      : { _tag: "Known", at, from: "replied", value };
  };

  const { user, host, realname, account, away } = profile;
  const mask = user === undefined || host === undefined ? undefined : { host, user };
  const message = away === undefined ? undefined : { message: away };

  if (isSelf(run, profile.nick)) {
    updateOpen(run, (open) => {
      const { presence } = open;

      return presence._tag === "Session"
        ? {
            ...open,
            presence: {
              ...presence,
              account: replied<string | null>("account", account, presence.account),
              away: replied<{ readonly message: string } | null>("away", message, presence.away),
              mask: replied("mask", mask, presence.mask),
              realname: replied("realname", realname, presence.realname),
            },
          }
        : open;
    });

    return;
  }

  see(run, profile.nick, (seen) => ({
    ...seen,
    away: replied<{ readonly message: string } | null>("away", message, seen.away),
    mask: replied("mask", mask, seen.mask),
  }));
};

/** How a Lookup ended: its reply's end, its time running out, or its Connection's end. */
type Ending = "End" | Extract<PartialReason, "TimedOut" | "Ended">;

const resultOf = (looking: Looking, ending: Ending, reply: string): LookResult => {
  if (looking.error !== undefined) {
    return looking.error;
  }

  if (looking.bounded) {
    return { _tag: "Partial", profiles: looking.profiles, reason: "Bounded" };
  }

  if (ending !== "End") {
    return { _tag: "Partial", profiles: looking.profiles, reason: ending };
  }

  if (looking.profiles.length > 0) {
    return { _tag: "Found", profiles: looking.profiles };
  }

  // An end numeric with no User before it says there is none. A labelled answer that
  // ended without one, such as a lone `NOTICE`, said nothing the Client can read, so it
  // failed, named by the command that ended it.
  return looking.labelled && !looking.ended
    ? { _tag: "Failed", reply }
    : { _tag: "NotFound", reply };
};

// Reports a Lookup once, and forgets it. A `WHOIS` found whole refreshes what is known.
const finish = (run: Run, intent: IntentId, ending: Ending, reply: string): void => {
  const looking = openOf(run.state)?.lookups.find((each) => each.intent === intent);

  if (looking === undefined) {
    return;
  }

  updateOpen(run, (open) => ({
    ...open,
    lookups: open.lookups.filter((each) => each.intent !== intent),
  }));

  const result = resultOf(looking, ending, reply);

  report(run, looking, result);

  if (result._tag === "Found" && looking.lookup._tag === "Whois") {
    for (const profile of result.profiles) {
      learn(run, looking, profile);
    }
  }
};

const change = (run: Run, intent: IntentId, apply: (looking: Looking) => Looking): void => {
  updateOpen(run, (open) => ({
    ...open,
    lookups: open.lookups.map((each) => (each.intent === intent ? apply(each) : each)),
  }));
};

// The reply a rejection gives: an error numeric by its number, or a `FAIL` by its code.
const rejectionOf = (looking: Looking, line: Line): Looking["error"] => {
  const { command, params } = line;

  if (command === "FAIL") {
    const [, code] = params;

    return { _tag: "Failed", reply: code ?? command };
  }

  return command === missing[looking.lookup._tag]
    ? { _tag: "NotFound", reply: command }
    : { _tag: "Failed", reply: command };
};

// One Line of a Lookup's reply: its end, an error, or something it says of a User.
const take = (run: Run, looking: Looking, line: Line): void => {
  const { command } = line;
  const { intent } = looking;

  // A labelled reply ends with its batch, or as a lone Line, so an end numeric inside it
  // ends nothing, and what follows it in the batch is kept.
  if (command === ends[looking.lookup._tag]) {
    if (looking.labelled) {
      change(run, intent, (each) => ({ ...each, ended: true }));
    } else {
      finish(run, intent, "End", command);
    }

    return;
  }

  // Only reply numerics and `FAIL` say anything of a Lookup. Any other Line of a labelled
  // answer, such as a `NOTICE`, is read as it is elsewhere, and describes no User.
  if (!isNumeric(command) && command !== "FAIL") {
    return;
  }

  if (isError(command) || command === "FAIL") {
    change(run, intent, (each) => ({
      ...each,
      error: each.error ?? rejectionOf(each, line),
      lines: each.lines + 1,
    }));

    return;
  }

  // Past its bound, or once an error said what it found, a reply's Lines are not kept.
  if (looking.bounded || looking.error !== undefined || looking.lines >= maxLookupLines) {
    change(run, intent, (each) => ({ ...each, bounded: each.error === undefined }));

    return;
  }

  const profiles = described(run, looking, line);

  if (profiles === undefined) {
    ignore(run, { _tag: "Malformed", command });
  }

  // What a `WHOIS` says of a fact Knowledge keeps is stamped with this Line's time, and
  // with the fact as it stands now.
  const [, nick] = line.params;
  const fields = profiles === undefined || nick === undefined ? [] : (speaksOf.get(command) ?? []);
  const heard = new Map(looking.heard);

  for (const field of looking.lookup._tag === "Whois" ? fields : []) {
    heard.set(field, { at: run.at, was: factOf(run, nick ?? "", field) });
  }

  change(run, intent, (each) => ({
    ...each,
    heard,
    lines: each.lines + 1,
    profiles: profiles ?? each.profiles,
  }));
};

// Whether a numeric, not tied by label, is part of a Lookup's reply on the floor: one its
// kind of reply holds, an error, or another reply numeric, that names its nick second,
// as the protocol says vendors' numerics must. `431` names no nick.
const answers = (run: Run, looking: Looking, line: Line): boolean => {
  const { command, params } = line;
  const kind = looking.lookup._tag;
  const other = kind === "Whois" ? "Whowas" : "Whois";

  // A reply holds one error, so a Lookup that has one leaves the next to whoever sent
  // another Line naming the nick.
  const another = looking.error !== undefined && (isError(command) || command === "FAIL");

  if (looking.labelled || another || only[other].has(command) || readElsewhere.has(command)) {
    return false;
  }

  if (command === "431") {
    return true;
  }

  const fold = folder(run.state);
  const [, named] = params;

  const holds =
    only[kind].has(command) ||
    command === "312" ||
    errors.has(command) ||
    /^[23]\d\d$/u.test(command);

  return holds && named !== undefined && fold(named) === fold(looking.lookup.nick);
};

/**
 * Collects one received Line into the Lookup whose labelled reply it is part of, as
 * `labeled-response` marked it `within` its intent. Only a live Line counts.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 * @returns Whether it was part of a Lookup's reply.
 */
export const collectLabelled = (run: Run, arrival: Arrival): boolean => {
  const { line, within } = arrival;

  const looking =
    within === undefined || !arrival.live
      ? undefined
      : openOf(run.state)?.lookups.find((each) => each.intent === within.intent);

  if (within === undefined || looking === undefined) {
    return false;
  }

  if (line.command !== "BATCH") {
    take(run, looking, line);
  }

  if (within.ends) {
    finish(run, within.intent, "End", line.command);
  }

  return true;
};

/**
 * The oldest Lookup sent without a label whose reply a live numeric, outside any batch or
 * label, could be part of: by the nick it names, and the kind of reply it is. The caller
 * weighs it against an action's Line the numeric also names, by which was sent first.
 * @param run - The step.
 * @param line - The Line.
 * @returns The Lookup, or `undefined` for none.
 */
export const floorLookup = (run: Run, line: Line): Looking | undefined =>
  isNumeric(line.command) && !line.tags.has("label")
    ? openOf(run.state)?.lookups.find((each) => answers(run, each, line))
    : undefined;

/**
 * Collects a Line into a Lookup's reply, as {@link floorLookup} found it.
 * @param run - The step.
 * @param looking - The Lookup.
 * @param line - The Line.
 */
export const collectFloor = (run: Run, looking: Looking, line: Line): void => {
  take(run, looking, line);
};

/**
 * A Lookup's time ran out with no end: it reports what it has.
 * @param run - The step.
 * @param intent - Its intent.
 */
export const expireLookup = (run: Run, intent: IntentId): void => {
  finish(run, intent, "TimedOut", "");
};

/**
 * The Lookups whose Line never left report `Unsent`, and are forgotten.
 * @param run - The step.
 * @param intents - The intents of the Lines that never left.
 * @returns The intents that were Lookups', which nothing else reports.
 */
export const unsentLookups = (run: Run, intents: ReadonlySet<IntentId>): ReadonlySet<IntentId> => {
  const lookups = openOf(run.state)?.lookups ?? [];
  const gone = lookups.filter((each) => intents.has(each.intent));

  if (gone.length === 0) {
    return new Set();
  }

  updateOpen(run, (open) => ({
    ...open,
    lookups: open.lookups.filter((each) => !intents.has(each.intent)),
  }));

  for (const looking of gone) {
    report(run, looking, { _tag: "Unsent" });
  }

  return new Set(gone.map((each) => each.intent));
};

/**
 * A Connection ended: each Lookup still awaiting its reply reports what it has.
 * @param run - The step.
 * @param link - The Connection, as it was.
 */
export const endLookups = (run: Run, link: Link): void => {
  if (link.phase._tag !== "Open") {
    return;
  }

  for (const looking of link.phase.lookups) {
    report(run, looking, resultOf(looking, "Ended", ""));
  }
};
