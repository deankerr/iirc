import { describe, expect, it } from "vitest";

import { makeFramer } from "./framer.ts";

const bytes = new TextEncoder();
const text = new TextDecoder();

// Feeds each read in turn and gives every Line, as text.
const frame = (limit: number, reads: readonly string[]) => {
  const framer = makeFramer(limit);

  return reads.flatMap((read) => framer.push(bytes.encode(read)).map((line) => text.decode(line)));
};

describe("the framer", () => {
  it("ends a Line at LF, removing one CR before it", () => {
    expect(frame(512, ["PING :a\r\nPING :b\nPING :c\r\r\n"])).toStrictEqual([
      "PING :a",
      "PING :b",
      "PING :c\r",
    ]);
  });

  it("gives several Lines from one read", () => {
    expect(frame(512, ["one\r\ntwo\r\nthree\r\n"])).toStrictEqual(["one", "two", "three"]);
  });

  it("joins a Line split across reads", () => {
    expect(frame(512, ["PI", "NG :spl", "it\r\n"])).toStrictEqual(["PING :split"]);
  });

  it("strips a CR that arrived in an earlier read than its LF", () => {
    expect(frame(512, ["PING :x\r", "\nPONG :y\r", "\n"])).toStrictEqual(["PING :x", "PONG :y"]);
  });

  it("gives a Line one byte at a time", () => {
    expect(frame(512, "NOTICE * :slow\r\n".split(""))).toStrictEqual(["NOTICE * :slow"]);
  });

  it("skips empty Lines, including a lone CR", () => {
    expect(frame(512, ["\r\n\n\r\nPING :x\r\n\r", "\n"])).toStrictEqual(["PING :x"]);
  });

  it("holds back an unfinished Line, which the end of the stream drops", () => {
    expect(frame(512, ["PING :done\r\nPING :unfin", "ished"])).toStrictEqual(["PING :done"]);
  });

  it("keeps a CR inside a Line", () => {
    expect(frame(512, ["a\rb\r\n"])).toStrictEqual(["a\rb"]);
  });

  it("gives a Line of exactly the limit whole, with or without CR", () => {
    expect(frame(4, ["abcd\r\nefgh\n"])).toStrictEqual(["abcd", "efgh"]);
  });

  it("cuts a Line over the limit, keeping its start, and drops the rest of it", () => {
    expect(frame(4, ["abcde\r\nfghij\nk\r\n"])).toStrictEqual(["abcd", "fghi", "k"]);
  });

  it("does not take a CR past the limit for the Line's ending", () => {
    expect(frame(4, ["abc\rx\r\n"])).toStrictEqual(["abc\r"]);
  });

  it("cuts a long Line that arrives over many reads, and holds no more than the limit", () => {
    const limit = 8701;
    const framer = makeFramer(limit);
    const read = new Uint8Array(4096).fill(0x78);
    const lines: Uint8Array[] = [];

    for (let index = 0; index < 1000; index += 1) {
      lines.push(...framer.push(read));
    }

    lines.push(...framer.push(bytes.encode("\r\nPING :after\r\n")));

    expect(lines.map((line) => line.length)).toStrictEqual([limit, 11]);
    expect(lines[0]?.every((byte) => byte === 0x78)).toBeTruthy();
    expect(text.decode(lines[1])).toBe("PING :after");
  });

  it("gives bytes as they came, not decoded", () => {
    const latin1 = new Uint8Array([0x50, 0xe9, 0xff, 0x00, 0x0d, 0x0a]);

    expect(makeFramer(512).push(latin1)).toStrictEqual([new Uint8Array([0x50, 0xe9, 0xff, 0x00])]);
  });

  it("gives Lines that do not share memory with the read", () => {
    const read = bytes.encode("PING :x\r\n");
    const [line] = makeFramer(512).push(read);

    read.fill(0);

    expect(text.decode(line)).toBe("PING :x");
  });
});
