import { existsSync } from "node:fs";

import {
  CallerIntent,
  ConfigurationChanged,
  CredentialPathName,
  DaemonApi,
  NetworkId,
  Sequence as WireSequence,
  TimelineId,
  UiChanged,
} from "@iirc/api";
import type {
  Member,
  MembersAfter,
  NewsEvent,
  Resume,
  TimelineChangesEvent,
  TimelineItem,
  UiEvent,
} from "@iirc/api";
import { Instant } from "@iirc/client";
import { configured } from "@iirc/client/testing";
import { Entry } from "@iirc/runtime/journal";
import type { JournalRecord } from "@iirc/runtime/journal";
import { makeMemoryJournal } from "@iirc/runtime/testing";
import { TimelineStoreFailed } from "@iirc/timeline-store";
import type { TimelineStoreService } from "@iirc/timeline-store";
import { makeMemoryTimelineStore } from "@iirc/timeline-store/testing";
import { emptyDirectory, projectionVersion } from "@iirc/timelines";
import { Deferred, Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ApiHandlers, ChangesPage } from "./handlers.ts";
import { ApiKeys } from "./keys.ts";
import { SignIns } from "./sign-ins.ts";
import {
  faultyJournal,
  heard,
  layerWorld,
  makeKey,
  makeWorld,
  presenting,
  presentingSignIn,
  registerOnFloor,
  say,
  temporaryDirectory,
} from "./testing/world.ts";
import type { AppendFault, World } from "./testing/world.ts";

const libera = NetworkId.make("libera");

const floor = configured({
  channels: [{ name: "#iirc" }],
  ircds: [{ host: "irc.test", port: 6667, tls: false }],
});

/** 2026-01-01T00:00:00Z, where every test's clock starts. */
const epoch = 1_767_225_600_000;

const makeClient = HttpApiTest.groups(DaemonApi, [
  "signIn",
  "networks",
  "news",
  "timelines",
  "ui",
  "credentials",
]);

/**
 * Runs a test against the handlers, through an in-process client, on the in-memory ports
 * and a TestClock, with a key made for it.
 * @param test - The test, given the world, a client presenting the key, the key, and the data directory.
 * @param fault - Which Journal appends to fail.
 * @param store - The Timeline store, instead of a fresh one in memory.
 * @param page - How many things one event of the Timelines' changes holds at most.
 * @returns A promise of its result.
 */
// What a test may ask of its context: what the client needs, the key check's client side,
// and the keys and sign-ins behind it.
type Provided =
  | Effect.Services<typeof makeClient>
  | Layer.Success<ReturnType<typeof presenting>>
  | ApiKeys
  | SignIns;

const run = async <A, E>(
  test: (
    world: World,
    api: Effect.Success<typeof makeClient>,
    key: string,
    dataDir: string
  ) => Effect.Effect<A, E, Provided>,
  fault?: AppendFault,
  store?: TimelineStoreService,
  page?: number
): Promise<A> =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(epoch);
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const memory = yield* makeMemoryJournal;

        const world = yield* makeWorld(
          fault === undefined ? memory : faultyJournal(memory, fault),
          store
        );

        const handlers = ApiHandlers.pipe(
          Layer.provide(page === undefined ? Layer.empty : Layer.succeed(ChangesPage, page)),
          Layer.provideMerge(layerWorld(world, dataDir)),
          Layer.provideMerge(HttpServer.layerServices)
        );

        return yield* Effect.gen(function* () {
          const api = yield* makeClient;

          return yield* test(world, api, key, dataDir);
        }).pipe(Effect.provide(Layer.merge(presenting(key), handlers)));
      })
    ).pipe(Effect.provide(TestClock.layer()))
  );

/**
 * A client as a browser is: a sign-in's cookie, and no key.
 * @param token - The sign-in's token.
 * @param headers - What the browser says of the request's origin.
 * @returns The client.
 */
const browser = (token: string, headers: Readonly<Record<string, string>> = {}) =>
  makeClient.pipe(Effect.provide(presentingSignIn(token, headers)));

/**
 * What a call came to: `ok`, or its error's tag.
 * @param effect - The call.
 * @returns The outcome.
 */
const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, { onFailure: (error) => error._tag, onSuccess: () => "ok" });

const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 200; turn += 1) {
    yield* Effect.yieldNow;
  }
});

const happenings = (events: readonly NewsEvent[]) =>
  events.flatMap((event) => (event.event === "happened" ? [event] : []));

const textOf = (item: TimelineItem) =>
  item.content._tag === "Message" ? item.content.text : item.content._tag;

const changesOf = (events: readonly TimelineChangesEvent[]) =>
  events.flatMap((event) => (event.event === "changed" ? [event] : []));

/**
 * What each changed event carries.
 * @param events - The events.
 * @returns Each `changed` event's id, its sequence, and its items' texts.
 */
const briefly = (events: readonly TimelineChangesEvent[]) =>
  changesOf(events).map((event) => ({
    id: event.id,
    items: event.data.items.map(textOf),
    sequence: event.data.sequence,
  }));

/**
 * Configures `libera`, registers it on the floor, and has `peer` say each text to Self.
 * @param world - The ports.
 * @param api - The client.
 * @param texts - What `peer` says.
 * @returns The Connection.
 */
const directly = (world: World, api: Effect.Success<typeof makeClient>, texts: readonly string[]) =>
  Effect.gen(function* () {
    yield* api.networks.configure({ params: { network: libera }, payload: floor, query: {} });
    const call = yield* registerOnFloor(world.memory);

    for (const text of texts) {
      yield* say(call, `:peer!u@h PRIVMSG iirc :${text}`);
    }

    yield* settle;

    return call;
  });

/**
 * The id of the Network's Timeline with a name.
 * @param api - The client.
 * @param name - The Timeline's name.
 * @returns Its id.
 */
const timelineNamed = (api: Effect.Success<typeof makeClient>, name: string) =>
  api.timelines.list({ params: { network: libera }, query: {} }).pipe(
    Effect.flatMap((listed) => {
      const found = listed.timelines.find((each) => each.name === name);

      return found === undefined
        ? Effect.die(new Error(`no Timeline named ${name}`))
        : Effect.succeed(found.id);
    })
  );

/** A store that keeps nothing: every apply fails. */
const failingStore = makeMemoryTimelineStore.pipe(
  Effect.map((store): TimelineStoreService => ({
    ...store,
    apply: () => Effect.fail(new TimelineStoreFailed({ reason: "the test failed this apply" })),
  }))
);

/**
 * The first `changed` event of a stream of the changes.
 * @param events - The stream.
 * @returns An Effect of that event, alone.
 */
const firstChange = <E>(events: Stream.Stream<TimelineChangesEvent, E>) =>
  events.pipe(
    Stream.filter((event) => event.event === "changed"),
    Stream.take(1),
    Stream.runCollect
  );

const stoppedSaying = async (named: "lost" | "kept") =>
  await run(
    (world, api) =>
      Effect.gen(function* () {
        const intent = CallerIntent.make(named);

        yield* api.networks.configure({ params: { network: libera }, payload: floor, query: {} });
        yield* registerOnFloor(world.memory);
        yield* settle;

        const stopped = yield* api.networks
          .say({
            params: { network: libera },
            payload: { intent, kind: "Privmsg", target: "#iirc", text: "hello" },
          })
          .pipe(Effect.flip);

        const said = yield* api.networks.said({ params: { intent, network: libera } });
        const listed = yield* api.networks.list();

        return { listed: listed[0]?.status._tag, said, stopped };
      }),
    (record: JournalRecord) =>
      // Either the Say itself fails to append, or what it output does.
      (named === "lost" && record._tag === "Input" && record.input._tag === "Say") ||
      (named === "kept" &&
        record._tag === "Outputs" &&
        record.outputs.some(
          (output) => output._tag === "Send" && output.line.command === "PRIVMSG"
        ))
        ? "fail"
        : "keep"
  );

/**
 * The first `changed` events of the `ui` options' stream, each as its id and `time`.
 * @param events - The stream.
 * @param count - How many.
 * @returns Them.
 */
const uiChangedIn = <E>(events: Stream.Stream<UiEvent, E>, count: number) =>
  events.pipe(
    Stream.filter((event) => event.event === "changed"),
    Stream.take(count),
    Stream.runCollect,
    Effect.map((all) =>
      all.map((event) =>
        event.event === "changed" ? `${event.id} ${event.data.options.time}` : ""
      )
    )
  );

describe("the handlers", () => {
  it("reads the Configuration in force, and refuses a PUT made from another, with 409", async () => {
    const result = await run((_, api) =>
      Effect.gen(function* () {
        const unknown = yield* outcome(api.networks.configuration({ params: { network: libera } }));
        const params = { network: libera };

        const absent = yield* api.networks
          .configure({ params, payload: floor, query: { ifSequence: 7 } })
          .pipe(Effect.flip);

        const added = yield* api.networks.configure({
          params,
          payload: floor,
          query: { ifSequence: 0 },
        });

        const read = yield* api.networks.configuration({ params });
        const renamed = { ...floor, nicks: ["renamed"] } as const;

        const kept = yield* api.networks.configure({
          params,
          payload: renamed,
          query: { ifSequence: read.sequence },
        });

        const stale = yield* api.networks
          .configure({ params, payload: floor, query: { ifSequence: read.sequence } })
          .pipe(Effect.flip);

        const after = yield* api.networks.configuration({ params });

        return {
          absent,
          added: added.sequence,
          after: { nicks: after.configuration.nicks, sequence: after.sequence },
          kept: kept.sequence,
          read: read.sequence,
          stale,
          unknown,
        };
      })
    );

    expect(result).toStrictEqual({
      absent: new ConfigurationChanged({ network: libera, sequence: null }),
      added: 1,
      // The first `Configured` dials, so its Outputs take sequence 2.
      after: { nicks: ["renamed"], sequence: 3 },
      kept: 3,
      read: 1,
      stale: new ConfigurationChanged({ network: libera, sequence: WireSequence.make(3) }),
      unknown: "UnknownNetwork",
    });
  });

  it("reads the ui options, sets and unsets one made from them, and refuses one made from others with 409", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const fresh = yield* api.ui.read();

        const set = yield* api.ui.set({
          params: { option: "time" },
          payload: { value: "HH:mm:ss" },
          query: { ifSequence: 0 },
        });

        // Made from the options before that Change, so refused, and nothing journaled.
        const stale = yield* api.ui
          .set({
            params: { option: "theme" },
            payload: { value: "dark" },
            query: { ifSequence: 0 },
          })
          .pipe(Effect.flip);

        const theme = yield* api.ui.set({
          params: { option: "theme" },
          payload: { value: "dark" },
          query: { ifSequence: set.sequence },
        });

        const both = yield* api.ui.read();

        // Without `ifSequence`, the latest wins.
        yield* api.ui.set({ params: { option: "theme" }, payload: { value: "light" }, query: {} });
        const unset = yield* api.ui.unset({ params: { option: "time" }, query: {} });
        const after = yield* api.ui.read();

        const refused = yield* api.ui
          .set({ params: { option: "activity" }, payload: { value: "loud" }, query: {} })
          .pipe(Effect.flip);

        const journaled = (yield* Stream.runCollect(world.journal.read({}))).flatMap(
          ({ record }) =>
            record._tag === "Change" ? [`${record.change._tag} ${record.change.option}`] : []
        );

        return {
          after,
          both,
          fresh,
          journaled,
          refused: refused._tag === "InvalidRequest" ? refused.issues : refused._tag,
          set,
          stale,
          theme,
          unset,
        };
      })
    );

    expect(result).toStrictEqual({
      after: {
        options: { activity: "all", colours: "theme", theme: "light", themes: [], time: "HH:mm" },
        sequence: 4,
      },
      both: {
        options: { activity: "all", colours: "theme", theme: "dark", themes: [], time: "HH:mm:ss" },
        sequence: 2,
      },
      fresh: {
        options: { activity: "all", colours: "theme", theme: "system", themes: [], time: "HH:mm" },
        sequence: 0,
      },
      journaled: ["UiSet time", "UiSet theme", "UiSet theme", "UiUnset time"],
      refused: [{ message: "Is not a value of ui.activity", path: ["payload", "value"] }],
      set: { sequence: 1 },
      stale: new UiChanged({ sequence: 1 }),
      theme: { sequence: 2 },
      unset: { sequence: 4 },
    });
  });

  it("follows the ui options, the ones in force first, and resumes after a sequence", async () => {
    const result = await run((_, api) =>
      Effect.gen(function* () {
        // With no place, the options in force come first, before any Change.
        const fromNothing = yield* uiChangedIn(
          yield* api.ui.changes({ headers: {}, query: {} }),
          1
        );

        yield* api.ui.set({ params: { option: "time" }, payload: { value: "none" }, query: {} });

        // After 1, which the header says and wins over the query: only what came later.
        const resumed = yield* Effect.forkChild(
          uiChangedIn(
            yield* api.ui.changes({ headers: { "last-event-id": 1 }, query: { after: 0 } }),
            1
          )
        );

        yield* Effect.yieldNow;
        yield* api.ui.set({
          params: { option: "time" },
          payload: { value: "HH:mm:ss" },
          query: {},
        });

        return { fromNothing, resumed: yield* Fiber.join(resumed) };
      })
    );

    expect(result).toStrictEqual({ fromNothing: ["0 HH:mm"], resumed: ["2 HH:mm:ss"] });
  });

  it("refuses a request with no key, or a key it does not hold", async () => {
    const result = await run((_, api) =>
      Effect.gen(function* () {
        // A client presents what it was made with.
        const anonymous = yield* makeClient.pipe(Effect.provide(presenting(undefined)));
        const guessing = yield* makeClient.pipe(Effect.provide(presenting("iirc_not-a-key")));
        const none = yield* anonymous.networks.list().pipe(Effect.flip);
        const wrong = yield* guessing.networks.list().pipe(Effect.flip);
        const right = yield* api.networks.list();

        return { none: none._tag, right, wrong: wrong._tag };
      })
    );

    expect(result).toStrictEqual({ none: "Unauthorized", right: [], wrong: "Unauthorized" });
  });

  it("configures, registers, joins, says, and hears a Message as News", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const configuredAt = yield* api.networks.configure({
          params: { network: libera },
          payload: floor,
          query: {},
        });

        const call = yield* registerOnFloor(world.memory);

        expect(yield* heard(call)).toBe("JOIN #iirc");
        yield* say(call, ":iirc!~iirc@iirc.test JOIN #iirc");
        yield* say(call, ":irc.test 353 iirc = #iirc :iirc @peer");
        yield* say(call, ":irc.test 366 iirc #iirc :End of /NAMES list.");
        yield* settle;

        const said = yield* api.networks.say({
          params: { network: libera },
          payload: { kind: "Privmsg", target: "#iirc", text: "hello" },
        });

        // Registration and the join spent the burst, so it waits its turn.
        yield* TestClock.adjust(2000);
        const line = yield* heard(call);

        yield* say(call, ":peer!u@h PRIVMSG #iirc :hi there");
        yield* settle;

        const stream = yield* api.news.follow({ headers: {}, query: {} });

        const events = yield* stream.pipe(
          Stream.takeUntil(
            (event) =>
              event.event === "happened" &&
              event.data.news.some((one) => one._tag === "Message" && one.ours === null)
          ),
          Stream.runCollect
        );

        const messages = happenings(events).flatMap((event) =>
          event.data.news.flatMap((one) =>
            one._tag === "Message" ? [`${one.sender} ${one.target} :${one.text}`] : []
          )
        );

        const known = yield* api.networks.known({ params: { network: libera } });
        const listed = yield* api.networks.list();
        const inspected = yield* api.networks.inspect({ params: { network: libera } });

        return {
          configuredAt: configuredAt.sequence,
          ids: happenings(events).every((event) => event.id === event.data.sequence),
          inspected: inspected.client.states,
          line,
          listed,
          members: known.channels.map((channel) => [
            channel.name,
            channel.members.map((member) => member.nick),
          ]),
          messages,
          said: [said._tag, said.intent.length],
          session: known.session._tag,
        };
      })
    );

    expect(result).toStrictEqual({
      configuredAt: 1,
      ids: true,
      inspected: [
        { machine: "network", state: "Connection.Open" },
        { machine: "caps", state: "None" },
        { machine: "presence", state: "Session" },
        { machine: "keepalive", state: "Listening" },
        { machine: "channel #iirc", state: "Joined.Synced" },
      ],
      line: "PRIVMSG #iirc hello",
      listed: [{ network: "libera", status: { _tag: "Running" } }],
      members: [["#iirc", ["iirc", "peer"]]],
      messages: ["iirc #iirc :hello", "peer #iirc :hi there"],
      said: ["Said", 32],
      session: "Registered",
    });
  });

  it("answers a Say the Client refused as it took it: Offline with no Session, Unsendable when no Line can carry it", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* api.networks.configure({ params: { network: libera }, payload: floor, query: {} });
        yield* settle;

        const offline = yield* api.networks.say({
          params: { network: libera },
          payload: {
            intent: CallerIntent.make("early"),
            kind: "Privmsg",
            target: "#iirc",
            text: "hi",
          },
        });

        yield* registerOnFloor(world.memory);
        yield* settle;

        // A list of Targets is never one, so no Line carries it.
        const unsendable = yield* api.networks.say({
          params: { network: libera },
          payload: {
            intent: CallerIntent.make("listed"),
            kind: "Privmsg",
            target: "#a,#b",
            text: "hi",
          },
        });

        const said = yield* api.networks.said({
          params: { intent: CallerIntent.make("early"), network: libera },
        });

        return {
          offline: [offline._tag, offline.intent, "reason" in offline ? offline.reason : undefined],
          said: said._tag,
          unsendable: [
            unsendable._tag,
            unsendable.intent,
            "reason" in unsendable ? unsendable.reason : undefined,
          ],
        };
      })
    );

    expect(result).toStrictEqual({
      offline: ["Refused", "early", { _tag: "Offline" }],
      // Refused, and journaled all the same, at the sequence it answered with.
      said: "Journaled",
      unsendable: ["Refused", "listed", { _tag: "Unsendable" }],
    });
  });

  it("acts on a Network, answers as its step knew, and gives the Ircd's error tied to it as News", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* api.networks.configure({ params: { network: libera }, payload: floor, query: {} });
        yield* settle;

        const offline = yield* api.networks.act({
          params: { network: libera },
          payload: {
            action: { _tag: "Topic", channel: "#iirc", text: "early" },
            intent: CallerIntent.make("early"),
          },
        });

        const call = yield* registerOnFloor(world.memory);

        expect(yield* heard(call)).toBe("JOIN #iirc");
        yield* say(call, ":iirc!~iirc@iirc.test JOIN #iirc");
        yield* say(call, ":irc.test 366 iirc #iirc :End of /NAMES list.");
        yield* settle;

        const unsendable = yield* api.networks.act({
          params: { network: libera },
          payload: { action: { _tag: "Topic", channel: "#a,#b", text: "hi" } },
        });

        const acted = yield* api.networks.act({
          params: { network: libera },
          payload: {
            action: { _tag: "Topic", channel: "#iirc", text: "a new topic" },
            intent: CallerIntent.make("topic"),
          },
        });

        const away = yield* api.networks.act({
          params: { network: libera },
          payload: { action: { _tag: "Away", message: "gone fishing" } },
        });

        // Registration and the join spent the burst, so they wait their turn.
        yield* TestClock.adjust(4000);
        const lines = [yield* heard(call), yield* heard(call)];

        yield* say(call, ":irc.test 482 iirc #iirc :You're not channel operator");
        yield* say(call, ":irc.test 306 iirc :You have been marked as being away");
        yield* settle;

        const stream = yield* api.news.follow({ headers: {}, query: {} });

        const events = yield* stream.pipe(
          Stream.takeUntil(
            (event) =>
              event.event === "happened" &&
              event.data.news.some((one) => one._tag === "Refused" && one.intent === "topic")
          ),
          Stream.runCollect
        );

        const refused = happenings(events).flatMap((event) =>
          event.data.news.flatMap((one) =>
            one._tag === "Refused" ? [[one.intent, one.reason]] : []
          )
        );

        const known = yield* api.networks.known({ params: { network: libera } });

        return {
          acted,
          away: away._tag,
          lines,
          offline: [offline._tag, "reason" in offline ? offline.reason : undefined],
          refused,
          said: yield* api.networks.said({
            params: { intent: CallerIntent.make("topic"), network: libera },
          }),
          self: known.self?.away,
          unknown: yield* api.networks
            .act({
              params: { network: NetworkId.make("nowhere") },
              payload: { action: { _tag: "Nick", nick: "other" } },
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error._tag)
            ),
          unsendable: [unsendable._tag, "reason" in unsendable ? unsendable.reason : undefined],
        };
      })
    );

    expect(result).toMatchObject({
      acted: { _tag: "Acted", intent: "topic" },
      away: "Acted",
      lines: ["TOPIC #iirc :a new topic", "AWAY :gone fishing"],
      offline: ["Refused", { _tag: "Offline" }],
      refused: [
        ["early", { _tag: "Offline" }],
        [expect.any(String), { _tag: "Unsendable" }],
        ["topic", { _tag: "Rejected", reply: "482" }],
      ],
      said: { _tag: "Journaled", sequence: result.acted.sequence },
      self: { _tag: "Known", from: "ircd", value: { message: "gone fishing" } },
      unknown: "UnknownNetwork",
    });
    expect(result.unsendable).toStrictEqual(["Refused", { _tag: "Unsendable" }]);
  });

  it("resumes the News after a sequence, from the query or Last-Event-ID", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* api.networks.configure({ params: { network: libera }, payload: floor, query: {} });
        const call = yield* registerOnFloor(world.memory);

        for (const text of ["one", "two", "three"]) {
          yield* say(call, `:peer!u@h PRIVMSG iirc :${text}`);
        }

        yield* settle;

        const all = yield* api.news.follow({ headers: {}, query: {} }).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.filter((event) => event.event === "happened"),
              Stream.take(3),
              Stream.runCollect
            )
          )
        );

        const sequences = happenings(all).map((event) => event.data.sequence);
        const [, second = 0] = sequences;

        const fromQuery = yield* api.news
          .follow({ headers: {}, query: { after: second } })
          .pipe(Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)));

        // The header wins, as an `EventSource` reconnecting sends it with the first URL.
        const fromHeader = yield* api.news
          .follow({ headers: { "last-event-id": second }, query: { after: 0 } })
          .pipe(Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)));

        return {
          fromHeader: happenings(fromHeader).map((event) => event.data.sequence),
          fromQuery: happenings(fromQuery).map((event) => event.data.sequence),
          third: sequences[2],
        };
      })
    );

    expect(result.fromQuery).toStrictEqual([result.third]);
    expect(result.fromHeader).toStrictEqual([result.third]);
  });

  it("sends a heartbeat while nothing happens", async () => {
    const result = await run((_, api) =>
      Effect.gen(function* () {
        const stream = yield* api.news.follow({ headers: {}, query: {} });
        const fiber = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* TestClock.adjust("31 seconds");

        return yield* Fiber.join(fiber);
      })
    );

    expect(result).toStrictEqual([
      { data: {}, event: "heartbeat" },
      { data: {}, event: "heartbeat" },
    ]);
  });

  it("marks a Timeline read, and gives Read Markers and Highlights as News", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* api.networks.configure({ params: { network: libera }, payload: floor, query: {} });

        const call = yield* registerOnFloor(world.memory);

        expect(yield* heard(call)).toBe("JOIN #iirc");
        yield* say(call, ":iirc!~iirc@iirc.test JOIN #iirc");
        yield* say(call, ":peer!u@h PRIVMSG #iirc :iirc: look");
        yield* settle;

        const read = (target: string | null, millis: number) =>
          api.networks.read({
            params: { network: libera },
            payload: { read: Instant.make(epoch + millis), target },
          });

        const channel = yield* read("#IIRC", 5000);
        const behind = yield* read("#iirc", 4000);
        const own = yield* read(null, 1000);
        const listed = yield* read("#a,#b", 1000);
        const stream = yield* api.news.follow({ headers: {}, query: {} });

        const events = yield* stream.pipe(
          Stream.takeUntil(
            (event) => event.event === "happened" && event.data.sequence === listed.sequence
          ),
          Stream.runCollect
        );

        const unknown = yield* api.networks
          .read({
            params: { network: NetworkId.make("oftc") },
            payload: { read: Instant.make(0), target: null },
          })
          .pipe(Effect.flip);

        return {
          answers: [channel, behind, own, listed].map(({ sequence }) => sequence),
          news: happenings(events).flatMap((event) =>
            event.data.news.flatMap((one): readonly unknown[] => {
              if (one._tag === "Message") {
                return [`${one.sender} :${one.text}${one.highlight ? " (highlight)" : ""}`];
              }

              if (one._tag === "Ignored") {
                return [one.reason._tag];
              }

              return one._tag === "ReadMarker" ? [one] : [];
            })
          ),
          unknown: unknown._tag,
        };
      })
    );

    // Each was journaled and stepped, the one behind and the one that marks nothing too.
    expect(result.answers).toStrictEqual(result.answers.toSorted((left, right) => left - right));
    expect(new Set(result.answers).size).toBe(4);
    expect(result.news).toStrictEqual([
      "peer :iirc: look (highlight)",
      {
        _tag: "ReadMarker",
        read: epoch + 5000,
        where: { _tag: "Channel", key: "#iirc", name: "#IIRC" },
      },
      { _tag: "ReadMarker", read: epoch + 1000, where: { _tag: "Network" } },
      "NoTimeline",
    ]);
    expect(result.unknown).toBe("UnknownNetwork");
  });

  it("refuses a Network it does not know", async () => {
    const result = await run((_, api) =>
      Effect.gen(function* () {
        const said = yield* api.networks
          .say({
            params: { network: libera },
            payload: { kind: "Privmsg", target: "#iirc", text: "hello" },
          })
          .pipe(Effect.flip);

        const known = yield* api.networks.known({ params: { network: libera } }).pipe(Effect.flip);

        return [said, known].map((error) => error._tag);
      })
    );

    expect(result).toStrictEqual(["UnknownNetwork", "UnknownNetwork"]);
  });

  it("answers NetworkStopped as uncertain, and `said` says the Say was never journaled", async () => {
    const result = await stoppedSaying("lost");

    expect(result.stopped).toMatchObject({
      _tag: "NetworkStopped",
      intent: "lost",
      network: "libera",
      outcome: "Uncertain",
    });
    expect(result.said).toStrictEqual({ _tag: "NotJournaled" });
    expect(result.listed).toBe("Stopped");
  });

  it("answers NetworkStopped as uncertain, and `said` says the Say was journaled", async () => {
    const result = await stoppedSaying("kept");

    expect(result.stopped).toMatchObject({ _tag: "NetworkStopped", intent: "kept" });
    expect(result.said).toMatchObject({ _tag: "Journaled" });
  });

  it("holds and forgets Credentials by name, and never shows a value", async () => {
    const secret = "correct-horse-battery-staple";
    const name = CredentialPathName.make("libera-pass");

    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* api.credentials.set({
          params: { name },
          payload: { value: Redacted.make(secret) },
        });
        const listed = yield* api.credentials.list();
        // The Credential is used: `PASS` carries it, and nothing else does.
        yield* api.networks.configure({
          params: { network: libera },
          payload: configured({ ...floor, password: name }),
          query: {},
        });
        const call = yield* world.memory.ircd.accept;

        yield* call.open;
        const sent = [yield* heard(call), yield* heard(call)];

        yield* api.credentials.delete({ params: { name } });
        const after = yield* api.credentials.list();

        const journal = yield* world.journal.read({}).pipe(
          Stream.runCollect,
          Effect.map((entries) =>
            entries.map((entry) => Schema.encodeSync(Schema.toCodecJson(Entry))(entry))
          )
        );

        return {
          after,
          journal: JSON.stringify(journal),
          listed,
          logged: world.logged.join("\n"),
          sent,
        };
      })
    );

    expect({ after: result.after, listed: result.listed, sent: result.sent }).toStrictEqual({
      after: { names: [] },
      listed: { names: ["libera-pass"] },
      sent: ["CAP LS 302", `PASS ${secret}`],
    });
    // The Journal and the log name it, and never hold its value.
    expect(
      [result.journal, result.logged].map((text) => text.includes("libera-pass"))
    ).toStrictEqual([true, true]);
    expect([result.journal, result.logged].map((text) => text.includes(secret))).toStrictEqual([
      false,
      false,
    ]);
  });

  it("authorizes by a sign-in's cookie, and refuses a write from another origin", async () => {
    const name = CredentialPathName.make("libera-pass");

    const result = await run((_, api, key) =>
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const signIns = yield* SignIns;
        const held = yield* Effect.flatMap(keys.verify(Redacted.make(key)), Effect.fromOption);
        const token = yield* signIns.start(held);

        const write = (client: Effect.Success<typeof makeClient>) =>
          outcome(
            client.credentials.set({ params: { name }, payload: { value: Redacted.make("x") } })
          );

        const own = yield* browser(Redacted.value(token), { "sec-fetch-site": "same-origin" });
        const silent = yield* browser(Redacted.value(token));

        const writes = {
          bearer: yield* write(api),
          crossSite: yield* write(
            yield* browser(Redacted.value(token), { "sec-fetch-site": "cross-site" })
          ),
          foreignOrigin: yield* write(
            yield* browser(Redacted.value(token), { origin: "https://evil.test" })
          ),
          sameOrigin: yield* write(own),
          sameSite: yield* write(
            yield* browser(Redacted.value(token), { "sec-fetch-site": "same-site" })
          ),
          silent: yield* write(silent),
        };

        const reads = {
          forged: yield* outcome((yield* browser("iirc_s_forged")).networks.list()),
          silent: yield* outcome(silent.networks.list()),
        };

        yield* signIns.end(token);

        return { after: yield* outcome(own.networks.list()), reads, writes };
      })
    );

    expect(result).toStrictEqual({
      after: "Unauthorized",
      reads: { forged: "Unauthorized", silent: "ok" },
      writes: {
        bearer: "ok",
        crossSite: "CrossOrigin",
        foreignOrigin: "CrossOrigin",
        sameOrigin: "ok",
        sameSite: "CrossOrigin",
        silent: "CrossOrigin",
      },
    });
  });

  it("refuses to sign a browser in or out by a request that says nothing of its origin", async () => {
    const result = await run((_, api, key, dataDir) =>
      Effect.gen(function* () {
        const signIn = yield* api.signIn
          .signIn({ payload: { key: Redacted.make(key) } })
          .pipe(Effect.flip);

        const signOut = yield* api.signIn.signOut().pipe(Effect.flip);

        return {
          signIn: signIn._tag,
          signOut: signOut._tag,
          written: existsSync(`${dataDir}/sign-ins.json`),
        };
      })
    );

    expect(result).toStrictEqual({ signIn: "CrossOrigin", signOut: "CrossOrigin", written: false });
  });

  it("lists a Network's Timelines with how far they were folded, and reads one", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const call = yield* directly(world, api, []);

        expect(yield* heard(call)).toBe("JOIN #iirc");
        yield* say(call, ":iirc!~iirc@iirc.test JOIN #iirc");
        yield* say(call, ":peer!u@h PRIVMSG #iirc :hi there");
        yield* say(call, ":peer!u@h PRIVMSG iirc :psst");
        yield* settle;

        const listed = yield* api.timelines.list({ params: { network: libera }, query: {} });
        const channel = yield* timelineNamed(api, "#iirc");
        const window = yield* api.timelines.window({ params: { timeline: channel }, query: {} });
        const news = yield* api.news.follow({ headers: {}, query: {} });

        // The step that folded `psst` is the last there was.
        const last = yield* news.pipe(
          Stream.takeUntil(
            (event) =>
              event.event === "happened" &&
              event.data.news.some((one) => one._tag === "Message" && one.text === "psst")
          ),
          Stream.runCollect,
          Effect.map((events) => happenings(events).at(-1)?.id)
        );

        return {
          latest: listed.timelines.map((each) => each.latest !== null),
          listed: listed.timelines.map(({ detached, key, kind, name, network }) => ({
            detached,
            key,
            kind,
            name,
            network,
          })),
          projection: listed.projection,
          through: [listed.through, window.through].map((through) => through === last),
          window: {
            earlier: window.earlier,
            gaps: window.gaps,
            items: window.items.map(textOf),
            later: window.later,
            network: window.network,
            resolved: window.timeline === channel,
          },
        };
      })
    );

    expect(result).toStrictEqual({
      latest: [true, true, true],
      listed: [
        { detached: false, key: null, kind: "Network", name: "libera", network: "libera" },
        { detached: false, key: "#iirc", kind: "Channel", name: "#iirc", network: "libera" },
        { detached: false, key: "peer", kind: "Direct", name: "peer", network: "libera" },
      ],
      projection: { _tag: "Running" },
      through: [true, true],
      window: {
        earlier: false,
        gaps: [],
        items: ["Activity", "hi there"],
        later: false,
        network: "libera",
        resolved: true,
      },
    });
  });

  it("lists each Timeline's Read Marker and what lies after it, by level", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const call = yield* directly(world, api, ["psst"]);

        expect(yield* heard(call)).toBe("JOIN #iirc");
        yield* say(call, ":iirc!~iirc@iirc.test JOIN #iirc");
        yield* say(call, ":peer!u@h PRIVMSG #iirc :hi there");
        yield* say(call, ":peer!u@h PRIVMSG #iirc :iirc: look");
        yield* say(call, ":iirc!~iirc@elsewhere PRIVMSG #iirc :from my phone");
        yield* settle;

        const counts = api.timelines
          .list({ params: { network: libera }, query: {} })
          .pipe(
            Effect.map((listed) =>
              listed.timelines.map(({ name, read, unread }) => ({ name, read, unread }))
            )
          );

        const before = yield* counts;

        yield* TestClock.adjust(1000);
        yield* say(call, ":peer!u@h PRIVMSG #iirc :later");
        yield* api.networks.read({
          params: { network: libera },
          payload: { read: Instant.make(epoch + 500), target: "#iirc" },
        });
        yield* settle;

        return { after: yield* counts, before };
      })
    );

    const none = { activity: 0, direct: 0, highlights: 0, messages: 0 };

    expect(result.before).toStrictEqual([
      { name: "libera", read: null, unread: { ...none, activity: 1 } },
      { name: "peer", read: null, unread: { ...none, direct: 1 } },
      { name: "#iirc", read: null, unread: { ...none, activity: 1, highlights: 1, messages: 1 } },
    ]);
    expect(result.after.find(({ name }) => name === "#iirc")).toStrictEqual({
      name: "#iirc",
      read: epoch + 500,
      unread: { ...none, messages: 1 },
    });
  });

  it("reads windows before, after, and around a cursor, and says whether more lie beyond", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* directly(world, api, ["1", "2", "3", "4", "5"]);

        const timeline = yield* timelineNamed(api, "peer");

        const all = yield* api.timelines.window({
          params: { timeline },
          query: { limit: 5 },
        });

        const [one, , three, four, five] = all.items.map((item) => item.position);

        if (one === undefined || three === undefined || four === undefined || five === undefined) {
          return yield* Effect.die(new Error("fewer than five items"));
        }

        const two = all.items[1]?.position ?? one;

        const read = (query: Parameters<typeof api.timelines.window>[0]["query"]) =>
          api.timelines
            .window({ params: { timeline }, query })
            .pipe(
              Effect.map(
                (window) =>
                  `${window.earlier ? "<" : "|"} ${window.items.map(textOf).join(" ")} ${window.later ? ">" : "|"}`
              )
            );

        return [
          yield* read({ limit: 5 }),
          yield* read({ limit: 2 }),
          yield* read({ before: four, limit: 2 }),
          yield* read({ after: two, limit: 2 }),
          yield* read({ after: four, limit: 2 }),
          yield* read({ around: three, limit: 3 }),
          yield* read({ around: one, limit: 3 }),
          yield* read({ around: five, limit: 2 }),
          yield* read({}),
        ];
      })
    );

    expect(result).toStrictEqual([
      "| 1 2 3 4 5 |",
      "< 4 5 |",
      "< 2 3 >",
      "< 3 4 >",
      "< 5 |",
      "< 2 3 4 >",
      "| 1 2 3 >",
      "< 4 5 |",
      "| 1 2 3 4 5 |",
    ]);
  });

  it("reads a merged Timeline's id as the one it went to, and refuses an id never given", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const call = yield* directly(world, api, []);

        yield* say(call, ":irc.test 005 iirc CASEMAPPING=ascii :are supported by this server");
        yield* say(call, ":a[!u@h PRIVMSG iirc :first");
        yield* say(call, ":a{!u@h PRIVMSG iirc :second");
        yield* settle;

        const kept = yield* timelineNamed(api, "a[");
        const merged = yield* timelineNamed(api, "a{");

        yield* say(call, ":irc.test 005 iirc -CASEMAPPING :are supported by this server");
        yield* settle;

        const listed = yield* api.timelines.list({ params: { network: libera }, query: {} });
        const window = yield* api.timelines.window({ params: { timeline: merged }, query: {} });

        const unknown = yield* api.timelines
          .window({
            params: { timeline: TimelineId.make("00000000000fff-00000000-00000000") },
            query: {},
          })
          .pipe(Effect.flip);

        return {
          items: window.items.map(textOf),
          listed: listed.timelines.map(({ name }) => name),
          resolved: window.timeline === kept,
          unknown: unknown._tag,
        };
      })
    );

    expect(result).toStrictEqual({
      items: ["first", "second"],
      listed: ["libera", "a["],
      resolved: true,
      unknown: "UnknownTimeline",
    });
  });

  it("locates the items a step made, and refuses a Network it does not know", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* directly(world, api, ["one"]);

        const timeline = yield* timelineNamed(api, "peer");
        const window = yield* api.timelines.window({ params: { timeline }, query: {} });
        const [item] = window.items;

        if (item === undefined) {
          return yield* Effect.die(new Error("no item"));
        }

        const located = yield* api.timelines.locate({
          params: { network: libera, sequence: item.sequence },
          query: {},
        });

        const other = yield* api.timelines
          .locate({
            params: { network: NetworkId.make("oftc"), sequence: item.sequence },
            query: {},
          })
          .pipe(Effect.flip);

        const listed = yield* api.timelines
          .list({ params: { network: NetworkId.make("oftc") }, query: {} })
          .pipe(Effect.flip);

        return {
          located: located.items.map((one) => [textOf(one), one.timeline === timeline]),
          other: other._tag,
          same: located.items[0]?.position.sequence === item.sequence,
          through: located.through === window.through,
          unlisted: listed._tag,
        };
      })
    );

    expect(result).toStrictEqual({
      located: [["one", true]],
      other: "UnknownNetwork",
      same: true,
      through: true,
      unlisted: "UnknownNetwork",
    });
  });

  it("follows what changed, live, and resumes after an event from the query or Last-Event-ID", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const call = yield* directly(world, api, ["one", "two"]);

        const following = yield* api.timelines.changes({ headers: {}, query: {} });

        const live = yield* following.pipe(
          Stream.takeUntil(
            (event) =>
              event.event === "changed" && event.data.items.some((item) => textOf(item) === "three")
          ),
          Stream.runCollect,
          Effect.forkChild
        );

        yield* settle;
        yield* say(call, ":peer!u@h PRIVMSG iirc :three");
        yield* settle;

        const all = yield* Fiber.join(live);

        const two = changesOf(all).find((event) =>
          event.data.items.some((item) => textOf(item) === "two")
        );

        const after = two?.id ?? { sequence: 0, version: projectionVersion };

        const fromQuery = yield* api.timelines
          .changes({ headers: {}, query: { after } })
          .pipe(Effect.flatMap(firstChange));

        // The header wins, as an `EventSource` reconnecting sends it with the first URL.
        const fromHeader = yield* api.timelines
          .changes({
            headers: { "last-event-id": after },
            query: { after: { sequence: 0, version: projectionVersion } },
          })
          .pipe(Effect.flatMap(firstChange));

        const ids = changesOf(all).map((event) => event.id.sequence);

        return {
          fromHeader: briefly(fromHeader).map(({ items }) => items),
          fromQuery: briefly(fromQuery).map(({ items }) => items),
          idsAreSequences: briefly(all).every(
            ({ id, sequence }) => id.sequence === sequence && id.version === projectionVersion
          ),
          increasing: ids.every((id, index) => index === 0 || id > (ids[index - 1] ?? 0)),
          messages: briefly(all).flatMap(({ items }) =>
            items.filter((text) => ["one", "two", "three"].includes(text))
          ),
        };
      })
    );

    expect(result).toStrictEqual({
      fromHeader: [["three"]],
      fromQuery: [["three"]],
      idsAreSequences: true,
      increasing: true,
      messages: ["one", "two", "three"],
    });
  });

  it("sends a heartbeat on the changes while nothing is folded", async () => {
    const result = await run((_, api) =>
      Effect.gen(function* () {
        const stream = yield* api.timelines.changes({ headers: {}, query: {} });
        const fiber = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* TestClock.adjust("31 seconds");

        return yield* Fiber.join(fiber);
      })
    );

    expect(result).toStrictEqual([
      { data: {}, event: "heartbeat" },
      { data: {}, event: "heartbeat" },
    ]);
  });

  it("shows the projection Stopped, with its reason, while the Network goes on", async () => {
    const result = await run(
      (world, api) =>
        Effect.gen(function* () {
          yield* directly(world, api, ["one"]);

          const listed = yield* api.timelines.list({ params: { network: libera }, query: {} });
          const networks = yield* api.networks.list();

          return {
            networks: networks.map(({ status }) => status._tag),
            projection: listed.projection,
            through: listed.through,
            timelines: listed.timelines,
          };
        }),
      undefined,
      await Effect.runPromise(failingStore)
    );

    expect(result).toStrictEqual({
      networks: ["Running"],
      projection: { _tag: "Stopped", reason: "TimelineStoreFailed: the test failed this apply" },
      through: null,
      timelines: [],
    });
  });

  it("pages a Network's Timelines by id, and says whether more follow", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const call = yield* directly(world, api, []);

        for (const nick of ["p1", "p2", "p3"]) {
          yield* say(call, `:${nick}!u@h PRIVMSG iirc :hi`);
        }

        yield* settle;

        const first = yield* api.timelines.list({
          params: { network: libera },
          query: { limit: 3 },
        });

        const last = first.timelines.at(-1)?.id;

        const next = yield* api.timelines.list({
          params: { network: libera },
          query: last === undefined ? { limit: 3 } : { after: last, limit: 3 },
        });

        return {
          first: [first.timelines.map(({ name }) => name), first.more],
          next: [next.timelines.map(({ name }) => name), next.more],
          same: [first.version === next.version, first.through === next.through],
          version: first.version,
        };
      })
    );

    expect(result).toStrictEqual({
      first: [["libera", "p1", "p2"], true],
      next: [["p3"], false],
      same: [true, true],
      version: projectionVersion,
    });
  });

  it("resets a follower whose place another version folded, or that is ahead of what was folded", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const call = yield* directly(world, api, ["one"]);
        const listed = yield* api.timelines.list({ params: { network: libera }, query: {} });
        const through = listed.through ?? 0;

        // Up to the first `changed` event, which needs a step folded after the reset.
        const opening = (after: Resume) =>
          api.timelines.changes({ headers: {}, query: { after } }).pipe(
            Effect.flatMap((events) =>
              events.pipe(
                Stream.filter((event) => event.event !== "heartbeat"),
                Stream.takeUntil((event) => event.event === "changed"),
                Stream.runCollect,
                Effect.forkChild
              )
            )
          );

        const previous = yield* opening({ sequence: through, version: projectionVersion - 1 });
        const ahead = yield* opening({ sequence: through + 1000, version: projectionVersion });
        const current = yield* opening({ sequence: through, version: projectionVersion });

        yield* settle;
        yield* say(call, ":peer!u@h PRIVMSG iirc :two");
        yield* settle;

        const shown = (events: readonly TimelineChangesEvent[]) =>
          events.map((event) => {
            switch (event.event) {
              case "reset": {
                return ["reset", event.data.version, event.data.through === through];
              }

              case "changed": {
                return ["changed", event.id.version, event.data.items.map(textOf)];
              }

              case "heartbeat":
              case "overflowed": {
                return [event.event];
              }

              default: {
                return event satisfies never;
              }
            }
          });

        return {
          ahead: shown(yield* Fiber.join(ahead)),
          current: shown(yield* Fiber.join(current)),
          previous: shown(yield* Fiber.join(previous)),
        };
      })
    );

    const reset = ["reset", projectionVersion, true];
    const two = ["changed", projectionVersion, ["two"]];

    expect(result).toStrictEqual({ ahead: [reset, two], current: [two], previous: [reset, two] });
  });

  it("gives a merge too big for one event as overflowed, naming its Timelines, and goes on", async () => {
    const result = await run(
      (world, api) =>
        Effect.gen(function* () {
          const call = yield* directly(world, api, []);

          yield* say(call, ":irc.test 005 iirc CASEMAPPING=ascii :are supported by this server");
          yield* say(call, ":a[!u@h PRIVMSG iirc :first");

          for (let n = 0; n < 6; n += 1) {
            yield* say(call, `:a{!u@h PRIVMSG iirc :moved ${n}`);
          }

          yield* settle;

          const kept = yield* timelineNamed(api, "a[");
          const merged = yield* timelineNamed(api, "a{");
          const listed = yield* api.timelines.list({ params: { network: libera }, query: {} });

          const following = yield* api.timelines
            .changes({
              headers: {},
              query: { after: { sequence: listed.through ?? 0, version: listed.version } },
            })
            .pipe(
              Effect.flatMap((events) =>
                events.pipe(
                  Stream.filter((event) => event.event !== "heartbeat"),
                  Stream.takeUntil(
                    (event) =>
                      event.event === "changed" &&
                      event.data.items.some((item) => textOf(item) === "after")
                  ),
                  Stream.runCollect,
                  Effect.forkChild
                )
              )
            );

          yield* settle;
          yield* say(call, ":irc.test 005 iirc -CASEMAPPING :are supported by this server");
          yield* say(call, ":a[!u@h PRIVMSG iirc :after");
          yield* settle;

          const events = yield* Fiber.join(following);

          return {
            bounded: events.every(
              (event) =>
                event.event !== "changed" ||
                event.data.items.length +
                  event.data.timelines.length +
                  event.data.merged.length +
                  event.data.gaps.length <=
                  5
            ),
            events: events.map((event) => {
              switch (event.event) {
                case "overflowed": {
                  return [
                    "overflowed",
                    event.data.timelines,
                    event.id.sequence === event.data.sequence,
                  ];
                }

                case "changed": {
                  return ["changed", event.data.items.map(textOf)];
                }

                case "reset": {
                  return [event.event];
                }

                default: {
                  return event satisfies never;
                }
              }
            }),
            ids: [kept, merged],
          };
        }),
      undefined,
      undefined,
      5
    );

    expect(result).toStrictEqual({
      bounded: true,
      events: [
        ["overflowed", result.ids, true],
        ["changed", ["after"]],
      ],
      ids: result.ids,
    });
  });

  it("collapses the Gaps a quiet Timeline's window spans, even with a limit of one, and up to a cursor", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        let call = yield* directly(world, api, ["hello"]);

        // Four reconnects, each a Gap, each after the backoff's wait.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          yield* call.close("Reset");
          yield* settle;
          yield* TestClock.adjust(2000 * 2 ** attempt);
          call = yield* registerOnFloor(world.memory);
          yield* settle;
        }

        const timeline = yield* timelineNamed(api, "peer");

        const quiet = yield* api.timelines.window({
          params: { timeline },
          query: { limit: 1 },
        });

        yield* say(call, ":peer!u@h PRIVMSG iirc :back");
        yield* settle;

        const both = yield* api.timelines.window({ params: { timeline }, query: { limit: 2 } });
        const latest = yield* api.timelines.window({ params: { timeline }, query: { limit: 1 } });

        // The page before the latest item fits against it: the run between them comes with
        // the page, since it ended before the cursor.
        const [back] = latest.items;

        const before =
          back === undefined
            ? latest
            : yield* api.timelines.window({
                params: { timeline },
                query: { before: back.position, limit: 1 },
              });

        const network = yield* api.timelines.window({
          params: { timeline: yield* timelineNamed(api, "libera") },
          query: { limit: 1 },
        });

        const shown = (window: typeof quiet) => ({
          gaps: window.gaps.map(({ count, to }) => [count, to !== null]),
          items: window.items.map(textOf),
        });

        return {
          before: shown(before),
          both: shown(both),
          latest: shown(latest),
          network: network.gaps.length,
          quiet: shown(quiet),
        };
      })
    );

    expect(result).toStrictEqual({
      before: { gaps: [[4, true]], items: ["hello"] },
      both: { gaps: [[4, true]], items: ["hello", "back"] },
      latest: { gaps: [], items: ["back"] },
      // The Network's own Timeline has an item at each Session's start and end, so Gaps
      // never run together there: its last item is the last Session's start, where the one
      // Gap that touches it ended.
      network: 1,
      quiet: { gaps: [[4, true]], items: ["hello"] },
    });
  });

  it("pages the items a QUIT made across more Channels than one page holds", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const channels = ["#a", "#b", "#c"];

        yield* api.networks.configure({
          params: { network: libera },
          payload: configured({
            channels: channels.map((name) => ({ name })),
            ircds: [{ host: "irc.test", port: 6667, tls: false }],
          }),
          query: {},
        });

        const call = yield* registerOnFloor(world.memory);

        yield* settle;

        for (const name of channels) {
          yield* say(call, `:iirc!~iirc@iirc.test JOIN ${name}`);
          yield* say(call, `:irc.test 353 iirc = ${name} :iirc peer`);
          yield* say(call, `:irc.test 366 iirc ${name} :End of /NAMES list.`);
        }

        yield* say(call, ":peer!u@h QUIT :gone");
        yield* settle;

        const quitIn = yield* api.timelines.window({
          params: { timeline: yield* timelineNamed(api, "#a") },
          query: { limit: 1 },
        });

        const sequence = quitIn.items[0]?.sequence ?? WireSequence.make(1);

        const first = yield* api.timelines.locate({
          params: { network: libera, sequence },
          query: { limit: 2 },
        });

        const rest =
          first.next === null
            ? undefined
            : yield* api.timelines.locate({
                params: { network: libera, sequence },
                query: { after: first.next, limit: 2 },
              });

        const named = new Map(
          (yield* api.timelines.list({ params: { network: libera }, query: {} })).timelines.map(
            ({ id, name }) => [id, name]
          )
        );

        const shown = (page: typeof first) => ({
          items: page.items.map((item) => [named.get(item.timeline), textOf(item)]),
          more: page.more,
          next: page.next !== null,
        });

        return { first: shown(first), rest: rest === undefined ? undefined : shown(rest) };
      })
    );

    expect(result).toStrictEqual({
      first: {
        items: [
          ["#a", "Activity"],
          ["#b", "Activity"],
        ],
        more: true,
        next: true,
      },
      rest: { items: [["#c", "Activity"]], more: false, next: false },
    });
  });

  it("resets an idle follower when the store is folded again, even short of its old place", async () => {
    // A store an older version folded far ahead, which the projector may not read until let.
    const gate = Deferred.makeUnsafe<boolean>();

    const older = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeMemoryTimelineStore;

        yield* store.reset(projectionVersion + 1);
        yield* store.apply({ changes: [], directory: emptyDirectory, through: 1000 });

        return {
          ...store,
          folded: Deferred.await(gate).pipe(Effect.andThen(store.folded)),
        } satisfies TimelineStoreService;
      })
    );

    const result = await run(
      (world, api) =>
        Effect.gen(function* () {
          const stream = yield* api.timelines.changes({
            headers: {},
            query: { after: { sequence: 1000, version: projectionVersion + 1 } },
          });

          const events = yield* stream.pipe(
            Stream.filter((event) => event.event !== "heartbeat"),
            Stream.takeUntil(
              (event) =>
                event.event === "changed" &&
                event.data.items.some((item) => textOf(item) === "after the reset")
            ),
            Stream.runCollect,
            Effect.forkChild
          );

          // The follower is idle at 1000 before the store is reset, and nothing it waits on
          // reaches 1000 again.
          yield* settle;
          const call = yield* directly(world, api, []);

          yield* Deferred.succeed(gate, true);
          yield* settle;
          yield* say(call, ":peer!u@h PRIVMSG iirc :after the reset");
          yield* settle;

          const all = yield* Fiber.join(events);
          const [first] = all;

          return {
            first: first?.event === "reset" ? ["reset", first.data.version] : first?.event,
            resets: all.filter((event) => event.event === "reset").length,
            through: (yield* api.timelines.list({ params: { network: libera }, query: {} }))
              .through,
            versions: changesOf(all).every((event) => event.id.version === projectionVersion),
          };
        }),
      undefined,
      older
    );

    expect(result.through).toBeLessThan(1000);
    expect({ ...result, through: undefined }).toStrictEqual({
      first: ["reset", projectionVersion],
      resets: 1,
      through: undefined,
      versions: true,
    });
  });
});

/**
 * Configures `libera` wanting `#iirc`, registers it on the floor with the ISUPPORT given,
 * and has Self join `#iirc` with the members listed, a `353` to every 50 of them.
 * @param world - The ports.
 * @param api - The client.
 * @param names - The members, with their prefixes, as a `NAMES` listing gives them.
 * @param isupport - The ISUPPORT tokens the Ircd sends.
 * @returns The Connection, and the Channel's Timeline.
 */
const inChannel = (
  world: World,
  api: Effect.Success<typeof makeClient>,
  names: readonly string[],
  isupport = "CASEMAPPING=rfc1459 PREFIX=(qov)~@+"
) =>
  Effect.gen(function* () {
    yield* api.networks.configure({ params: { network: libera }, payload: floor, query: {} });
    const call = yield* registerOnFloor(world.memory);

    yield* say(call, `:irc.test 005 iirc ${isupport} :are supported by this server`);
    expect(yield* heard(call)).toBe("JOIN #iirc");
    yield* say(call, ":iirc!~iirc@iirc.test JOIN #iirc");

    for (let first = 0; first < names.length; first += 50) {
      yield* say(call, `:irc.test 353 iirc = #iirc :${names.slice(first, first + 50).join(" ")}`);
    }

    yield* say(call, ":irc.test 366 iirc #iirc :End of /NAMES list.");
    yield* settle;

    return { call, timeline: yield* timelineNamed(api, "#iirc") };
  });

// The prefixes a member holds, as far as anything says.
const heldBy = (one: Member): readonly string[] => {
  switch (one.prefixes._tag) {
    case "Known": {
      return one.prefixes.value;
    }

    case "Partial": {
      return one.prefixes.atLeast;
    }

    case "Stale": {
      return one.prefixes.was;
    }

    case "Unknown": {
      return [];
    }

    default: {
      return one.prefixes satisfies never;
    }
  }
};

const shownMember = (one: Member) => {
  const held = heldBy(one);

  return held.length === 0 ? one.nick : `${one.nick} ${held.join("")}`;
};

// A `NAMES` listing's name for the nth of many members: some ops, some voiced.
const listedAs = (n: number) => {
  if (n % 50 === 0) {
    return `@user${n}`;
  }

  return n % 7 === 0 ? `+user${n}` : `user${n}`;
};

// Where a listed name stands: ops, then voiced, then the rest.
const listedRank = (name: string) => {
  const rank = ["@", "+"].indexOf(name[0] ?? "");

  return rank === -1 ? 2 : rank;
};

const listedNick = (name: string) => name.replace(/^[@+]/u, "");

/**
 * Every page of a Channel's members, from the first, as `<nick> <prefixes>`.
 * @param api - The client.
 * @param timeline - The Channel's Timeline.
 * @param query - The page's size, and the start of the nicks wanted.
 * @returns Each page's members.
 */
const everyPage = (
  api: Effect.Success<typeof makeClient>,
  timeline: TimelineId,
  query: { readonly limit: number; readonly prefix?: string }
) =>
  Effect.gen(function* () {
    const pages: string[][] = [];
    let after: MembersAfter | undefined;

    do {
      const page = yield* api.timelines.members({
        params: { timeline },
        query: after === undefined ? query : { ...query, after },
      });

      pages.push(page.members.map(shownMember));
      expect(page.more).toBe(page.next !== null);
      after = page.next ?? undefined;
    } while (after !== undefined && pages.length < 100);

    return pages;
  });

describe("a Channel's head and members", () => {
  it("gives a Channel's head: its name, topic, modes, Self's standing, how many, and PREFIX", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const { call, timeline } = yield* inChannel(world, api, ["iirc", "~@owner", "+voiced"]);

        yield* say(call, ":irc.test 332 iirc #iirc :the topic");
        yield* say(call, ":irc.test 333 iirc #iirc setter!u@h 1767225600");
        yield* say(call, ":irc.test 324 iirc #iirc +nt");
        yield* settle;

        return yield* api.timelines.channel({ params: { timeline } });
      })
    );

    expect(result).toMatchObject({
      chanmodes: { always: "k", flags: "imnpst", list: "beI", whenSet: "l" },
      chantypes: "#&",
      members: 3,
      modes: { _tag: "Known", value: [{ mode: "n" }, { mode: "t" }] },
      name: "#iirc",
      network: libera,
      ranks: [
        { mode: "q", symbol: "~" },
        { mode: "o", symbol: "@" },
        { mode: "v", symbol: "+" },
      ],
      standing: "Joined",
      topic: { _tag: "Known", value: { setBy: "setter", text: "the topic" } },
    });
  });

  it("pages the members by rank, the highest first, then by nick, each with whether they are away", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const { call, timeline } = yield* inChannel(world, api, [
          "zed",
          "+voiced",
          "@op",
          "iirc",
          "~owner",
          "@Alpha",
          "bob",
        ]);

        yield* say(call, ":bob!u@h AWAY :gone fishing");
        yield* settle;

        const first = yield* api.timelines.members({ params: { timeline }, query: {} });

        return {
          away: first.members.map(({ away, nick }) => [
            nick,
            away._tag === "Known" ? away.value : away._tag,
          ]),
          pages: yield* everyPage(api, timeline, { limit: 3 }),
        };
      })
    );

    expect(result.pages).toStrictEqual([
      ["owner q", "Alpha o", "op o"],
      ["voiced v", "bob", "iirc"],
      ["zed"],
    ]);
    expect(result.away).toContainEqual(["bob", { message: "gone fishing" }]);
    expect(result.away).toContainEqual(["zed", "Unknown"]);
  });

  it("filters the members by the start of a nick, under the Network's casemapping, still in order and paged", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const { timeline } = yield* inChannel(world, api, [
          "iirc",
          "[a]",
          "+{A}b",
          "@{a}c",
          "[b]",
          "a",
        ]);

        return {
          ascii: yield* everyPage(api, timeline, { limit: 10, prefix: "[" }),
          brace: yield* everyPage(api, timeline, { limit: 10, prefix: "{a}" }),
          bracket: yield* everyPage(api, timeline, { limit: 1, prefix: "[A" }),
          none: yield* everyPage(api, timeline, { limit: 10, prefix: "zz" }),
        };
      })
    );

    expect(result).toStrictEqual({
      ascii: [["{a}c o", "{A}b v", "[a]", "[b]"]],
      brace: [["{a}c o", "{A}b v", "[a]"]],
      bracket: [["{a}c o"], ["{A}b v"], ["[a]"]],
      none: [[]],
    });
  });

  it("ranks by the default PREFIX when the Ircd's repeats a mode, so no unprivileged member sorts ahead", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const { timeline } = yield* inChannel(
          world,
          api,
          ["iirc", "alice", "+zed", "%half", "@op", "+bob"],
          "CASEMAPPING=rfc1459 PREFIX=(oov)@%+"
        );

        const head = yield* api.timelines.channel({ params: { timeline } });

        return {
          pages: yield* everyPage(api, timeline, { limit: 10 }),
          ranks: head.ranks.map(({ symbol }) => symbol),
        };
      })
    );

    expect(result).toStrictEqual({
      pages: [["op o", "bob v", "zed v", "alice", "half", "iirc"]],
      ranks: ["@", "+"],
    });
  });

  it("goes on after a page whose members left, repeating none, and leaving out one that left", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const { call, timeline } = yield* inChannel(world, api, ["iirc", "@a", "b", "c", "d"]);

        const first = yield* api.timelines.members({ params: { timeline }, query: { limit: 2 } });

        // `b` was on the first page, and `c` would have begun the next.
        yield* say(call, ":b!u@h PART #iirc");
        yield* say(call, ":c!u@h QUIT :gone");
        yield* settle;

        const next = first.next ?? undefined;

        const rest = yield* api.timelines.members({
          params: { timeline },
          query: next === undefined ? {} : { after: next },
        });

        return [first.members.map(shownMember), rest.members.map(shownMember), rest.next];
      })
    );

    expect(result).toStrictEqual([["a o", "b"], ["d", "iirc"], null]);
  });

  it("refuses a Timeline that is not a Channel's, and an id never given", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* directly(world, api, ["hi"]);

        const never = TimelineId.make("0000000000ffff-00000000-00000001");

        const both = (timeline: TimelineId) =>
          Effect.all([
            outcome(api.timelines.channel({ params: { timeline } })),
            outcome(api.timelines.members({ params: { timeline }, query: {} })),
          ]);

        const kind = (timeline: TimelineId) =>
          api.timelines.channel({ params: { timeline } }).pipe(
            Effect.match({
              onFailure: (error) => (error._tag === "NotAChannel" ? error.kind : error._tag),
              onSuccess: () => "ok",
            })
          );

        return {
          direct: yield* both(yield* timelineNamed(api, "peer")),
          directKind: yield* kind(yield* timelineNamed(api, "peer")),
          network: yield* both(yield* timelineNamed(api, "libera")),
          networkKind: yield* kind(yield* timelineNamed(api, "libera")),
          never: yield* both(never),
        };
      })
    );

    expect(result).toStrictEqual({
      direct: ["NotAChannel", "NotAChannel"],
      directKind: "Direct",
      network: ["NotAChannel", "NotAChannel"],
      networkKind: "Network",
      never: ["UnknownTimeline", "UnknownTimeline"],
    });
  });

  it("gives the head of a Channel Self is not in, and refuses its members", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        const { call, timeline } = yield* inChannel(world, api, ["iirc", "@op"]);

        yield* say(call, ":op!u@h KICK #iirc iirc :out");
        yield* settle;

        const kicked = yield* api.timelines.channel({ params: { timeline } });

        const refused = yield* api.timelines
          .members({ params: { timeline }, query: {} })
          .pipe(Effect.flip);

        // No longer wanted, and parted, so the Client holds no such Channel.
        yield* api.networks.configure({
          params: { network: libera },
          payload: { ...floor, channels: [] },
          query: {},
        });
        yield* settle;

        const gone = yield* api.timelines.channel({ params: { timeline } });

        const unheld = yield* api.timelines
          .members({ params: { timeline }, query: {} })
          .pipe(Effect.flip);

        return {
          gone: [gone.name, gone.standing, gone.members, gone.topic._tag],
          kicked: [kicked.standing, kicked.members, kicked.topic._tag],
          refused: refused._tag === "NotInChannel" ? refused.standing : refused._tag,
          unheld: unheld._tag === "NotInChannel" ? unheld.standing : unheld._tag,
        };
      })
    );

    expect(result).toStrictEqual({
      gone: ["#iirc", null, 0, "Unknown"],
      kicked: ["Kicked", 0, "Unknown"],
      refused: "Kicked",
      unheld: null,
    });
  });

  it("reads a page of a Channel of 10,000 members quickly", async () => {
    const names = Array.from({ length: 10_000 }, (_, n) => listedAs(n));

    const result = await run((world, api) =>
      Effect.gen(function* () {
        const { timeline } = yield* inChannel(world, api, ["iirc", ...names]);
        const timings: number[] = [];

        // Ten thousand Lines take more than one settling to step.
        for (let turn = 0; turn < 1000; turn += 1) {
          const { members } = yield* api.timelines.channel({ params: { timeline } });

          if (members === names.length + 1) {
            break;
          }

          yield* settle;
        }

        const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const started = performance.now();
            const value = yield* effect;

            timings.push(performance.now() - started);

            return value;
          });

        const first = yield* timed(api.timelines.members({ params: { timeline }, query: {} }));
        const next = first.next ?? undefined;

        const second = yield* timed(
          api.timelines.members({
            params: { timeline },
            query: next === undefined ? { limit: 500 } : { after: next, limit: 500 },
          })
        );

        const completing = yield* timed(
          api.timelines.members({ params: { timeline }, query: { prefix: "user99" } })
        );

        const head = yield* timed(api.timelines.channel({ params: { timeline } }));

        return {
          completing: [completing.members.map(({ nick }) => nick), completing.more],
          head: head.members,
          pages: [...first.members, ...second.members].map(({ nick }) => nick),
          timings,
        };
      })
    );

    // Ops, then voiced, then the rest, each by nick, which here sorts as it folds.
    const ordered = ["iirc", ...names]
      .toSorted(
        (left, right) =>
          listedRank(left) - listedRank(right) || (listedNick(left) < listedNick(right) ? -1 : 1)
      )
      .map(listedNick);

    // A generous bound, for a loaded machine: each read sorts the one Channel's members.
    expect(Math.max(...result.timings)).toBeLessThan(500);
    expect(result).toMatchObject({
      completing: [ordered.filter((nick) => nick.startsWith("user99")).slice(0, 100), true],
      head: 10_001,
      pages: ordered.slice(0, 600),
    });
  });
});
