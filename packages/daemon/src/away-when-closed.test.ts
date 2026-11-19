/**
 * Self marked away while no Frontend is open, and back once one has been open a while: the
 * decision where it is made, then through the API on a test clock.
 */
import { DaemonApi, NetworkId } from "@iirc/api";
import { Instant, IntentId } from "@iirc/client";
import { configured } from "@iirc/client/testing";
import { NetworkId as JournalNetworkId } from "@iirc/runtime/journal";
import type { JournalRecord } from "@iirc/runtime/journal";
import { makeMemoryJournal } from "@iirc/runtime/testing";
import type { TestCall } from "@iirc/runtime/testing";
import { Duration, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { comingBack, foldAway, movedOn, moveOf } from "./away-when-closed.ts";
import type { AwaysHeld, Situation } from "./away-when-closed.ts";
import { ApiHandlers } from "./handlers.ts";
import {
  heard,
  layerWorld,
  makeKey,
  makeWorld,
  presenting,
  registerOnFloor,
  say,
  temporaryDirectory,
} from "./testing/world.ts";
import type { World } from "./testing/world.ts";

const five = Duration.minutes(5);

describe("the move a situation calls for", () => {
  const closed: Situation = { after: five, away: false, message: "Away", open: false };

  it.each([
    {
      situation: closed,
      want: { move: { _tag: "Away", message: "Away" }, wait: five },
      why: "closed, and not away, goes away after the wait",
    },
    { situation: { ...closed, after: undefined }, want: undefined, why: "off until set" },
    { situation: { ...closed, open: true }, want: undefined, why: "open, and not away, stays" },
    { situation: { ...closed, away: true }, want: undefined, why: "closed, and away, stays" },
    {
      situation: { ...closed, away: true, open: true },
      want: { move: { _tag: "Back" }, wait: comingBack },
      why: "open, and away, comes back after a short while",
    },
    {
      situation: { ...closed, after: undefined, away: true },
      want: { move: { _tag: "Back" }, wait: Duration.zero },
      why: "turned off while away, comes back now",
    },
  ])("$why", ({ situation, want }) => {
    expect(moveOf(situation)).toStrictEqual(want);
  });
});

const libera = JournalNetworkId.make("libera");
const oftc = JournalNetworkId.make("oftc");
const efnet = JournalNetworkId.make("efnet");

describe("the Networks a move acts on", () => {
  const held: AwaysHeld = new Map([
    [libera, { message: "Away", ours: true }],
    [oftc, { message: "lunch", ours: false }],
    [efnet, { message: undefined, ours: false }],
  ]);

  const networks = [libera, oftc, efnet, JournalNetworkId.make("never")];

  it("goes away on each Network not away, and leaves the Owner's own away as it is", () => {
    expect(movedOn({ _tag: "Away", message: "Away" }, networks, held)).toStrictEqual([
      efnet,
      JournalNetworkId.make("never"),
    ]);
  });

  it("comes back only where it marked Self away", () => {
    expect(movedOn({ _tag: "Back" }, networks, held)).toStrictEqual([libera]);
  });
});

const acted = (message: string | null, intent: string): JournalRecord => ({
  _tag: "Input",
  input: {
    _tag: "Act",
    action: { _tag: "Away", message },
    at: Instant.make(0),
    intent: IntentId.make(intent),
  },
  network: libera,
});

describe("the aways the Journal holds", () => {
  it.each([
    {
      records: [acted("Away", "away-when-closed-1")],
      want: { message: "Away", ours: true },
      why: "one this marked is its own, across a restart",
    },
    {
      records: [acted("Away", "away-when-closed-1"), acted("lunch", "typed")],
      want: { message: "lunch", ours: false },
      why: "the Owner's away over it is the Owner's",
    },
    {
      records: [acted("lunch", "typed"), acted("", "typed")],
      want: { message: undefined, ours: false },
      why: "an empty message is back",
    },
  ])("$why", ({ records, want }) => {
    let held: AwaysHeld = new Map();

    for (const record of records) {
      held = foldAway(held, record);
    }

    expect(held.get(libera)).toStrictEqual(want);
  });
});

const network = NetworkId.make("libera");

const floor = configured({ ircds: [{ host: "irc.test", port: 6667, tls: false }] });

const makeClient = HttpApiTest.groups(DaemonApi, ["networks", "news", "timelines", "options"]);

type Api = Effect.Success<typeof makeClient>;

type Provided = Effect.Services<typeof makeClient> | Layer.Success<ReturnType<typeof presenting>>;

const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 200; turn += 1) {
    yield* Effect.yieldNow;
  }
});

/** The Lines the Client sent, but `PING`, which the Ircd answers as they come. */
type Sent = Queue.Dequeue<string>;

/**
 * Plays the Ircd past registration: answers each `PING`, so the Connection lives however
 * far the clock goes, and keeps every other Line for the test.
 * @param call - The Connection.
 * @returns The Lines sent.
 */
const playing = (call: TestCall) =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<string>();

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(heard(call), (line) =>
          line.startsWith("PING ")
            ? say(call, `:irc.test PONG irc.test ${line.slice(5)}`)
            : Queue.offer(sent, line)
        )
      )
    );

    return sent;
  });

/**
 * Runs a test against the handlers over a world on a test clock, with `libera` configured
 * and registered on the floor.
 * @param test - The test, given the world, the client, and the Lines sent.
 * @returns What it returns.
 */
const run = async <A, E>(
  test: (world: World, api: Api, sent: Sent) => Effect.Effect<A, E, Provided>
): Promise<A> =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const world = yield* makeWorld(yield* makeMemoryJournal);

        const handlers = ApiHandlers.pipe(
          Layer.provideMerge(layerWorld(world, dataDir)),
          Layer.provideMerge(HttpServer.layerServices)
        );

        return yield* Effect.gen(function* () {
          const api = yield* makeClient;

          yield* api.networks.configure({ params: { network }, payload: floor, query: {} });
          const sent = yield* playing(yield* registerOnFloor(world.memory));

          yield* settle;

          const result = yield* test(world, api, sent);

          yield* TestClock.adjust("10 seconds");

          return result;
        }).pipe(Effect.provide(Layer.merge(presenting(key), handlers)));
      })
    ).pipe(Effect.provide(TestClock.layer()))
  );

/**
 * Sets an option, made from the options in force.
 * @param api - The client.
 * @param option - The option.
 * @param value - Its value.
 * @returns The Change's sequence.
 */
const setOption = (api: Api, option: "away.after" | "away.message", value: number | string) =>
  Effect.flatMap(api.options.read(), ({ sequence }) =>
    api.options.set({ params: { option }, payload: { value }, query: { ifSequence: sequence } })
  );

/**
 * Holds the News stream open, as a Frontend does, until the fiber is interrupted.
 * @param api - The client.
 * @returns The fiber reading it.
 */
const followNews = (api: Api) =>
  Effect.flatMap(api.news.follow({ headers: {}, query: {} }), (stream) =>
    Effect.forkScoped(Stream.runDrain(stream))
  );

/**
 * Holds the Timelines' changes open, as the web app does.
 * @param api - The client.
 * @returns The fiber reading them.
 */
const followTimelines = (api: Api) =>
  Effect.flatMap(api.timelines.changes({ headers: {}, query: {} }), (stream) =>
    Effect.forkScoped(Stream.runDrain(stream))
  );

/**
 * Advances the clock ten seconds at a time, letting what woke run, as the Ircd answers.
 * @param duration - How far.
 * @returns An Effect that advances it.
 */
const pass = (duration: Duration.Input) =>
  Effect.gen(function* () {
    let left = Duration.toMillis(Duration.fromInputUnsafe(duration));

    yield* settle;

    while (left > 0) {
      const step = Math.min(left, 10_000);

      yield* TestClock.adjust(step);
      yield* settle;
      left -= step;
    }
  });

/**
 * The next Line sent, a second of the clock at a time, since a Line waits its turn at
 * the Connection's pace.
 * @param sent - The Lines sent.
 * @returns The Line.
 */
const sentNext = (sent: Sent) =>
  Effect.gen(function* () {
    for (let second = 0; second < 60; second += 1) {
      const line = yield* Queue.poll(sent);

      if (line._tag === "Some") {
        return line.value;
      }

      yield* TestClock.adjust(1000);
      yield* settle;
    }

    return yield* Effect.die(new Error("nothing was sent for a minute"));
  });

/**
 * The next Line sent, once the Owner says `marker`, which shows that anything sent before
 * it came first.
 * @param api - The client.
 * @param sent - The Lines sent.
 * @returns The Line.
 */
const sentByMarker = (api: Api, sent: Sent) =>
  Effect.gen(function* () {
    yield* api.networks.say({
      params: { network },
      payload: { kind: "Privmsg", target: "peer", text: "marker" },
    });

    return yield* sentNext(sent);
  });

/**
 * The `Away` acts journaled, by message.
 * @param world - The world.
 * @returns Their messages, in order.
 */
const awayActs = (world: World) =>
  world.journal.read({}).pipe(
    Stream.runCollect,
    Effect.map((entries) =>
      entries.flatMap(({ record }) =>
        record._tag === "Input" &&
        record.input._tag === "Act" &&
        record.input.action._tag === "Away"
          ? [record.input.action.message]
          : []
      )
    )
  );

describe("away while no Frontend is open, on a test clock", () => {
  it("is off until set, then goes away after the wait, journaled as the Owner's /away", async () => {
    const result = await run((world, api, sent) =>
      Effect.gen(function* () {
        yield* pass("1 hour");
        const whileOff = yield* sentByMarker(api, sent);

        yield* setOption(api, "away.message", "gone");
        yield* setOption(api, "away.after", 5);
        yield* pass(Duration.subtract(five, Duration.seconds(3)));
        const beforeTheWait = yield* sentByMarker(api, sent);

        yield* pass("1 second");

        const away = yield* sentNext(sent);

        return { acts: yield* awayActs(world), away, beforeTheWait, whileOff };
      })
    );

    expect(result).toStrictEqual({
      acts: ["gone"],
      away: "AWAY gone",
      beforeTheWait: "PRIVMSG peer marker",
      whileOff: "PRIVMSG peer marker",
    });
  });

  it("comes back only once the Timelines have been followed a short while", async () => {
    const result = await run((world, api, sent) =>
      Effect.gen(function* () {
        yield* setOption(api, "away.after", 5);
        yield* pass(five);
        const away = yield* sentNext(sent);

        yield* followTimelines(api);
        yield* pass(Duration.subtract(comingBack, Duration.seconds(3)));
        const soon = yield* sentByMarker(api, sent);

        yield* pass("1 second");

        const back = yield* sentNext(sent);

        return { acts: yield* awayActs(world), away, back, soon };
      })
    );

    expect(result).toStrictEqual({
      acts: ["Away", null],
      away: "AWAY Away",
      back: "AWAY",
      soon: "PRIVMSG peer marker",
    });
  });

  it("does not come back for News followed a moment, nor go away again", async () => {
    const result = await run((_world, api, sent) =>
      Effect.gen(function* () {
        yield* setOption(api, "away.after", 5);
        yield* pass(five);
        const away = yield* sentNext(sent);

        const follower = yield* followNews(api);

        yield* pass("10 seconds");
        yield* Fiber.interrupt(follower);
        yield* pass("1 hour");

        return { after: yield* sentByMarker(api, sent), away };
      })
    );

    expect(result).toStrictEqual({ after: "PRIVMSG peer marker", away: "AWAY Away" });
  });

  it("comes back for News followed a short while", async () => {
    const result = await run((_world, api, sent) =>
      Effect.gen(function* () {
        yield* setOption(api, "away.after", 5);
        yield* pass(five);
        const away = yield* sentNext(sent);

        yield* followNews(api);
        yield* pass(comingBack);

        return { away, back: yield* sentNext(sent) };
      })
    );

    expect(result).toStrictEqual({ away: "AWAY Away", back: "AWAY" });
  });

  it("leaves an away the Owner set by hand, and its message, as they are", async () => {
    const result = await run((world, api, sent) =>
      Effect.gen(function* () {
        yield* api.networks.act({
          params: { network },
          payload: { action: { _tag: "Away", message: "lunch" } },
        });
        const typed = yield* sentNext(sent);

        yield* setOption(api, "away.after", 5);
        yield* pass("1 hour");
        const closed = yield* sentByMarker(api, sent);

        yield* followNews(api);
        yield* pass("1 hour");

        const open = yield* sentByMarker(api, sent);

        return { acts: yield* awayActs(world), closed, open, typed };
      })
    );

    expect(result).toStrictEqual({
      acts: ["lunch"],
      closed: "PRIVMSG peer marker",
      open: "PRIVMSG peer marker",
      typed: "AWAY lunch",
    });
  });

  it("leaves an away the Owner set over its own, once a Frontend opens", async () => {
    const result = await run((_world, api, sent) =>
      Effect.gen(function* () {
        yield* setOption(api, "away.after", 5);
        yield* pass(five);
        const away = yield* sentNext(sent);

        yield* api.networks.act({
          params: { network },
          payload: { action: { _tag: "Away", message: "lunch" } },
        });
        const typed = yield* sentNext(sent);

        yield* followNews(api);
        yield* pass("1 hour");

        return { away, open: yield* sentByMarker(api, sent), typed };
      })
    );

    expect(result).toStrictEqual({
      away: "AWAY Away",
      open: "PRIVMSG peer marker",
      typed: "AWAY lunch",
    });
  });
});
