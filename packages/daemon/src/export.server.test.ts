import { BunHttpServer } from "@effect/platform-bun";
import { Instant } from "@iirc/client";
import type { TimelineStoreService } from "@iirc/timeline-store";
import { makeMemoryTimelineStore } from "@iirc/timeline-store/testing";
import { emptyDirectory, projectionVersion, timelineIdOf } from "@iirc/timelines";
import type { Change, Content, TimelineId } from "@iirc/timelines";
import { Context, Deferred, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { describe, expect, it } from "vitest";

import { ApiRoutes } from "./handlers.ts";
import { layerWorld, makeKey, makeWorld, temporaryDirectory } from "./testing/world.ts";

const libera = "libera";
const network = timelineIdOf(1, 0, 0);
const channel = timelineIdOf(1, 0, 1);

/** 2026-11-20T05:54:27.000Z, and a time that many milliseconds after it. */
const t0 = Date.UTC(2026, 10, 20, 5, 54, 27);
const at = (ms: number) => Instant.make(t0 + ms);

const said = (text: string, sender = "alice"): Content => ({
  _tag: "Message",
  answers: undefined,
  at: { _tag: "Unknown" },
  bot: false,
  context: undefined,
  id: { _tag: "Unknown" },
  kind: "Privmsg",
  live: true,
  ours: undefined,
  sender,
  tags: [],
  target: "#iirc",
  text,
});

const joined = (nick: string): Content => ({
  _tag: "Activity",
  activity: { _tag: "Joined", channel: "#iirc", nick },
  at: { _tag: "Unknown" },
  id: { _tag: "Unknown" },
  live: true,
});

const described: readonly Change[] = [
  {
    _tag: "Described",
    sequence: 1,
    timeline: { id: network, key: null, kind: "Network", life: 1, name: libera, network: libera },
  },
  {
    _tag: "Described",
    sequence: 1,
    timeline: {
      id: channel,
      key: "#iirc",
      kind: "Channel",
      life: 1,
      name: "#iirc",
      network: libera,
    },
  },
];

// An item in the Channel's Timeline, `ms` after `t0`, the `n`th of its step.
const added = (ms: number, n: number, content: Content): Change => ({
  _tag: "Added",
  content,
  ignored: [],
  intent: undefined,
  level: "Message",
  messageId: undefined,
  network: libera,
  position: { at: at(ms), n, sequence: 1 },
  sequence: 1,
  timeline: channel,
});

/**
 * A store in memory already folded by this projection version, with the Channel's items,
 * so the projector resumes after them and finds nothing more in an empty Journal.
 * @param contents - The items to fold in, after the Network and the Channel are described.
 * @returns The store.
 */
const storeWith = (contents: readonly Change[]) =>
  Effect.gen(function* () {
    const store = yield* makeMemoryTimelineStore;

    yield* store.reset(projectionVersion);
    yield* store.apply({
      changes: [...described, ...contents],
      directory: emptyDirectory,
      through: 1000,
    });

    return store;
  }).pipe(Effect.orDie);

interface Served {
  /** Sends a GET with the key, or none when `signedIn` is false. */
  readonly get: (path: string, signedIn?: boolean) => Effect.Effect<Response>;
}

/**
 * Serves the API over a real Bun server on a loopback port the kernel picks, on a store.
 * @param store - The Timeline store.
 * @returns The server, which stops when the Scope closes.
 */
const serve = (store: TimelineStoreService): Effect.Effect<Served, never, Scope.Scope> =>
  Effect.gen(function* () {
    const dataDir = yield* temporaryDirectory;
    const key = yield* makeKey(dataDir);
    const world = yield* makeWorld(undefined, store);

    const server = HttpRouter.serve(ApiRoutes, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        BunHttpServer.layer({ gracefulShutdownTimeout: 100, hostname: "127.0.0.1", port: 0 })
      ),
      Layer.provide(layerWorld(world, dataDir))
    );

    const { address } = Context.get(yield* Layer.build(server), HttpServer.HttpServer);

    const base =
      address._tag === "UnixPathAddress" ? "http://invalid" : `http://127.0.0.1:${address.port}`;

    return {
      get: (path: string, signedIn = true) =>
        Effect.promise(
          async () =>
            await fetch(`${base}${path}`, {
              headers: signedIn ? { authorization: `Bearer ${key}` } : {},
            })
        ),
    };
  }).pipe(Effect.orDie);

const run = async <A>(
  store: Effect.Effect<TimelineStoreService>,
  test: (served: Served) => Effect.Effect<A, never, Scope.Scope>
) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const served = yield* serve(yield* store);

        return yield* test(served);
      })
    )
  );

const linesOf = (text: string) => text.split("\n").filter((line) => line !== "");

const textOf = (response: Response) => Effect.promise(async () => await response.text());

const exportOf = (timeline: TimelineId, query = "") => `/api/timelines/${timeline}/export${query}`;

describe("exporting a Timeline", () => {
  it("answers its items as text, a line each with its time, as a file named for the Network and Timeline", async () => {
    const result = await run(
      storeWith([
        added(0, 0, joined("alice")),
        added(1000, 1, said("hello")),
        added(2500, 2, said("hi alice", "bob")),
      ]),
      (served) =>
        Effect.gen(function* () {
          const response = yield* served.get(exportOf(channel));

          return {
            body: yield* textOf(response),
            disposition: response.headers.get("content-disposition"),
            status: response.status,
            type: response.headers.get("content-type"),
          };
        })
    );

    expect(result).toStrictEqual({
      body: [
        "2026-11-20T05:54:27.000Z --> alice joined #iirc",
        "2026-11-20T05:54:28.000Z <alice> hello",
        "2026-11-20T05:54:29.500Z <bob> hi alice",
        "",
      ].join("\n"),
      disposition: `attachment; filename="libera-#iirc.txt"; filename*=UTF-8''libera-%23iirc.txt`,
      status: 200,
      type: "text/plain; charset=utf-8",
    });
  });

  it("keeps a range of time, from `since` on and before `until`", async () => {
    const body = await run(
      storeWith([
        added(9, 0, said("before since")),
        added(10, 1, said("at since")),
        added(19, 2, said("before until")),
        added(20, 3, said("at until")),
      ]),
      (served) =>
        served
          .get(exportOf(channel, `?since=${at(10)}&until=${at(20)}`))
          .pipe(Effect.flatMap(textOf))
    );

    expect(body).toBe(
      "2026-11-20T05:54:27.010Z <alice> at since\n2026-11-20T05:54:27.019Z <alice> before until\n"
    );
  });

  it("strips formatting from what a Network sent", async () => {
    const body = await run(
      storeWith([
        added(0, 0, said("\u0002bold\u0002 \u000304,01red\u0003 \u001Dplain", "\u0002bob")),
      ]),
      (served) => served.get(exportOf(channel)).pipe(Effect.flatMap(textOf))
    );

    expect(body).toBe("2026-11-20T05:54:27.000Z <bob> bold red plain\n");
  });

  it("refuses a request that is not signed in, with nothing of the Timeline", async () => {
    const result = await run(storeWith([added(0, 0, said("secret words"))]), (served) =>
      Effect.gen(function* () {
        const response = yield* served.get(exportOf(channel), false);

        return [response.status, yield* textOf(response)];
      })
    );

    expect(result).toStrictEqual([401, `{"_tag":"Unauthorized"}`]);
  });

  it("answers an id no Timeline ever had as UnknownTimeline", async () => {
    const unknown = timelineIdOf(1, 0, 99);

    const result = await run(storeWith([]), (served) =>
      Effect.gen(function* () {
        const response = yield* served.get(exportOf(unknown));

        return [response.status, yield* textOf(response)];
      })
    );

    expect(result).toStrictEqual([
      404,
      JSON.stringify({ _tag: "UnknownTimeline", timeline: unknown }),
    ]);
  });

  it("sends each page as it is read, before the store is read to the end", async () => {
    const count = 600;

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inner = yield* storeWith(
            Array.from({ length: count }, (_, n) => added(n, n, said(`line ${n}`)))
          );

          const reached = yield* Deferred.make<undefined>();
          const release = yield* Deferred.make<undefined>();

          // Every page after the first waits until the test releases it.
          const store: TimelineStoreService = {
            ...inner,
            range: (timeline, range) =>
              range.after === undefined
                ? inner.range(timeline, range)
                : Deferred.succeed(reached, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(inner.range(timeline, range))
                  ),
          };

          const served = yield* serve(store);
          const response = yield* served.get(exportOf(channel));
          const stream: ReadableStream<Uint8Array> | null = response.body;
          const body = stream?.getReader();

          if (body === undefined) {
            return yield* Effect.die(new Error("no body"));
          }

          const decoder = new TextDecoder();

          // Reads until the text holds `lines` lines, or the body ends.
          const readUntil = (sofar: string, lines: number) =>
            Effect.promise(async () => {
              let text = sofar;

              while (text.split("\n").length - 1 < lines) {
                // oxlint-disable-next-line no-await-in-loop -- reading a stream in order
                const chunk = await body.read();

                if (chunk.done) {
                  return text;
                }

                text += decoder.decode(chunk.value, { stream: true });
              }

              return text;
            });

          const first = yield* readUntil("", 256);

          // The next page has been asked of the store, which holds it back.
          yield* Deferred.await(reached);

          const held = yield* Deferred.isDone(release);

          yield* Deferred.succeed(release, undefined);

          const whole = yield* readUntil(first, Number.POSITIVE_INFINITY);

          return {
            first: linesOf(first).length,
            firstEnds: linesOf(first).at(-1),
            held,
            whole: linesOf(whole).length,
            wholeEnds: linesOf(whole).at(-1),
          };
        })
      )
    );

    expect(result).toStrictEqual({
      first: 256,
      firstEnds: "2026-11-20T05:54:27.255Z <alice> line 255",
      held: false,
      whole: count,
      wholeEnds: "2026-11-20T05:54:27.599Z <alice> line 599",
    });
  });
});
