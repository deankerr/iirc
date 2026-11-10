/**
 * The Runtime's Outbox: each Connection's Lines leave at pace, `PING` and `PONG` first,
 * and what never leaves comes back to the Client as `Unsent`. Shutdown says `QUIT`
 * through the Client and hangs up within its bound.
 */
import { ConnectionId, Instant } from "@iirc/client";
import type { Client, Input, Output } from "@iirc/client";
import { configured, scripted } from "@iirc/client/testing";
import type { Scripted } from "@iirc/client/testing";
import { CredentialName, encode, isRejected, ping, pong, privmsg, quit } from "@iirc/protocol/line";
import type { OutboundLine, Rejected } from "@iirc/protocol/line";
import { Clock, Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { NetworkId } from "./journal.ts";
import type { Entry } from "./journal.ts";
import { entries, epoch, outline, runTest, settle, startRuntime } from "./testing/harness.ts";
import type { World } from "./testing/harness.ts";
import type { TestCall } from "./testing/memory-transport.ts";

const libera = NetworkId.make("libera");
const configuration = configured();
const ircd = { host: "irc.test", port: 6697, tls: true };
const first = ConnectionId.make(1);
const text = new TextDecoder();

const line = (built: OutboundLine | Rejected): OutboundLine => {
  if (isRejected(built)) {
    throw new Error(`a test Line was rejected: ${built.reason}`);
  }

  return built;
};

const dial: Output = { _tag: "Dial", connection: first, ircd };

const say = (index: number): Output => ({
  _tag: "Send",
  connection: first,
  line: line(privmsg("#iirc", `line ${index}`)),
});

const says = (count: number, from = 1): readonly Output[] =>
  Array.from({ length: count }, (_, index) => say(from + index));

const hangup: Output = { _tag: "Hangup", connection: first };
const sendQuit: Output = { _tag: "Send", connection: first, line: line(quit()) };

const inputs = (all: readonly Entry[]): readonly Input[] =>
  all.flatMap(({ record }) => (record._tag === "Input" ? [record.input] : []));

// A Line as the far end would read it, without its line ending.
const textOf = (sent: OutboundLine): string => {
  const bytes = encode(sent);

  return isRejected(bytes) ? bytes.reason : text.decode(bytes).trimEnd();
};

// The text of each Unsent Line, by input.
const unsentOf = (all: readonly Entry[]): readonly (readonly string[])[] =>
  inputs(all).flatMap((input) =>
    input._tag === "Unsent"
      ? [
          input.outputs.map((output) =>
            output._tag === "Send" ? textOf(output.line) : output.line._tag
          ),
        ]
      : []
  );

// Every Line the far end has heard so far, without waiting for more.
const heardNow = (call: TestCall): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    yield* settle;
    const heard: string[] = [];

    for (;;) {
      const next = yield* Effect.raceFirst(
        call.heard.pipe(Effect.map((bytes) => text.decode(bytes).trimEnd())),
        settle.pipe(Effect.as(undefined))
      );

      if (next === undefined) {
        return heard;
      }

      heard.push(next);
    }
  });

// Starts a Runtime with a scripted Client, configures it, and opens its one Connection.
const opened = <S>(world: World, client: Client<S>, options = {}) =>
  Effect.gen(function* () {
    const started = yield* startRuntime(world, client, options);

    yield* started.runtime.configure(libera, configuration);
    const call = yield* world.memory.ircd.accept;

    yield* call.open;

    return { ...started, call };
  });

const script = (...steps: readonly Scripted[]): readonly Scripted[] => [
  { outputs: [dial], when: "Configured" },
  ...steps,
];

describe("pacing", () => {
  it("sends a burst of 5, then one Line every 2 s, and shows the queue", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { call, runtime } = yield* opened(
          world,
          scripted(script({ outputs: says(8), when: "Opened" }))
        );

        const burst = yield* heardNow(call);
        const queue = (yield* runtime.inspect(libera)).connections;

        yield* TestClock.adjust(1999);
        const early = yield* heardNow(call);

        yield* TestClock.adjust(1);
        const second = yield* heardNow(call);

        yield* TestClock.adjust(4000);

        return { burst, early, queue, rest: yield* heardNow(call), second };
      })
    );

    expect(result).toStrictEqual({
      burst: [
        "PRIVMSG #iirc :line 1",
        "PRIVMSG #iirc :line 2",
        "PRIVMSG #iirc :line 3",
        "PRIVMSG #iirc :line 4",
        "PRIVMSG #iirc :line 5",
      ],
      early: [],
      queue: [{ connection: first, nextAt: Instant.make(epoch + 2000), queued: 3 }],
      rest: ["PRIVMSG #iirc :line 7", "PRIVMSG #iirc :line 8"],
      second: ["PRIVMSG #iirc :line 6"],
    });
  });

  it("takes its pacing from the Runtime's options", async () => {
    const heard = await runTest((world) =>
      Effect.gen(function* () {
        const { call } = yield* opened(
          world,
          scripted(script({ outputs: says(4), when: "Opened" })),
          { pacing: { burst: 2, interval: 500 } }
        );

        const burst = (yield* heardNow(call)).length;

        yield* TestClock.adjust(500);

        return [burst, (yield* heardNow(call)).length];
      })
    );

    expect(heard).toStrictEqual([2, 1]);
  });

  it("lets PING and PONG go ahead of the Lines waiting, and keeps the rest in order", async () => {
    const heard = await runTest((world) =>
      Effect.gen(function* () {
        const pinged: Output = { _tag: "Send", connection: first, line: line(ping("lag")) };
        const ponged: Output = { _tag: "Send", connection: first, line: line(pong("keep")) };

        const { call } = yield* opened(
          world,
          scripted(
            script(
              { outputs: says(7), when: "Opened" },
              { outputs: [pinged, ponged, ...says(1, 8)], when: "Received" }
            )
          )
        );

        yield* heardNow(call);
        yield* call.say(new TextEncoder().encode("PING :keep"));
        yield* TestClock.adjust(10_000);

        return yield* heardNow(call);
      })
    );

    expect(heard).toStrictEqual([
      "PING lag",
      "PONG keep",
      "PRIVMSG #iirc :line 6",
      "PRIVMSG #iirc :line 7",
      "PRIVMSG #iirc :line 8",
    ]);
  });

  it("reveals a Credential when its Line's turn comes, not when it is queued", async () => {
    const heard = await runTest((world) =>
      Effect.gen(function* () {
        const credential = CredentialName.make("server");

        const pass: Output = {
          _tag: "SendSecret",
          connection: first,
          line: { _tag: "Pass", credential },
        };

        yield* world.vault.hold(credential, Redacted.make("old"));

        const { call } = yield* opened(
          world,
          scripted(script({ outputs: [...says(5), pass], when: "Opened" }))
        );

        yield* heardNow(call);
        yield* world.vault.hold(credential, Redacted.make("new"));
        yield* TestClock.adjust(2000);

        return yield* heardNow(call);
      })
    );

    expect(heard).toStrictEqual(["PASS new"]);
  });

  it("steps a Credential that cannot be filled at its turn as Unfilled", async () => {
    const outlined = await runTest((world) =>
      Effect.gen(function* () {
        const pass: Output = {
          _tag: "SendSecret",
          connection: first,
          line: { _tag: "Pass", credential: CredentialName.make("absent") },
        };

        yield* opened(
          world,
          scripted(script({ outputs: [...says(5), pass], when: "Opened" }, { when: "Unfilled" }))
        );
        yield* TestClock.adjust(2000);
        yield* settle;

        return yield* outline(world.journal);
      })
    );

    expect(outlined.slice(3)).toStrictEqual([
      "4 libera of 3: Send Send Send Send Send SendSecret",
      "5 libera Unfilled",
    ]);
  });
});

describe("Unsent", () => {
  it("steps what never left before the Closed of a Connection the Ircd ended", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { call } = yield* opened(
          world,
          scripted(
            script({ outputs: says(8), when: "Opened" }, { when: "Unsent" }, { when: "Closed" })
          )
        );

        yield* heardNow(call);
        yield* call.close("Reset");
        yield* settle;
        const all = yield* entries(world.journal);

        return { outline: (yield* outline(world.journal)).slice(4), unsent: unsentOf(all) };
      })
    );

    expect(result).toStrictEqual({
      outline: ["5 libera Unsent", "6 libera Closed"],
      unsent: [["PRIVMSG #iirc :line 6", "PRIVMSG #iirc :line 7", "PRIVMSG #iirc :line 8"]],
    });
  });

  it("drains at pace after a Hangup, then drops what is left but the QUIT, and hangs up", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { call } = yield* opened(
          world,
          scripted(
            script(
              { outputs: [...says(10), sendQuit, hangup], when: "Opened" },
              { when: "Unsent" },
              { when: "Closed" }
            )
          )
        );

        const burst = (yield* heardNow(call)).length;

        yield* TestClock.adjust(4999);
        const drained = yield* heardNow(call);

        yield* TestClock.adjust(1);
        const last = yield* heardNow(call);

        yield* settle;
        const all = yield* entries(world.journal);
        const closed = inputs(all).find((input) => input._tag === "Closed");

        return {
          burst,
          closed,
          drained,
          last,
          outline: (yield* outline(world.journal)).slice(4),
          unsent: unsentOf(all),
        };
      })
    );

    expect(result).toStrictEqual({
      burst: 5,
      closed: {
        _tag: "Closed",
        at: Instant.make(epoch + 5000),
        connection: first,
        reason: "HungUp",
      },
      drained: ["PRIVMSG #iirc :line 6", "PRIVMSG #iirc :line 7"],
      last: ["QUIT"],
      outline: ["5 libera Unsent", "6 libera Closed"],
      unsent: [["PRIVMSG #iirc :line 8", "PRIVMSG #iirc :line 9", "PRIVMSG #iirc :line 10"]],
    });
  });

  it("hangs up at once when nothing waits", async () => {
    const closedAt = await runTest((world) =>
      Effect.gen(function* () {
        yield* opened(
          world,
          scripted(script({ outputs: [sendQuit, hangup], when: "Opened" }, { when: "Closed" }))
        );
        yield* settle;

        return inputs(yield* entries(world.journal)).find((input) => input._tag === "Closed")?.at;
      })
    );

    expect(closedAt).toBe(epoch);
  });

  it("refuses a Line to a full queue at once, as Unsent, without waiting for room", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { call } = yield* opened(
          world,
          scripted(script({ outputs: says(5), when: "Opened" }, { when: "Unsent" })),
          { outboxCapacity: 3, pacing: { burst: 1, interval: 1000 } }
        );

        yield* settle;
        const all = yield* entries(world.journal);

        return {
          heard: (yield* heardNow(call)).length,
          outline: (yield* outline(world.journal)).slice(4),
          unsent: unsentOf(all),
        };
      })
    );

    expect(result).toStrictEqual({
      heard: 1,
      outline: ["5 libera Unsent"],
      unsent: [["PRIVMSG #iirc :line 4", "PRIVMSG #iirc :line 5"]],
    });
  });
});

describe("shutdown", () => {
  it("steps a Stopping, sends the Client's QUIT, and hangs up within the bound", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { call, close } = yield* opened(
          world,
          scripted(
            script(
              { when: "Opened" },
              { outputs: [sendQuit, hangup], when: "Stopping" },
              { when: "Closed" }
            )
          )
        );

        yield* settle;
        const before = yield* Clock.currentTimeMillis;

        yield* close;

        return {
          elapsed: (yield* Clock.currentTimeMillis) - before,
          heard: yield* heardNow(call),
          outline: yield* outline(world.journal),
        };
      })
    );

    expect(result).toStrictEqual({
      elapsed: 0,
      heard: ["QUIT"],
      outline: [
        "1 libera Configured",
        "2 libera of 1: Dial",
        "3 libera Opened",
        "4 libera Stopping",
        "5 libera of 4: Send Hangup",
        "6 libera Closed",
      ],
    });
  });

  it("drains for at most half the bound, so the QUIT still leaves before it", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const { call, close } = yield* opened(
          world,
          scripted(
            script(
              { outputs: says(9), when: "Opened" },
              { outputs: [sendQuit, hangup], when: "Stopping" },
              { when: "Unsent" },
              { when: "Closed" }
            )
          )
        );

        yield* heardNow(call);
        const before = yield* Clock.currentTimeMillis;

        // Closing moves the TestClock past the bound while shutdown waits.
        yield* close;
        const all = yield* entries(world.journal);
        const closed = inputs(all).find((input) => input._tag === "Closed");

        return {
          closedAfter: (closed?.at ?? 0) - before,
          heard: yield* heardNow(call),
          outline: (yield* outline(world.journal)).slice(4),
          unsent: unsentOf(all),
        };
      })
    );

    expect(result).toStrictEqual({
      closedAfter: 2500,
      heard: ["PRIVMSG #iirc :line 6", "QUIT"],
      outline: [
        "5 libera Stopping",
        "6 libera of 5: Send Hangup",
        "7 libera Unsent",
        "8 libera Closed",
      ],
      unsent: [["PRIVMSG #iirc :line 7", "PRIVMSG #iirc :line 8", "PRIVMSG #iirc :line 9"]],
    });
  });

  it("gives a Network that has stopped no Stopping", async () => {
    const outlined = await runTest((world) =>
      Effect.gen(function* () {
        const throws: Client<null> = {
          initial: null,
          inspect: () => {
            throw new Error("not inspected");
          },
          known: () => {
            throw new Error("not read");
          },
          step: () => {
            throw new Error("a bug");
          },
        };

        const { close, runtime } = yield* startRuntime(world, throws);

        yield* Effect.exit(runtime.configure(libera, configuration));
        yield* close;

        return yield* outline(world.journal);
      })
    );

    expect(outlined).toStrictEqual(["1 libera Configured"]);
  });
});
