import { assert, describe, it } from "@effect/vitest";

import type { Entry, Ircd } from "./entry.ts";
import { toEvent } from "./events.ts";

const ircd: Ircd = { host: "irc.test", port: 6697, tls: true };
const encoder = new TextEncoder();
const stamp = { at: 42, sequence: 7 };

const lineEntry = (direction: "inbound" | "outbound", bytes: Uint8Array): Entry => ({
  ...stamp,
  _tag: "Line",
  bytes,
  connection: 1,
  direction,
  network: "libera",
});

const inbound = (bytes: Uint8Array) => lineEntry("inbound", bytes);

describe(toEvent, () => {
  it("maps each Connection phase, taking `at` from the Entry", () => {
    const connection = { ...stamp, _tag: "Connection", ircd, network: "libera" } as const;

    assert.deepStrictEqual(toEvent({ ...connection, phase: "attempt" }), {
      at: 42,
      type: "ATTEMPT",
    });
    assert.deepStrictEqual(toEvent({ ...connection, phase: "opened" }), {
      at: 42,
      type: "OPENED",
    });
    assert.deepStrictEqual(toEvent({ ...connection, phase: "closed", reason: "gone" }), {
      at: 42,
      reason: "gone",
      type: "CLOSED",
    });
  });

  it("gives a `closed` Entry with no reason a reason", () => {
    const event = toEvent({
      ...stamp,
      _tag: "Connection",
      ircd,
      network: "libera",
      phase: "closed",
    });

    assert.strictEqual(event?.type, "CLOSED");
  });

  it("maps a Deadline by name", () => {
    assert.deepStrictEqual(toEvent({ ...stamp, _tag: "Deadline", name: "x", network: "libera" }), {
      at: 42,
      name: "x",
      type: "DEADLINE",
    });
  });

  it("parses an inbound Line from its bytes", () => {
    assert.deepStrictEqual(toEvent(inbound(encoder.encode(":irc.test PING :token"))), {
      at: 42,
      command: "PING",
      params: ["token"],
      type: "LINE",
    });
  });

  it("has no event for an outbound Line, which would answer itself", () => {
    assert.isUndefined(toEvent(lineEntry("outbound", encoder.encode("PING :token"))));
  });

  it("has no event for a cut Line, even one that reads as a command", () => {
    assert.isUndefined(
      toEvent({
        ...stamp,
        _tag: "Line",
        bytes: encoder.encode("ERROR :tail"),
        connection: 1,
        cut: true,
        direction: "inbound",
        network: "libera",
      })
    );
  });

  it("has no event for what is not a Line", () => {
    assert.isUndefined(toEvent(inbound(new Uint8Array())));
    assert.isUndefined(toEvent(inbound(encoder.encode(":source-only"))));
    assert.isUndefined(toEvent(inbound(Uint8Array.of(0, 0, 0))));
  });

  it("has no event for a Daemon Entry", () => {
    assert.isUndefined(toEvent({ ...stamp, _tag: "Daemon", phase: "started", version: "0" }));
  });

  it("never throws, whatever the bytes", () => {
    for (let seed = 1; seed < 2000; seed += 1) {
      const bytes = Uint8Array.from({ length: seed % 97 }, (_, index) => (seed * index * 31) % 256);

      assert.doesNotThrow(() => toEvent(inbound(bytes)));
    }
  });
});
