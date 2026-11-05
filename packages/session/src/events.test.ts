import { assert, describe, it } from "@effect/vitest";

import type { Entry, Ircd } from "./entry.ts";
import { toEvent } from "./events.ts";
import { attemptInput } from "./testing.ts";

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

const decoded = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe(toEvent, () => {
  const connection = { ...stamp, _tag: "Connection", ircd, network: "libera" } as const;

  it("maps each Connection phase, taking `at` from the Entry", () => {
    assert.deepStrictEqual(
      toEvent({ ...connection, ...attemptInput, nicks: [], phase: "attempt" }),
      {
        ...attemptInput,
        at: 42,
        nicks: [],
        type: "ATTEMPT",
      }
    );
    assert.deepStrictEqual(toEvent({ ...connection, connection: 1, phase: "opened" }), {
      at: 42,
      type: "OPENED",
    });
    assert.deepStrictEqual(
      toEvent({ ...connection, connection: 1, phase: "closed", reason: "gone" }),
      { at: 42, reason: "gone", type: "CLOSED" }
    );
  });

  it("CONN-4: gives an `attempt` the nicks it recorded, in order", () => {
    assert.deepStrictEqual(
      toEvent({ ...connection, ...attemptInput, nicks: ["claude", "claude_"], phase: "attempt" }),
      { ...attemptInput, at: 42, nicks: ["claude", "claude_"], type: "ATTEMPT" }
    );
  });

  it("CONN-2, LIVE-2: gives an `attempt` the input it recorded, whatever the settings now", () => {
    const tuning = { ...attemptInput.tuning, silenceMillis: 1234 };

    assert.deepInclude(
      toEvent({
        ...connection,
        loginLines: 0,
        nicks: ["claude"],
        phase: "attempt",
        realname: "Then",
        services: [],
        tuning,
        username: "then",
      }),
      { realname: "Then", tuning, username: "then" }
    );
  });

  it("LIVE-9: maps a chosen `closing` Entry with its reason", () => {
    assert.deepStrictEqual(
      toEvent({
        ...connection,
        chosen: true,
        connection: 1,
        phase: "closing",
        reason: "Owner stopped",
      }),
      { at: 42, reason: "Owner stopped", type: "CLOSING" }
    );
  });

  it("LOG-2: maps a `closing` the Daemon did not choose to LEAVING, so a refusal still counts", () => {
    assert.deepStrictEqual(
      toEvent({ ...connection, chosen: false, connection: 1, phase: "closing", reason: "x" }),
      { at: 42, type: "LEAVING" }
    );
  });

  it("LIVE-5: reads nothing into the refusal mark an earlier Daemon wrote", () => {
    assert.deepStrictEqual(
      toEvent({ ...connection, connection: 1, phase: "closed", reason: "banned", refused: true }),
      { at: 42, reason: "banned", type: "CLOSED" }
    );
  });

  it("gives a `closed` Entry with no reason a reason", () => {
    const event = toEvent({ ...connection, connection: 1, phase: "closed" });

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
    assert.deepStrictEqual(toEvent(inbound(encoder.encode(":irc.test 001 claude :Hi"))), {
      at: 42,
      command: "001",
      params: ["claude", "Hi"],
      source: "irc.test",
      type: "LINE",
    });
  });

  it("LIVE-1: gives a PING its token as the bytes that arrived", () => {
    const token = Uint8Array.of(0xff, 0xfe, 0x80);
    const event = toEvent(inbound(Uint8Array.of(...encoder.encode(":irc.test PING :"), ...token)));

    assert.deepStrictEqual(event, { at: 42, token, type: "PING" });
  });

  it("LIVE-1: keeps an ordinary PING's token", () => {
    const event = toEvent(inbound(encoder.encode("PING :token")));

    assert.isTrue(event?.type === "PING" && decoded(event.token ?? new Uint8Array()) === "token");
  });

  it("LIVE-1: gives a bare PING no token, and still a PING", () => {
    assert.deepStrictEqual(toEvent(inbound(encoder.encode("PING"))), {
      at: 42,
      token: undefined,
      type: "PING",
    });
  });

  it("has no event for an outbound Line, which would answer itself", () => {
    assert.isUndefined(toEvent(lineEntry("outbound", encoder.encode("PING :token"))));
    assert.isUndefined(toEvent(lineEntry("outbound", encoder.encode("PRIVMSG #a :hi"))));
    assert.isUndefined(toEvent(lineEntry("outbound", new Uint8Array())));
  });

  it("LIVE-2: says a cut Line was heard, even one that reads as a command", () => {
    for (const text of ["ERROR :tail", "PING :token", "001 claude :Hi", "garbage"]) {
      assert.deepStrictEqual(
        toEvent({
          ...stamp,
          _tag: "Line",
          bytes: encoder.encode(text),
          connection: 1,
          cut: true,
          direction: "inbound",
          network: "libera",
        }),
        { at: 42, type: "HEARD" }
      );
    }
  });

  it("LIVE-2: says what is not a Line was heard, and nothing more", () => {
    for (const bytes of [
      new Uint8Array(),
      encoder.encode(":source-only"),
      encoder.encode("@tags=only"),
      Uint8Array.of(0, 0, 0),
    ]) {
      assert.deepStrictEqual(toEvent(inbound(bytes)), { at: 42, type: "HEARD" });
    }
  });

  it("has no event for a Daemon Entry", () => {
    assert.isUndefined(toEvent({ ...stamp, _tag: "Daemon", phase: "started", version: "0" }));
  });

  it("SEND-4: has no event for a Dropped Entry, which changes nothing on the wire", () => {
    assert.isUndefined(
      toEvent({
        ...stamp,
        _tag: "Dropped",
        bytes: encoder.encode("PRIVMSG #a :late"),
        cause: "owner",
        connection: 1,
        network: "libera",
        reason: "the Connection ended",
      })
    );
  });

  it("LIVE-2: gives every inbound Line an event, whatever the bytes", () => {
    for (let seed = 1; seed < 2000; seed += 1) {
      const bytes = Uint8Array.from({ length: seed % 97 }, (_, index) => (seed * index * 31) % 256);

      assert.isDefined(toEvent(inbound(bytes)));
    }
  });

  it("never throws, whatever the bytes", () => {
    for (let seed = 1; seed < 2000; seed += 1) {
      const bytes = Uint8Array.from({ length: seed % 97 }, (_, index) => (seed * index * 31) % 256);

      assert.doesNotThrow(() => toEvent(inbound(bytes)));
      assert.doesNotThrow(() =>
        toEvent(inbound(Uint8Array.of(0x50, 0x49, 0x4e, 0x47, 0x20, ...bytes)))
      );
    }
  });
});
