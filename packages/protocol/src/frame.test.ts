import { describe, expect, it } from "vitest";

import { maxFrameBytes, takeFrames } from "./frame.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (frame: Uint8Array) => new TextDecoder().decode(frame);

describe(takeFrames, () => {
  it("splits on both line endings", () => {
    const { frames, pending } = takeFrames(new Uint8Array(), bytes("one\r\ntwo\nthree"));

    expect(frames.map(text)).toStrictEqual(["one", "two"]);
    expect(text(pending)).toBe("three");
  });

  it("keeps a character split across chunks whole", () => {
    const snowman = bytes("☃\r\n");
    const first = takeFrames(new Uint8Array(), snowman.subarray(0, 1));
    const second = takeFrames(first.pending, snowman.subarray(1));

    expect(second.frames.map(text)).toStrictEqual(["☃"]);
  });

  it("does not let an endless line grow the buffer", () => {
    const { frames, pending } = takeFrames(
      new Uint8Array(),
      new Uint8Array(maxFrameBytes * 2 + 1).fill(0x78)
    );

    expect(frames).toHaveLength(2);
    expect(pending).toHaveLength(1);
  });
});
