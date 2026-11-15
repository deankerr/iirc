/**
 * How a day is written where a Timeline's day changes, as `ui.day` says, in the device's
 * own language and time zone, which only a view reads. Every day the web frontend writes
 * comes from here, so no two places can disagree on the form.
 *
 * @packageDocumentation
 */
import type { DayShown } from "@iirc/api";

import { dateOf } from "./dates.ts";

/** The forms that are the device's own way of writing a date, by their `dateStyle`. */
type Styled = Exclude<DayShown, "iso">;

/** Each form's format, built once, as a format is costly to build and cheap to use. */
const formats: Readonly<Record<Styled, Intl.DateTimeFormat>> = {
  full: new Intl.DateTimeFormat(undefined, { dateStyle: "full" }),
  long: new Intl.DateTimeFormat(undefined, { dateStyle: "long" }),
  medium: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }),
  short: new Intl.DateTimeFormat(undefined, { dateStyle: "short" }),
};

/**
 * A number as digits, at least as long as a width.
 * @param value - The number.
 * @param width - The fewest digits.
 * @returns The digits.
 */
const padded = (value: number, width: number) => String(value).padStart(width, "0");

/**
 * The date of an instant in the device's zone as `2026-11-15`: the year at least four
 * digits, with a `-` before it for a year before 0.
 * @param date - The date.
 * @returns The day, written.
 */
const isoOf = (date: Date) => {
  const year = date.getFullYear();
  const sign = year < 0 ? "-" : "";

  return `${sign}${padded(Math.abs(year), 4)}-${padded(date.getMonth() + 1, 2)}-${padded(date.getDate(), 2)}`;
};

/**
 * An instant's day written as `ui.day` says, in the device's zone.
 * @param shown - How a day is written.
 * @param at - The instant.
 * @returns The day, or none when a `Date` cannot hold the instant.
 */
export const dayWritten = (shown: DayShown, at: number): string | undefined => {
  const date = dateOf(at);

  if (date === undefined) {
    return undefined;
  }

  return shown === "iso" ? isoOf(date) : formats[shown].format(date);
};

/**
 * An instant's day as `2026-11-15`, in the device's zone, for a `<time>` to carry. HTML's
 * dates begin at the year 1, so a day before that has none.
 * @param at - The instant.
 * @returns The day, or none when a `Date` cannot hold the instant or HTML cannot write it.
 */
export const dayIso = (at: number): string | undefined => {
  const date = dateOf(at);

  return date === undefined || date.getFullYear() < 1 ? undefined : isoOf(date);
};
