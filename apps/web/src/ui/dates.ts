/**
 * Instants as the Owner reads them, guarded. An instant a Network gave can be any safe
 * integer, but a JavaScript `Date` holds only ±8.64e15 ms, and past that `format` and
 * `toISOString` throw `RangeError`, so every instant shown goes through here and one out
 * of range shows as unavailable rather than taking the page down.
 *
 * @packageDocumentation
 */
import type { Zone } from "@iirc/frontend/timelines";

/**
 * The date of an instant, or none when a `Date` cannot hold it.
 * @param at - The instant, in milliseconds since the Unix epoch.
 * @returns The date, or none.
 */
export const dateOf = (at: number): Date | undefined => {
  const date = new Date(at);

  return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * An instant in a format, or none when a `Date` cannot hold it.
 * @param format - The format.
 * @param at - The instant.
 * @returns The text, or none.
 */
export const formattedAt = (format: Intl.DateTimeFormat, at: number): string | undefined => {
  const date = dateOf(at);

  return date === undefined ? undefined : format.format(date);
};

/**
 * A date's local time in the device's zone, read as if it were UTC: `NaN` when that lies
 * past a `Date`'s range.
 * @param date - The date.
 * @returns The instant whose UTC time is the date's local time.
 */
const wallClockOf = (date: Date): number => {
  // `Date.UTC` reads a year under 100 as one of the 1900s, so the year is set on its own.
  const local = new Date(0);

  local.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  local.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());

  return local.getTime();
};

/**
 * The device's time zone, as the core is given it: the offset from UTC in force at an
 * instant, in milliseconds east, or none when a `Date` cannot hold the instant or its local
 * time. It is the local time read as UTC, less the instant, since `getTimezoneOffset` drops
 * the seconds of a historical offset. This is the one place the page reads the zone, so a
 * day begins at the device's midnight everywhere.
 * @param at - The instant.
 * @returns The offset, or none.
 */
export const zone: Zone = (at) => {
  const date = dateOf(at);
  const offset = date === undefined ? Number.NaN : wallClockOf(date) - at;

  return Number.isNaN(offset) ? undefined : offset;
};
