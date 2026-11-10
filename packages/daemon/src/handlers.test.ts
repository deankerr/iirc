import { existsSync } from "node:fs";

import { CallerIntent, CredentialPathName, DaemonApi, NetworkId } from "@iirc/api";
import type { NewsEvent } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Entry } from "@iirc/runtime/journal";
import type { JournalRecord } from "@iirc/runtime/journal";
import { makeMemoryJournal } from "@iirc/runtime/testing";
import { Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ApiHandlers } from "./handlers.ts";
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

const makeClient = HttpApiTest.groups(DaemonApi, ["signIn", "networks", "news", "credentials"]);

/**
 * Runs a test against the handlers, through an in-process client, on the in-memory ports
 * and a TestClock, with a key made for it.
 * @param test - The test, given the world, a client presenting the key, the key, and the data directory.
 * @param fault - Which Journal appends to fail.
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
  fault?: AppendFault
): Promise<A> =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(epoch);
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const memory = yield* makeMemoryJournal;

        const world = yield* makeWorld(fault === undefined ? memory : faultyJournal(memory, fault));

        const handlers = ApiHandlers.pipe(
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

const stoppedSaying = async (named: "lost" | "kept") =>
  await run(
    (world, api) =>
      Effect.gen(function* () {
        const intent = CallerIntent.make(named);

        yield* api.networks.configure({ params: { network: libera }, payload: floor });
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

describe("the handlers", () => {
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
          said: said.intent.length,
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
      said: 32,
      session: "Registered",
    });
  });

  it("resumes the News after a sequence, from the query or Last-Event-ID", async () => {
    const result = await run((world, api) =>
      Effect.gen(function* () {
        yield* api.networks.configure({ params: { network: libera }, payload: floor });
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
});
