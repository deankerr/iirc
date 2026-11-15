import type { DayShown } from "@iirc/api";
import { describe, expect, it } from "vitest";

import { dayIso, dayWritten } from "./day.ts";

// A local instant at noon, so no zone puts it on another day.
const noon = new Date(2026, 10, 5, 12).getTime();

const forms: readonly DayShown[] = ["full", "long", "medium", "short", "iso"];

describe("a day written", () => {
  it("is written as the device writes a date for each style, and as 2026-11-05 for iso", () => {
    const written = Object.fromEntries(forms.map((shown) => [shown, dayWritten(shown, noon)]));

    expect(written).toStrictEqual({
      full: new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(noon),
      iso: "2026-11-05",
      long: new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(noon),
      medium: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(noon),
      short: new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(noon),
    });
  });

  it("is none for an instant a Date cannot hold, in every form", () => {
    const hostile = 9_000_000_000_000_000;

    expect({
      iso: dayIso(hostile),
      none: forms.every((shown) => dayWritten(shown, hostile) === undefined),
    }).toStrictEqual({ iso: undefined, none: true });
    expect(dayIso(noon)).toBe("2026-11-05");
  });

  it("writes a year before 0 with its sign, and gives HTML no date for it", () => {
    const ancient = new Date(2026, 0, 2, 12);

    ancient.setFullYear(-1);

    expect({
      iso: dayWritten("iso", ancient.getTime()),
      machine: dayIso(ancient.getTime()),
    }).toStrictEqual({
      iso: "-0001-01-02",
      machine: undefined,
    });
  });
});
