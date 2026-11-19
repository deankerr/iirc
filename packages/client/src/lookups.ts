/**
 * Lookups: the Owner asks the Network for information, and the Client collects the reply,
 * which may span many Lines, into one result for the intent. The reply is tied to the
 * Lookup only by structure: by label, where `labeled-response` ties it, and otherwise by
 * the numerics that name the nick, Channel, or mask looked up, oldest Lookup first, since
 * an Ircd answers a Connection's commands in the order they came. A `LIST`'s numerics name
 * nothing it asked, so only one awaits at a time, and every `321`, `322`, and `323` on the
 * floor while it does is its own. It ends at its end numeric, such as `318`, `368`, `366`,
 * `315`, or `323`, at the end of its labelled answer, when its time runs out, or when its
 * Connection ends, and is reported once, as `LookedUp`.
 *
 * @packageDocumentation
 */
import { list, mode, names, upperCaseAscii, who, whois, whowas } from "@iirc/protocol/line";
import type { Line, OutboundLine, Rejected } from "@iirc/protocol/line";
import { globMatches } from "@iirc/protocol/mask";

import { fits, online } from "./acts.ts";
import { endOfNames, listedApart, see } from "./channels.ts";
import type { ListedPart } from "./channels.ts";
import type { Arrival } from "./feature.ts";
import { Instant } from "./ids.ts";
import type { IntentId } from "./ids.ts";
import type { Input, Lookup } from "./input.ts";
import type { Fact, MaskList } from "./known.ts";
import { isSelf, namingNow, rulesNow } from "./meaning.ts";
import { listMore } from "./members.ts";
import type { Listed } from "./modes.ts";
import { maskListsOf } from "./modes.ts";
import { parseChannel, parseNick } from "./names.ts";
import type {
  ChannelEntry,
  LookRefusal,
  LookResult,
  MaskEntry,
  NamesEntry,
  PartialReason,
  Profile,
  ProfileChannel,
  StandardReply,
} from "./news.ts";
import { readReply } from "./replies.ts";
import type { Run } from "./run.ts";
import { folder, ignore, send, updateOpen } from "./run.ts";
import type { Link, Looking, Refreshed } from "./state.ts";
import {
  maxDirectory,
  maxForgotten,
  maxLookupEntries,
  maxLookupLines,
  maxLookups,
} from "./state.ts";
import { lookupTime } from "./timers.ts";
import { userIn } from "./users.ts";
import { openOf } from "./views.ts";
import { awayOf, readWho, whoAnswering } from "./who-query.ts";

/** A Lookup of a User: a `WHOIS` or a `WHOWAS`. */
type UserLookup = Extract<Lookup, { readonly _tag: "Whois" | "Whowas" }>;

/** A Lookup of a list of masks on a Channel. */
type ListLookup = Extract<Lookup, { readonly _tag: MaskList }>;

const isList = (lookup: Lookup): lookup is ListLookup =>
  lookup._tag === "Bans" || lookup._tag === "Exceptions" || lookup._tag === "Invitations";

/** A Lookup whose reply is a list of entries: a Channel's members, or the Users a mask matches. */
type EntryLookup = Extract<Lookup, { readonly _tag: "Names" | "Who" }>;

const isEntries = (lookup: Lookup): lookup is EntryLookup =>
  lookup._tag === "Names" || lookup._tag === "Who";

/** A `LIST` of the Network's Channels. */
type ChannelsLookup = Extract<Lookup, { readonly _tag: "Channels" }>;

// What an entries Lookup asked: a `NAMES`'s Channel, or a `WHO`'s mask.
const askedOf = (lookup: EntryLookup): string =>
  lookup._tag === "Names" ? lookup.channel : lookup.mask;

/** The numerics that end a reply, by the Lookup they end. */
const ends: Readonly<Record<Lookup["_tag"], string>> = {
  Bans: "368",
  Channels: "323",
  Exceptions: "349",
  Invitations: "347",
  Names: "366",
  Who: "315",
  Whois: "318",
  Whowas: "369",
};

/** The numeric that gives one mask of a list, by the list. */
const entries: Readonly<Record<MaskList, string>> = {
  Bans: "367",
  Exceptions: "348",
  Invitations: "346",
};

const noChannel: ReadonlySet<string> = new Set(["401", "403"]);

/**
 * The error numerics that say there is no such User, or no such Channel, by the Lookup they
 * answer. Some Ircds answer a `MODE` of a name no Channel holds with `401`.
 */
const missing: Readonly<Record<Lookup["_tag"], ReadonlySet<string>>> = {
  Bans: noChannel,
  Channels: new Set(),
  Exceptions: noChannel,
  Invitations: noChannel,
  Names: noChannel,
  Who: noChannel,
  Whois: new Set(["401"]),
  Whowas: new Set(["406"]),
};

/**
 * The error numerics that refuse a `MODE` of a Channel by naming it second: no such nick
 * or Channel, not on it, a name it cannot have, and not its operator.
 */
const channelErrors: ReadonlySet<string> = new Set(["401", "403", "442", "476", "479", "482"]);

/** The numerics only a `WHOIS` reply holds, and only a `WHOWAS` reply. `312` is in both. */
const only: Readonly<Record<UserLookup["_tag"], ReadonlySet<string>>> = {
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

/**
 * Whether a command is a numeric: three digits.
 * @param command - The command.
 * @returns Whether it is.
 */
export const isNumeric = (command: string): boolean => /^\d{3}$/u.test(command);

const isError = (command: string): boolean => /^[45]\d\d$/u.test(command);

const report = (run: Run, looking: Looking, result: LookResult): void => {
  run.news.push({ _tag: "LookedUp", intent: looking.intent, lookup: looking.lookup, result });
};

const refuse = (run: Run, input: Input & { readonly _tag: "Look" }, reason: LookRefusal): void => {
  run.news.push({
    _tag: "LookedUp",
    intent: input.intent,
    lookup: input.lookup,
    result: { _tag: "Refused", reason },
  });
};

/** What a `LIST` asks of the Ircd, and what the Client filters its reply by itself. */
interface Listing {
  readonly conditions: readonly string[];
  readonly sift: Looking["sift"];
}

/**
 * What a `LIST` asks of the Ircd, as its `ELIST` allows, by letters in any case: the mask
 * by `M`, and the least members by `U`, as `>N` for one fewer, but never `>0`. What the
 * Ircd is not asked, the Client filters by itself.
 * @param run - The step.
 * @param lookup - The Lookup.
 * @returns The conditions to send, and what is left to filter.
 */
const listingOf = (run: Run, lookup: ChannelsLookup): Listing => {
  const elist = upperCaseAscii(openOf(run.state)?.isupport.get("ELIST") ?? "");
  const { least, mask } = lookup;
  const conditions: string[] = [];
  let sift: Listing["sift"] = { least, mask };

  if (mask !== undefined && elist.includes("M")) {
    conditions.push(mask);
    sift = { ...sift, mask: undefined };
  }

  if (least !== undefined && least >= 2 && elist.includes("U")) {
    conditions.push(`>${least - 1}`);
    sift = { ...sift, least: undefined };
  }

  return { conditions, sift };
};

// Whether a `LIST` asks what a Line can carry: a mask that is not empty and holds no comma
// or space, which would make it a list or a second parameter, and a least count that is a
// whole number of at least one.
const isListable = ({ least, mask }: ChannelsLookup): boolean =>
  (mask === undefined || (mask !== "" && !/[ ,]/u.test(mask))) &&
  (least === undefined || (Number.isSafeInteger(least) && least >= 1));

/**
 * The Line a Lookup sends: a `WHOIS` or `WHOWAS` of a nick by the Network's rules, a
 * `MODE` asking a Channel's list, by the mode the Network gives that list, a `NAMES` of a
 * Channel's name by the Network's rules, a `WHO` of a mask as one parameter, never
 * asking WHOX fields, or a `LIST` with what `ELIST` lets the Ircd filter, each sent whole.
 * @param run - The step.
 * @param lookup - The Lookup.
 * @returns The Line, or why it cannot be sent.
 */
const lineOf = (run: Run, lookup: Lookup): OutboundLine | "NotOffered" | "Unsendable" => {
  const naming = namingNow(run);
  let line: OutboundLine | Rejected | undefined;

  if (isList(lookup)) {
    const letter = maskListsOf(openOf(run.state)?.isupport ?? new Map())[lookup._tag];

    if (letter === undefined) {
      return "NotOffered";
    }

    line =
      parseChannel(naming, lookup.channel) === undefined
        ? undefined
        : mode(lookup.channel, [`+${letter}`]);
  } else if (lookup._tag === "Names") {
    line = parseChannel(naming, lookup.channel) === undefined ? undefined : names(lookup.channel);
  } else if (lookup._tag === "Who") {
    line = who(lookup.mask);
  } else if (lookup._tag === "Channels") {
    line = isListable(lookup) ? list(listingOf(run, lookup).conditions) : undefined;
  } else if (parseNick(naming, lookup.nick) !== undefined) {
    line = lookup._tag === "Whois" ? whois(lookup.nick) : whowas(lookup.nick);
  }

  return line !== undefined && fits(run, line) ? line : "Unsendable";
};

/**
 * The Owner looks something up. It needs a Session. A nick must be a nick by the Network's
 * rules, and a Channel's name a Channel's, and a list one the Network keeps, sent whole. At
 * most {@link maxLookups} await their replies on a Connection at once, and one `LIST`,
 * which awaits its end even once its time runs out, since nothing but its being the one
 * awaiting ties its reply to it on the floor.
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

  const line = lineOf(run, lookup);

  if (line === "NotOffered" || line === "Unsendable") {
    refuse(run, input, line);

    return;
  }

  if (
    open.lookups.filter((each) => !each.lapsed).length >= maxLookups ||
    (lookup._tag === "Channels" && open.lookups.some((each) => each.lookup._tag === "Channels"))
  ) {
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
      channels: [],
      deadline: Instant.make(run.at + lookupTime),
      ended: false,
      error: undefined,
      heard: new Map(),
      intent: input.intent,
      labelled: sent.echo,
      lapsed: false,
      lines: 0,
      listing: undefined,
      lookup,
      masks: [],
      members: [],
      mode: isList(lookup) ? maskListsOf(phase.isupport)[lookup._tag] : undefined,
      notes: [],
      order: phase.awaited,
      profiles: [],
      seen: 0,
      sift:
        lookup._tag === "Channels"
          ? listingOf(run, lookup).sift
          : { least: undefined, mask: undefined },
      users: [],
    };

    return { ...phase, awaited: phase.awaited + 1, lookups: [...phase.lookups, looking] };
  });
};

const profileOf = (nick: string): Profile => ({
  account: undefined,
  actual: undefined,
  away: undefined,
  channels: [],
  host: undefined,
  idle: undefined,
  modes: undefined,
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
type Reader = (
  said: readonly string[],
  run: Run,
  line: Line
) => ((profile: Profile) => Profile) | undefined;

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

// Any other numeric of a reply, kept as it came, after the parameter that names Self.
const keepOther = (line: Line) => (profile: Profile) => ({
  ...profile,
  other: [...profile.other, { numeric: line.command, params: line.params.slice(1) }],
});

// An IPv4 address in dotted-quad form, each part 0 to 255 in decimal, with no leading
// zero, which some readers take as octal.
const isIpv4 = (text: string): boolean => {
  const parts = text.split(".");

  return (
    parts.length === 4 &&
    parts.every((part) => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)
  );
};

const hextet = /^[\dA-Fa-f]{1,4}$/u;

// An IPv6 address: eight groups of up to four hex digits, or fewer around one `::`, as
// `0::1`, the form an Ircd prefixes with a zero so it cannot start with a colon. An IPv4
// address may stand for the last two groups only, the final 32 bits, as in
// `0::ffff:192.0.2.1`, so nothing may follow it, a `::` included.
const isIpv6 = (text: string): boolean => {
  const halves = text.split("::");

  if (halves.length > 2) {
    return false;
  }

  const groups = halves.map((half) => (half === "" ? [] : half.split(":")));
  const tail = groups.at(-1) ?? [];
  const last = tail.at(-1);
  const embedded = last !== undefined && isIpv4(last);
  const hextets = [...groups.slice(0, -1).flat(), ...(embedded ? tail.slice(0, -1) : tail)];
  const count = hextets.length + (embedded ? 2 : 0);

  if (!hextets.every((group) => hextet.test(group))) {
    return false;
  }

  return halves.length === 2 ? count <= 7 : count === 8;
};

const isIp = (text: string): boolean => isIpv4(text) || isIpv6(text);

// `338 <client> <nick> [<user@host>] [<ip>] :<text>`. Its forms vary by Ircd, so each
// parameter between the nick and the text is told by its shape alone: one holding `@`
// is the mask, and one that is an IP address the IP. Its text is never read. A reply
// with no such parameter, two of a kind, or one of neither shape is kept as it came.
const readActual: Reader = (said, _run, line) => {
  let mask: string | undefined;
  let ip: string | undefined;

  for (const param of said.slice(0, -1)) {
    if (param.includes("@") && mask === undefined) {
      mask = param;
    } else if (isIp(param) && ip === undefined) {
      ip = param;
    } else {
      return keepOther(line);
    }
  }

  return mask === undefined && ip === undefined
    ? keepOther(line)
    : (profile) => ({ ...profile, actual: { ip, mask } });
};

const userModes = /^\+[A-Za-z]+$/u;

// `379 <client> <nick> :is using modes +Zi`. The modes have no parameter of their own,
// only a word in the text. A `+` and letters alone is the syntax of a change of user
// modes, which no wording around it shares, so a text with exactly one such word gives
// it, and any other, with none or with a second, as UnrealIRCd adds a snomask, is kept
// as it came.
const readModes: Reader = (said, _run, line) => {
  const words = (said.at(-1) ?? "").split(" ").filter((word) => userModes.test(word));
  const [modes] = words;

  return words.length === 1 && modes !== undefined
    ? (profile) => ({ ...profile, modes })
    : keepOther(line);
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
  ["338", readActual],
  ["379", readModes],
  // `671 <client> <nick> :is using a secure connection`
  ["671", () => (profile) => ({ ...profile, secure: true })],
]);

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
  const apply = reader === undefined ? keepOther(line) : reader(said, run, line);

  if (nick === undefined || apply === undefined) {
    return undefined;
  }

  return command === "314"
    ? [...profiles, apply(profileOf(nick))]
    : changeLast(profiles, nick, apply);
};

/**
 * One mask of a list, from `367`, `348`, or `346`, each
 * `<client> <channel> <mask> [<who> <set-ts>]`: who set it and when only where the Ircd
 * gives them, and the time only as a count of seconds.
 * @param line - The Line.
 * @returns The mask, or `undefined` when the Line names none.
 */
const maskOf = (line: Line): MaskEntry | undefined => {
  const [mask, setBy, setAt] = line.params.slice(2);

  return mask === undefined || mask === ""
    ? undefined
    : {
        mask,
        setAt:
          setAt !== undefined && digits.test(setAt)
            ? Instant.make(Number(setAt) * 1000)
            : undefined,
        setBy: setBy === undefined || setBy === "" ? undefined : setBy,
      };
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

  const seen = open === undefined ? undefined : userIn(open.users, folder(run.state)(nick));

  return seen === undefined ? unknown : seen[field];
};

// What a reply says of a User the Client already models, as `replied`, as of the Line
// that said it: Self's mask, realname, account, and away, and another User's, while they
// share a Channel with Self. Each is refreshed only when Knowledge holds
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
    account: replied<string | null>("account", account, seen.account),
    away: replied<{ readonly message: string } | null>("away", message, seen.away),
    mask: replied("mask", mask, seen.mask),
    realname: replied("realname", realname, seen.realname),
  }));
};

/** How a Lookup ended: its reply's end, its time running out, or its Connection's end. */
type Ending = "End" | Extract<PartialReason, "TimedOut" | "Ended">;

// What a `NAMES` or `WHO` found. A labelled answer that ended with no end numeric stopped
// short of it, and with no entry either, said nothing the Client can read, as for a list.
// An end numeric with none before it is an empty list.
const entriesResultOf = (
  looking: Looking,
  lookup: EntryLookup,
  ending: Ending,
  reply: string
): LookResult => {
  const { members, notes, users } = looking;
  const unended = ending === "End" && looking.labelled && !looking.ended;
  const stopped = ending === "End" ? undefined : ending;
  const cut = looking.bounded ? "Bounded" : (stopped ?? (unended ? "Ended" : undefined));
  const isNames = lookup._tag === "Names";
  const none = (isNames ? members.length : users.length) === 0;

  if (unended && none) {
    return { _tag: "Failed", notes, reply };
  }

  return isNames ? { _tag: "Members", cut, members, notes } : { _tag: "Users", cut, notes, users };
};

// What a `LIST` found, cut short as a `NAMES` is, and `Bounded` once it saw more than it
// kept.
const channelsResultOf = (looking: Looking, ending: Ending, reply: string): LookResult => {
  const { channels, notes, seen } = looking;
  const unended = ending === "End" && looking.labelled && !looking.ended;
  const stopped = ending === "End" ? undefined : ending;
  const bounded = looking.bounded || seen > channels.length;
  const cut = bounded ? "Bounded" : (stopped ?? (unended ? "Ended" : undefined));

  return unended && seen === 0
    ? { _tag: "Failed", notes, reply }
    : { _tag: "Channels", channels, cut, notes, seen };
};

const resultOf = (looking: Looking, ending: Ending, reply: string): LookResult => {
  const { notes } = looking;

  if (looking.error !== undefined) {
    return { ...looking.error, notes };
  }

  if (looking.lookup._tag === "Channels") {
    return channelsResultOf(looking, ending, reply);
  }

  if (isEntries(looking.lookup)) {
    return entriesResultOf(looking, looking.lookup, ending, reply);
  }

  // A labelled answer that ended with no mask and no end numeric said nothing the Client
  // can read, as for a User. An end numeric with none before it is an empty list.
  if (isList(looking.lookup)) {
    const stopped = ending === "End" ? undefined : ending;
    const cut = looking.bounded ? "Bounded" : stopped;

    return ending === "End" && looking.labelled && !looking.ended && looking.masks.length === 0
      ? { _tag: "Failed", notes, reply }
      : { _tag: "Listed", cut, masks: looking.masks, notes };
  }

  if (looking.bounded) {
    return { _tag: "Partial", notes, profiles: looking.profiles, reason: "Bounded" };
  }

  if (ending !== "End") {
    return { _tag: "Partial", notes, profiles: looking.profiles, reason: ending };
  }

  if (looking.profiles.length > 0) {
    return { _tag: "Found", notes, profiles: looking.profiles };
  }

  // An end numeric with no User before it says there is none. A labelled answer that
  // ended without one, such as a lone `NOTICE`, said nothing the Client can read, so it
  // failed, named by the command that ended it.
  return looking.labelled && !looking.ended
    ? { _tag: "Failed", notes, reply }
    : { _tag: "NotFound", notes, reply };
};

// Reports a Lookup once, and forgets it. A `WHOIS` found whole refreshes what is known.
const finish = (run: Run, intent: IntentId, ending: Ending, reply: string): void => {
  const looking = openOf(run.state)?.lookups.find((each) => each.intent === intent);

  if (looking === undefined) {
    return;
  }

  // Its own listing goes with it: one its `366` did not end corrects nothing.
  updateOpen(run, (open) => ({
    ...open,
    lookups: open.lookups.filter((each) => each.intent !== intent),
  }));

  if (looking.lapsed) {
    return;
  }

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

  return missing[looking.lookup._tag].has(command)
    ? { _tag: "NotFound", reply: command }
    : { _tag: "Failed", reply: command };
};

// A `WARN` or a `NOTE` says something of the Lookup, and ends nothing, and neither does a
// `FAIL` after the one that gave its result, which is kept beside them so none is lost.
const isNote = (looking: Looking, command: string): boolean =>
  command === "WARN" || command === "NOTE" || (command === "FAIL" && looking.error !== undefined);

// Keeps a note in the Lookup's notes. Past the Lines one Lookup keeps, it is not kept.
const keepNote = (run: Run, looking: Looking, line: Line): void => {
  const note = readReply(line);

  if (note === undefined) {
    ignore(run, { _tag: "Malformed", command: line.command });

    return;
  }

  change(run, looking.intent, (each) =>
    each.lines >= maxLookupLines
      ? { ...each, bounded: each.error === undefined }
      : { ...each, lines: each.lines + 1, notes: [...each.notes, note] }
  );
};

// Keeps the mask one Line of a list's reply gives.
const keepMask = (run: Run, looking: Looking, line: Line): void => {
  const mask = maskOf(line);

  if (mask === undefined) {
    ignore(run, { _tag: "Malformed", command: line.command });
  }

  change(run, looking.intent, (each) => ({
    ...each,
    lines: each.lines + 1,
    masks: mask === undefined ? each.masks : [...each.masks, mask],
  }));
};

// Keeps the User one `352` of a `WHO` reply describes, up to its bound.
const keepWho = (run: Run, looking: Looking, line: Line): void => {
  const reply = readWho(line);

  if (reply === undefined) {
    ignore(run, { _tag: "Malformed", command: line.command });

    return;
  }

  const { flags, host, nick, realname, user } = reply;

  change(run, looking.intent, (each) =>
    each.users.length >= maxLookupEntries
      ? { ...each, bounded: true }
      : { ...each, users: [...each.users, { away: awayOf(flags), host, nick, realname, user }] }
  );
};

/**
 * One Channel a `322` describes, `<client> <channel> <count> [:<topic>]`: a name that is a
 * Channel's by the Network's rules, and a count of digits.
 * @param run - The step.
 * @param line - The Line.
 * @returns The Channel, or `undefined` when the Line does not fit.
 */
const readListed = (run: Run, line: Line): ChannelEntry | undefined => {
  const [, channel, count, topic] = line.params;

  return channel === undefined ||
    count === undefined ||
    !digits.test(count) ||
    parseChannel(namingNow(run), channel) === undefined
    ? undefined
    : { channel, members: Number(count), topic: topic ?? "" };
};

// Most members first, then by name, in code-unit order.
const ranks = (left: ChannelEntry, right: ChannelEntry): number =>
  right.members - left.members ||
  (left.channel < right.channel ? -1 : Number(left.channel > right.channel));

// The Channels kept with one more, in rank, and at most {@link maxDirectory} of them, so
// the least drops out once there are more.
const ranked = (kept: readonly ChannelEntry[], entry: ChannelEntry): readonly ChannelEntry[] => {
  let low = 0;
  let high = kept.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const there = kept[middle];

    if (there !== undefined && ranks(there, entry) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low >= maxDirectory
    ? kept
    : [...kept.slice(0, low), entry, ...kept.slice(low, maxDirectory - 1)];
};

// Keeps the Channel one `322` of a `LIST` reply describes, if it matches what the Ircd was
// not asked to filter by: its name by the glob, folded by the Network's casemapping, and
// its members by the least. Every one that matches is seen.
const keepChannel = (run: Run, looking: Looking, line: Line): void => {
  const entry = readListed(run, line);

  if (entry === undefined) {
    ignore(run, { _tag: "Malformed", command: line.command });

    return;
  }

  const { least, mask } = looking.sift;
  const fold = folder(run.state);

  if (
    (least !== undefined && entry.members < least) ||
    (mask !== undefined && !globMatches(fold(mask), fold(entry.channel)))
  ) {
    return;
  }

  change(run, looking.intent, (each) => ({
    ...each,
    channels: ranked(each.channels, entry),
    seen: each.seen + 1,
  }));
};

// The modes a member's prefixes stand for, as far as the listing knows them.
const prefixesOf = (prefixes: Listed["prefixes"]): readonly string[] => {
  switch (prefixes._tag) {
    case "Known": {
      return [...prefixes.value];
    }

    case "Partial": {
      return [...prefixes.atLeast];
    }

    case "Stale":
    case "Unknown": {
      return [];
    }

    default: {
      return prefixes satisfies never;
    }
  }
};

// Keeps what one Line of a `WHOIS` or `WHOWAS` reply says of a User.
const keepDescribed = (run: Run, looking: Looking, line: Line): void => {
  const { command } = line;
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

  change(run, looking.intent, (each) => ({
    ...each,
    heard,
    lines: each.lines + 1,
    profiles: profiles ?? each.profiles,
  }));
};

// Whether an end numeric names what a `NAMES` or `WHO` asked, second. Any other Lookup's
// end names nothing it must match here.
const endsOwn = (run: Run, lookup: Lookup, line: Line): boolean => {
  if (!isEntries(lookup)) {
    return true;
  }

  const [, named] = line.params;
  const fold = folder(run.state);

  return named !== undefined && fold(named) === fold(askedOf(lookup));
};

// Its own end numeric. A labelled reply ends with its batch, or as a lone Line, so an end
// numeric inside it only marks it ended, and what follows it in the batch is kept.
const takeEnd = (run: Run, looking: Looking, line: Line): void => {
  const { intent } = looking;
  const { command } = line;

  // A `366` ends a whole listing, so it corrects the members even past the bound of what
  // the Lookup reports, which bounds only the card. A labelled answer's rows are its
  // own, so its `366` leaves the Channel's own listing to its own end. One on the floor
  // may have taken the rest of the listing of Self's `JOIN`, so it ends that too.
  if (looking.lookup._tag === "Names") {
    if (looking.labelled) {
      listedApart(run, looking.lookup.channel, looking.listing);
    } else {
      endOfNames(run, looking.lookup.channel, looking.listing);
    }
  }

  if (looking.labelled) {
    change(run, intent, (each) => ({ ...each, ended: true }));
  } else {
    finish(run, intent, "End", command);
  }
};

// Whether a `LIST`'s reply is a `263`, which asks to try again later, and ends it as an
// error would.
const refusesList = (looking: Looking, command: string): boolean =>
  looking.lookup._tag === "Channels" && command === "263";

// Whether a Line of a Lookup's reply refuses it: an error numeric, a `FAIL`, or a `263` of a
// `LIST`.
const isRejection = (looking: Looking, command: string): boolean =>
  isError(command) || command === "FAIL" || refusesList(looking, command);

// A `322` of a `LIST` that has neither its error nor run out of time.
const takeListed = (run: Run, looking: Looking, line: Line): void => {
  if (line.command === "322" && looking.error === undefined && !looking.lapsed) {
    keepChannel(run, looking, line);
  }
};

// One Line of a Lookup's reply: its end, an error, or something it says of a User or a list.
const take = (run: Run, looking: Looking, line: Line): void => {
  const { command } = line;
  const { intent } = looking;

  // A `NAMES` or `WHO` end must name what was asked, and any other is read as it is
  // elsewhere.
  if (command === ends[looking.lookup._tag] && endsOwn(run, looking.lookup, line)) {
    takeEnd(run, looking, line);

    return;
  }

  if (isNote(looking, command)) {
    keepNote(run, looking, line);

    return;
  }

  // Only reply numerics and `FAIL` say anything of a Lookup. Any other Line of a labelled
  // answer, such as a `NOTICE`, is read as it is elsewhere, and describes no User.
  if (!isNumeric(command) && command !== "FAIL") {
    return;
  }

  if (isRejection(looking, command)) {
    change(run, intent, (each) => ({
      ...each,
      error: each.error ?? rejectionOf(each, line),
      lines: each.lines + 1,
    }));

    return;
  }

  // A `LIST` keeps what each `322` describes, none counted against the Lines one Lookup
  // keeps. One whose time ran out keeps nothing, and a `321` says nothing.
  if (looking.lookup._tag === "Channels") {
    takeListed(run, looking, line);

    return;
  }

  // A `NAMES` reply's `353` is read with its members as Features refined them, by
  // `collectListed`. Any other numeric a labelled answer holds is read as it is elsewhere.
  if (isEntries(looking.lookup)) {
    if (command === "352" && looking.lookup._tag === "Who" && looking.error === undefined) {
      keepWho(run, looking, line);
    }

    return;
  }

  // Only its own numeric gives a list a mask. Any other a labelled answer holds is read
  // as it is elsewhere.
  if (isList(looking.lookup) && command !== entries[looking.lookup._tag]) {
    return;
  }

  // Past its bound, or once an error said what it found, a reply's Lines are not kept.
  if (looking.bounded || looking.error !== undefined || looking.lines >= maxLookupLines) {
    change(run, intent, (each) => ({ ...each, bounded: each.error === undefined }));

    return;
  }

  if (isList(looking.lookup)) {
    keepMask(run, looking, line);
  } else {
    keepDescribed(run, looking, line);
  }
};

// Whether a numeric is part of a list's reply on the floor: a mask of that list, its end,
// an error that refuses a `MODE` of a Channel, naming its Channel second, a `421` or
// `461` naming `MODE`, or a `472` naming the list's mode. Others that
// name a Channel second, such as `324` or `332`, the Client reads for something else.
const answersList = (run: Run, looking: Looking, lookup: ListLookup, line: Line): boolean => {
  const { command, params } = line;
  const [, named] = params;
  const fold = folder(run.state);

  // `421` and `461` name the command they refuse, not the Channel.
  if (command === "421" || command === "461") {
    return named !== undefined && upperCaseAscii(named) === "MODE";
  }

  // `472 <client> <modechar>` names the mode it does not know: the list's own.
  if (command === "472") {
    return named !== undefined && named === looking.mode;
  }

  const holds =
    command === entries[lookup._tag] || command === ends[lookup._tag] || channelErrors.has(command);

  return holds && named !== undefined && fold(named) === fold(lookup.channel);
};

// Whether a `352` on the floor is part of a `WHO` Lookup's reply. It names no mask, only a
// Channel the User is in, or `*`, so it goes to the oldest `WHO` Lookup. The Client's own
// `WHO` of a Channel it joined reads the same `352`s by the Channel they name, so one
// naming a Channel whose answer is still read goes to that answer alone, unless the Lookup
// asked that very Channel, when both read it. The limit: a Lookup of a mask asked while
// that answer is read misses a User it describes by that Channel.
const whoTakes = (run: Run, lookup: Extract<Lookup, { readonly _tag: "Who" }>, line: Line) => {
  const [, channel] = line.params;
  const fold = folder(run.state);

  return (
    channel === undefined || !whoAnswering(run, channel) || fold(channel) === fold(lookup.mask)
  );
};

// Whether a numeric is part of a `NAMES` or `WHO` reply on the floor: its end, or an error,
// naming its Channel or mask second, a `421` or `461` naming its command, or for a `WHO`, a
// `352`. A `353` never comes here: it is read for its meaning, and collected there.
const answersEntries = (run: Run, lookup: EntryLookup, line: Line): boolean => {
  const { command, params } = line;
  const [, named] = params;
  const fold = folder(run.state);

  if (command === "421" || command === "461") {
    return named !== undefined && upperCaseAscii(named) === upperCaseAscii(lookup._tag);
  }

  if (command === "352") {
    return lookup._tag === "Who" && whoTakes(run, lookup, line);
  }

  const holds = command === ends[lookup._tag] || isError(command);

  return holds && named !== undefined && fold(named) === fold(askedOf(lookup));
};

// Whether a numeric, not tied by label, is part of a User's reply on the floor: one its
// kind of reply holds, an error, or another reply numeric, that names its nick second,
// as the protocol says vendors' numerics must. `431` names no nick.
const answersUser = (run: Run, lookup: UserLookup, line: Line): boolean => {
  const { command, params } = line;
  const kind = lookup._tag;
  const other = kind === "Whois" ? "Whowas" : "Whois";

  if (only[other].has(command) || readElsewhere.has(command)) {
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

  return holds && named !== undefined && fold(named) === fold(lookup.nick);
};

// Whether a numeric is part of a `LIST`'s reply on the floor: a `321`, `322`, or `323`,
// which name nothing it asked, so belong to the one `LIST` that awaits, or an error or a
// `263` naming `LIST`.
const answersChannels = (line: Line): boolean => {
  const { command, params } = line;
  const [, named] = params;

  if (command === "321" || command === "322" || command === "323") {
    return true;
  }

  return (
    (isError(command) || command === "263") &&
    named !== undefined &&
    upperCaseAscii(named) === "LIST"
  );
};

// Whether a numeric, not tied by label, is part of a Lookup's reply on the floor.
const answers = (run: Run, looking: Looking, line: Line): boolean => {
  const { command } = line;
  const { lookup } = looking;

  // A reply holds one error, so a Lookup that has one leaves the next to whoever sent
  // another Line naming the nick or Channel.
  const another = looking.error !== undefined && (isError(command) || command === "FAIL");

  if (looking.labelled || another) {
    return false;
  }

  if (isEntries(lookup)) {
    return answersEntries(run, lookup, line);
  }

  if (lookup._tag === "Channels") {
    return answersChannels(line);
  }

  return isList(lookup) ? answersList(run, looking, lookup, line) : answersUser(run, lookup, line);
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

  // A `353` is collected as Features refine it, after this, so a lone labelled one ends
  // its Lookup by `endLone`, once it has been read.
  if (within.ends && !(line.command === "353" && looking.lookup._tag === "Names")) {
    finish(run, within.intent, "End", line.command);
  }

  return true;
};

/**
 * A lone labelled Line is the whole of its Lookup's answer: once it has been read, whether
 * or not it parsed, the Lookup ends, if nothing ended it already.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 */
export const endLone = (run: Run, arrival: Arrival): void => {
  const { within } = arrival;

  if (within?.ends === true && arrival.live) {
    finish(run, within.intent, "End", arrival.line.command);
  }
};

const forgottenOf = (run: Run, channel: string): number =>
  openOf(run.state)?.forgotten.get(folder(run.state)(channel)) ?? 0;

/**
 * Whether a live `366` ends a listing kept apart from the Channel's own, so the Channel's
 * own listing does not end by it: a labelled Lookup's own, or one a forgotten Lookup began,
 * by label or, counted for its Channel, on the floor. One on the floor is taken here, and
 * read by nothing else.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it, before any Lookup collects it.
 * @returns Whether it does.
 */
export const endsApart = (run: Run, arrival: Arrival): boolean => {
  const { line, within } = arrival;
  const [, channel] = line.params;

  if (line.command !== "366" || !arrival.live || channel === undefined) {
    return false;
  }

  if (within !== undefined) {
    const looking = openOf(run.state)?.lookups.find((each) => each.intent === within.intent);

    return (
      looking === undefined ||
      (looking.lookup._tag === "Names" && endsOwn(run, looking.lookup, line))
    );
  }

  const floor = arrival.batch === undefined && !line.tags.has("label");

  if (!floor || forgottenOf(run, channel) === 0) {
    return false;
  }

  const key = folder(run.state)(channel);

  updateOpen(run, (open) => {
    const forgotten = new Map(open.forgotten);
    const left = (forgotten.get(key) ?? 1) - 1;

    if (left > 0) {
      forgotten.set(key, left);
    } else {
      forgotten.delete(key);
    }

    return { ...open, forgotten };
  });

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

// The command a Lookup is sent with.
const verbOf = (lookup: Lookup): string => {
  if (isList(lookup)) {
    return "MODE";
  }

  return lookup._tag === "Channels" ? "LIST" : upperCaseAscii(lookup._tag);
};

/**
 * The oldest Lookup sent without a label that a standard reply, outside any batch or label,
 * names by its command, `WHOIS`, `WHOWAS`, `NAMES`, `WHO`, `LIST`, or a list's `MODE`, compared without regard to
 * ASCII case. One that already has its error keeps a later `FAIL` in its notes.
 * @param run - The step.
 * @param reply - The standard reply.
 * @returns The Lookup, or `undefined` for none.
 */
export const lookupByCommand = (run: Run, reply: StandardReply): Looking | undefined => {
  const verb = upperCaseAscii(reply.command);

  return openOf(run.state)?.lookups.find((each) => !each.labelled && verbOf(each.lookup) === verb);
};

/**
 * Collects a Line into a Lookup's reply, as {@link floorLookup} or
 * {@link lookupByCommand} found it. A `FAIL` that gives it its result ends it at once, and
 * so does an error numeric that gives a list its result.
 * @param run - The step.
 * @param looking - The Lookup.
 * @param line - The Line.
 */
export const collectFloor = (run: Run, looking: Looking, line: Line): void => {
  take(run, looking, line);

  // The protocol promises no end numeric after a `FAIL`, or after an error numeric that
  // refuses a `MODE`, `NAMES`, or `WHO`, so one that gives the Lookup its result ends it, rather than leaving
  // it to wait out its time. A `WHOIS` or `WHOWAS` error numeric is followed by its end
  // numeric, as it always was. A `263` refusing a `LIST` is followed by nothing either.
  const final =
    line.command === "FAIL" ||
    refusesList(looking, line.command) ||
    ((isList(looking.lookup) || isEntries(looking.lookup) || looking.lookup._tag === "Channels") &&
      isError(line.command));

  if (final && looking.error === undefined) {
    finish(run, looking.intent, "End", line.command);
  }
};

/**
 * Collects the members one live `353` lists, as Features refined them, into the `NAMES`
 * Lookup whose reply it is part of: by label, or on the floor, the oldest sent without one
 * of the Channel it names, its time run out or not. Each goes into the Lookup's own
 * listing, and past {@link maxLookupEntries}, no more are reported. A lone labelled one
 * ends its Lookup.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 * @param listed - What it lists.
 * @param part - The same, as part of a listing.
 * @returns Whether a Lookup took it, so the Channel's own listing does not.
 */
export const collectListed = (
  run: Run,
  arrival: Arrival,
  listed: { readonly channel: string; readonly members: readonly Listed[] },
  part: ListedPart
): boolean => {
  const { channel, members } = listed;
  const { within, line } = arrival;
  const fold = folder(run.state);
  const floor = within === undefined && arrival.batch === undefined && !line.tags.has("label");

  // A labelled answer's rows are its Lookup's own, or no one's, once it was forgotten. On
  // the floor, an answer a forgotten Lookup began comes first, and is kept by no one.
  if (floor && forgottenOf(run, channel) > 0) {
    return true;
  }

  const looking = openOf(run.state)?.lookups.find((each) =>
    within === undefined
      ? floor &&
        each.lookup._tag === "Names" &&
        !each.labelled &&
        fold(each.lookup.channel) === fold(channel)
      : each.intent === within.intent
  );

  if (looking?.lookup._tag !== "Names") {
    return within !== undefined;
  }

  const entries: readonly NamesEntry[] = members.map((member) => ({
    nick: member.nick,
    prefixes: prefixesOf(member.prefixes),
  }));

  change(run, looking.intent, (each) => {
    const room = each.error === undefined ? Math.max(0, maxLookupEntries - each.members.length) : 0;

    return {
      ...each,
      bounded: each.bounded || (each.error === undefined && entries.length > room),
      listing: listMore(each.listing, part),
      members: [...each.members, ...entries.slice(0, room)],
    };
  });

  return true;
};

// One more answer a forgotten Lookup began on the floor, for a Channel. Past
// {@link maxForgotten} Channels, the one counted longest ago is no longer counted.
const forgetting = (
  forgotten: ReadonlyMap<string, number>,
  key: string
): ReadonlyMap<string, number> => {
  const next = new Map(forgotten);
  const count = (next.get(key) ?? 0) + 1;

  next.delete(key);
  next.set(key, count);

  const [oldest] = next.keys();

  if (next.size > maxForgotten && oldest !== undefined) {
    next.delete(oldest);
  }

  return next;
};

/**
 * A Lookup's time ran out with no end: it reports what it has.
 * @param run - The step.
 * @param intent - Its intent.
 */
export const expireLookup = (run: Run, intent: IntentId): void => {
  const looking = openOf(run.state)?.lookups.find((each) => each.intent === intent);

  const readsOn = looking?.lookup._tag === "Names" || looking?.lookup._tag === "Channels";

  if (looking === undefined || !readsOn || looking.lapsed) {
    finish(run, intent, "TimedOut", "");

    return;
  }

  report(run, looking, resultOf(looking, "TimedOut", ""));

  // It reads on, as the Client's own `WHO` does, so a `NAMES`'s late `366` still corrects
  // the members, and its late `353`s never reach the Channel's listing, and a `LIST`'s late
  // `322`s are taken, kept by no one, until its `323`, holding off another `LIST` till then.
  // At most {@link maxLookups} `NAMES` read on so, the oldest forgotten first. What a forgotten one would
  // still have read is kept by no one: by its label, or on the floor, counted for its
  // Channel, up to its `366`, so no part of its answer ever replaces the members.
  updateOpen(run, (open) => {
    const lookups = open.lookups.map((each) =>
      each.intent === intent ? { ...each, lapsed: true } : each
    );

    const lapsed = lookups.filter((each) => each.lapsed && each.lookup._tag === "Names");
    const oldest = lapsed.length > maxLookups ? lapsed[0] : undefined;
    const kept = lookups.filter((each) => each !== oldest);

    if (oldest?.lookup._tag !== "Names" || oldest.labelled) {
      return { ...open, lookups: kept };
    }

    return {
      ...open,
      forgotten: forgetting(open.forgotten, folder(run.state)(oldest.lookup.channel)),
      lookups: kept,
    };
  });
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

  for (const looking of gone.filter((each) => !each.lapsed)) {
    report(run, looking, { _tag: "Unsent" });
  }

  return new Set(gone.map((each) => each.intent));
};

/**
 * The Network was removed: each Lookup still awaiting its reply reports what it has now,
 * and is forgotten, since nothing of the Network is reported after its removal.
 * @param run - The step.
 */
export const removedLookups = (run: Run): void => {
  const lookups = openOf(run.state)?.lookups ?? [];

  if (lookups.length === 0) {
    return;
  }

  updateOpen(run, (open) => ({ ...open, lookups: [] }));

  for (const looking of lookups.filter((each) => !each.lapsed)) {
    report(run, looking, resultOf(looking, "Ended", ""));
  }
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

  for (const looking of link.phase.lookups.filter((each) => !each.lapsed)) {
    report(run, looking, resultOf(looking, "Ended", ""));
  }
};
