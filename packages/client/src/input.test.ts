import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ConnectionId, Instant } from "./ids.ts";
import { Input } from "./input.ts";

const json = Schema.toCodecJson(Input);

describe("inputs", () => {
  it("survive the Journal's JSON form, bytes and all", () => {
    const received: Input = {
      _tag: "Received",
      at: Instant.make(1_762_600_000_000),
      bytes: new Uint8Array([0x50, 0x49, 0x4e, 0x47, 0xff]),
      connection: ConnectionId.make(3),
    };

    const recorded = JSON.stringify(Schema.encodeSync(json)(received));
    const read: unknown = JSON.parse(recorded);

    expect(Schema.decodeUnknownSync(json)(read)).toStrictEqual(received);
  });

  it("refuse a recorded input that is not one", () => {
    const recorded = JSON.stringify({ _tag: "Fired", at: 1.5, timer: "t" });

    expect(() => Schema.decodeUnknownSync(json)(JSON.parse(recorded))).toThrow(
      "Expected an integer"
    );
  });
});
