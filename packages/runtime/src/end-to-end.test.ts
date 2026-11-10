import { client } from "@iirc/client";
import type { ClientState, IntentId, News, NetworkConfiguration } from "@iirc/client";
import { configured, joined, parse, registered } from "@iirc/client/testing";
import { Effect, Fiber, Result, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { NetworkId } from "./journal.ts";
import type { Happened } from "./runtime.ts";
import { entries, runTest, settle, startRuntime } from "./testing/harness.ts";
import type { TestCall } from "./testing/memory-transport.ts";

const libera = NetworkId.make("libera");
const text = new TextDecoder();
const encoder = new TextEncoder();

const heardText = (call: TestCall) => call.heard.pipe(Effect.map((bytes) => text.decode(bytes)));

// Plays the Ircd's side of a transcript: says each `<<` Line, and checks each `>>` Line
// is what the Client sent next, byte for byte. Everything else in it is the Runtime's
// side, which the test drives itself.
const converse = (call: TestCall, transcript: string) =>
  Effect.gen(function* () {
    for (const item of Result.getOrThrow(parse(transcript))) {
      if (item._tag === "Received") {
        yield* call.say(item.bytes);
      }

      if (item._tag === "Sent") {
        expect(yield* heardText(call)).toBe(`${text.decode(item.bytes)}\r\n`);
      }
    }
  });

const opening = (configuration: NetworkConfiguration, offered: readonly string[]) =>
  registered(configuration, { offered, requested: [] });

const describeNews = (happened: readonly Happened[]) =>
  happened.flatMap(({ news }) =>
    news.flatMap((one: News) => {
      switch (one._tag) {
        case "SessionBegan": {
          return [`began ${one.nick}`];
        }

        case "SessionEnded":
        case "ConnectionFailed": {
          return [`${one._tag} ${JSON.stringify(one.reason)}`];
        }

        case "Message": {
          return [
            `${one.sender} ${one.target} :${one.text}${one.ours === undefined ? "" : " (ours)"}`,
          ];
        }

        case "Activity": {
          return [one.activity._tag];
        }

        case "Confirmed":
        case "Ignored":
        case "ReadMarker":
        case "Refolded":
        case "Refused": {
          return [];
        }

        default: {
          return one satisfies never;
        }
      }
    })
  );

describe("the real Client on the in-memory ports", () => {
  it("upgrades to TLS, registers, joins, talks, keeps alive, and reconnects", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const plain = configured({
          channels: [{ name: "#iirc" }],
          ircds: [{ host: "irc.test", port: 6667, tls: false }],
        });

        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, plain);

        // Plaintext first: the Ircd's STS policy names a TLS port, so the Client hangs up
        // and dials it at once.
        const insecure = yield* world.memory.ircd.accept;

        yield* insecure.open;
        yield* converse(insecure, ">> CAP LS 302\n>> NICK iirc\n>> USER iirc 0 * iirc\n");
        yield* insecure.say(encoder.encode(":irc.test CAP * LS :sts=port=6697"));
        const secure = yield* world.memory.ircd.accept;

        yield* secure.open;
        yield* converse(secure, opening(plain, ["sts=duration=3600"]));
        yield* converse(secure, joined(plain, "#iirc", ["@peer"]));
        yield* settle;
        const registeredAs = (yield* runtime.known(libera)).session;

        // Talking.
        const said = yield* runtime.say(libera, {
          kind: "Privmsg",
          target: "#iirc",
          text: "hello",
        });

        // The Lines of registration and the join spent the burst, so it waits its turn.
        yield* TestClock.adjust(2000);
        expect(yield* heardText(secure)).toBe("PRIVMSG #iirc hello\r\n");
        yield* secure.say(encoder.encode(":peer!u@h PRIVMSG #iirc :hi there"));
        yield* settle;

        // A minute of silence, and the Client checks the Connection with a PING.
        yield* TestClock.adjust(60_000);
        const ping = yield* heardText(secure);

        // The Connection resets, and the Client redials after its backoff, under the
        // policy it learnt.
        yield* secure.close("Reset");
        yield* settle;
        const waiting = (yield* runtime.inspect(libera)).timers;

        yield* TestClock.adjust(2000);
        const again = yield* world.memory.ircd.accept;

        const news = yield* Stream.runCollect(
          Stream.takeUntil(runtime.news(), (happened) =>
            happened.news.some((one) => one._tag === "SessionEnded")
          )
        );

        return {
          addresses: [insecure.address, secure.address, again.address],
          intent: said.intent,
          news: describeNews(news),
          ping,
          registeredAs,
          waiting: [...waiting.keys()],
        };
      })
    );

    expect(result.addresses).toStrictEqual([
      { host: "irc.test", port: 6667, tls: false },
      { host: "irc.test", port: 6697, tls: true },
      { host: "irc.test", port: 6697, tls: true },
    ]);
    expect(result.registeredAs).toMatchObject({ _tag: "Registered" });
    expect(result.ping).toMatch(/^PING \S+\r\n$/u);
    expect(result.waiting).toContain("redial");
    expect(result.news).toStrictEqual([
      'ConnectionFailed {"_tag":"Upgrading","port":6697}',
      "began iirc",
      "Joined",
      "iirc #iirc :hello (ours)",
      "peer #iirc :hi there",
      'SessionEnded {"_tag":"Closed","reason":"Reset"}',
    ]);
  });
});

describe("Lines that never left", () => {
  it("are refused as Unsent when the Ircd ends the Connection first", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const base = configured({ channels: [{ name: "#iirc" }] });
        const { runtime } = yield* startRuntime(world, client);

        yield* runtime.configure(libera, base);
        const call = yield* world.memory.ircd.accept;

        yield* call.open;
        yield* converse(call, opening(base, []));
        yield* converse(call, joined(base, "#iirc", ["@peer"]));

        // Registration and the join spent all but one Line of the burst, so the first
        // leaves at once, and the others wait their turn.
        const intents: IntentId[] = [];

        for (const words of ["one", "two", "three"]) {
          const said = yield* runtime.say(libera, {
            kind: "Privmsg",
            target: "#iirc",
            text: words,
          });

          intents.push(said.intent);
        }

        const heard = yield* heardText(call);

        yield* call.close("Reset");

        const news = yield* Stream.runCollect(
          Stream.takeUntil(runtime.news(), (happened) =>
            happened.news.some((one) => one._tag === "SessionEnded")
          )
        );

        return {
          heard,
          refused: news.flatMap((happened) =>
            happened.news.flatMap((one) =>
              one._tag === "Refused" ? [[intents.indexOf(one.intent), one.reason._tag]] : []
            )
          ),
        };
      })
    );

    expect(result).toStrictEqual({
      heard: "PRIVMSG #iirc one\r\n",
      refused: [
        [1, "Unsent"],
        [2, "Unsent"],
      ],
    });
  });
});

// What a single uninterrupted run would show: the fold of the same inputs.
const uninterrupted = (state: ClientState) => ({
  client: client.inspect(state),
  known: client.known(state),
  timers: client.inspect(state).timers,
});

describe("a restart", () => {
  it("rebuilds every Network from the Journal, sets its timers, and steps a Started", async () => {
    const result = await runTest((world) =>
      Effect.gen(function* () {
        const base = configured({ channels: [{ name: "#iirc" }] });
        const first = yield* startRuntime(world, client);

        yield* first.runtime.configure(libera, base);
        const call = yield* world.memory.ircd.accept;

        yield* call.open;
        yield* converse(call, opening(base, []));
        yield* converse(call, joined(base, "#iirc", ["@peer"]));
        yield* first.runtime.say(libera, { kind: "Privmsg", target: "#iirc", text: "hello" });
        yield* settle;

        const before = {
          inspected: yield* first.runtime.inspect(libera),
          known: yield* first.runtime.known(libera),
        };

        const running = (yield* entries(world.journal)).length;

        // Shutdown steps a Stopping: the Client says QUIT and hangs up, and the Ircd's
        // side ends.
        yield* first.close;
        const kept = (yield* entries(world.journal)).length;
        const second = yield* startRuntime(world, client);
        const redial = yield* Effect.forkChild(world.memory.ircd.accept);

        yield* settle;
        const all = yield* entries(world.journal);

        // A single uninterrupted run is the fold of the same inputs, from `initial`.
        const folded = (upTo: number) => {
          let state = client.initial;

          for (const { record } of all.slice(0, upTo)) {
            if (record._tag === "Input") {
              ({ state } = client.step(state, record.input));
            }
          }

          return state;
        };

        return {
          after: {
            inspected: yield* second.runtime.inspect(libera),
            known: yield* second.runtime.known(libera),
          },
          before,
          foldedAfter: folded(all.length),
          foldedBefore: folded(running),
          redialled: (yield* Fiber.join(redial)).address,
          stepped: all
            .slice(kept)
            .map(({ record }) => (record._tag === "Input" ? record.input._tag : "Outputs")),
          stopped: all
            .slice(running, kept)
            .map(({ record }) => (record._tag === "Input" ? record.input._tag : "Outputs")),
        };
      })
    );

    const seen = (run: typeof result.before) => ({
      client: run.inspected.client,
      known: run.known,
      timers: run.inspected.timers,
    });

    expect({ after: seen(result.after), before: seen(result.before) }).toStrictEqual({
      after: uninterrupted(result.foldedAfter),
      before: uninterrupted(result.foldedBefore),
    });
    expect({
      pending: [...result.before.inspected.timers.keys()],
      redialled: result.redialled,
      status: result.after.inspected.status,
      stepped: result.stepped,
      stopped: result.stopped,
    }).toStrictEqual({
      pending: ["keepalive"],
      redialled: { host: "irc.test", port: 6697, tls: true },
      status: { _tag: "Running" },
      stepped: ["Started", "Outputs"],
      stopped: ["Stopping", "Outputs", "Closed"],
    });
  });
});
