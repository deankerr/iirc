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
  it("ends a Line at CRLF", () => {
    expect(frame(512, ["PING :a\r\nPING :b\r\n"])).toStrictEqual(["PING :a", "PING :b"]);
  });

  it("ends a Line at a bare LF", () => {
    expect(frame(512, ["PING :a\nPING :b\n"])).toStrictEqual(["PING :a", "PING :b"]);
  });

  it("ends a Line at a bare CR, rather than joining it to the next", () => {
    expect(frame(512, ["PING :a\rPING :b\r"])).toStrictEqual(["PING :a", "PING :b"]);
  });

  it("takes every kind of ending in one read", () => {
    expect(frame(512, ["one\r\ntwo\nthree\rfour\r\n"])).toStrictEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });

  it("ends a Line once at a CRLF split across reads", () => {
    expect(frame(512, ["PING :x\r", "\nPONG :y\r", "\n"])).toStrictEqual(["PING :x", "PONG :y"]);
  });

  it("ends a Line at a CR at the end of a read, before the next Line's read", () => {
    expect(frame(512, ["PING :x\r", "PING :y\r"])).toStrictEqual(["PING :x", "PING :y"]);
  });

  it("gives nothing between LF and CR, which are two endings", () => {
    expect(frame(512, ["PING :x\n\rPING :y\n", "\r"])).toStrictEqual(["PING :x", "PING :y"]);
  });

  it("joins a Line split across reads", () => {
    expect(frame(512, ["PI", "NG :spl", "it\r\n"])).toStrictEqual(["PING :split"]);
  });

  it("gives a Line one byte at a time", () => {
    expect(frame(512, "NOTICE * :slow\r\n".split(""))).toStrictEqual(["NOTICE * :slow"]);
  });

  it("skips empty Lines", () => {
    expect(frame(512, ["\r\n\n\r\r\nPING :x\r\n\r", "\n"])).toStrictEqual(["PING :x"]);
  });

  it("holds back an unfinished Line, which the end of the stream drops", () => {
    expect(frame(512, ["PING :done\r\nPING :unfin", "ished"])).toStrictEqual(["PING :done"]);
  });

  it("gives a Line of exactly the limit whole", () => {
    expect(frame(4, ["abcd\r\nefgh\n"])).toStrictEqual(["abcd", "efgh"]);
  });

  it("cuts a Line over the limit, keeping its start, and drops the rest of it", () => {
    expect(frame(4, ["abcdefg\r\nhi\r\n"])).toStrictEqual(["abcd", "hi"]);
  });

  it.each([
    ["CR", "\r"],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("recovers after a cut Line that ends in %s", (_, ending) => {
    expect(frame(4, [`abcdefgh${ending}next${ending}`])).toStrictEqual(["abcd", "next"]);
    expect(frame(4, ["abcde", "fgh", ending, `next${ending}`])).toStrictEqual(["abcd", "next"]);
  });

  it("cuts a long Line that arrives over many reads, and holds no more than the limit", () => {
    const limit = 8701;
    const framer = makeFramer(limit);
    const read = new Uint8Array(4096).fill(0x78);
    const lines: Uint8Array[] = [];

    for (let index = 0; index < 1000; index += 1) {
      lines.push(...framer.push(read));
    }

    lines.push(...framer.push(bytes.encode("\rPING :after\r\n")));

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
