import { assert, describe, it } from "@effect/vitest";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { ctcpReplyCause, replyExpired } from "./ctcp.ts";
import { droppedIn, entries, host, linesOf, manyTurns, safe, wire } from "./network.fixture.ts";
import type { Overrides } from "./network.fixture.ts";
import { Recorder } from "./recorder.ts";
import { fakeIrcd } from "./testing.ts";
import type { FakeIrcd } from "./testing.ts";

const memory = Effect.provide(Recorder.memoryReadable);

// A Session with its burst over and nothing to join, so the background lane is the
// replies' alone.
const burstOver = Effect.fnUntraced(function* (ircd: FakeIrcd, overrides?: Overrides) {
  const hosted = yield* host(ircd, { channels: [], ...overrides });

  yield* ircd.read(":ircd 001 iirc :Welcome\r\n:ircd 422 iirc :No MOTD\r\n");
  yield* manyTurns;
  yield* TestClock.adjust(`${defaultTuning.rejoinSettleMillis} millis`);
  yield* manyTurns;

  return hosted;
});

const version = (from: string) => `:${from}!u@h.test PRIVMSG iirc :\u0001VERSION\u0001\r\n`;

const reply = (to: string) => `NOTICE ${to} :\u0001VERSION iirc\u0001\r\n`;

const notices = (ircd: FakeIrcd) =>
  Effect.map(wire(ircd), (written) => written.filter((text) => text.startsWith("NOTICE ")));

// Long enough for the background lane to let out anything it holds, at a Line every 2
// seconds, and short of a minute, so no limit runs out.
const drain = Effect.gen(function* () {
  for (let step = 0; step < 25; step += 1) {
    yield* TestClock.adjust("2 seconds");
    yield* manyTurns;
  }
});

describe("PROT-3, PROT-4, HOST-3: a host answers CTCP", () => {
  it.effect("PROT-3: a VERSION gets one NOTICE, recorded as ctcp-reply", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd);
      yield* ircd.read(version("bob"));
      yield* manyTurns;

      assert.deepStrictEqual(yield* notices(ircd), [reply("bob")]);
      assert.deepStrictEqual(
        linesOf(yield* entries)
          .filter(({ direction }) => direction === "outbound")
          .map(({ cause }) => cause)
          .at(-1),
        ctcpReplyCause
      );
    }).pipe(memory)
  );

  it.effect("PROT-4: a NOTICE carrying a CTCP gets nothing", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd);
      yield* ircd.read(":bob!u@h.test NOTICE iirc :\u0001VERSION\u0001\r\n");
      yield* manyTurns;
      yield* drain;

      assert.deepStrictEqual(yield* notices(ircd), []);
    }).pipe(memory)
  );

  it.effect("PROT-4, HOST-3: a flood of 20 VERSIONs from one User gets one", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd);

      for (let index = 0; index < 20; index += 1) {
        yield* ircd.read(version("bob"));
        yield* manyTurns;
      }

      yield* drain;

      assert.deepStrictEqual(yield* notices(ircd), [reply("bob")]);
    }).pipe(memory)
  );

  it.effect("PROT-4, HOST-3: 20 Users get 5 a minute", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const users = Array.from({ length: 20 }, (_unused, index) => `user${index}`);

      yield* burstOver(ircd);
      yield* ircd.read(users.map(version).join(""));
      yield* manyTurns;
      yield* drain;

      assert.deepStrictEqual(yield* notices(ircd), users.slice(0, 5).map(reply));

      // A minute on, the first replies no longer count, and 5 more go out.
      yield* TestClock.adjust("10 seconds");
      yield* ircd.read(users.map(version).join(""));
      yield* manyTurns;
      yield* drain;

      assert.deepStrictEqual(yield* notices(ircd), [
        ...users.slice(0, 5).map(reply),
        ...users.slice(0, 5).map(reply),
      ]);
    }).pipe(memory)
  );

  it.effect("SEND-1, PROT-3: a Message queued alongside a reply goes out first", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const tuning = { ...defaultTuning, floodBurst: 1 };
      const hosted = yield* burstOver(ircd, { tuning });

      yield* hosted.send(safe("PRIVMSG", ["#one", "hi"]), "spends the token");
      yield* ircd.read(version("bob"));
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).lanes.background, 1);

      const said = yield* Effect.forkChild(hosted.send(safe("PRIVMSG", ["#one", "first"]), "api"));

      yield* manyTurns;
      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;
      yield* Fiber.join(said);
      yield* TestClock.adjust("2 seconds");
      yield* manyTurns;

      assert.deepStrictEqual((yield* wire(ircd)).slice(-2), [
        "PRIVMSG #one first\r\n",
        reply("bob"),
      ]);
    }).pipe(memory)
  );

  it.effect("PROT-4: a reply held in the lane past its window is Dropped, not sent late", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      // One Line every 70 seconds, so the lane holds the replies past their minute.
      const tuning = { ...defaultTuning, floodBurst: 1, floodIntervalMillis: 70_000 };
      const users = ["a", "b", "c", "d", "e"];
      const hosted = yield* burstOver(ircd, { tuning });

      yield* hosted.send(safe("PRIVMSG", ["#one", "hi"]), "spends the token");
      yield* ircd.read(users.map(version).join(""));
      yield* manyTurns;

      assert.strictEqual((yield* hosted.status).lanes.background, 5);

      yield* TestClock.adjust("70 seconds");
      yield* manyTurns;

      assert.deepStrictEqual(yield* notices(ircd), []);
      assert.deepStrictEqual(
        droppedIn(yield* entries).map(({ cause, reason }) => [cause, reason]),
        users.map(() => [ctcpReplyCause, replyExpired])
      );
      assert.strictEqual((yield* hosted.status).lanes.background, 0);

      // None of them counts now, so the next request is answered, with the token they left.
      yield* ircd.read(version("f"));
      yield* manyTurns;

      assert.deepStrictEqual(yield* notices(ircd), [reply("f")]);
    }).pipe(memory)
  );

  it.effect("HOST-3: a forged source naming a Channel draws no NOTICE to it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* burstOver(ircd);
      yield* ircd.read(":#victims!u@h PRIVMSG iirc :\u0001VERSION\u0001\r\n");
      yield* ircd.read(":$*.test!u@h PRIVMSG iirc :\u0001VERSION\u0001\r\n");
      yield* manyTurns;
      yield* drain;

      assert.deepStrictEqual(yield* notices(ircd), []);
    }).pipe(memory)
  );
});
