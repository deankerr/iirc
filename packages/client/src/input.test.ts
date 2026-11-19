import { isRejected, notice } from "@iirc/protocol/line";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ConnectionId, Instant } from "./ids.ts";
import { Input } from "./input.ts";

const json = Schema.toCodecJson(Input);

// Lines that never left, on Connection 1.
const unsent = (outputs: Extract<Input, { _tag: "Unsent" }>["outputs"]): Input => ({
  _tag: "Unsent",
  at: Instant.make(0),
  connection: ConnectionId.make(1),
  outputs,
});

// An input written to the Journal as JSON, and read back.
const read = (input: Input): Input => {
  const recorded = JSON.stringify(Schema.encodeSync(json)(input));

  return Schema.decodeUnknownSync(json)(JSON.parse(recorded));
};

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

  it("give back a CTCP answer that never left with its request, and read ones recorded before", () => {
    const line = notice("peer", "\u0001VERSION iirc\u0001");

    if (isRejected(line)) {
      throw new Error("the answer's Line is valid");
    }

    const send = { _tag: "Send", connection: ConnectionId.make(1), line } as const;

    const answers = {
      answer: 0,
      channels: ["#iirc"],
      command: "VERSION",
      nick: "peer",
      target: "#iirc",
    };

    expect([read(unsent([{ ...send, answers }])), read(unsent([send]))]).toStrictEqual([
      unsent([{ ...send, answers }]),
      unsent([send]),
    ]);
  });
});
