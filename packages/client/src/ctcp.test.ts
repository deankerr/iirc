import { describe, expect, it } from "vitest";

import { imfDate } from "./ctcp.ts";
import { Instant } from "./ids.ts";

describe(imfDate, () => {
  it.each([
    [0, "Thu, 01 Jan 1970 00:00:00 GMT"],
    [951_782_400_000, "Tue, 29 Feb 2000 00:00:00 GMT"],
    [1_709_251_199_000, "Thu, 29 Feb 2024 23:59:59 GMT"],
    [1_767_225_600_999, "Thu, 01 Jan 2026 00:00:00 GMT"],
    [4_102_444_800_000, "Fri, 01 Jan 2100 00:00:00 GMT"],
    [253_402_300_799_000, "Fri, 31 Dec 9999 23:59:59 GMT"],
  ])("writes %d as %s, in UTC, by arithmetic alone", (at, text) => {
    expect(imfDate(Instant.make(at))).toBe(text);
  });
});
