import type { TimeShown } from "@iirc/api";
import { describe, expect, it } from "vitest";

import { clockFor, formOf, hasSeconds, sampleOf } from "./clock.ts";

// A local instant in the afternoon, whose 12-hour hour is not its 24-hour one.
const afternoon = new Date(2026, 10, 15, 13, 5, 9);

const forms: readonly TimeShown[] = ["HH:mm", "HH:mm:ss", "h:mm a", "h:mm:ss a", "none"];

/**
 * The parts of a time of day a form draws, by their kind.
 * @param shown - How a line's time shows.
 * @returns The parts' text, by kind.
 */
const partsOf = (shown: TimeShown) =>
  Object.fromEntries(
    clockFor(shown)
      .formatToParts(afternoon)
      .map((part) => [part.type, part.value])
  );

// A number as the device's own digits write it, which a time's hour is in whatever language.
const digits = new Intl.NumberFormat(undefined, { useGrouping: false });

const sample = (shown: TimeShown) => sampleOf(shown)?.split("\n");

const hours = (shown: TimeShown) =>
  sample(shown)?.map((line) => /\p{Nd}+/u.exec(line)?.[0]?.length);

describe("the Owner's clock", () => {
  it("draws a 12-hour time with its day period and a 24-hour one without", () => {
    const [twentyFour, twelve, twelveWithSeconds, withSeconds] = [
      partsOf("HH:mm"),
      partsOf("h:mm a"),
      partsOf("h:mm:ss a"),
      partsOf("HH:mm:ss"),
    ];

    expect({
      twelve: [twelve.hour, "dayPeriod" in twelve],
      twelveWithSeconds: [twelveWithSeconds.hour, "dayPeriod" in twelveWithSeconds],
      twentyFour: [twentyFour.hour, "dayPeriod" in twentyFour],
      withSeconds: [withSeconds.hour, "dayPeriod" in withSeconds],
    }).toStrictEqual({
      twelve: [digits.format(1), true],
      twelveWithSeconds: [digits.format(1), true],
      twentyFour: [digits.format(13), false],
      withSeconds: [digits.format(13), false],
    });
  });

  it("draws seconds in exactly the forms that name them", () => {
    expect(
      Object.fromEntries(
        forms.map((shown) => [shown, ["second" in partsOf(shown), hasSeconds(shown)]])
      )
    ).toStrictEqual({
      "HH:mm": [false, false],
      "HH:mm:ss": [true, true],
      "h:mm a": [false, false],
      "h:mm:ss a": [true, true],
      // A time that must show under none is HH:mm's.
      none: [false, false],
    });
    expect(formOf("none")).toBe("HH:mm");
  });

  it("measures a 12-hour column by a time in each day period, each with an hour of two digits", () => {
    expect({
      none: sampleOf("none"),
      twelve: [sample("h:mm a")?.length, hours("h:mm a")],
      twelveDiffer: new Set(sample("h:mm:ss a")).size,
      twelveWithSeconds: [sample("h:mm:ss a")?.length, hours("h:mm:ss a")],
      twentyFour: [sample("HH:mm")?.length, hours("HH:mm")],
      withSeconds: [sample("HH:mm:ss")?.length, hours("HH:mm:ss")],
    }).toStrictEqual({
      none: undefined,
      twelve: [2, [2, 2]],
      twelveDiffer: 2,
      twelveWithSeconds: [2, [2, 2]],
      twentyFour: [1, [2]],
      withSeconds: [1, [2]],
    });
  });
});
