import { BunHttpServer } from "@effect/platform-bun";
import { Happened, SaidAnswer } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { makeSqliteJournal } from "@iirc/journal-sqlite";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { describe, expect, it } from "vitest";

import { ApiRoutes, Heartbeat } from "./handlers.ts";
import {
  layerWorld,
  makeKey,
  makeWorld,
  registerOnFloor,
  say,
  temporaryDirectory,
} from "./testing/world.ts";
import type { World } from "./testing/world.ts";

const floor = configured({ ircds: [{ host: "irc.test", port: 6667, tls: false }] });

/** What a test over a real server gets. */
interface Served {
  readonly world: World;
  readonly base: string;
  readonly key: string;
  /** Sends a request with the key, unless `key` says otherwise. */
  readonly request: (
    path: string,
    init?: RequestInit & { readonly key?: string | null }
  ) => Effect.Effect<Response>;
}

/**
 * Serves the API over a real Bun server on an ephemeral loopback port, on the SQLite
 * Journal in a temporary directory, the in-memory Transport and Vault, and the live
 * clock, with heartbeats every 50 ms.
 */
const serve = Effect.gen(function* () {
  const dataDir = yield* temporaryDirectory;
  const key = yield* makeKey(dataDir);
  const journal = yield* makeSqliteJournal(`${dataDir}/journal.sqlite`);
  const world = yield* makeWorld(journal);

  const server = HttpRouter.serve(ApiRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({ gracefulShutdownTimeout: 100, hostname: "127.0.0.1", port: 0 })
    ),
    Layer.provide(layerWorld(world, dataDir)),
    Layer.provide(Layer.succeed(Heartbeat, Duration.millis(50)))
  );

  const context = yield* Layer.build(server);
  const { address } = Context.get(context, HttpServer.HttpServer);

  const base =
    address._tag === "UnixPathAddress" ? "http://invalid" : `http://127.0.0.1:${address.port}`;

  const served: Served = {
    base,
    key,
    request: (path, init = {}) =>
      Effect.promise(async () => {
        const { key: presented = key, ...rest } = init;
        const headers = new Headers(rest.headers);

        if (presented !== null) {
          headers.set("authorization", `Bearer ${presented}`);
        }

        return await fetch(`${base}${path}`, { ...rest, headers });
      }),
    world,
  };

  return served;
});

const run = async <A, E>(test: (served: Served) => Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(serve.pipe(Effect.flatMap(test))));

/** One Server-Sent Event, as the wire carries it. */
interface Sse {
  readonly id: string | undefined;
  readonly event: string;
  readonly data: string;
}

/**
 * Reads events from an SSE response until `enough` says to stop, then cancels it.
 * @param response - The response.
 * @param enough - Whether the events so far are enough.
 * @returns The events.
 */
const readEvents = (response: Response, enough: (events: readonly Sse[]) => boolean) =>
  Effect.promise(async () => {
    const body: ReadableStream<Uint8Array> | null = response.body;
    const events: Sse[] = [];

    if (body === null) {
      return events;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let done = enough(events);

    while (!done) {
      // oxlint-disable-next-line no-await-in-loop -- reading a stream in order
      const chunk = await reader.read();

      buffered += chunk.done ? "" : decoder.decode(chunk.value, { stream: true });
      let end = buffered.indexOf("\n\n");

      while (end !== -1) {
        const fields = new Map(
          buffered
            .slice(0, end)
            .split("\n")
            .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)])
        );

        events.push({
          data: fields.get("data") ?? "",
          event: fields.get("event") ?? "message",
          id: fields.get("id"),
        });
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf("\n\n");
      }

      done = chunk.done || enough(events);
    }

    await reader.cancel();

    return events;
  });

const happened = (events: readonly Sse[]) => events.filter((event) => event.event === "happened");

const json = (body: string): RequestInit => ({
  body,
  headers: { "content-type": "application/json" },
});

const sayTo = (served: Served, text: string) =>
  served.request("/api/networks/libera/say", {
    method: "POST",
    ...json(JSON.stringify({ kind: "Privmsg", target: "peer", text })),
  });

const sayUnder = (served: Served, intent: string) =>
  served.request("/api/networks/libera/say", {
    method: "POST",
    ...json(JSON.stringify({ intent, kind: "Privmsg", target: "peer", text: "hi" })),
  });

/**
 * Configures `libera`, registers it on the floor, and has a peer say each text.
 * @param served - The server.
 * @param texts - What the peer says.
 * @returns The Connection.
 */
const talk = (served: Served, texts: readonly string[]) =>
  Effect.gen(function* () {
    const configured = yield* served.request("/api/networks/libera", {
      method: "PUT",
      ...json(JSON.stringify(floor)),
    });

    expect(configured.status).toBe(200);
    const call = yield* registerOnFloor(served.world.memory);

    for (const text of texts) {
      yield* say(call, `:peer!u@h PRIVMSG iirc :${text}`);
    }

    return call;
  });

// Every `happened` event decodes as the contract says.
const decodeHappened = Schema.decodeUnknownSync(Schema.fromJsonString(Happened));

const decodeSaid = Schema.decodeUnknownSync(Schema.fromJsonString(SaidAnswer));

const messagesOf = (events: readonly Sse[]) =>
  happened(events).flatMap((event) =>
    decodeHappened(event.data).news.flatMap((one) => (one._tag === "Message" ? [one.text] : []))
  );

describe("the API over a real server", () => {
  it("streams News with the sequence as each event's id, and resumes after one", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* talk(served, ["one", "two", "three"]);

        const all = yield* Effect.flatMap(served.request("/api/news"), (response) =>
          readEvents(response, (events) => messagesOf(events).length === 3)
        );

        const ids = happened(all).map((event) => event.id);
        const second = happened(all).find((event) => messagesOf([event]).includes("two"))?.id;

        const fromQuery = yield* Effect.flatMap(
          served.request(`/api/news?after=${second}`),
          (response) => readEvents(response, (events) => happened(events).length > 0)
        );

        const fromHeader = yield* Effect.flatMap(
          served.request("/api/news?after=0", { headers: { "last-event-id": second ?? "" } }),
          (response) => readEvents(response, (events) => happened(events).length > 0)
        );

        return {
          contentType: (yield* served.request("/api/news?after=999999")).headers.get(
            "content-type"
          ),
          fromHeader: messagesOf(fromHeader),
          fromQuery: messagesOf(fromQuery),
          ids: ids.every((id) => id !== undefined && /^\d+$/u.test(id)),
          messages: messagesOf(all),
        };
      })
    );

    expect(result).toStrictEqual({
      contentType: "text/event-stream",
      fromHeader: ["three"],
      fromQuery: ["three"],
      ids: true,
      messages: ["one", "two", "three"],
    });
  });

  it("sends heartbeats while nothing happens, with no id", async () => {
    const result = await run((served) =>
      Effect.flatMap(served.request("/api/news"), (response) =>
        readEvents(response, (events) => events.length >= 3)
      )
    );

    expect(result.slice(0, 3)).toStrictEqual([
      { data: "{}", event: "heartbeat", id: undefined },
      { data: "{}", event: "heartbeat", id: undefined },
      { data: "{}", event: "heartbeat", id: undefined },
    ]);
  });

  it("goes on while a reader reads nothing, and the reader then misses nothing", async () => {
    const texts = Array.from({ length: 300 }, (_, index) => `message ${index} ${"x".repeat(400)}`);

    const result = await run((served) =>
      Effect.gen(function* () {
        const stalled = yield* served.request("/api/news");
        const call = yield* talk(served, texts);
        const last = texts.at(-1) ?? "";

        // Another reader sees every Message arrive while the first reads nothing, so the
        // Session is up, and the Runtime still takes the Owner's input and answers it.
        yield* Effect.flatMap(served.request("/api/news"), (response) =>
          readEvents(response, (read) => messagesOf(read).includes(last))
        );
        const said = yield* sayTo(served, "still here");
        const line = new TextDecoder().decode(yield* call.heard);

        const events = yield* readEvents(stalled, (read) =>
          messagesOf(read).includes("still here")
        );

        return { line, messages: messagesOf(events), said: said.status };
      })
    );

    expect(result.said).toBe(200);
    expect(result.line).toBe("PRIVMSG peer :still here\r\n");
    expect(result.messages).toStrictEqual([...texts, "still here"]);
  }, 30_000);

  it("refuses a request without a good key, before anything else", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const none = yield* served.request("/api/networks", { key: null });
        const wrong = yield* served.request("/api/networks", { key: "iirc_wrong" });
        const news = yield* served.request("/api/news", { key: null });

        const body = yield* served.request("/api/networks/libera", {
          key: null,
          method: "PUT",
          ...json(JSON.stringify({ nonsense: true })),
        });

        return {
          body: [body.status, yield* Effect.promise(async () => await body.json())],
          statuses: [none.status, wrong.status, news.status],
        };
      })
    );

    expect(result).toStrictEqual({
      body: [401, { _tag: "Unauthorized" }],
      statuses: [401, 401, 401],
    });
  });

  it("refuses a body that does not decode with 400, saying where, and never quoting it", async () => {
    const secret = "correct-horse-battery-staple";

    const result = await run((served) =>
      Effect.gen(function* () {
        const twoLines = yield* sayTo(served, "two\nlines");

        const credential = yield* served.request("/api/credentials/libera-pass", {
          method: "PUT",
          ...json(JSON.stringify({ valu: secret })),
        });

        const notJson = yield* served.request("/api/networks/libera", {
          body: `{"password": "${secret}`,
          headers: { "content-type": "application/json" },
          method: "PUT",
        });

        const badName = yield* served.request("/api/networks/Not%20One/known");

        return {
          badName: [badName.status, yield* Effect.promise(async () => await badName.json())],
          credential: [
            credential.status,
            yield* Effect.promise(async () => await credential.text()),
          ],
          notJson: [notJson.status, yield* Effect.promise(async () => await notJson.text())],
          twoLines: [twoLines.status, yield* Effect.promise(async () => await twoLines.json())],
        };
      })
    );

    expect(result.twoLines).toStrictEqual([
      400,
      {
        _tag: "InvalidRequest",
        issues: [{ message: "must not hold a line break or NUL", path: ["payload", "text"] }],
      },
    ]);
    expect([result.badName[0], result.credential[0], result.notJson[0]]).toStrictEqual([
      400, 400, 400,
    ]);
    expect(
      [result.credential[1], result.notJson[1]].map((body) => String(body).includes(secret))
    ).toStrictEqual([false, false]);
  });

  it("finds a dotted intent through `said`, and refuses the two that URL handling collapses", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* talk(served, []);

        const dotted = yield* sayUnder(served, "...");
        const lookup = yield* served.request("/api/networks/libera/said/...");
        const found = decodeSaid(yield* Effect.promise(async () => await lookup.text()));
        const one = yield* sayUnder(served, ".");
        const two = yield* sayUnder(served, "..");

        return {
          found: found._tag,
          statuses: [dotted.status, lookup.status, one.status, two.status],
        };
      })
    );

    expect(result).toStrictEqual({
      found: "Journaled",
      statuses: [200, 200, 400, 400],
    });
  });

  it("refuses a body over 1 MiB", async () => {
    const result = await run((served) =>
      Effect.map(
        served.request("/api/credentials/big", {
          method: "PUT",
          ...json(JSON.stringify({ value: "x".repeat(1024 * 1024 + 1) })),
        }),
        (response) => [response.status, response.headers.get("connection")]
      )
    );

    expect(result).toStrictEqual([413, "close"]);
  });
});
