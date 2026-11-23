import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";

import { BunFileSystem, BunHttpServer } from "@effect/platform-bun";
import {
  DaemonApi,
  Happened,
  ItemAfter,
  LookedAnswer,
  SaidAnswer,
  SearchResults,
  TimelineChange,
  TimelineList,
  TimelineWindow,
} from "@iirc/api";
import type { NetworkConfiguration } from "@iirc/client";
import { configured } from "@iirc/client/testing";
import { makeSqliteJournal } from "@iirc/journal-sqlite";
import { TimelineStoreFailed } from "@iirc/timeline-store";
import type { TimelineStoreService } from "@iirc/timeline-store";
import { makeSqliteTimelineStore } from "@iirc/timeline-store-sqlite";
import { Context, Duration, Effect, Layer, Ref, Schema } from "effect";
import type { Scope } from "effect";
import { constVoid } from "effect/Function";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { ApiRoutes, Heartbeat } from "./handlers.ts";
import { eventually } from "./testing/running.ts";
import {
  layerWorld,
  makeKey,
  makeWorld,
  registerOnFloor,
  say,
  storedSignIns,
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
 * Journal and Timeline store in a data directory, the in-memory Transport and Vault, and
 * the live clock, with heartbeats every 50 ms.
 * @param dataDir - The data directory, which holds the keys and the sign-ins.
 * @param key - The key requests present unless told otherwise.
 * @param wrap - What to make of the Timeline store, itself unless given.
 * @returns The server, which stops when the Scope closes.
 */
const serveOn = (
  dataDir: string,
  key: string,
  wrap: (store: TimelineStoreService) => TimelineStoreService = (store) => store
) =>
  Effect.gen(function* () {
    const journal = yield* makeSqliteJournal(`${dataDir}/journal.sqlite`);

    const store = yield* makeSqliteTimelineStore(`${dataDir}/views.sqlite`).pipe(
      Effect.provide(BunFileSystem.layer)
    );

    const world = yield* makeWorld(journal, wrap(store));

    const server = HttpRouter.serve(ApiRoutes, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
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

/** Serves the API on a fresh data directory with a key made in it. */
const serve = Effect.gen(function* () {
  const dataDir = yield* temporaryDirectory;

  return yield* serveOn(dataDir, yield* makeKey(dataDir));
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

/**
 * A response's body, as text.
 * @param response - The response.
 * @returns Its text.
 */
const textOf = (response: Response) => Effect.promise(async () => await response.text());

const happened = (events: readonly Sse[]) => events.filter((event) => event.event === "happened");

// What refusing a value of an option says, as the wire carries it.
const refused = (option: string) => [
  400,
  `{"_tag":"InvalidRequest","issues":[{"message":"Is not a value of ${option}","path":["payload","value"]}]}`,
];

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

/**
 * PUTs `libera`'s Configuration with some fields changed.
 * @param served - The server.
 * @param fields - The fields to change.
 * @returns The status and the body.
 */
const putConfiguration = (served: Served, fields: Partial<typeof NetworkConfiguration.Encoded>) =>
  Effect.gen(function* () {
    const response = yield* served.request("/api/networks/libera", {
      method: "PUT",
      ...json(JSON.stringify({ ...floor, ...fields })),
    });

    return [response.status, yield* Effect.promise(async () => await response.text())] as const;
  });

// Every `happened` event decodes as the contract says.
const decodeHappened = Schema.decodeUnknownSync(Schema.fromJsonString(Happened));

const decodeSaid = Schema.decodeUnknownSync(Schema.fromJsonString(SaidAnswer));

const decodeLooked = Schema.decodeUnknownSync(Schema.fromJsonString(LookedAnswer));

const decodeChange = Schema.decodeUnknownSync(Schema.fromJsonString(TimelineChange));

const decodeList = Schema.decodeUnknownSync(Schema.fromJsonString(TimelineList));

const decodeWindow = Schema.decodeUnknownSync(Schema.fromJsonString(TimelineWindow));

const decodeSearch = Schema.decodeUnknownSync(Schema.fromJsonString(SearchResults));

const encodeAfter = Schema.encodeSync(ItemAfter);

// What an error's body says: its tag, and for an `InvalidRequest`, where each issue was.
const decodeError = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.String,
      issues: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ path: Schema.Array(Schema.Union([Schema.String, Schema.Int])) })
        )
      ),
    })
  )
);

const changed = (events: readonly Sse[]) => events.filter((event) => event.event === "changed");

/**
 * What the Messages in `changed` events said.
 * @param events - The events.
 * @returns The texts of the Messages they carry, in order.
 */
const changedTexts = (events: readonly Sse[]) =>
  changed(events).flatMap((event) =>
    decodeChange(event.data).items.flatMap((item) =>
      item.content._tag === "Message" ? [item.content.text] : []
    )
  );

const messagesOf = (events: readonly Sse[]) =>
  happened(events).flatMap((event) =>
    decodeHappened(event.data).news.flatMap((one) => (one._tag === "Message" ? [one.text] : []))
  );

/** What a browser says of a request from the Daemon's own origin. */
const sameOrigin = { "sec-fetch-site": "same-origin" };

/**
 * Signs in as a browser does, with the key in the body and no `Authorization`.
 * @param served - The server.
 * @param key - The key to give.
 * @param headers - What the browser says of the request's origin, and any proxy headers.
 * @returns The response.
 */
const signIn = (
  served: Served,
  key: string,
  headers: Readonly<Record<string, string>> = sameOrigin
) =>
  served.request("/api/sign-in", {
    body: JSON.stringify({ key }),
    headers: { "content-type": "application/json", ...headers },
    key: null,
    method: "POST",
  });

/**
 * Sends a request as a browser does: the sign-in's cookie, if any, and never a key.
 * @param served - The server.
 * @param path - The path.
 * @param token - The sign-in's token.
 * @param init - The request, with what the browser says of its origin in its headers.
 * @returns The response.
 */
const asBrowser = (
  served: Served,
  path: string,
  token: string | undefined,
  init: Omit<RequestInit, "headers"> & { readonly headers?: Readonly<Record<string, string>> } = {}
) =>
  served.request(path, {
    ...init,
    headers: { ...init.headers, ...(token !== undefined && { cookie: `iirc_sign_in=${token}` }) },
    key: null,
  });

/**
 * The attributes of each `Set-Cookie` in a response.
 * @param response - The response.
 * @returns Each cookie's attributes, the first being `name=value`.
 */
const setCookies = (response: Response) =>
  response.headers.getSetCookie().map((cookie) => cookie.split("; "));

/**
 * The sign-in's token from a sign-in's `Set-Cookie`.
 * @param response - The sign-in's response.
 * @returns The token.
 */
const tokenOf = (response: Response) =>
  /^iirc_sign_in=(?<token>[^;]+)/u.exec(response.headers.getSetCookie()[0] ?? "")?.groups?.token ??
  "";

/**
 * What `sign-ins.json` holds, or nothing if there is no file.
 * @param dataDir - The data directory.
 * @returns The file's text.
 */
const readSignIns = (dataDir: string) =>
  existsSync(`${dataDir}/sign-ins.json`)
    ? readFileSync(`${dataDir}/sign-ins.json`, "utf-8")
    : undefined;

const bodyOf = (response: Response) => Effect.promise(async () => await response.text());

const holdCredential = (headers: Readonly<Record<string, string>> = {}) => ({
  body: JSON.stringify({ value: "hunter2" }),
  headers: { "content-type": "application/json", ...headers },
  method: "PUT",
});

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

        // Read for its header alone, and cancelled, as a reader that leaves does.
        const ahead = yield* served.request("/api/news?after=999999");

        yield* Effect.promise(async () => {
          await ahead.body?.cancel();
        });

        return {
          contentType: ahead.headers.get("content-type"),
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

  it("reads a Message in its Timeline's window, and carries it on the changes with its step's id", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const following = yield* served.request("/api/timelines/changes");

        yield* talk(served, ["hello there"]);

        const events = yield* readEvents(following, (read) =>
          changedTexts(read).includes("hello there")
        );

        const carrying = changed(events).find((event) =>
          changedTexts([event]).includes("hello there")
        );

        const listed = decodeList(
          yield* bodyOf(yield* served.request("/api/networks/libera/timelines"))
        );

        const direct = listed.timelines.find((each) => each.kind === "Direct");

        const window = decodeWindow(
          yield* bodyOf(yield* served.request(`/api/timelines/${direct?.id ?? "none"}?limit=10`))
        );

        const [item] = window.items;

        const located = yield* served.request(`/api/networks/libera/at/${item?.sequence ?? 0}`);

        return {
          direct: direct === undefined ? undefined : [direct.name, direct.key],
          id: carrying?.id === `${window.version}.${item?.sequence}`,
          ids: changed(events).every(
            (event) => event.id === `${listed.version}.${decodeChange(event.data).sequence}`
          ),
          items: window.items.map((one) =>
            one.content._tag === "Message" ? [one.content.sender, one.content.text] : []
          ),
          located: located.status,
          projection: listed.projection,
          through:
            listed.through !== null && window.through !== null && window.through >= listed.through,
        };
      })
    );

    expect(result).toStrictEqual({
      direct: ["peer", "peer"],
      id: true,
      ids: true,
      items: [["peer", "hello there"]],
      located: 200,
      projection: { _tag: "Running" },
      through: true,
    });
  });

  it("searches over the wire, takes a query's syntax as text, and refuses a search it cannot make", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const following = yield* served.request("/api/timelines/changes");
        const texts = ['say "hi" OR NEAR(x)', "Hello there", "hello again"];

        yield* talk(served, texts);
        yield* readEvents(following, (read) => changedTexts(read).includes("hello again"));

        const search = (query: string) =>
          served.request(`/api/search?${query}`).pipe(
            Effect.flatMap((response) => bodyOf(response)),
            Effect.map(decodeSearch)
          );

        const found = (query: string) =>
          search(query).pipe(
            Effect.map((page) =>
              page.items.map((item) => (item.content._tag === "Message" ? item.content.text : ""))
            )
          );

        const first = yield* search("text=HELLO&limit=1");

        const answered = [];

        for (const query of [
          "text=ab",
          "text=a%00bc",
          "text=a%0Abc",
          "",
          "text=hello&limit=501",
          "text=hello&after=nope",
          "text=hello&since=soon",
          "text=hello&from=a%20b",
          "text=hello&timeline=nope",
          "text=hello&network=Libera",
          "text=hello&network=oftc",
          "text=hello&timeline=00000000000fff-00000000-00000000",
        ]) {
          const response = yield* served.request(`/api/search?${query}`);

          answered.push([response.status, decodeError(yield* bodyOf(response))._tag]);
        }

        return {
          answered,
          first: [first.items.length, first.more, first.next === null],
          hostile: yield* found(`text=${encodeURIComponent('"hi" OR NEAR(')}`),
          next: yield* found(
            `text=hello&after=${encodeURIComponent(first.next === null ? "" : encodeAfter(first.next))}`
          ),
          peer: yield* found("text=hello&from=PEER&network=libera"),
          star: yield* found(`text=${encodeURIComponent("*")}${encodeURIComponent("**")}`),
        };
      })
    );

    expect(result).toStrictEqual({
      answered: [
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [404, "UnknownNetwork"],
        [404, "UnknownTimeline"],
      ],
      first: [1, true, false],
      hostile: ['say "hi" OR NEAR(x)'],
      next: ["Hello there"],
      peer: ["hello again", "Hello there"],
      star: [],
    });
  });

  it("refuses a cursor that is not one with 400, and a Timeline never given with 404", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const never = "00000000000fff-00000000-00000000";

        const statuses = [
          `/api/timelines/${never}?before=nope`,
          `/api/timelines/${never}?before=0020000000000000-00000000000001-00000000&after=0020000000000000-00000000000001-00000000`,
          `/api/timelines/${never}?limit=501`,
          `/api/timelines/${never}`,
          "/api/timelines/not-an-id",
          "/api/networks/libera/at/0",
          "/api/networks/libera/at/1?after=nope",
          "/api/networks/libera/at/1?limit=501",
          "/api/timelines/changes?after=7",
          "/api/networks/libera/timelines?limit=0",
          "/api/networks/libera/timelines?after=nope",
          "/api/networks/libera/timelines",
        ];

        const answered = [];

        for (const path of statuses) {
          const response = yield* served.request(path);

          answered.push([response.status, decodeError(yield* bodyOf(response))._tag]);
        }

        const issue = yield* bodyOf(yield* served.request(`/api/timelines/${never}?after=nope`));

        return { answered, issue: decodeError(issue).issues?.[0]?.path };
      })
    );

    expect(result).toStrictEqual({
      answered: [
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [404, "UnknownTimeline"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [400, "InvalidRequest"],
        [404, "UnknownNetwork"],
      ],
      issue: ["query", "after"],
    });
  });

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

  it("refuses a Configuration whose Lines /quote would refuse, or whose user modes are no mode string, with 400, never quoting the Line", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        return {
          kept: (yield* putConfiguration(served, {
            lines: ["PRIVMSG HostServ :ON"],
            userModes: "+ix-w",
          }))[0],
          modes: (yield* putConfiguration(served, { userModes: "ix" }))[0],
          pass: yield* putConfiguration(served, { lines: ["PING a", "PASS correct-horse"] }),
          tooMany: (yield* putConfiguration(served, {
            lines: Array.from({ length: 17 }, () => "PING a"),
          }))[0],
        };
      })
    );

    expect([result.kept, result.modes, result.pass[0], result.tooMany]).toStrictEqual([
      200, 400, 400, 400,
    ]);
    expect(JSON.parse(result.pass[1])).toMatchObject({
      issues: [{ path: ["payload", "lines", 1] }],
    });
    expect(result.pass[1].includes("correct-horse")).toBeFalsy();
  });

  it("sets a ui option over the wire, refuses an option it has not and a value it cannot take, and streams the options", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const first = yield* Effect.flatMap(served.request("/api/ui/changes"), (response) =>
          readEvents(response, (events) => events.some((event) => event.event === "changed"))
        );

        const set = yield* served.request("/api/ui/timeline.timeFormat?ifSequence=0", {
          method: "PUT",
          ...json('{"value":"HH:mm:ss"}'),
        });

        const stale = yield* served.request("/api/ui/timeline.timeFormat?ifSequence=0", {
          method: "DELETE",
        });

        const unknown = yield* served.request("/api/ui/palette", {
          method: "PUT",
          ...json('{"value":"dusk"}'),
        });

        const badValue = yield* served.request("/api/ui/timeline.activity", {
          method: "PUT",
          ...json('{"value":"loud"}'),
        });

        const tooTall = yield* served.request("/api/ui/font.lineHeight", {
          method: "PUT",
          ...json('{"value":2.5}'),
        });

        const tooShort = yield* served.request("/api/ui/font.lineHeight", {
          method: "PUT",
          ...json('{"value":0.9}'),
        });

        // A value no step of a hundredth makes is refused, as a sum in binary makes one.
        const offStep = yield* served.request("/api/ui/font.lineHeight", {
          method: "PUT",
          ...json(`{"value":${1.1 + 0.05}}`),
        });

        const finer = yield* served.request("/api/ui/font.lineHeight", {
          method: "PUT",
          ...json('{"value":1.455}'),
        });

        // An import may not take a built-in theme's name, so it never hides that theme.
        const palette = JSON.stringify({
          ansi: Array.from({ length: 16 }, () => "#808080"),
          background: "#000000",
          foreground: "#ffffff",
        });

        const reserved = yield* served.request("/api/ui/theme.imported", {
          method: "PUT",
          ...json(`{"value":[{"name":"nord","palette":${palette}}]}`),
        });

        const resumed = yield* Effect.flatMap(
          served.request("/api/ui/changes", { headers: { "last-event-id": "0" } }),
          (response) =>
            readEvents(response, (events) => events.some((event) => event.event === "changed"))
        );

        return {
          badValue: [badValue.status, yield* textOf(badValue)],
          finer: [finer.status, yield* textOf(finer)],
          first: first.filter((event) => event.event === "changed"),
          offStep: [offStep.status, yield* textOf(offStep)],
          reserved: [reserved.status, yield* textOf(reserved)],
          resumed: resumed.filter((event) => event.event === "changed"),
          set: [set.status, yield* textOf(set)],
          stale: [stale.status, yield* textOf(stale)],
          tooShort: [tooShort.status, yield* textOf(tooShort)],
          tooTall: [tooTall.status, yield* textOf(tooTall)],
          unknown: [
            unknown.status,
            (yield* textOf(unknown)).includes('"path":["params","option"]'),
          ],
        };
      })
    );

    expect(result).toStrictEqual({
      badValue: [
        400,
        '{"_tag":"InvalidRequest","issues":[{"message":"Is not a value of ui.timeline.activity","path":["payload","value"]}]}',
      ],
      finer: [
        400,
        '{"_tag":"InvalidRequest","issues":[{"message":"Is not a value of ui.font.lineHeight","path":["payload","value"]}]}',
      ],
      first: [
        {
          data: '{"options":{"aliases":[],"composer.enter":"send","composer.nickSuffix":": ","composer.spellcheck":true,"font":"system","font.lineHeight":1.45,"font.size":14,"members.width":18,"previews":"off","previews.animate":true,"previews.mediaHeight":"medium","previews.players":["www.youtube-nocookie.com","player.vimeo.com","w.soundcloud.com","bandcamp.com","open.spotify.com","player.twitch.tv"],"previews.start":"open","previews.timelines":{},"sidebar.networks":[],"sidebar.order":[],"sidebar.pinned":[],"tail":"info","theme":"system","theme.dark":"dark","theme.imported":[],"theme.light":"light","timeline.activity":"all","timeline.colours":"theme","timeline.dateFormat":"full","timeline.layout":"columns","timeline.maxWidth":"none","timeline.nickBrackets":true,"timeline.nickPrefix":true,"timeline.nickWidth":16,"timeline.spacing":0.3,"timeline.timeFormat":"HH:mm","unread.markRead":"latest","unread.muted":[],"unread.quietBots":false},"sequence":0}',
          event: "changed",
          id: "0",
        },
      ],
      offStep: [
        400,
        '{"_tag":"InvalidRequest","issues":[{"message":"Is not a value of ui.font.lineHeight","path":["payload","value"]}]}',
      ],
      reserved: [
        400,
        '{"_tag":"InvalidRequest","issues":[{"message":"Is not a value of ui.theme.imported","path":["payload","value"]}]}',
      ],
      resumed: [
        {
          data: '{"options":{"aliases":[],"composer.enter":"send","composer.nickSuffix":": ","composer.spellcheck":true,"font":"system","font.lineHeight":1.45,"font.size":14,"members.width":18,"previews":"off","previews.animate":true,"previews.mediaHeight":"medium","previews.players":["www.youtube-nocookie.com","player.vimeo.com","w.soundcloud.com","bandcamp.com","open.spotify.com","player.twitch.tv"],"previews.start":"open","previews.timelines":{},"sidebar.networks":[],"sidebar.order":[],"sidebar.pinned":[],"tail":"info","theme":"system","theme.dark":"dark","theme.imported":[],"theme.light":"light","timeline.activity":"all","timeline.colours":"theme","timeline.dateFormat":"full","timeline.layout":"columns","timeline.maxWidth":"none","timeline.nickBrackets":true,"timeline.nickPrefix":true,"timeline.nickWidth":16,"timeline.spacing":0.3,"timeline.timeFormat":"HH:mm:ss","unread.markRead":"latest","unread.muted":[],"unread.quietBots":false},"sequence":1}',
          event: "changed",
          id: "1",
        },
      ],
      set: [200, '{"sequence":1}'],
      stale: [409, '{"_tag":"UiChanged","sequence":1}'],
      tooShort: [
        400,
        '{"_tag":"InvalidRequest","issues":[{"message":"Is not a value of ui.font.lineHeight","path":["payload","value"]}]}',
      ],
      tooTall: [
        400,
        '{"_tag":"InvalidRequest","issues":[{"message":"Is not a value of ui.font.lineHeight","path":["payload","value"]}]}',
      ],
      unknown: [400, true],
    });
  });

  it("sets a store, uploads, or previews option over the wire, refuses an option it has not, a value it cannot take, and a stale write, and streams the options", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const first = yield* Effect.flatMap(served.request("/api/options/changes"), (response) =>
          readEvents(response, (events) => events.some((event) => event.event === "changed"))
        );

        const bucket = yield* served.request("/api/options/store.s3.bucket?ifSequence=0", {
          method: "PUT",
          ...json('{"value":"uploads"}'),
        });

        const key = yield* served.request("/api/options/store.s3.accessKeyId?ifSequence=1", {
          method: "PUT",
          ...json('{"value":"bucket-key"}'),
        });

        const stale = yield* served.request("/api/options/uploads.maxSize?ifSequence=1", {
          method: "PUT",
          ...json('{"value":1024}'),
        });

        const unknown = yield* served.request("/api/options/store.s3.colour", {
          method: "PUT",
          ...json('{"value":"blue"}'),
        });

        const uiByName = yield* served.request("/api/options/ui.timeline.timeFormat", {
          method: "PUT",
          ...json('{"value":"none"}'),
        });

        const notWhole = yield* served.request("/api/options/uploads.maxSize", {
          method: "PUT",
          ...json('{"value":1.5}'),
        });

        const notHttp = yield* served.request("/api/options/uploads.publicUrl", {
          method: "PUT",
          ...json('{"value":"ftp://files.example.com"}'),
        });

        const withQuery = yield* served.request("/api/options/uploads.publicUrl", {
          method: "PUT",
          ...json('{"value":"https://files.example.com/?x=1"}'),
        });

        const unset = yield* served.request("/api/options/store.s3.bucket?ifSequence=2", {
          method: "DELETE",
        });

        const read = yield* served.request("/api/options");
        const ui = yield* served.request("/api/ui");

        const resumed = yield* Effect.flatMap(
          served.request("/api/options/changes", { headers: { "last-event-id": "2" } }),
          (response) =>
            readEvents(response, (events) => events.some((event) => event.event === "changed"))
        );

        return {
          bucket: [bucket.status, yield* textOf(bucket)],
          first: changed(first),
          key: [key.status, yield* textOf(key)],
          notHttp: [notHttp.status, yield* textOf(notHttp)],
          notWhole: [notWhole.status, yield* textOf(notWhole)],
          read: [read.status, yield* textOf(read)],
          resumed: changed(resumed),
          stale: [stale.status, yield* textOf(stale)],
          ui: (yield* textOf(ui)).endsWith('"sequence":0}'),
          uiByName: [
            uiByName.status,
            (yield* textOf(uiByName)).includes('"path":["params","option"]'),
          ],
          unknown: [
            unknown.status,
            (yield* textOf(unknown)).includes('"path":["params","option"]'),
          ],
          unset: [unset.status, yield* textOf(unset)],
          withQuery: [withQuery.status, yield* textOf(withQuery)],
        };
      })
    );

    expect(result).toStrictEqual({
      bucket: [200, '{"sequence":1}'],
      first: [
        {
          data: '{"options":{"previews.maxTotal":1073741824,"uploads.maxSize":104857600},"sequence":0}',
          event: "changed",
          id: "0",
        },
      ],
      key: [200, '{"sequence":2}'],
      notHttp: refused("uploads.publicUrl"),
      notWhole: refused("uploads.maxSize"),
      read: [
        200,
        '{"options":{"previews.maxTotal":1073741824,"store.s3.accessKeyId":"bucket-key","uploads.maxSize":104857600},"sequence":3}',
      ],
      resumed: [
        {
          data: '{"options":{"previews.maxTotal":1073741824,"store.s3.accessKeyId":"bucket-key","uploads.maxSize":104857600},"sequence":3}',
          event: "changed",
          id: "3",
        },
      ],
      stale: [409, '{"_tag":"OptionsChanged","sequence":2}'],
      ui: true,
      uiByName: [400, true],
      unknown: [400, true],
      unset: [200, '{"sequence":3}'],
      withQuery: refused("uploads.publicUrl"),
    });
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

  it("refuses a Lookup the wire cannot read, saying where, and finds one by its intent", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        // With no Session, a Lookup is answered at once, refused as `Offline`.
        yield* served.request("/api/networks/libera", {
          method: "PUT",
          ...json(JSON.stringify(floor)),
        });

        const look = (body: {
          readonly intent?: string;
          readonly lookup: { readonly _tag: string; readonly nick?: string };
        }) =>
          served.request("/api/networks/libera/lookups", {
            method: "POST",
            ...json(JSON.stringify(body)),
          });

        const answered = [];

        for (const body of [
          { lookup: { _tag: "Whois", nick: "peer\r\nQUIT" } },
          { lookup: { _tag: "Whois", nick: "" } },
          { lookup: { _tag: "List" } },
          { intent: "..", lookup: { _tag: "Whois", nick: "peer" } },
        ]) {
          const response = yield* look(body);
          const error = decodeError(yield* bodyOf(response));

          answered.push([response.status, error._tag, error.issues?.[0]?.path]);
        }

        const pending = yield* look({ intent: "who.1", lookup: { _tag: "Whowas", nick: "gone" } });
        const found = yield* served.request("/api/networks/libera/lookups/who.1");

        return {
          answered,
          found: [found.status, decodeLooked(yield* bodyOf(found))._tag],
          looked: [pending.status, decodeLooked(yield* bodyOf(pending))._tag],
        };
      })
    );

    expect(result.answered).toStrictEqual([
      [400, "InvalidRequest", ["payload", "lookup", "nick"]],
      [400, "InvalidRequest", ["payload", "lookup", "nick"]],
      [400, "InvalidRequest", ["payload", "lookup"]],
      [400, "InvalidRequest", ["payload", "intent"]],
    ]);
    expect(result.looked).toStrictEqual([200, "LookedUp"]);
    expect(result.found).toStrictEqual([200, "LookedUp"]);
  });

  it("signs a browser in for an HttpOnly cookie, Secure only behind TLS", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const plain = yield* signIn(served, served.key);

        const tls = yield* signIn(served, served.key, {
          ...sameOrigin,
          "x-forwarded-proto": "https",
        });

        const byOrigin = yield* signIn(served, served.key, { origin: served.base });
        const wrong = yield* signIn(served, "iirc_wrong");
        const crossSite = yield* signIn(served, served.key, { "sec-fetch-site": "cross-site" });
        const foreign = yield* signIn(served, served.key, { origin: "http://evil.test" });
        const silent = yield* signIn(served, served.key, {});

        const refused = [wrong, crossSite, foreign, silent];

        return {
          byOrigin: byOrigin.status,
          plain: [plain.status, setCookies(plain).map((cookie) => cookie.slice(1))],
          refused: refused.map((response) => response.status),
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
          refusedBodies: yield* Effect.forEach(refused, bodyOf),
          refusedCookies: refused.flatMap((response) => response.headers.getSetCookie()),
          tls: setCookies(tls).map((cookie) => cookie.slice(1)),
          token: /^iirc_s_[\w-]{43}$/u.test(tokenOf(plain)),
        };
      })
    );

    const attributes = ["Max-Age=34560000", "Path=/api", "HttpOnly", "SameSite=Strict"];

    expect(result.plain).toStrictEqual([204, [attributes]]);
    expect(result.tls).toStrictEqual([
      ["Max-Age=34560000", "Path=/api", "HttpOnly", "Secure", "SameSite=Strict"],
    ]);
    expect(result).toMatchObject({
      byOrigin: 204,
      refused: [401, 403, 403, 403],
      refusedBodies: [
        '{"_tag":"Unauthorized"}',
        '{"_tag":"CrossOrigin"}',
        '{"_tag":"CrossOrigin"}',
        '{"_tag":"CrossOrigin"}',
      ],
      refusedCookies: [],
      token: true,
    });
  });

  it("authorizes reads and News by the cookie alone, and writes only from the same origin", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const token = tokenOf(yield* signIn(served, served.key));
        const listed = yield* asBrowser(served, "/api/networks", token);

        const news = yield* asBrowser(served, "/api/news", token);
        const events = yield* readEvents(news, (read) => read.length > 0);

        const write = (headers: Readonly<Record<string, string>>, by = token) =>
          Effect.map(
            asBrowser(served, "/api/credentials/libera-pass", by, holdCredential(headers)),
            (response) => response.status
          );

        return {
          bearer: (yield* served.request("/api/credentials/libera-pass", holdCredential())).status,
          listed: [listed.status, yield* bodyOf(listed)],
          news: [news.status, news.headers.get("content-type"), events[0]?.event],
          noCookie: (yield* asBrowser(served, "/api/networks", undefined)).status,
          writes: {
            crossSite: yield* write({ "sec-fetch-site": "cross-site" }),
            foreignOrigin: yield* write({ origin: "http://evil.test" }),
            forged: yield* write(sameOrigin, "iirc_s_forged"),
            ownOrigin: yield* write({ origin: served.base }),
            sameOrigin: yield* write(sameOrigin),
            sameSite: yield* write({ "sec-fetch-site": "same-site" }),
            silent: yield* write({}),
          },
        };
      })
    );

    expect(result).toStrictEqual({
      bearer: 204,
      listed: [200, "[]"],
      news: [200, "text/event-stream", "heartbeat"],
      noCookie: 401,
      writes: {
        crossSite: 403,
        foreignOrigin: 403,
        forged: 401,
        ownOrigin: 204,
        sameOrigin: 204,
        sameSite: 403,
        silent: 403,
      },
    });
  });

  it("signs a browser out, so its cookie authorizes nothing, and clears the cookie", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const token = tokenOf(yield* signIn(served, served.key));
        const other = tokenOf(yield* signIn(served, served.key));

        const crossSite = yield* asBrowser(served, "/api/sign-in", token, {
          headers: { "sec-fetch-site": "cross-site" },
          method: "DELETE",
        });

        const stillIn = (yield* asBrowser(served, "/api/networks", token)).status;

        const out = yield* asBrowser(served, "/api/sign-in", token, {
          headers: sameOrigin,
          method: "DELETE",
        });

        const again = yield* asBrowser(served, "/api/sign-in", token, {
          headers: sameOrigin,
          method: "DELETE",
        });

        const none = yield* asBrowser(served, "/api/sign-in", undefined, {
          headers: sameOrigin,
          method: "DELETE",
        });

        return {
          after: (yield* asBrowser(served, "/api/networks", token)).status,
          cleared: [out, again, none].map((response) => [
            response.status,
            setCookies(response).map((cookie) => cookie[0]),
          ]),
          crossSite: [crossSite.status, crossSite.headers.getSetCookie()],
          expires: setCookies(out)[0]?.some((attribute) =>
            /^(?:Max-Age=0|Expires=)/u.test(attribute)
          ),
          other: (yield* asBrowser(served, "/api/networks", other)).status,
          stillIn,
        };
      })
    );

    expect(result).toStrictEqual({
      after: 401,
      cleared: [
        [204, ["iirc_sign_in="]],
        [204, ["iirc_sign_in="]],
        [204, ["iirc_sign_in="]],
      ],
      crossSite: [403, []],
      expires: true,
      other: 200,
      stillIn: 200,
    });
  });

  it("answers 503 and changes nothing when a sign-in cannot be written, and signs in once it can", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* temporaryDirectory;
          const served = yield* serveOn(dataDir, yield* makeKey(dataDir));
          const existing = tokenOf(yield* signIn(served, served.key));
          const before = readSignIns(dataDir);

          // A directory where the temporary file goes, so the write fails the same way a full or
          // unwritable disk would, and mending it is removing the directory.
          mkdirSync(`${dataDir}/sign-ins.json.tmp`);
          const failed = yield* signIn(served, served.key);
          const body = yield* bodyOf(failed);

          const during = {
            cookies: failed.headers.getSetCookie(),
            existing: (yield* asBrowser(served, "/api/networks", existing)).status,
            file: readSignIns(dataDir) === before,
            status: failed.status,
          };

          rmdirSync(`${dataDir}/sign-ins.json.tmp`);
          const retried = yield* signIn(served, served.key);
          const token = tokenOf(retried);

          return {
            after: {
              existing: (yield* asBrowser(served, "/api/networks", existing)).status,
              retried: [retried.status, token.startsWith("iirc_s_")],
              retriedToken: (yield* asBrowser(served, "/api/networks", token)).status,
              // The failed sign-in left nothing behind: the existing one and the retry only.
              stored: storedSignIns(dataDir).length,
            },
            body: body.includes("SignInsFailed"),
            during,
          };
        })
      )
    );

    expect(result).toStrictEqual({
      after: { existing: 200, retried: [204, true], retriedToken: 200, stored: 2 },
      body: true,
      during: { cookies: [], existing: 200, file: true, status: 503 },
    });
  });

  it("answers 503 and changes nothing when a sign-out cannot be written, and signs out once it can", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* temporaryDirectory;
          const served = yield* serveOn(dataDir, yield* makeKey(dataDir));
          const token = tokenOf(yield* signIn(served, served.key));
          const before = readSignIns(dataDir);

          const signOut = () =>
            asBrowser(served, "/api/sign-in", token, { headers: sameOrigin, method: "DELETE" });

          mkdirSync(`${dataDir}/sign-ins.json.tmp`);
          const failed = yield* signOut();
          const body = yield* bodyOf(failed);

          const during = {
            cookies: failed.headers.getSetCookie(),
            file: readSignIns(dataDir) === before,
            status: failed.status,
            stillIn: (yield* asBrowser(served, "/api/networks", token)).status,
          };

          rmdirSync(`${dataDir}/sign-ins.json.tmp`);
          const retried = yield* signOut();

          return {
            after: {
              cleared: setCookies(retried).map((cookie) => cookie[0]),
              refused: (yield* asBrowser(served, "/api/networks", token)).status,
              status: retried.status,
              stored: storedSignIns(dataDir).length,
            },
            body: body.includes("SignInsFailed"),
            during,
          };
        })
      )
    );

    expect(result).toStrictEqual({
      after: { cleared: ["iirc_sign_in="], refused: 401, status: 204, stored: 0 },
      body: true,
      during: { cookies: [], file: true, status: 503, stillIn: 200 },
    });
  });

  it("keeps a sign-in across a restart, and drops it once its key is gone", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* temporaryDirectory;
          const key = yield* makeKey(dataDir);

          const token = yield* Effect.scoped(
            Effect.flatMap(serveOn(dataDir, key), (served) =>
              Effect.map(signIn(served, key), tokenOf)
            )
          );

          const restarted = yield* Effect.scoped(
            Effect.flatMap(serveOn(dataDir, key), (served) =>
              Effect.map(asBrowser(served, "/api/networks", token), (response) => response.status)
            )
          );

          // The key is revoked, and another made under the same name.
          rmSync(`${dataDir}/keys.json`);
          const remade = yield* makeKey(dataDir);

          const revoked = yield* Effect.scoped(
            Effect.flatMap(serveOn(dataDir, remade), (served) =>
              Effect.map(asBrowser(served, "/api/networks", token), (response) => response.status)
            )
          );

          return {
            file: readFileSync(`${dataDir}/sign-ins.json`, "utf-8"),
            restarted,
            revoked,
          };
        })
      )
    );

    expect(result).toStrictEqual({
      file: JSON.stringify({ signIns: [], version: 1 }, null, 2),
      restarted: 200,
      revoked: 401,
    });
  });

  it("never shows a key in a response, a log, or sign-ins.json, nor a sign-in's token but in its cookie", async () => {
    const wrong = "iirc_not-the-key-but-a-secret-all-the-same";

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* temporaryDirectory;
          const key = yield* makeKey(dataDir);
          const served = yield* serveOn(dataDir, key);

          const responses = [
            yield* signIn(served, key),
            yield* signIn(served, wrong),
            yield* signIn(served, key, { "sec-fetch-site": "cross-site" }),
            yield* served.request("/api/sign-in", {
              body: JSON.stringify({ key, remember: true }),
              headers: { "content-type": "application/json", ...sameOrigin },
              key: null,
              method: "POST",
            }),
          ];

          const [signedIn] = responses;
          const token = signedIn === undefined ? "" : tokenOf(signedIn);

          const out = yield* asBrowser(served, "/api/sign-in", token, {
            headers: sameOrigin,
            method: "DELETE",
          });

          const shown = yield* Effect.forEach([...responses, out], (response) =>
            Effect.map(
              bodyOf(response),
              (body) => `${JSON.stringify([...response.headers])}\n${body}`
            )
          );

          const stored = readFileSync(`${dataDir}/sign-ins.json`, "utf-8");

          return {
            key,
            logged: served.world.logged.join("\n"),
            shown: shown.join("\n"),
            statuses: [...responses, out].map((response) => response.status),
            stored,
            token,
          };
        })
      )
    );

    expect(result.statuses).toStrictEqual([204, 401, 403, 400, 204]);
    expect(result.logged).toContain("Signed a browser in");
    expect(result.logged).toContain("Signed a browser out");

    // A response carries a token only in the sign-in's cookie, and never a key.
    const keys = [result.key, wrong];
    const all = [...keys, result.token];

    expect({
      logged: all.some((secret) => result.logged.includes(secret)),
      shown: keys.some((secret) => result.shown.includes(secret)),
      stored: all.some((secret) => result.stored.includes(secret)),
    }).toStrictEqual({ logged: false, shown: false, stored: false });
  });
});

/**
 * Asks whether the Daemon is well.
 * @param served - The server.
 * @param key - The key to present, or `null` for none.
 * @returns The status and the body.
 */
const health = (served: Served, key: string | null) =>
  served
    .request("/api/health", { key })
    .pipe(
      Effect.flatMap((response) =>
        textOf(response).pipe(Effect.map((body) => [response.status, body] as const))
      )
    );

describe("whether the Daemon is well, over a real server", () => {
  // A reason that holds a path, as a store's own can, which the answer must never carry.
  const reason = "SQLITE_FULL writing /home/owner/.local/share/iirc/views.sqlite";

  /**
   * Serves the API on a Timeline store that fails every read of how far it folded, and
   * every apply, once armed, so the step to fail is the first one folded after arming it.
   * @param keyed - Whether the data directory holds a key.
   * @param armedFromStart - Whether it is armed before the projector starts.
   * @returns The server, and arming.
   */
  const serveArmed = (keyed: boolean, armedFromStart = false) =>
    Effect.gen(function* () {
      const dataDir = yield* temporaryDirectory;
      const key = keyed ? yield* makeKey(dataDir) : "iirc_no-key-was-made";
      const armed = yield* Ref.make(armedFromStart);

      const failing = <A>(effect: Effect.Effect<A, TimelineStoreFailed>) =>
        Effect.flatMap(Ref.get(armed), (now) =>
          now ? Effect.fail(new TimelineStoreFailed({ reason })) : effect
        );

      const served = yield* serveOn(dataDir, key, (store) => ({
        ...store,
        apply: (step) => failing(store.apply(step)),
        folded: failing(store.folded),
      }));

      return { arm: Ref.set(armed, true), served };
    });

  const well = [200, '{"_tag":"Well"}'];
  const unwell = [503, '{"_tag":"Unwell","part":"projector"}'];

  it("is well before the step the store fails, and unwell after it, asked without a key", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { arm, served } = yield* serveArmed(true);
          const call = yield* talk(served, ["one"]);

          // "one" is folded: the peer's Timeline is listed.
          yield* eventually(
            Effect.flatMap(served.request("/api/networks/libera/timelines"), textOf),
            (body) => decodeList(body).timelines.some((timeline) => timeline.name === "peer")
          );

          const before = yield* health(served, null);

          yield* arm;
          yield* say(call, ":peer!u@h PRIVMSG iirc :two");

          const after = yield* eventually(health(served, null), ([status]) => status !== 200);

          return { after, before, withKey: yield* health(served, served.key) };
        })
      )
    );

    expect(result).toStrictEqual({ after: unwell, before: well, withKey: unwell });
  });

  it("answers the same on a Daemon with no keys", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* serveArmed(false);
          const stopped = yield* serveArmed(false, true);

          return {
            running: yield* health(running.served, null),
            stopped: yield* eventually(health(stopped.served, null), ([status]) => status !== 200),
          };
        })
      )
    );

    expect(result).toStrictEqual({ running: well, stopped: unwell });
  });

  // Every route of the contract, with each path parameter filled in, but asking whether
  // the Daemon is well and signing a browser in and out.
  interface Route {
    readonly method: string;
    readonly path: string;
  }

  const keyed: Route[] = [];

  HttpApi.reflect(DaemonApi, {
    onEndpoint: ({ endpoint, group }) => {
      if (group.identifier !== "health" && group.identifier !== "signIn") {
        keyed.push({ method: endpoint.method, path: endpoint.path.replaceAll(/:\w+/gu, "x") });
      }
    },
    onGroup: constVoid,
  });

  it.each([
    ["with keys", true],
    ["with none", false],
  ])(
    "leaves every other route refusing without a key or a sign-in, on a Daemon %s",
    async (_, withKeys) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { served } = yield* serveArmed(withKeys);

            const ask = ({ method, path }: Route) =>
              served
                .request(path, { key: null, method })
                .pipe(Effect.map((response) => `${response.status} ${method} ${path}`));

            return yield* Effect.forEach(keyed, ask, { concurrency: 1 });
          })
        )
      );

      expect(keyed.length).toBeGreaterThan(40);
      expect(result).toStrictEqual(keyed.map(({ method, path }) => `401 ${method} ${path}`));
    }
  );
});
