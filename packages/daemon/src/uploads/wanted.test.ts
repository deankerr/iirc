import { describe, expect, it } from "vitest";

import { wantedOf } from "./wanted.ts";

const tag = '"k3x9abcdefgh7f2q"';

const get = (headers: Record<string, string>) => wantedOf({ headers }, tag, 10);

describe("what a request for bytes wants", () => {
  it("is the whole with no Range", () => {
    expect(get({})).toStrictEqual({ _tag: "Whole" });
  });

  it("is one range, its last position included", () => {
    expect(get({ range: "bytes=2-5" })).toStrictEqual({ _tag: "Part", end: 6, start: 2 });
  });

  it("is from a position to the end, or the last so many bytes", () => {
    expect([get({ range: "bytes=7-" }), get({ range: "bytes=-3" })]).toStrictEqual([
      { _tag: "Part", end: 10, start: 7 },
      { _tag: "Part", end: 10, start: 7 },
    ]);
  });

  it("clamps a range past the end, and a suffix longer than the bytes", () => {
    expect([get({ range: "bytes=8-100" }), get({ range: "bytes=-50" })]).toStrictEqual([
      { _tag: "Part", end: 10, start: 8 },
      { _tag: "Part", end: 10, start: 0 },
    ]);
  });

  it("reads the unit in any case, and spaces around the range", () => {
    expect(get({ range: "Bytes= 2-5 ," })).toStrictEqual({ _tag: "Part", end: 6, start: 2 });
  });

  it("is the whole for several ranges", () => {
    expect(get({ range: "bytes=0-1,4-5" })).toStrictEqual({ _tag: "Whole" });
  });

  it("is unsatisfiable for a range that begins past the end, or an empty suffix", () => {
    expect([
      get({ range: "bytes=10-" }),
      get({ range: "bytes=20-30" }),
      get({ range: "bytes=-0" }),
    ]).toStrictEqual([
      { _tag: "Unsatisfiable" },
      { _tag: "Unsatisfiable" },
      { _tag: "Unsatisfiable" },
    ]);
  });

  it("is the whole for another unit, or a range that does not parse", () => {
    expect(
      ["items=0-1", "bytes=5-2", "bytes=abc", "bytes=-", "bytes=", "bytes=1-2-3", "0-1"].map(
        (range) => get({ range })
      )
    ).toStrictEqual(Array.from({ length: 7 }, () => ({ _tag: "Whole" })));
  });

  it("is unchanged for If-None-Match holding the tag, weak or strong, alone or among others, or *", () => {
    expect(
      [tag, `W/${tag}`, `"other", ${tag}`, "*"].map((ifNoneMatch) =>
        get({ "if-none-match": ifNoneMatch, range: "bytes=2-5" })
      )
    ).toStrictEqual(Array.from({ length: 4 }, () => ({ _tag: "Unchanged" })));
  });

  it("is not unchanged for another tag, or one that only contains the id", () => {
    expect(
      ['"other"', "k3x9abcdefgh7f2q", '"k3x9abcdefgh7f2q-x"'].map((ifNoneMatch) =>
        get({ "if-none-match": ifNoneMatch })
      )
    ).toStrictEqual(Array.from({ length: 3 }, () => ({ _tag: "Whole" })));
  });

  it("answers a range only while If-Range is the strong tag", () => {
    expect([
      get({ "if-range": tag, range: "bytes=2-5" }),
      get({ "if-range": `W/${tag}`, range: "bytes=2-5" }),
      get({ "if-range": "Wed, 21 Oct 2026 07:28:00 GMT", range: "bytes=2-5" }),
    ]).toStrictEqual([{ _tag: "Part", end: 6, start: 2 }, { _tag: "Whole" }, { _tag: "Whole" }]);
  });
});
