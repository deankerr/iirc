/**
 * The Owner's clock: how a time of day is drawn, as `ui.timeline.timeFormat` says, in the device's own
 * language and time zone, which only a view reads. Every time of day the web frontend draws
 * comes from here, so no two places can disagree on the form.
 *
 * @packageDocumentation
 */
import type { TimeShown } from "@iirc/api";

/**
 * The form a time of day is drawn in: the clock's hours, and whether it has seconds. The
 * form of `none` is `HH:mm`, as a time that must show, such as a Gap's, still does.
 */
export type ClockForm = Exclude<TimeShown, "none">;

/**
 * The form a time of day is drawn in under an option. A time that must show even when no
 * line's time does, such as a Gap's, a Lookup's signon, or a search result's, takes `HH:mm`.
 * @param shown - How a line's time shows.
 * @returns The form.
 */
export const formOf = (shown: TimeShown): ClockForm => (shown === "none" ? "HH:mm" : shown);

/** The Intl options of each form, which every format here is made from. */
const clockOptions: Readonly<Record<ClockForm, Intl.DateTimeFormatOptions>> = {
  "HH:mm": { hour: "2-digit", hourCycle: "h23", minute: "2-digit" },
  "HH:mm:ss": { hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit" },
  "h:mm a": { hour: "numeric", hourCycle: "h12", minute: "2-digit" },
  "h:mm:ss a": { hour: "numeric", hourCycle: "h12", minute: "2-digit", second: "2-digit" },
};

/**
 * A form's format with its date.
 * @param form - The form.
 * @returns The format.
 */
const datedClock = (form: ClockForm) =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...clockOptions[form],
  });

/** Each form's format, built once, as a format is costly to build and cheap to use. */
const clocks: Readonly<Record<ClockForm, Intl.DateTimeFormat>> = {
  "HH:mm": new Intl.DateTimeFormat(undefined, clockOptions["HH:mm"]),
  "HH:mm:ss": new Intl.DateTimeFormat(undefined, clockOptions["HH:mm:ss"]),
  "h:mm a": new Intl.DateTimeFormat(undefined, clockOptions["h:mm a"]),
  "h:mm:ss a": new Intl.DateTimeFormat(undefined, clockOptions["h:mm:ss a"]),
};

/** Each form's format with its date, built once. Intl forbids a `dateStyle` beside an hour. */
const datedClocks: Readonly<Record<ClockForm, Intl.DateTimeFormat>> = {
  "HH:mm": datedClock("HH:mm"),
  "HH:mm:ss": datedClock("HH:mm:ss"),
  "h:mm a": datedClock("h:mm a"),
  "h:mm:ss a": datedClock("h:mm:ss a"),
};

/**
 * The format that draws a date and a time of day, as `ui.timeline.timeFormat` says: the day, the month,
 * and the year, then the clock. Where a time shows beyond a line's own, such as on hover, a
 * search result, a topic's, or a signon, it is this.
 * @param shown - How a line's time shows.
 * @returns The format, which is `HH:mm`'s for `none`.
 */
export const datedClockFor = (shown: TimeShown): Intl.DateTimeFormat => datedClocks[formOf(shown)];

/**
 * The format that draws a time of day, as `ui.timeline.timeFormat` says.
 * @param shown - How a line's time shows.
 * @returns The format, which is `HH:mm`'s for `none`.
 */
export const clockFor = (shown: TimeShown): Intl.DateTimeFormat => clocks[formOf(shown)];

/**
 * Whether a form has seconds, which says how its unavailable placeholder reads.
 * @param shown - How a line's time shows.
 * @returns Whether it does.
 */
export const hasSeconds = (shown: TimeShown): boolean =>
  shown === "HH:mm:ss" || shown === "h:mm:ss a";

/** Local midnight and noon: an hour of two digits in each day period, on any day. */
const midnight = new Date(2000, 0, 1, 0);
const noon = new Date(2000, 0, 1, 12);

/**
 * The sample a time column is measured by, as lines of text the column is as wide as the
 * widest of. Digits are as wide as each other, so a 24-hour time needs one. A 12-hour time
 * needs one in each day period, as AM and PM can differ in width, and midnight's hour and
 * noon's are each two digits. None for `none`, whose column is empty.
 * @param shown - How a line's time shows.
 * @returns The sample, or nothing.
 */
export const sampleOf = (shown: TimeShown): string | undefined => {
  switch (shown) {
    case "none": {
      return undefined;
    }

    case "HH:mm":
    case "HH:mm:ss": {
      return clocks[shown].format(midnight);
    }

    case "h:mm a":
    case "h:mm:ss a": {
      return `${clocks[shown].format(midnight)}\n${clocks[shown].format(noon)}`;
    }

    default: {
      return shown satisfies never;
    }
  }
};
