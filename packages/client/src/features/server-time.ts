/**
 * `server-time`: a Line's `time` tag says when it happened, so a Message's time comes
 * from the Ircd, not from when it arrived. A `time` that does not parse, or a Line
 * without one, leaves the time of receipt.
 *
 * @packageDocumentation
 */
import type { Feature } from "../feature.ts";
import { CapName, FeatureName, Instant } from "../ids.ts";

// `YYYY-MM-DDThh:mm:ss.sssZ`, as the spec writes it. The milliseconds may be left out or
// given to another precision, and `T` and `Z` may be lower case, as RFC 3339 allows. The
// seconds may be 60, for a leap second.
const timeTag =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,9}))?[Zz]$/u;

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const daysIn = (year: number, month: number): number =>
  month === 2 && isLeap(year) ? 29 : (monthDays[month - 1] ?? 0);

/**
 * Days from 1970-01-01 to a date in the proleptic Gregorian calendar, by Howard
 * Hinnant's `days_from_civil`.
 * @param year - The year.
 * @param month - The month, from 1.
 * @param day - The day, from 1.
 * @returns The days, negative before the epoch.
 */
const daysFromCivil = (year: number, month: number, day: number): number => {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;

  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

  return era * 146_097 + dayOfEra - 719_468;
};

const hourMs = 3_600_000;
const minuteMs = 60_000;

/**
 * Reads a `time` tag, without a clock, a time zone, or `Date`.
 * @param value - The tag's value, if there is one.
 * @returns The instant, or `undefined` if it is missing or does not parse.
 */
const parseTime = (value: string | undefined): Instant | undefined => {
  const parts = value === undefined ? undefined : timeTag.exec(value)?.groups;

  if (parts === undefined) {
    return undefined;
  }

  const [year, month, day, hour, minute, second] = [
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ].map(Number);

  const fits =
    year !== undefined &&
    month !== undefined &&
    day !== undefined &&
    hour !== undefined &&
    minute !== undefined &&
    second !== undefined &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60;

  if (!fits) {
    return undefined;
  }

  // A leap second is held at the last millisecond of the minute, so it still sorts
  // after the second before it and before the minute after.
  const millis = second === 60 ? 999 : Number((parts.fraction ?? "").padEnd(3, "0").slice(0, 3));

  return Instant.make(
    daysFromCivil(year, month, day) * 24 * hourMs +
      hour * hourMs +
      minute * minuteMs +
      Math.min(second, 59) * 1000 +
      millis
  );
};

/** The `server-time` Feature. */
export const serverTime: Feature = {
  name: FeatureName.make("server-time"),
  needs: { caps: [CapName.make("server-time")] },
  own: undefined,
  tags: (arrival) => {
    const time = parseTime(arrival.line.tags.get("time"));

    return {
      value:
        time === undefined
          ? arrival
          : { ...arrival, time: { _tag: "Known", at: time, from: "ircd", value: time } },
    };
  },
};
