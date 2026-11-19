import { describe, expect, it } from "vitest";

import { dateOf, formattedAt, zone } from "./dates.ts";

const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

describe("an instant shown", () => {
  it("is formatted while a Date can hold it, and unavailable past that, never throwing", () => {
    // `317 self peer 0 9000000000000` gives this instant: an Instant, but past a Date's range.
    const hostile = 9_000_000_000_000_000;

    expect({
      edge: formattedAt(clock, 8.64e15),
      hostile: [dateOf(hostile), formattedAt(clock, hostile)],
      negative: formattedAt(clock, -9e15),
      ordinary: formattedAt(clock, 3_600_000),
    }).toStrictEqual({
      edge: "00:00",
      hostile: [undefined, undefined],
      negative: undefined,
      ordinary: "01:00",
    });
  });
});

/**
 * The date of an instant in the device's zone, as numbers.
 * @param at - The instant.
 * @returns Its year, month, and day.
 */
const asLocal = (at: number) => {
  const date = new Date(at);

  return [date.getFullYear(), date.getMonth(), date.getDate()];
};

/**
 * The date of an instant moved by the device's zone, read in UTC, as numbers.
 * @param at - The instant.
 * @returns Its year, month, and day.
 */
const asUtc = (at: number) => {
  const shifted = new Date(at + (zone(at) ?? Number.NaN));

  return [shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()];
};

describe("the device's zone", () => {
  it("gives the offset in force at an instant in milliseconds east, and none past a Date's range", () => {
    const at = new Date(2026, 10, 15, 12).getTime();

    expect({
      hostile: zone(9_000_000_000_000_000),
      ordinary: zone(at),
    }).toStrictEqual({
      hostile: undefined,
      // `0 -` so that UTC's offset is +0, as the zone gives it, never -0.
      ordinary: 0 - new Date(at).getTimezoneOffset() * 60_000,
    });
  });

  it("keeps the seconds of a historical offset, so the instant plus it is the local time", () => {
    // Paris kept its mean time, 9 minutes 21 seconds east, until 1911: these two fall either
    // side of local midnight there, which an offset in minutes would miss.
    const instants = [Date.UTC(1890, 0, 1, 23, 50, 38), Date.UTC(1890, 0, 1, 23, 50, 39)];
    const before = process.env.TZ;

    try {
      process.env.TZ = "Europe/Paris";

      expect(instants.map(asUtc)).toStrictEqual(instants.map(asLocal));
    } finally {
      if (before === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = before;
      }
    }
  });
});
