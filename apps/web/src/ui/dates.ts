/**
 * Instants as the Owner reads them, guarded. An instant a Network gave can be any safe
 * integer, but a JavaScript `Date` holds only ±8.64e15 ms, and past that `format` and
 * `toISOString` throw `RangeError`, so every instant shown goes through here and one out
 * of range shows as unavailable rather than taking the page down.
 *
 * @packageDocumentation
 */

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
