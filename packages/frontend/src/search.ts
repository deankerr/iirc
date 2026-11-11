/**
 * Searching the Messages of the Timelines, as the API's `GET /api/search` does: the
 * Owner's query read into its filters, the results read a page at a time, newest first, and
 * where each result's text holds what was searched for, to mark it. The Daemon reads no
 * syntax from a query, so the words `from:`, `in:`, `network:`, `since:`, and `until:` are
 * read here, and the Timeline `in:` names is found among those the Frontend holds, never
 * guessed.
 *
 * @packageDocumentation
 */
import type {
  NetworkId,
  SearchQuery,
  SearchResults,
  Timeline,
  TimelineId,
  TimelineItem,
} from "@iirc/api";
import {
  SearchText,
  cursorOf,
  foldForSearch,
  searchTextMaximum,
  searchTextMinimum,
} from "@iirc/timelines";
import { Option, Schema } from "effect";

import type { Parsed, SayKind } from "./commands.ts";
import { nickColour, plainCharacters } from "./render.ts";

/** How many results a page of a search asks for. */
export const searchPage = 100;

/** The most results a search holds: past them, it asks for no more, and says so. */
export const searchCap = 500;

/** Where the next page of a search begins, as a page gave it. */
export type ItemAfter = NonNullable<SearchResults["next"]>;

/** An instant, in milliseconds since the Unix epoch, as the API takes one. */
type Instant = NonNullable<SearchQuery["since"]>;

/**
 * What a search looks for: its text, as one run of characters, kept to a Network, a
 * Timeline, a sender, and a range of time when given, as `GET /api/search` takes them.
 */
export interface SearchFilters {
  readonly text: SearchText;
  readonly network: NetworkId | undefined;
  readonly timeline: TimelineId | undefined;
  readonly from: string | undefined;
  /** Kept to those at or after this instant. */
  readonly since: Instant | undefined;
  /** Kept to those before this instant. */
  readonly until: Instant | undefined;
}

/** A day of the calendar, as the Owner wrote it: a year, a month from 1, and a day from 1. */
export interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A Network, and the Timelines it lists, which `in:` is found among. */
export interface SearchNetwork {
  readonly network: NetworkId;
  readonly timelines: readonly Timeline[];
}

/**
 * What a query is read against: the Networks and their Timelines, the Network of the
 * Timeline in focus, and when a day begins in the Owner's time zone, which only the runtime
 * knows, since the core reads no clock, zone, or locale.
 */
export interface QueryContext {
  readonly networks: readonly SearchNetwork[];
  /** The Network of the Timeline in focus, which `in:` is found on unless `network:` names one. */
  readonly focused: NetworkId | undefined;
  /** The instant a day begins in the Owner's time zone, in milliseconds since the epoch. */
  readonly dayStart: (day: Day) => number;
}

const parsed = <A>(value: A): Parsed<A> => ({ _tag: "Parsed", value });

const invalid = <A>(message: string): Parsed<A> => ({ _tag: "Invalid", message });

/** The filters a query may hold, each once. */
const filterNames = ["from", "in", "network", "since", "until"] as const;

type FilterName = (typeof filterNames)[number];

const filterSet: ReadonlySet<string> = new Set(filterNames);

const isFilterName = (name: string): name is FilterName => filterSet.has(name);

/** One word of a query: text, or a filter with its value. */
type Word =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Filter"; readonly name: string; readonly value: string };

const asciiLower = (text: string) => text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

const isSpace = (character: string) => character === " " || character === "\t";

/**
 * Reads a quoted run from just after its opening quote to its closing one.
 * @param text - The query.
 * @param from - Where the run begins, after the quote.
 * @returns The run and where reading goes on, or none when no quote closes it.
 */
const quoted = (
  text: string,
  from: number
): { readonly run: string; readonly end: number } | undefined => {
  const close = text.indexOf('"', from);

  return close === -1 ? undefined : { end: close + 1, run: text.slice(from, close) };
};

/**
 * A query's words: runs between spaces, a quoted run kept whole, spaces and colons
 * included, and `name:value` read as a filter when its name is letters, with a value
 * that may be quoted too.
 * @param text - The query.
 * @returns The words, or why they cannot be read.
 */
const wordsOf = (text: string): Parsed<readonly Word[]> => {
  const words: Word[] = [];
  let at = 0;

  while (at < text.length) {
    const character = text[at] ?? "";

    if (isSpace(character)) {
      at += 1;
    } else if (character === '"') {
      const run = quoted(text, at + 1);

      if (run === undefined) {
        return invalid('A quote is not closed. Close it with another ".');
      }

      words.push({ _tag: "Text", text: run.run });
      at = run.end;
    } else {
      const named = /^(?<name>[A-Za-z]+):/u.exec(text.slice(at))?.groups?.name;

      if (named !== undefined && text[at + named.length + 1] === '"') {
        const run = quoted(text, at + named.length + 2);

        if (run === undefined) {
          return invalid('A quote is not closed. Close it with another ".');
        }

        words.push({ _tag: "Filter", name: asciiLower(named), value: run.run });
        at = run.end;
      } else {
        let end = at;

        while (end < text.length && !isSpace(text[end] ?? "")) {
          end += 1;
        }

        const word = text.slice(at, end);

        words.push(
          named === undefined
            ? { _tag: "Text", text: word }
            : { _tag: "Filter", name: asciiLower(named), value: word.slice(named.length + 1) }
        );
        at = end;
      }
    }
  }

  return parsed(words);
};

/**
 * Text's characters, each one code point, as a search counts and compares them.
 * @param text - The text.
 * @returns Its code points, each as a string.
 */
const codePoints = (text: string): readonly string[] => text.match(/./gsu) ?? [];

// How many characters, by code point, text holds.
const codePointsIn = (text: string): number => codePoints(text).length;

const decodeSearchText = Schema.decodeUnknownOption(SearchText);

/**
 * The text a search looks for, as the API takes it, or why it cannot be, in words.
 * @param text - The words of the query that are not filters, joined by a space.
 * @returns The text.
 */
const searchTextOf = (text: string): Parsed<SearchText> => {
  const folded = codePointsIn(foldForSearch(text));

  if (folded === 0) {
    return invalid(
      `Say what to search for: at least ${searchTextMinimum} characters, with from:, in:, network:, since:, or until: to narrow it.`
    );
  }

  if (folded < searchTextMinimum) {
    return invalid(`Search for at least ${searchTextMinimum} characters.`);
  }

  if (folded > searchTextMaximum) {
    return invalid(`Search for at most ${searchTextMaximum} characters.`);
  }

  const decoded = Option.getOrUndefined(decodeSearchText(text));

  return decoded === undefined
    ? invalid("A search holds no line break, NUL, or broken character.")
    : parsed(decoded);
};

// Days.

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysIn = (year: number, month: number): number => {
  if (month === 2) {
    return isLeap(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/**
 * The day after a day.
 * @param day - The day.
 * @returns The next.
 */
const nextDay = ({ day, month, year }: Day): Day => {
  if (day < daysIn(year, month)) {
    return { day: day + 1, month, year };
  }

  return month < 12 ? { day: 1, month: month + 1, year } : { day: 1, month: 1, year: year + 1 };
};

/**
 * How many days a day of the proleptic Gregorian calendar lies after 1970-01-01, as Howard
 * Hinnant's `days_from_civil` counts them, with no clock or zone.
 * @param day - The day.
 * @returns The days, negative before 1970.
 */
const daysFromEpoch = ({ day, month, year }: Day): number => {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const ofEra = shifted - era * 400;
  const ofYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const ofEras = ofEra * 365 + Math.floor(ofEra / 4) - Math.floor(ofEra / 100) + ofYear;

  return era * 146_097 + ofEras - 719_468;
};

const dayPattern = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

const timePattern =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?)?(?<zone>[Zz]|[+-]\d{2}:\d{2})?$/u;

const zonePattern = /^(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2})$/u;

/**
 * A day as written, if it is one of the calendar.
 * @param groups - The year, month, and day, as written, by name.
 * @returns The day, or none.
 */
const dayOf = (groups: Readonly<Record<string, string | undefined>>): Day | undefined => {
  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);

  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month)
    ? { day, month, year }
    : undefined;
};

/** The milliseconds of each unit. */
const minute = 60_000;
const hour = 60 * minute;
const dayLength = 24 * hour;

/**
 * An instant, if it is a whole number of milliseconds a JavaScript time can be.
 * @param at - The milliseconds.
 * @returns The instant, or none.
 */
const instantOf = (at: number): Instant | undefined =>
  // SAFETY: the API's `Instant` is a whole number of milliseconds since the epoch, which
  // `isSafeInteger` just checked this is. The core cannot hold the Schema's value to decode it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked just before
  Number.isSafeInteger(at) ? (at as Instant) : undefined;

/**
 * A zone's offset from UTC, in milliseconds: `Z` none, or `+HH:MM` or `-HH:MM` within
 * RFC 3339's, hours 00 to 23 and minutes 00 to 59.
 * @param zone - The zone, as written.
 * @returns The offset, or none when it is past those.
 */
const offsetOf = (zone: string): number | undefined => {
  const groups = zonePattern.exec(zone)?.groups;

  if (groups === undefined) {
    return 0;
  }

  const hours = Number(groups.hours);
  const minutes = Number(groups.minutes);

  if (hours > 23 || minutes > 59) {
    return undefined;
  }

  return (groups.sign === "-" ? -1 : 1) * (hours * hour + minutes * minute);
};

/**
 * Where `since:` or `until:` stands: a date, the start of that day in the Owner's time zone
 * for `since:`, and of the next for `until:`, so `until:` takes the whole day it names; or
 * an ISO time with its zone, exactly.
 * @param name - The filter, `since` or `until`.
 * @param value - What was written.
 * @param dayStart - When a day begins in the Owner's time zone.
 * @returns The instant, or why it cannot be read, in words.
 */
const boundOf = (
  name: "since" | "until",
  value: string,
  dayStart: QueryContext["dayStart"]
): Parsed<Instant> => {
  const usage = `${name}: takes a date, such as 2026-11-10, a day in your time zone, or a time with its zone, such as 2026-11-10T09:30Z or 2026-11-10T09:30+01:00.`;
  const date = dayPattern.exec(value)?.groups;

  if (date !== undefined) {
    const day = dayOf(date);

    if (day === undefined) {
      return invalid(`${value} is no day of the calendar. ${usage}`);
    }

    const at = instantOf(dayStart(name === "since" ? day : nextDay(day)));

    return at === undefined ? invalid(`${value} cannot be searched from. ${usage}`) : parsed(at);
  }

  const time = timePattern.exec(value)?.groups;

  if (time === undefined) {
    return invalid(usage);
  }

  const day = dayOf(time);
  const hours = Number(time.hour);
  const minutes = Number(time.minute);
  const seconds = Number(time.second ?? "0");
  const millis = Number((time.fraction ?? "").padEnd(3, "0"));

  if (day === undefined || hours > 23 || minutes > 59 || seconds > 59) {
    return invalid(`${value} is no time of the calendar. ${usage}`);
  }

  if (time.zone === undefined) {
    return invalid(`${value} needs its zone, such as Z or +01:00, or a date alone. ${usage}`);
  }

  const offset = offsetOf(time.zone);

  if (offset === undefined) {
    return invalid(`${time.zone} is no zone's offset. ${usage}`);
  }

  const at = instantOf(
    daysFromEpoch(day) * dayLength +
      hours * hour +
      minutes * minute +
      seconds * 1000 +
      millis -
      offset
  );

  return at === undefined ? invalid(`${value} cannot be searched from. ${usage}`) : parsed(at);
};

// Timelines.

/**
 * The Timelines among some that a name finds: those with exactly that name, or with none,
 * those the Daemon keyed by it, as written or with its ASCII letters lower-cased, which
 * every casemapping folds alike, so nothing another casemapping would fold together is
 * guessed. A detached Direct Message Timeline is found only when nothing else is.
 * @param timelines - The Timelines.
 * @param name - The name.
 * @returns What it finds.
 */
const named = (timelines: readonly Timeline[], name: string): readonly Timeline[] => {
  const lower = asciiLower(name);
  const exact = timelines.filter((one) => one.name === name);

  const found =
    exact.length > 0
      ? exact
      : timelines.filter((one) => one.key !== null && (one.key === name || one.key === lower));

  const attached = found.filter((one) => !one.detached);

  return attached.length > 0 ? attached : found;
};

/**
 * The Timeline `in:` names, on the Network `network:` names, or else the Network in focus,
 * or else on any Network, found only when exactly one is.
 * @param name - The name.
 * @param network - The Network to look on, if one is known.
 * @param networks - The Networks.
 * @returns Its id, or why it cannot be found, in words.
 */
const timelineNamed = (
  name: string,
  network: NetworkId | undefined,
  networks: readonly SearchNetwork[]
): Parsed<TimelineId> => {
  const on = network === undefined ? networks : networks.filter((one) => one.network === network);
  const found = on.flatMap((one) => named(one.timelines, name));
  const [only] = found;

  if (only !== undefined && found.length === 1) {
    return parsed(only.id);
  }

  if (found.length === 0) {
    return invalid(
      network === undefined
        ? `No Timeline is called ${name}.`
        : `${network} has no Timeline called ${name}.`
    );
  }

  const where = [...new Set(found.map((one) => one.network))];

  return invalid(
    where.length > 1
      ? `${name} names Timelines on ${where.join(" and ")}. Say which with network:<id>.`
      : `${name} names more than one Timeline on ${where.join("")}.`
  );
};

/**
 * The filters a query's words give, each at most once, and the words that are not
 * filters, joined by a space as one run of text.
 * @param words - The words.
 * @returns The filters by name, and the text, or why they cannot be read.
 */
const filtersGiven = (
  words: readonly Word[]
): Parsed<{ readonly filters: ReadonlyMap<FilterName, string>; readonly text: string }> => {
  const filters = new Map<FilterName, string>();
  const text: string[] = [];

  for (const word of words) {
    if (word._tag === "Text") {
      text.push(word.text);
    } else if (!isFilterName(word.name)) {
      return invalid(
        `There is no filter ${word.name}:. A search takes from:, in:, network:, since:, and until:. Put text with a colon in quotes, such as "${word.name}:${word.value}".`
      );
    } else if (filters.has(word.name)) {
      return invalid(`${word.name}: is given twice.`);
    } else if (word.value === "") {
      return invalid(`${word.name}: needs a value after it.`);
    } else {
      filters.set(word.name, word.value);
    }
  }

  return parsed({ filters, text: text.join(" ") });
};

/**
 * Where a search is kept: the Network `network:` names, and the Timeline `in:` names.
 * @param filters - The filters given.
 * @param context - What they are read against.
 * @returns The Network and the Timeline, or why they cannot be found, in words.
 */
const placeOf = (
  filters: ReadonlyMap<FilterName, string>,
  context: QueryContext
): Parsed<Pick<SearchFilters, "network" | "timeline">> => {
  const networkName = filters.get("network");
  const network = context.networks.find((one) => one.network === networkName)?.network;

  if (networkName !== undefined && network === undefined) {
    return invalid(`No Network is called ${networkName}.`);
  }

  const inName = filters.get("in");

  if (inName === undefined) {
    return parsed({ network, timeline: undefined });
  }

  const timeline = timelineNamed(inName, network ?? context.focused, context.networks);

  return timeline._tag === "Invalid" ? timeline : parsed({ network, timeline: timeline.value });
};

/**
 * The range of time a search is kept to, by `since:` and `until:`.
 * @param filters - The filters given.
 * @param dayStart - When a day begins in the Owner's time zone.
 * @returns The range, or why it cannot be read, in words.
 */
const rangeOf = (
  filters: ReadonlyMap<FilterName, string>,
  dayStart: QueryContext["dayStart"]
): Parsed<Pick<SearchFilters, "since" | "until">> => {
  const sinceText = filters.get("since");
  const untilText = filters.get("until");
  const since = sinceText === undefined ? undefined : boundOf("since", sinceText, dayStart);
  const until = untilText === undefined ? undefined : boundOf("until", untilText, dayStart);

  if (since?._tag === "Invalid") {
    return since;
  }

  if (until?._tag === "Invalid") {
    return until;
  }

  if (since !== undefined && until !== undefined && since.value >= until.value) {
    return invalid("since: must come before until:.");
  }

  return parsed({ since: since?.value, until: until?.value });
};

/**
 * The Owner's query read into a search's filters: words that are not filters, joined by a
 * space, as one run of text, a quoted run kept whole, and each of `from:<nick>`,
 * `in:<#channel|nick>`, `network:<id>`, `since:<date>`, and `until:<date>` at most once.
 * Anything it cannot read is said in words, and nothing is searched.
 * @param query - The query, as typed.
 * @param context - What it is read against.
 * @returns The filters, or why there are none.
 */
export const parseQuery = (query: string, context: QueryContext): Parsed<SearchFilters> => {
  const words = wordsOf(query);
  const given = words._tag === "Parsed" ? filtersGiven(words.value) : words;

  if (given._tag === "Invalid") {
    return given;
  }

  const { filters, text } = given.value;
  const searched = searchTextOf(text);

  if (searched._tag === "Invalid") {
    return searched;
  }

  const from = filters.get("from");

  if (from !== undefined && (/[\0\r\n ]/u.test(from) || from.length > searchTextMaximum)) {
    return invalid("from: takes one nick, with no space in it.");
  }

  const placed = placeOf(filters, context);

  if (placed._tag === "Invalid") {
    return placed;
  }

  const range = rangeOf(filters, context.dayStart);

  if (range._tag === "Invalid") {
    return range;
  }

  return parsed({ from, text: searched.value, ...placed.value, ...range.value });
};

// The search.

/**
 * A search, as a Frontend holds it: the query in its field, the filters its results are
 * of, the results read so far, newest first, whether more lie beyond them, and which is
 * selected. A page is read only while it is wanted, and an answer is taken only by the
 * generation of the search it was read for.
 */
export interface Search {
  /** The query in the field, as typed. */
  readonly query: string;
  /** What the results are of, or none before anything was searched. */
  readonly searched: SearchFilters | undefined;
  /** Why the query could not be searched, or the search failed, in words. */
  readonly error: string | undefined;
  /** What was found so far, newest first, at most `searchCap`. */
  readonly results: readonly TimelineItem[];
  /** Where the next page begins, while more follow. */
  readonly next: ItemAfter | undefined;
  /** More lie beyond what is held. */
  readonly more: boolean;
  /** The projection version the first page was read at, which every page must share. */
  readonly version: number | undefined;
  /** Which search this is: one begun again is another, and an older answer is not taken. */
  readonly generation: number;
  /** A page is wanted, and not yet asked for. */
  readonly wanted: boolean;
  /** A page is being read. */
  readonly reading: boolean;
  /** How many reads in a row came back unusable, for the runtime to wait longer. */
  readonly attempt: number;
  /** The result selected, by its index. */
  readonly selected: number;
}

/** Before anything is searched. */
export const initialSearch: Search = {
  attempt: 0,
  error: undefined,
  generation: 0,
  more: false,
  next: undefined,
  query: "",
  reading: false,
  results: [],
  searched: undefined,
  selected: 0,
  version: undefined,
  wanted: false,
};

/** A read of a page of a search, for one generation of it. */
export interface SearchRequest {
  readonly _tag: "Search";
  readonly generation: number;
  readonly filters: SearchFilters;
  readonly after: ItemAfter | undefined;
  readonly limit: number;
  readonly attempt: number;
}

/**
 * What happened to a search.
 *
 * - `Typed`: the Owner typed in its field.
 * - `Submitted`: the Owner searched a query, read as given, which begins the search again.
 * - `Restarted`: the changes reported a merge, an overflow, or a reset, so pages read from
 *   here could repeat what was found: it begins again from the first page.
 * - `More`: the next page is wanted, as when the Owner scrolls near the end.
 * - `Selected`: the Owner moved to a result.
 * - `Started`, `Read`, `Failed`: the runtime took on a read, what it answered, or why it
 *   gave up, in words.
 */
export type SearchEvent =
  | { readonly _tag: "Typed"; readonly query: string }
  | { readonly _tag: "Submitted"; readonly query: string; readonly parsed: Parsed<SearchFilters> }
  | { readonly _tag: "Restarted" }
  | { readonly _tag: "More" }
  | { readonly _tag: "Selected"; readonly index: number }
  | { readonly _tag: "Started"; readonly read: SearchRequest }
  | { readonly _tag: "Read"; readonly read: SearchRequest; readonly page: SearchResults }
  | { readonly _tag: "Failed"; readonly read: SearchRequest; readonly message: string };

/**
 * A search begun again from its first page, as a new generation, with what it searches.
 * @param search - The search.
 * @param searched - What it searches, or none.
 * @param error - Why nothing is searched, in words.
 * @param attempt - How many reads in a row came back unusable.
 * @returns The search.
 */
const begun = (
  search: Search,
  searched: SearchFilters | undefined,
  error: string | undefined,
  attempt = 0
): Search => ({
  ...search,
  attempt,
  error,
  generation: search.generation + 1,
  more: false,
  next: undefined,
  reading: false,
  results: [],
  searched,
  selected: 0,
  version: undefined,
  wanted: searched !== undefined,
});

/**
 * The key of a result, unique among them: its Timeline and its position.
 * @param item - The result.
 * @returns Its key.
 */
export const resultKey = (item: TimelineItem): string =>
  `${item.timeline}.${cursorOf(item.position)}`;

/**
 * Takes a page of results, unless it is of another generation. A page after the first read
 * at another projection version does not fit the pages before it, so the search begins
 * again.
 * @param search - The search.
 * @param read - The read the page answers.
 * @param page - The page.
 * @returns The search.
 */
const pageRead = (search: Search, read: SearchRequest, page: SearchResults): Search => {
  if (read.after !== undefined && page.version !== search.version) {
    return begun(search, search.searched, undefined, search.attempt + 1);
  }

  const held = new Set(search.results.map(resultKey));
  const fresh = page.items.filter((item) => !held.has(resultKey(item)));
  const results = [...search.results, ...fresh].slice(0, searchCap);

  return {
    ...search,
    attempt: 0,
    more: page.more,
    next: page.next ?? undefined,
    reading: false,
    results,
    version: page.version,
  };
};

/**
 * A search after an event.
 * @param search - The search before.
 * @param event - What happened.
 * @returns The search after.
 */
export const reduceSearch = (search: Search, event: SearchEvent): Search => {
  switch (event._tag) {
    case "Typed": {
      return { ...search, query: event.query };
    }

    case "Submitted": {
      return event.parsed._tag === "Parsed"
        ? { ...begun(search, event.parsed.value, undefined), query: event.query }
        : { ...begun(search, undefined, event.parsed.message), query: event.query };
    }

    case "Restarted": {
      return search.searched === undefined ? search : begun(search, search.searched, undefined);
    }

    case "More": {
      const room = search.results.length < searchCap;

      return search.more && room && !search.reading && search.error === undefined
        ? { ...search, wanted: true }
        : search;
    }

    case "Selected": {
      const last = Math.max(0, search.results.length - 1);

      return { ...search, selected: Math.min(last, Math.max(0, event.index)) };
    }

    case "Started": {
      return event.read.generation === search.generation
        ? { ...search, reading: true, wanted: false }
        : search;
    }

    case "Read": {
      return event.read.generation === search.generation
        ? pageRead(search, event.read, event.page)
        : search;
    }

    case "Failed": {
      return event.read.generation === search.generation
        ? { ...search, error: event.message, reading: false, wanted: false }
        : search;
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The read a search calls for: the next page while one is wanted and none is in flight.
 * @param search - The search.
 * @returns The read, or none.
 */
export const searchWanted = (search: Search): SearchRequest | undefined =>
  search.wanted && !search.reading && search.searched !== undefined
    ? {
        _tag: "Search",
        after: search.next,
        attempt: search.attempt,
        filters: search.searched,
        generation: search.generation,
        limit: searchPage,
      }
    : undefined;

/**
 * Whether a search stopped at `searchCap` with more beyond, which the Owner narrows to see.
 * @param search - The search.
 * @returns Whether it did.
 */
export const capped = (search: Search): boolean =>
  search.more && search.results.length >= searchCap;

// What a result shows.

/** A run of a result's text: whether it is what was searched for, and its characters. */
export interface MatchRun {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Whether what was sought, folded, stands at a place in text, folded, character by
 * character.
 * @param folded - The text's characters, folded.
 * @param needle - What was sought, folded, by character.
 * @param at - Where to look.
 * @returns Whether it stands there.
 */
const foundAt = (folded: readonly string[], needle: readonly string[], at: number): boolean =>
  needle.length > 0 &&
  at + needle.length <= folded.length &&
  needle.every((character, index) => folded[at + index] === character);

/**
 * A Message's text as plain text, in runs, each that holds what was searched for marked:
 * found as the Daemon finds it, each character lower-cased by `foldForSearch`, one code
 * point to one, so a run's characters are the text's own. The text is the plain text a
 * notification shows, with formatting stripped and controls dropped, and nothing here is
 * markup: a view puts each run in a text node.
 * @param text - The Message's text, as the Network sent it.
 * @param sought - What was searched for.
 * @returns The runs, in order, adjacent runs never alike.
 */
export const matchRuns = (text: string, sought: string): readonly MatchRun[] => {
  const characters = plainCharacters(text);
  const folded = characters.map((character) => foldForSearch(character));
  const needle = codePoints(foldForSearch(sought));
  const runs: MatchRun[] = [];

  const push = (run: string, match: boolean) => {
    const last = runs.at(-1);

    if (run === "") {
      return;
    }

    if (last?.match === match) {
      runs[runs.length - 1] = { match, text: last.text + run };
    } else {
      runs.push({ match, text: run });
    }
  };

  let at = 0;

  while (at < characters.length) {
    if (foundAt(folded, needle, at)) {
      push(characters.slice(at, at + needle.length).join(""), true);
      at += needle.length;
    } else {
      push(characters[at] ?? "", false);
      at += 1;
    }
  }

  return runs;
};

/** A result as a view shows it: who said it, how, and its text in runs, the match marked. */
export interface Found {
  readonly key: string;
  readonly item: TimelineItem;
  readonly kind: SayKind;
  readonly nick: string;
  readonly colour: number;
  readonly runs: readonly MatchRun[];
}

/**
 * A result as a view shows it. Only a Message is ever found, and anything else shows
 * nothing. One of ours shows the text the Ircd confirmed once it did, as it is found by.
 * @param item - The result.
 * @param sought - What was searched for.
 * @returns What it shows, or none.
 */
export const foundOf = (item: TimelineItem, sought: string): Found | undefined => {
  const { content } = item;

  if (content._tag !== "Message") {
    return undefined;
  }

  const delivery = content.ours?.delivery;
  const text = delivery?._tag === "Confirmed" ? delivery.text : content.text;

  return {
    colour: nickColour(content.sender),
    item,
    key: resultKey(item),
    kind: content.kind,
    nick: plainCharacters(content.sender).join(""),
    runs: matchRuns(text, sought),
  };
};
