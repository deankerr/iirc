import { describe, expect, it } from "vitest";

import { dateOf, formattedAt } from "./dates.ts";

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
