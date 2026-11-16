import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";

import { BunHttpServer } from "@effect/platform-bun";
import { Upload, UploadsStatus } from "@iirc/api";
import { ByteStoreUnavailable, Sha256 } from "@iirc/byte-store";
import type { ByteStoreService } from "@iirc/byte-store";
import { makeMemoryJournal } from "@iirc/runtime/testing";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { describe, expect, it } from "vitest";

import { ApiRoutes, Heartbeat, Stopping } from "./handlers.ts";
import { freePort, loopback } from "./testing/children.ts";
import {
  layerWorld,
  makeKey,
  makeWorld,
  temporaryDirectory,
  unreachableEndpoint,
} from "./testing/world.ts";
import type { World } from "./testing/world.ts";

/** A 1×1 PNG. */
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  )
);

const encoder = new TextEncoder();

const decodeUpload = Schema.decodeUnknownSync(Schema.fromJsonString(Upload));

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(UploadsStatus));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** A request's body, as these tests send it. */
type Body = Uint8Array | string | ReadableStream<Uint8Array>;

/** A Daemon's API and link listener over real servers, which a test may stop and start again. */
interface Served {
  readonly world: World;
  readonly dataDir: string;
  readonly key: string;
  /** Where the API is now. */
  readonly base: Effect.Effect<string>;
  /** Sends a request to the API with the key, unless `key` says otherwise. */
  readonly request: (
    path: string,
    init?: {
      readonly method?: string;
      readonly body?: Body;
      readonly headers?: Readonly<Record<string, string>>;
      readonly key?: string | null;
    }
  ) => Effect.Effect<Response>;
  /** Says the Daemon is beginning to stop, as the Daemon does before serving stops. */
  readonly beginStopping: Effect.Effect<void>;
  /** Stops the server and every service, and starts them again on the same Journal and store. */
  readonly restart: Effect.Effect<void>;
}

/**
 * Serves the API on a real Bun server on an ephemeral loopback port, over the world's
 * in-memory Journal, Vault, and byte store, with its link listener, until it is closed.
 * @param world - The ports.
 * @param dataDir - The data directory, which holds the keys and staging.
 * @param stopping - What says the Daemon is beginning to stop.
 * @returns Where the API is, and how to close it.
 */
const start = (world: World, dataDir: string, stopping: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const server = HttpRouter.serve(ApiRoutes, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        BunHttpServer.layer({ gracefulShutdownTimeout: 100, hostname: loopback, port: 0 })
      ),
      Layer.provide(layerWorld(world, dataDir)),
      Layer.provide(Layer.succeed(Stopping, stopping)),
      Layer.provide(Layer.succeed(Heartbeat, Duration.millis(50)))
    );

    const context = yield* Layer.buildWithScope(server, scope);
    const { address } = Context.get(context, HttpServer.HttpServer);
    const port = address._tag === "UnixPathAddress" ? 0 : address.port;

    return { base: `http://${loopback}:${port}`, close: Scope.close(scope, Exit.void) };
  });

const serve = Effect.gen(function* () {
  const dataDir = yield* temporaryDirectory;
  const key = yield* makeKey(dataDir);
  const world = yield* makeWorld(yield* makeMemoryJournal);
  const latch = yield* Latch.make();
  let running = yield* start(world, dataDir, latch.await);

  yield* Effect.addFinalizer(() => Effect.suspend(() => running.close));

  const served: Served = {
    base: Effect.sync(() => running.base),
    beginStopping: Effect.asVoid(latch.open),
    dataDir,
    key,
    request: (path, init = {}) =>
      Effect.promise(async () => {
        const { key: presented = key, ...rest } = init;
        const headers = new Headers(rest.headers);

        if (presented !== null) {
          headers.set("authorization", `Bearer ${presented}`);
        }

        return await fetch(`${running.base}${path}`, { ...rest, headers });
      }),
    restart: Effect.gen(function* () {
      yield* running.close;
      running = yield* start(world, dataDir, latch.await);
    }).pipe(Effect.orDie),
    world,
  };

  return served;
});

const run = async <A, E>(test: (served: Served) => Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(serve.pipe(Effect.flatMap(test))));

const textOf = (response: Response) => Effect.promise(async () => await response.text());

const jsonOf = (response: Response) => Effect.map(textOf(response), decodeJson);

const recordOf = (response: Response) => Effect.map(textOf(response), decodeUpload);

/**
 * Sends a request that must answer with `status`.
 * @param answer - The request.
 * @param status - The status it must answer with.
 * @returns An Effect that dies otherwise.
 */
const expecting = (answer: Effect.Effect<Response>, status: number) =>
  answer.pipe(
    Effect.flatMap((response) =>
      response.status === status
        ? Effect.void
        : textOf(response).pipe(
            Effect.flatMap((text) => Effect.die(new Error(`answered ${response.status}: ${text}`)))
          )
    )
  );

const setOption = (served: Served, option: string, value: Schema.Json) =>
  expecting(
    served.request(`/api/options/${option}`, {
      body: JSON.stringify({ value }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    }),
    200
  );

const unsetOption = (served: Served, option: string) =>
  expecting(served.request(`/api/options/${option}`, { method: "DELETE" }), 200);

const holdCredential = (served: Served, name: string, value: string) =>
  expecting(
    served.request(`/api/credentials/${name}`, {
      body: JSON.stringify({ value }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    }),
    204
  );

const publicUrl = "https://up.example";

/**
 * Turns Uploads on: the bucket and its keys, held, and the public URL, and, given a port,
 * the link listener there.
 * @param served - The server.
 * @param port - Where the link listener listens, if anywhere.
 * @returns An Effect that turns them on.
 */
const turnOn = (served: Served, port?: number) =>
  Effect.gen(function* () {
    yield* holdCredential(served, "bucket-key-id", "AKIA-test");
    yield* holdCredential(served, "bucket-secret", "s3cr3t");
    yield* setOption(served, "store.s3.endpoint", "http://bucket.test");
    yield* setOption(served, "store.s3.bucket", "uploads");
    yield* setOption(served, "store.s3.region", "us-east-1");
    yield* setOption(served, "store.s3.accessKeyId", "bucket-key-id");
    yield* setOption(served, "store.s3.secretAccessKey", "bucket-secret");
    yield* setOption(served, "uploads.publicUrl", publicUrl);

    if (port !== undefined) {
      yield* setOption(served, "uploads.listen", `${loopback}:${port}`);
    }
  });

const upload = (
  served: Served,
  body: Body,
  name?: string,
  init: { readonly headers?: Readonly<Record<string, string>>; readonly key?: string | null } = {}
) =>
  served.request(
    name === undefined ? "/api/uploads" : `/api/uploads?name=${encodeURIComponent(name)}`,
    { body, method: "POST", ...init }
  );

/**
 * Uploads, and must be answered with a record.
 * @param served - The server.
 * @param body - The bytes.
 * @param name - The name to give, if any.
 * @returns The record.
 */
const uploaded = (served: Served, body: Body, name?: string) =>
  Effect.flatMap(upload(served, body, name), recordOf);

/**
 * The ids of the `Uploaded` Changes a world's Journal holds.
 * @param world - The world.
 * @returns The ids, in order.
 */
const journaledUploads = (world: World) =>
  Stream.runCollect(world.journal.read({})).pipe(
    Effect.map((entries) =>
      entries.flatMap(({ record }) =>
        record._tag === "Change" && record.change._tag === "Uploaded" ? [record.change.id] : []
      )
    )
  );

const staged = (served: Served) => Effect.sync(() => readdirSync(`${served.dataDir}/staging`));

/**
 * Asks until `ready` holds, or two seconds pass, and gives the last answer.
 * @param ask - What to ask.
 * @param ready - Whether the answer is the one waited for.
 * @returns The answer.
 */
const settled = <A, E>(ask: Effect.Effect<A, E>, ready: (answer: A) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; ; tries += 1) {
      const answer = yield* ask;

      if (ready(answer) || tries === 100) {
        return answer;
      }

      yield* Effect.sleep("20 millis");
    }
  });

const emptied = (served: Served) => settled(staged(served), (files) => files.length === 0);

/**
 * Fetches from the link listener, saying `refused` where nothing listens.
 * @param port - Its port.
 * @param path - The path.
 * @param init - The method and headers.
 * @returns The response, or `refused`.
 */
const fromLinks = (
  port: number,
  path: string,
  init: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> } = {}
) =>
  Effect.promise(async () => {
    try {
      return await fetch(`http://${loopback}:${port}${path}`, init);
    } catch {
      return "refused" as const;
    }
  });

/**
 * Fetches from the link listener once it is bound.
 * @param port - Its port.
 * @param path - The path.
 * @returns The response, or `refused` if it never was.
 */
const fromBound = (port: number, path: string) =>
  settled(fromLinks(port, path), (answer) => answer !== "refused");

const statusOf = (answer: Response | "refused") =>
  answer === "refused" ? "refused" : answer.status;

// Every header but `Date`, which says nothing of what was served, and which Bun leaves out
// of an answer to `HEAD`.
const headersOf = (answer: Response | "refused") =>
  answer === "refused"
    ? {}
    : Object.fromEntries(answer.headers.entries().filter(([name]) => name !== "date"));

const bytesOf = (answer: Response | "refused") =>
  Effect.promise(async () =>
    answer === "refused" ? undefined : new Uint8Array(await answer.arrayBuffer())
  );

/**
 * A link's path, from its link.
 * @param link - The link.
 * @returns Its path.
 */
const pathOf = (link: string | null) => new URL(link ?? "http://invalid/").pathname;

/** A request written by hand over TCP, so a test controls how much of its body is sent. */
interface Raw {
  readonly send: (bytes: Uint8Array) => Effect.Effect<void>;
  /** Everything the server answered, once it closes the Connection, or within two seconds. */
  readonly answered: Effect.Effect<string>;
  readonly abort: Effect.Effect<void>;
}

/**
 * Opens a Connection to the API and writes a request's head, with the key.
 * @param served - The server.
 * @param head - The request line and headers, with no blank line after them.
 * @returns The request.
 */
const raw = (served: Served, head: string) =>
  Effect.gen(function* () {
    const url = new URL(yield* served.base);
    const decoder = new TextDecoder();
    let text = "";
    const { promise, resolve } = Promise.withResolvers<string>();

    const socket = yield* Effect.promise(
      async () =>
        await Bun.connect({
          hostname: url.hostname,
          port: Number(url.port),
          socket: {
            close: () => {
              resolve(text);
            },
            data: (_, data) => {
              text += decoder.decode(data);
            },
            error: () => {
              resolve(text);
            },
          },
        })
    );

    socket.write(`${head}\r\nauthorization: Bearer ${served.key}\r\n\r\n`);

    const request: Raw = {
      abort: Effect.sync(() => {
        socket.terminate();
      }),
      answered: Effect.promise(async () => await promise).pipe(
        Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.sync(() => text) })
      ),
      send: (bytes) =>
        Effect.sync(() => {
          socket.write(bytes);
        }),
    };

    return request;
  });

const allOff = [
  "store.s3.endpoint",
  "store.s3.bucket",
  "store.s3.region",
  "store.s3.accessKeyId",
  "store.s3.secretAccessKey",
  "uploads.publicUrl",
];

describe("Uploads over the API", () => {
  it("are off until the bucket, its keys, and the public URL are all set, naming each one missing", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const status = Effect.flatMap(served.request("/api/uploads/status"), (response) =>
          Effect.map(textOf(response), decodeStatus)
        );

        const before = yield* status;
        const refused = yield* upload(served, png, "cat.png");

        yield* setOption(served, "store.s3.bucket", "uploads");
        yield* setOption(served, "uploads.publicUrl", publicUrl);
        const partly = yield* status;

        yield* turnOn(served);
        const on = yield* status;

        yield* setOption(served, "uploads.maxSize", 2048);

        return {
          before,
          journaled: yield* journaledUploads(served.world),
          on,
          partly,
          refused: [refused.status, refused.headers.get("connection"), yield* jsonOf(refused)],
          smaller: yield* status,
        };
      })
    );

    expect(result).toStrictEqual({
      before: { _tag: "Off", maxSize: 104_857_600, missing: allOff },
      journaled: [],
      on: { _tag: "On", maxSize: 104_857_600 },
      partly: {
        _tag: "Off",
        maxSize: 104_857_600,
        missing: [
          "store.s3.endpoint",
          "store.s3.region",
          "store.s3.accessKeyId",
          "store.s3.secretAccessKey",
        ],
      },
      refused: [409, "close", { _tag: "UploadsOff", missing: allOff }],
      smaller: { _tag: "On", maxSize: 2048 },
    });
  });

  it("keeps a raw body and answers its record and link, and reads it back by its id", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const record = yield* uploaded(served, png, "cat.png");
        const read = yield* served.request(`/api/uploads/${record.id}`);

        return { read: [read.status, yield* recordOf(read)], record };
      })
    );

    const { id } = result.record;

    expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{16}$/u);
    expect(result.record).toStrictEqual({
      at: result.record.at,
      hash: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
      id,
      link: `${publicUrl}/${id}/cat.png`,
      name: "cat.png",
      safeName: "cat.png",
      size: png.length,
      type: "image/png",
    });
    expect(result.read).toStrictEqual([200, result.record]);
  });

  it("takes any Content-Type, and reads none of it", async () => {
    const types = ["application/x-www-form-urlencoded", "text/html", "image/gif", "nonsense"];

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);

        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
        return yield* Effect.forEach(types, (type) =>
          Effect.map(
            Effect.flatMap(
              upload(served, png, undefined, { headers: { "content-type": type } }),
              recordOf
            ),
            (record) => record.type
          )
        );
      })
    );

    expect(result).toStrictEqual(types.map(() => "image/png"));
  });

  it("reads the type from the bytes, never the name, and fixes the name's extension", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const photo = yield* uploaded(served, png, "photo.jpg");
        const page = yield* uploaded(served, encoder.encode("<!doctype html><p>hi</p>"), "x.txt");
        const pasted = yield* uploaded(served, png);

        return [photo, page, pasted].map(({ safeName, type }) => [safeName, type]);
      })
    );

    expect(result).toStrictEqual([
      ["photo.png", "image/png"],
      ["x.html", "text/html; charset=utf-8"],
      ["image.png", "image/png"],
    ]);
  });

  it("answers an unknown id with 404 and an id that is not one with 400", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        const unknown = yield* served.request("/api/uploads/0000000000000000");
        const malformed = yield* served.request("/api/uploads/NOT-AN-ID");

        return { malformed: malformed.status, unknown: [unknown.status, yield* jsonOf(unknown)] };
      })
    );

    expect(result).toStrictEqual({
      malformed: 400,
      unknown: [404, { _tag: "UnknownUpload", id: "0000000000000000" }],
    });
  });

  it("refuses an empty body, whether it says its length or is chunked, and keeps nothing", async () => {
    const empty = {
      _tag: "InvalidRequest",
      issues: [{ message: "An Upload has at least one byte", path: ["payload"] }],
    };

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const sized = yield* upload(served, "");

        const chunked = yield* upload(
          served,
          new ReadableStream({
            start: (c) => {
              c.close();
            },
          })
        );

        return {
          chunked: [chunked.status, yield* jsonOf(chunked)],
          journaled: yield* journaledUploads(served.world),
          sized: [sized.status, yield* jsonOf(sized)],
        };
      })
    );

    expect(result).toStrictEqual({
      chunked: [400, empty],
      journaled: [],
      sized: [400, empty],
    });
  });

  it("cuts a body off with 413 once it passes uploads.maxSize, before the rest is sent, and keeps nothing", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        yield* setOption(served, "uploads.maxSize", 4096);

        // The head says the body is far larger than is ever sent, so only an answer given
        // before the body ends can arrive.
        const request = yield* raw(
          served,
          "POST /api/uploads?name=big.bin HTTP/1.1\r\nhost: daemon\r\ncontent-length: 10000000"
        );

        yield* request.send(new Uint8Array(8192));
        const answered = yield* request.answered;
        yield* request.abort;

        return {
          answer: answered.split("\r\n")[0],
          body: answered.endsWith('{"_tag":"UploadTooLarge","maxSize":4096}'),
          closes: /^connection: close$/imu.test(answered),
          journaled: yield* journaledUploads(served.world),
          staged: yield* emptied(served),
        };
      })
    );

    expect(result).toStrictEqual({
      answer: "HTTP/1.1 413 Payload Too Large",
      body: true,
      closes: true,
      journaled: [],
      staged: [],
    });
  });

  it("keeps nothing of a request whose client goes away mid-body", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);

        const request = yield* raw(
          served,
          "POST /api/uploads?name=cut.bin HTTP/1.1\r\nhost: daemon\r\ncontent-length: 100000"
        );

        yield* request.send(new Uint8Array(5000));
        const midway = yield* settled(staged(served), (files) => files.length === 1);
        yield* request.abort;

        return {
          after: yield* emptied(served),
          journaled: yield* journaledUploads(served.world),
          midway: midway.length,
        };
      })
    );

    expect(result).toStrictEqual({ after: [], journaled: [], midway: 1 });
  });

  it("cuts off an upload in flight once the Daemon begins to stop, and keeps nothing", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);

        const request = yield* raw(
          served,
          "POST /api/uploads HTTP/1.1\r\nhost: daemon\r\ncontent-length: 100000"
        );

        yield* request.send(new Uint8Array(5000));
        yield* settled(staged(served), (files) => files.length === 1);
        yield* served.beginStopping;
        const answered = yield* request.answered;
        yield* request.abort;

        return {
          answer: answered.split("\r\n")[0],
          closes: /^connection: close$/imu.test(answered),
          journaled: yield* journaledUploads(served.world),
          staged: yield* emptied(served),
        };
      })
    );

    expect(result).toStrictEqual({
      answer: "HTTP/1.1 503 Service Unavailable",
      closes: true,
      journaled: [],
      staged: [],
    });
  });

  it("answers 503 at once when the Daemon begins to stop, though the store's write cannot be stopped", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);

        // A store that reads the whole body, then never answers and cannot be interrupted.
        const hung: ByteStoreService = {
          ...served.world.bytes.store,
          put: (body) =>
            Stream.runDrain(body).pipe(
              Effect.orDie,
              Effect.andThen(Effect.uninterruptible(Effect.never))
            ),
        };

        Object.assign(served.world.bytes, { store: hung });

        const request = yield* raw(
          served,
          "POST /api/uploads HTTP/1.1\r\nhost: daemon\r\ncontent-length: 5000"
        );

        yield* request.send(new Uint8Array(5000));
        yield* Effect.sleep("200 millis");
        yield* served.beginStopping;

        const answered = yield* request.answered.pipe(Effect.timeoutOption("3 seconds"));
        const closed = yield* served.restart.pipe(Effect.timeoutOption("3 seconds"));

        return {
          answer: Option.isSome(answered) ? answered.value.split("\r\n")[0] : "no answer",
          closed: Option.isSome(closed),
          journaled: yield* journaledUploads(served.world),
        };
      })
    );

    expect(result).toStrictEqual({
      answer: "HTTP/1.1 503 Service Unavailable",
      closed: true,
      journaled: [],
    });
  });

  it("keeps staging owner-only", async () => {
    const mode = await run((served) =>
      Effect.sync(() => statSync(`${served.dataDir}/staging`).mode % 0o1000)
    );

    expect(mode).toBe(0o700);
  });

  it("removes what staging held when it starts", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        writeFileSync(`${served.dataDir}/staging/left-by-a-crash`, "half a file");
        mkdirSync(`${served.dataDir}/staging/a-directory`);
        yield* served.restart;

        return yield* staged(served);
      })
    );

    expect(result).toStrictEqual([]);
  });

  it("keeps an upload past 1 MiB, while every other route still refuses a body past it", async () => {
    const big = new Uint8Array(1024 * 1024 + 1).fill(0x61);

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const kept = yield* uploaded(served, big, "big.txt");

        const refused = yield* served.request("/api/credentials/big", {
          body: JSON.stringify({ value: "x".repeat(1024 * 1024 + 1) }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        });

        return { kept: kept.size, refused: [refused.status, refused.headers.get("connection")] };
      })
    );

    expect(result).toStrictEqual({ kept: big.length, refused: [413, "close"] });
  });

  it("refuses an upload a cookie carries from another origin, and takes one from its own", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);

        const signIn = yield* served.request("/api/sign-in", {
          body: JSON.stringify({ key: served.key }),
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          key: null,
          method: "POST",
        });

        const cookie = signIn.headers.getSetCookie()[0]?.split(";")[0] ?? "";

        const asBrowser = (site: string) =>
          Effect.map(
            upload(served, png, "cat.png", {
              headers: { cookie, "sec-fetch-site": site },
              key: null,
            }),
            (response) => response.status
          );

        const crossSite = yield* asBrowser("cross-site");
        const sameSite = yield* asBrowser("same-site");
        const sameOrigin = yield* asBrowser("same-origin");

        return {
          crossSite,
          journaled: (yield* journaledUploads(served.world)).length,
          sameOrigin,
          sameSite,
        };
      })
    );

    expect(result).toStrictEqual({ crossSite: 403, journaled: 1, sameOrigin: 200, sameSite: 403 });
  });

  it("answers 503 and keeps nothing when the store cannot be reached, or a key is not held", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        yield* setOption(served, "store.s3.endpoint", unreachableEndpoint);
        const unreachable = yield* upload(served, png, "cat.png");

        yield* setOption(served, "store.s3.endpoint", "http://bucket.test");
        yield* expecting(
          served.request("/api/credentials/bucket-secret", { method: "DELETE" }),
          204
        );
        const keyless = yield* upload(served, png, "cat.png");

        return {
          journaled: yield* journaledUploads(served.world),
          keyless: [keyless.status, yield* jsonOf(keyless)],
          staged: yield* emptied(served),
          unreachable: [unreachable.status, yield* jsonOf(unreachable)],
        };
      })
    );

    expect(result).toStrictEqual({
      journaled: [],
      keyless: [
        503,
        { _tag: "StoreUnavailable", reason: "the Credential bucket-secret is not held" },
      ],
      staged: [],
      unreachable: [503, { _tag: "StoreUnavailable", reason: "unreachable" }],
    });
  });

  it("keeps an Upload across a restart on the same Journal", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const record = yield* uploaded(served, png, "cat.png");

        yield* served.restart;

        return {
          read: yield* Effect.flatMap(served.request(`/api/uploads/${record.id}`), recordOf),
          record,
        };
      })
    );

    expect(result.read).toStrictEqual(result.record);
  });

  it("builds the link from the public URL in force, whatever else is set, and gives none while there is none", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const { id } = yield* uploaded(served, png, "cat.png");

        const link = Effect.map(
          Effect.flatMap(served.request(`/api/uploads/${id}`), recordOf),
          (record) => record.link
        );

        yield* setOption(served, "uploads.publicUrl", "https://files.example/u/");
        const moved = yield* link;

        yield* unsetOption(served, "store.s3.accessKeyId");
        const off = yield* link;

        yield* unsetOption(served, "uploads.publicUrl");

        return { id, moved, none: yield* link, off };
      })
    );

    expect(result).toStrictEqual({
      id: result.id,
      moved: `https://files.example/u/${result.id}/cat.png`,
      none: null,
      off: `https://files.example/u/${result.id}/cat.png`,
    });
  });
});

/** The headers every answer of the link listener carries. */
const safety = {
  "access-control-allow-origin": "*",
  "content-security-policy": "sandbox allow-downloads; default-src 'none'",
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * A link's `Content-Type` and `Content-Disposition`, once the listener is bound.
 * @param port - The listener's port.
 * @param link - The link.
 * @returns Both headers.
 */
const servedAs = (port: number, link: string | null) =>
  Effect.map(fromBound(port, pathOf(link)), (answer) => {
    const headers = headersOf(answer);

    return [headers["content-type"], headers["content-disposition"]];
  });

const atAll = (port: number, expected: number | "refused") =>
  Effect.map(
    settled(fromLinks(port, "/0000000000000000/x"), (answer) => statusOf(answer) === expected),
    statusOf
  );

// Each port is one the kernel just said was free. Another process could take it before the
// listener binds, a race too small to matter here.
describe("the link listener", () => {
  it("serves an Upload's bytes with every safety header", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const record = yield* uploaded(served, png, "cat.png");
        const got = yield* fromBound(port, pathOf(record.link));

        return { bytes: yield* bytesOf(got), headers: headersOf(got), status: statusOf(got) };
      })
    );

    expect(result).toStrictEqual({
      bytes: png,
      headers: {
        ...safety,
        "cache-control": "no-cache",
        "content-disposition": `inline; filename="cat.png"; filename*=UTF-8''cat.png`,
        "content-length": String(png.length),
        "content-type": "image/png",
      },
      status: 200,
    });
  });

  it("answers HEAD with the same headers and no body", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const path = pathOf((yield* uploaded(served, png, "cat.png")).link);
        const get = yield* fromBound(port, path);
        const head = yield* fromLinks(port, path, { method: "HEAD" });

        return {
          body: (yield* bytesOf(head))?.length,
          headers: headersOf(head),
          length: headersOf(get)["content-length"],
          status: statusOf(head),
          wanted: headersOf(get),
        };
      })
    );

    expect(result).toStrictEqual({
      body: 0,
      headers: result.wanted,
      length: String(png.length),
      status: 200,
      wanted: result.wanted,
    });
  });

  it("shows raster images and plain text in place, and makes SVG, HTML, PDF, and unknown bytes download", async () => {
    const port = freePort();

    const files = [
      ["html", encoder.encode("<!DOCTYPE html><html><body>hi</body></html>"), "page.html"],
      ["pdf", encoder.encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"), "doc.pdf"],
      ["png", png, "cat.png"],
      [
        "svg",
        encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
        "pic.svg",
      ],
      ["text", encoder.encode("hello, world\n"), "notes.txt"],
      ["unknown", new Uint8Array([0, 1, 2, 3, 0xff, 0xfe]), "blob.dat"],
    ] as const;

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);

        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
        const answers = yield* Effect.forEach(files, ([kind, bytes, name]) =>
          Effect.map(
            Effect.flatMap(uploaded(served, bytes, name), (record) => servedAs(port, record.link)),
            (headers) => [kind, headers] as const
          )
        );

        return Object.fromEntries(answers);
      })
    );

    expect(result).toStrictEqual({
      html: [
        "text/html; charset=utf-8",
        `attachment; filename="page.html"; filename*=UTF-8''page.html`,
      ],
      pdf: ["application/pdf", `attachment; filename="doc.pdf"; filename*=UTF-8''doc.pdf`],
      png: ["image/png", `inline; filename="cat.png"; filename*=UTF-8''cat.png`],
      svg: ["image/svg+xml", `attachment; filename="pic.svg"; filename*=UTF-8''pic.svg`],
      text: [
        "text/plain; charset=utf-8",
        `inline; filename="notes.txt"; filename*=UTF-8''notes.txt`,
      ],
      unknown: [
        "application/octet-stream",
        `attachment; filename="blob.dat"; filename*=UTF-8''blob.dat`,
      ],
    });
  });

  it("names a file outside ASCII in filename*, and only ASCII in filename", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const record = yield* uploaded(served, png, "café 猫.png");

        return [record.safeName, yield* servedAs(port, record.link)];
      })
    );

    expect(result).toStrictEqual([
      "café-猫.png",
      ["image/png", `inline; filename="caf_-_.png"; filename*=UTF-8''caf%C3%A9-%E7%8C%AB.png`],
    ]);
  });

  it("finds an Upload by its id alone, and answers everything else with 404 and the safety headers", async () => {
    const port = freePort();

    const status = (path: string, method = "GET") =>
      Effect.map(fromLinks(port, path, { method }), statusOf);

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const { id } = yield* uploaded(served, png, "cat.png");

        yield* fromBound(port, `/${id}/cat.png`);

        const unknown = yield* fromLinks(port, "/0000000000000000/cat.png");
        const unknownBody = unknown === "refused" ? "refused" : yield* textOf(unknown);

        return {
          byId: yield* status(`/${id}/anything-else.txt`),
          deeper: yield* status(`/${id}/a/b`),
          delete: yield* status(`/${id}/cat.png`, "DELETE"),
          idAlone: yield* status(`/${id}`),
          idSlash: yield* status(`/${id}/`),
          notAnId: yield* status("/cat/cat.png"),
          post: yield* status(`/${id}/cat.png`, "POST"),
          root: yield* status("/"),
          theApi: yield* status("/api/uploads/status"),
          unknown: [statusOf(unknown), headersOf(unknown), unknownBody],
          withQuery: yield* status(`/${id}/cat.png?download=1`),
        };
      })
    );

    expect(result).toStrictEqual({
      byId: 200,
      deeper: 200,
      delete: 404,
      idAlone: 404,
      idSlash: 404,
      notAnId: 404,
      post: 404,
      root: 404,
      theApi: 404,
      unknown: [
        404,
        {
          ...safety,
          "cache-control": "no-cache",
          "content-disposition": "inline",
          "content-length": "10",
          "content-type": "text/plain; charset=utf-8",
        },
        "Not found\n",
      ],
      withQuery: 200,
    });
  });

  it("reads no cookie and no key, and ignores the host a request names", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const path = pathOf((yield* uploaded(served, png, "cat.png")).link);

        yield* fromBound(port, path);

        const odd = yield* fromLinks(port, path, {
          headers: {
            authorization: "Bearer iirc_wrong",
            cookie: "iirc_sign_in=forged",
            host: "evil.example",
          },
        });

        return [statusOf(odd), yield* bytesOf(odd)];
      })
    );

    expect(result).toStrictEqual([200, png]);
  });

  it("answers 503 with no-store while the store cannot be reached", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const record = yield* uploaded(served, png, "cat.png");

        yield* setOption(served, "store.s3.endpoint", unreachableEndpoint);
        const got = yield* fromBound(port, pathOf(record.link));

        return [statusOf(got), headersOf(got)];
      })
    );

    expect(result).toStrictEqual([
      503,
      {
        ...safety,
        "cache-control": "no-store",
        "content-disposition": "inline",
        "content-length": "25",
        "content-type": "text/plain; charset=utf-8",
      },
    ]);
  });

  it("answers 503 with no-store, for GET and HEAD, when the store fails before the first byte", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const record = yield* uploaded(served, png, "cat.png");

        // A store that holds the bytes, and then fails the read before any arrives.
        const failing: ByteStoreService = {
          ...served.world.bytes.store,
          read: () => Effect.succeed(Stream.fail(new ByteStoreUnavailable({ reason: "reset" }))),
        };

        Object.assign(served.world.bytes, { store: failing });

        const path = pathOf(record.link);
        const get = yield* fromLinks(port, path);
        const head = yield* fromLinks(port, path, { method: "HEAD" });

        return [get, head].map((got) => [statusOf(got), headersOf(got)]);
      })
    );

    const expected = [
      503,
      {
        ...safety,
        "cache-control": "no-store",
        "content-disposition": "inline",
        "content-length": "25",
        "content-type": "text/plain; charset=utf-8",
      },
    ];

    expect(result).toStrictEqual([expected, expected]);
  });

  it("serves every chunk of a read the store gives in parts, after the first", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const record = yield* uploaded(served, png, "cat.png");

        // A store that gives the bytes a few at a time, with a pause between each part.
        const parted: ByteStoreService = {
          ...served.world.bytes.store,
          read: () =>
            Effect.succeed(
              Stream.fromIterable(
                Array.from({ length: Math.ceil(png.length / 8) }, (_, index) =>
                  png.slice(index * 8, index * 8 + 8)
                )
              ).pipe(Stream.tap(() => Effect.sleep(Duration.millis(5))))
            ),
        };

        Object.assign(served.world.bytes, { store: parted });

        return yield* bytesOf(yield* fromLinks(port, pathOf(record.link)));
      })
    );

    expect(result).toStrictEqual(png);
  });

  it("binds at uploads.listen while Uploads are on, rebinds when it changes, and closes when they go off", async () => {
    const [first, second] = [freePort(), freePort()];

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* setOption(served, "uploads.listen", `${loopback}:${first}`);
        const whileOff = yield* atAll(first, 404);

        yield* turnOn(served);
        const on = yield* atAll(first, 404);

        yield* setOption(served, "uploads.listen", `${loopback}:${second}`);
        const moved = [yield* atAll(first, "refused"), yield* atAll(second, 404)];

        yield* unsetOption(served, "uploads.publicUrl");
        const off = yield* atAll(second, "refused");

        yield* setOption(served, "uploads.publicUrl", publicUrl);
        const again = yield* atAll(second, 404);

        yield* unsetOption(served, "uploads.listen");
        const unset = yield* atAll(second, "refused");

        return { again, moved, off, on, unset, whileOff };
      })
    );

    expect(result).toStrictEqual({
      again: 404,
      moved: ["refused", 404],
      off: "refused",
      on: 404,
      unset: "refused",
      whileOff: "refused",
    });
  });
});

const decodePage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      more: Schema.Boolean,
      next: Schema.NullOr(Schema.String),
      through: Schema.Int,
      uploads: Schema.Array(Upload),
    })
  )
);

const pageOf = (response: Response) => Effect.map(textOf(response), decodePage);

/**
 * Uploads a few files, one after another, named `1.png` and on.
 * @param served - The server.
 * @param count - How many.
 * @returns Their records, oldest first.
 */
const uploadedMany = (served: Served, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => `${index + 1}.png`),
    (name) => uploaded(served, png, name)
  );

/**
 * Every page of the Uploads, following `next` from the first until none follows.
 * @param served - The server.
 * @param limit - How many a page holds.
 * @returns The pages.
 */
const allPages = (served: Served, limit: number) =>
  Effect.gen(function* () {
    const pages = [yield* pageOf(yield* served.request(`/api/uploads?limit=${limit}`))];

    for (let next = pages[0]?.next; next !== null && next !== undefined;) {
      const page = yield* pageOf(
        yield* served.request(`/api/uploads?limit=${limit}&after=${next}`)
      );

      pages.push(page);
      ({ next } = page);
    }

    return pages;
  });

const signedIn = (served: Served) =>
  Effect.map(
    served.request("/api/sign-in", {
      body: JSON.stringify({ key: served.key }),
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      key: null,
      method: "POST",
    }),
    (response) => response.headers.getSetCookie()[0]?.split(";")[0] ?? ""
  );

describe("the list of Uploads", () => {
  it("lists Uploads newest first, a page at a time, and following next gives each once", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const records = yield* uploadedMany(served, 5);
        const pages = yield* allPages(served, 2);

        return {
          pages: pages.map((page) => ({
            more: page.more,
            next: page.next,
            uploads: page.uploads.map((one) => one.name),
          })),
          records,
          uploads: pages.flatMap((page) => page.uploads),
          whole: yield* pageOf(yield* served.request("/api/uploads")),
        };
      })
    );

    const [first, second, third, fourth, fifth] = result.records;

    expect(result.pages).toStrictEqual([
      { more: true, next: fourth?.id, uploads: ["5.png", "4.png"] },
      { more: true, next: second?.id, uploads: ["3.png", "2.png"] },
      { more: false, next: null, uploads: ["1.png"] },
    ]);
    expect(result.uploads).toStrictEqual([fifth, fourth, third, second, first]);
    expect({ ...result.whole, through: undefined }).toStrictEqual({
      more: false,
      next: null,
      through: undefined,
      uploads: result.records.toReversed(),
    });
  });

  it("gives an empty page through 0 with nothing uploaded", async () => {
    const result = await run((served) =>
      Effect.flatMap(served.request("/api/uploads"), (response) =>
        Effect.map(pageOf(response), (page) => [response.status, page])
      )
    );

    expect(result).toStrictEqual([200, { more: false, next: null, through: 0, uploads: [] }]);
  });

  it("refuses a cursor that names no Upload", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        yield* uploadedMany(served, 1);
        const refused = yield* served.request("/api/uploads?after=0000000000000000");

        return [refused.status, yield* jsonOf(refused)];
      })
    );

    expect(result).toStrictEqual([
      400,
      {
        _tag: "InvalidRequest",
        issues: [{ message: "Names no Upload", path: ["query", "after"] }],
      },
    ]);
  });

  it("refuses a malformed cursor or limit", async () => {
    const result = await run((served) =>
      Effect.forEach(
        [
          "/api/uploads?after=NOT-AN-ID",
          "/api/uploads?after=5",
          "/api/uploads?limit=0",
          "/api/uploads?limit=501",
        ],
        (path) => Effect.map(served.request(path), (response) => response.status)
      )
    );

    expect(result).toStrictEqual([400, 400, 400, 400]);
  });

  it("lists in the same order after a restart on the same Journal", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        yield* uploadedMany(served, 3);
        const before = yield* allPages(served, 2);

        yield* served.restart;

        return { after: yield* allPages(served, 2), before };
      })
    );

    expect(result.before).toHaveLength(2);
    expect(result.after).toStrictEqual(result.before);
  });

  it("lists each Upload with its link from the public URL in force", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const [record] = yield* uploadedMany(served, 1);

        const links = Effect.map(Effect.flatMap(served.request("/api/uploads"), pageOf), (page) =>
          page.uploads.map((one) => one.link)
        );

        yield* setOption(served, "uploads.publicUrl", "https://files.example/u");
        const moved = yield* links;

        yield* unsetOption(served, "uploads.publicUrl");

        return { id: record?.id, moved, none: yield* links };
      })
    );

    expect(result).toStrictEqual({
      id: result.id,
      moved: [`https://files.example/u/${result.id}/1.png`],
      none: [null],
    });
  });
});

describe("an Upload's bytes on the API", () => {
  it("serves an Upload's bytes with a key, with exactly the link listener's headers", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const record = yield* uploaded(served, png, "cat.png");
        const content = yield* served.request(`/api/uploads/${record.id}/content`);
        const link = yield* fromBound(port, pathOf(record.link));

        return {
          bytes: yield* bytesOf(content),
          headers: headersOf(content),
          link: headersOf(link),
          status: content.status,
        };
      })
    );

    expect(result).toStrictEqual({
      bytes: png,
      headers: result.link,
      link: {
        ...safety,
        "cache-control": "no-cache",
        "content-disposition": `inline; filename="cat.png"; filename*=UTF-8''cat.png`,
        "content-length": String(png.length),
        "content-type": "image/png",
      },
      status: 200,
    });
  });

  it("makes what is not shown in place download, as its link does", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const page = encoder.encode("<!DOCTYPE html><p>hi</p>");
        const record = yield* uploaded(served, page, "x");
        const content = yield* served.request(`/api/uploads/${record.id}/content`);
        const link = yield* fromBound(port, pathOf(record.link));

        return { content: headersOf(content), link: headersOf(link) };
      })
    );

    expect(result.content).toStrictEqual(result.link);
    expect(result.content["content-disposition"]).toMatch(/^attachment;/u);
  });

  it("serves an Upload's bytes to a Sign-in cookie, and answers neither key nor cookie with 401", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const record = yield* uploaded(served, png, "cat.png");
        const cookie = yield* signedIn(served);
        const path = `/api/uploads/${record.id}/content`;
        const byCookie = yield* served.request(path, { headers: { cookie }, key: null });
        const byNeither = yield* served.request(path, { key: null });

        return {
          byCookie: [byCookie.status, yield* bytesOf(byCookie)],
          byNeither: byNeither.status,
        };
      })
    );

    expect(result).toStrictEqual({ byCookie: [200, png], byNeither: 401 });
  });

  it("answers an id no Upload has with 404", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const unknown = yield* served.request("/api/uploads/0000000000000000/content");

        return [unknown.status, yield* jsonOf(unknown)];
      })
    );

    expect(result).toStrictEqual([404, { _tag: "UnknownUpload", id: "0000000000000000" }]);
  });

  it("answers 404 when the store confirms an Upload's bytes are gone", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const record = yield* uploaded(served, png, "cat.png");

        yield* served.world.bytes.store.delete(Sha256.make(record.hash)).pipe(Effect.orDie);
        const gone = yield* served.request(`/api/uploads/${record.id}/content`);

        return { body: yield* jsonOf(gone), id: record.id, status: gone.status };
      })
    );

    expect(result).toStrictEqual({
      body: { _tag: "UnknownUpload", id: result.id },
      id: result.id,
      status: 404,
    });
  });

  it("answers 503 with no-store while the store cannot be reached, fails before the first byte, or Uploads are off", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const record = yield* uploaded(served, png, "cat.png");

        const answer = Effect.flatMap(
          served.request(`/api/uploads/${record.id}/content`),
          (response) =>
            Effect.map(jsonOf(response), (body) => [
              response.status,
              response.headers.get("cache-control"),
              body,
            ])
        );

        yield* setOption(served, "store.s3.endpoint", unreachableEndpoint);
        const unreachable = yield* answer;

        yield* setOption(served, "store.s3.endpoint", "http://bucket.test");
        const { store } = served.world.bytes;

        // A store that holds the bytes, and then fails the read before any arrives.
        const failing: ByteStoreService = {
          ...store,
          read: () => Effect.succeed(Stream.fail(new ByteStoreUnavailable({ reason: "reset" }))),
        };

        Object.assign(served.world.bytes, { store: failing });
        const reset = yield* answer;

        Object.assign(served.world.bytes, { store });
        yield* unsetOption(served, "store.s3.bucket");

        return { off: yield* answer, reset, unreachable };
      })
    );

    expect(result).toStrictEqual({
      off: [503, "no-store", { _tag: "StoreUnavailable", reason: "Uploads are off" }],
      reset: [503, "no-store", { _tag: "StoreUnavailable", reason: "reset" }],
      unreachable: [503, "no-store", { _tag: "StoreUnavailable", reason: "unreachable" }],
    });
  });
});

/** One Server-Sent Event, as the wire carries it. */
interface Sse {
  readonly id: string | undefined;
  readonly event: string;
  readonly data: string;
}

/** A stream of Server-Sent Events, read further as a test goes. */
interface Following {
  /** Reads until `enough` holds of every event read so far, and gives them all. */
  readonly until: (enough: (events: readonly Sse[]) => boolean) => Effect.Effect<readonly Sse[]>;
}

/**
 * One event, from the lines that make it.
 * @param text - Its lines.
 * @returns The event.
 */
const sseOf = (text: string): Sse => {
  const fields = new Map(
    text
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)])
  );

  return {
    data: fields.get("data") ?? "",
    event: fields.get("event") ?? "message",
    id: fields.get("id"),
  };
};

/**
 * Follows an SSE response until the test's Scope closes.
 * @param response - The response.
 * @returns How to read it further.
 */
const following = (response: Response) =>
  Effect.gen(function* () {
    const body: ReadableStream<Uint8Array> | null = response.body;
    const reader = body?.getReader();

    if (reader === undefined) {
      return yield* Effect.die(new Error("the stream has no body"));
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await reader.cancel();
      })
    );

    const decoder = new TextDecoder();
    const events: Sse[] = [];
    let buffered = "";

    const stream: Following = {
      until: (enough) =>
        Effect.promise(async () => {
          while (!enough(events)) {
            // oxlint-disable-next-line no-await-in-loop -- reading a stream in order
            const chunk = await reader.read();

            if (chunk.done) {
              break;
            }

            buffered += decoder.decode(chunk.value, { stream: true });

            for (let end = buffered.indexOf("\n\n"); end !== -1; end = buffered.indexOf("\n\n")) {
              events.push(sseOf(buffered.slice(0, end)));
              buffered = buffered.slice(end + 2);
            }
          }

          return [...events];
        }),
    };

    return stream;
  });

const changedOf = (events: readonly Sse[]) =>
  events.flatMap((event) =>
    event.event === "changed" ? [{ id: event.id, upload: decodeUpload(event.data) }] : []
  );

/**
 * Opens the stream of Upload Changes, and waits for its first heartbeat, which says it has
 * begun, so nothing made after this is made before the stream follows.
 * @param served - The server.
 * @param init - Its query and headers.
 * @returns The stream.
 */
const openChanges = (
  served: Served,
  init: { readonly query?: string; readonly headers?: Readonly<Record<string, string>> } = {}
) =>
  Effect.gen(function* () {
    const response = yield* served.request(`/api/uploads/changes${init.query ?? ""}`, {
      ...(init.headers !== undefined && { headers: init.headers }),
    });

    const stream = yield* following(response);

    yield* stream.until((events) => events.some((event) => event.event === "heartbeat"));

    return stream;
  });

/**
 * The first `count` Upload Changes a stream carries, once it has carried them.
 * @param stream - The stream.
 * @param count - How many.
 * @returns Them.
 */
const changesOf = (stream: Following, count: number) =>
  Effect.map(
    stream.until((events) => changedOf(events).length >= count),
    changedOf
  );

describe("the stream of Upload Changes", () => {
  it("delivers an Upload made after it was opened, with its Change's sequence as id, and none from before", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        yield* uploadedMany(served, 1);
        const stream = yield* openChanges(served);
        const record = yield* uploaded(served, png, "after.png");
        const events = yield* changesOf(stream, 1);

        return {
          events: events.map((event) => event.upload),
          id: Number(events[0]?.id) > 0,
          record,
        };
      })
    );

    expect(result).toStrictEqual({ events: [result.record], id: true, record: result.record });
  });

  it("replays exactly the Uploads made after `after`, then live ones, none twice", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const live = yield* openChanges(served);
        const records = yield* uploadedMany(served, 3);
        const seen = yield* changesOf(live, 3);
        const resumed = yield* openChanges(served, { query: `?after=${seen[0]?.id ?? ""}` });
        const fourth = yield* uploaded(served, png, "4.png");

        return { fourth, records, resumed: yield* changesOf(resumed, 3), seen };
      })
    );

    const [, second, third] = result.records;

    expect(result.seen.map((event) => event.upload)).toStrictEqual(result.records);
    expect(result.resumed.map((event) => event.upload)).toStrictEqual([
      second,
      third,
      result.fourth,
    ]);
    expect(result.resumed.slice(0, 2).map((event) => event.id)).toStrictEqual(
      result.seen.slice(1).map((event) => event.id)
    );
  });

  it("follows from a page's through: an Upload made after the page was read arrives, and nothing from the page is replayed", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        yield* uploadedMany(served, 2);
        const page = yield* pageOf(yield* served.request("/api/uploads"));
        const third = yield* uploaded(served, png, "3.png");
        const stream = yield* openChanges(served, { query: `?after=${page.through}` });
        // One made after it, so the replay is known to be over when it arrives.
        const fourth = yield* uploaded(served, png, "4.png");

        return { fourth, seen: yield* changesOf(stream, 2), third };
      })
    );

    expect(result.seen.map((event) => event.upload)).toStrictEqual([result.third, result.fourth]);
  });

  it("resumes after Last-Event-ID over `after`, as a reconnecting EventSource sends both", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const live = yield* openChanges(served);
        const records = yield* uploadedMany(served, 3);
        const seen = yield* changesOf(live, 3);

        const resumed = yield* openChanges(served, {
          headers: { "last-event-id": seen[1]?.id ?? "" },
          query: `?after=${seen[0]?.id ?? ""}`,
        });

        // One made after it, so the replay is known to be over when it arrives.
        const fourth = yield* uploaded(served, png, "4.png");

        return { fourth, records, resumed: yield* changesOf(resumed, 2) };
      })
    );

    expect(result.resumed.map((event) => event.upload)).toStrictEqual([
      result.records[2],
      result.fourth,
    ]);
  });
});

/**
 * The Upload Changes a world's Journal holds, as their tag, id, and sequence.
 * @param world - The world.
 * @returns Them, in order.
 */
const journaledChanges = (world: World) =>
  Stream.runCollect(world.journal.read({})).pipe(
    Effect.map((entries) =>
      entries.flatMap(({ record, sequence }) =>
        record._tag === "Change" && "id" in record.change
          ? [{ change: record.change, sequence }]
          : []
      )
    )
  );

const rename = (
  served: Served,
  id: string,
  name: string,
  init: { readonly headers?: Readonly<Record<string, string>>; readonly key?: string | null } = {}
) =>
  served.request(`/api/uploads/${id}`, {
    body: JSON.stringify({ name }),
    method: "PATCH",
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

const remove = (
  served: Served,
  id: string,
  init: { readonly headers?: Readonly<Record<string, string>>; readonly key?: string | null } = {}
) => served.request(`/api/uploads/${id}`, { method: "DELETE", ...init });

/**
 * Whether the world's byte store holds bytes under a hash.
 * @param served - The server.
 * @param hash - The hash.
 * @returns Whether it does.
 */
const inStore = (served: Served, hash: string) =>
  served.world.bytes.store.read(Sha256.make(hash)).pipe(
    Effect.as(true),
    Effect.catchTag("ByteStoreNotFound", () => Effect.succeed(false)),
    Effect.orDie
  );

/**
 * An answer, as these tests compare two: its status, every header but `Date`, and its body.
 * @param answer - The answer.
 * @returns Them.
 */
const wholly = (answer: Response | "refused") =>
  Effect.gen(function* () {
    const body = answer === "refused" ? "refused" : yield* textOf(answer);

    return { body, headers: headersOf(answer), status: statusOf(answer) };
  });

const dispositionOf = (answer: Response | "refused") =>
  answer === "refused" ? "refused" : answer.headers.get("content-disposition");

const statusFrom = (answer: Effect.Effect<Response>) => answer.pipe(Effect.map(statusOf));

const errorFrom = (answer: Response) =>
  Effect.gen(function* () {
    return [answer.status, yield* jsonOf(answer)];
  });

describe("renaming and deleting an Upload", () => {
  it("renames an Upload: journals Renamed with the safe name remade from the type, and both its old and new links serve it under the new name", async () => {
    const port = freePort();

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const record = yield* uploaded(served, png, "cat.png");

        yield* fromBound(port, pathOf(record.link));
        const answer = yield* rename(served, record.id, "my holiday photo.jpg");
        const renamed = yield* recordOf(answer);

        return {
          content: dispositionOf(yield* served.request(`/api/uploads/${record.id}/content`)),
          journaled: (yield* journaledChanges(served.world)).map(({ change }) => change),
          newLink: dispositionOf(yield* fromLinks(port, pathOf(renamed.link))),
          oldLink: dispositionOf(yield* fromLinks(port, pathOf(record.link))),
          read: yield* Effect.flatMap(served.request(`/api/uploads/${record.id}`), recordOf),
          record,
          renamed,
          status: answer.status,
        };
      })
    );

    const { id } = result.record;
    const served = `inline; filename="my-holiday-photo.png"; filename*=UTF-8''my-holiday-photo.png`;

    expect(result).toStrictEqual({
      content: served,
      journaled: [
        { _tag: "Uploaded", ...result.journaled[0] },
        {
          _tag: "Renamed",
          at: result.renamed.renamedAt,
          id,
          name: "my holiday photo.jpg",
          safeName: "my-holiday-photo.png",
        },
      ],
      newLink: served,
      oldLink: served,
      read: result.renamed,
      record: result.record,
      renamed: {
        ...result.record,
        link: `${publicUrl}/${id}/my-holiday-photo.png`,
        name: "my holiday photo.jpg",
        renamedAt: result.renamed.renamedAt,
        safeName: "my-holiday-photo.png",
      },
      status: 200,
    });
    expect(result.renamed.renamedAt).toBeGreaterThanOrEqual(result.record.at);
  });

  it("answers a deleted Upload at its link and its content exactly as an id that never was, still reads its record marked deleted, and lists it only when asked", async () => {
    const port = freePort();
    const never = "0000000000000000";

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served, port);
        const record = yield* uploaded(served, png, "cat.png");
        const other = yield* uploaded(served, png, "dog.png");

        yield* fromBound(port, pathOf(record.link));
        const answer = yield* remove(served, record.id);
        const deleted = yield* recordOf(answer);

        const link = (id: string, method: string) =>
          Effect.flatMap(fromLinks(port, `/${id}/cat.png`, { method }), wholly);

        const content = (id: string) =>
          Effect.flatMap(served.request(`/api/uploads/${id}/content`), wholly);

        const listed = (query: string) =>
          Effect.gen(function* () {
            const page = yield* pageOf(yield* served.request(`/api/uploads${query}`));

            return page.uploads.map((one) => one.id);
          });

        return {
          content: yield* content(record.id),
          contentNever: yield* content(never),
          deleted,
          get: yield* link(record.id, "GET"),
          getNever: yield* link(never, "GET"),
          head: yield* link(record.id, "HEAD"),
          headNever: yield* link(never, "HEAD"),
          journaled: (yield* journaledChanges(served.world)).map(({ change }) => change._tag),
          listed: yield* listed(""),
          listedDeleted: yield* listed("?deleted=true"),
          other,
          read: yield* Effect.flatMap(served.request(`/api/uploads/${record.id}`), recordOf),
          record,
          status: answer.status,
        };
      })
    );

    const { id } = result.record;

    expect({
      ...result,
      contentNever: undefined,
      getNever: undefined,
      headNever: undefined,
    }).toStrictEqual({
      content: { ...result.contentNever, body: result.contentNever.body.replace(never, id) },
      contentNever: undefined,
      deleted: {
        ...result.record,
        deleted: { at: result.deleted.deleted?.at, why: "owner" },
        link: null,
      },
      get: result.getNever,
      getNever: undefined,
      head: result.headNever,
      headNever: undefined,
      journaled: ["Uploaded", "Uploaded", "Deleted"],
      listed: [result.other.id],
      listedDeleted: [result.other.id, id],
      other: result.other,
      read: result.deleted,
      record: result.record,
      status: 200,
    });
    expect([result.get.status, result.head.status, result.content.status]).toStrictEqual([
      404, 404, 404,
    ]);
  });

  it("keeps bytes another Upload shares: deleting one leaves the other served, and deleting both releases them", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const first = yield* uploaded(served, png, "first.png");
        const second = yield* uploaded(served, png, "second.png");

        yield* expecting(remove(served, first.id), 200);
        const shared = yield* served.request(`/api/uploads/${second.id}/content`);
        const sharedBytes = yield* bytesOf(shared);
        const heldAfterOne = yield* inStore(served, first.hash);

        yield* expecting(remove(served, second.id), 200);

        return {
          heldAfterBoth: yield* inStore(served, first.hash),
          heldAfterOne,
          same: first.hash === second.hash,
          shared: [shared.status, sharedBytes],
        };
      })
    );

    expect(result).toStrictEqual({
      heldAfterBoth: false,
      heldAfterOne: true,
      same: true,
      shared: [200, png],
    });
  });

  it("never releases bytes an upload of the same bytes has put but not yet journaled", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const first = yield* uploaded(served, png, "first.png");
        const put = yield* Latch.make();
        const go = yield* Latch.make();
        const { store } = served.world.bytes;

        // A store whose put keeps the bytes, then waits before it answers, so the upload has
        // put them to the store and not yet journaled its Upload.
        const holding: ByteStoreService = {
          ...store,
          put: (body) =>
            store.put(body).pipe(
              Effect.tap(() => put.open),
              Effect.tap(() => go.await)
            ),
        };

        Object.assign(served.world.bytes, { store: holding });

        const second = yield* Effect.forkChild(uploaded(served, png, "second.png"));

        yield* put.await;
        yield* expecting(remove(served, first.id), 200);
        const heldMeanwhile = yield* inStore(served, first.hash);

        yield* go.open;

        const { id } = yield* Fiber.join(second);
        const kept = yield* served.request(`/api/uploads/${id}/content`);

        return { heldMeanwhile, kept: [kept.status, yield* bytesOf(kept)] };
      })
    );

    expect(result).toStrictEqual({ heldMeanwhile: true, kept: [200, png] });
  });

  it("has an upload of the same bytes wait for their release in progress, then keeps them", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const first = yield* uploaded(served, png, "first.png");
        const releasing = yield* Latch.make();
        const go = yield* Latch.make();
        const { store } = served.world.bytes;

        // A store whose delete waits before it removes anything.
        const holding: ByteStoreService = {
          ...store,
          delete: (hash) =>
            releasing.open.pipe(Effect.andThen(go.await), Effect.andThen(store.delete(hash))),
        };

        Object.assign(served.world.bytes, { store: holding });

        const deleting = yield* Effect.forkChild(remove(served, first.id));

        yield* releasing.await;
        const second = yield* Effect.forkChild(uploaded(served, png, "second.png"));

        // Long enough for an upload that did not wait to put its bytes and journal them.
        yield* Effect.sleep("200 millis");
        yield* go.open;
        const deleted = yield* Fiber.join(deleting);

        const { id } = yield* Fiber.join(second);
        const kept = yield* served.request(`/api/uploads/${id}/content`);

        return { deleted: deleted.status, kept: [kept.status, yield* bytesOf(kept)] };
      })
    );

    expect(result).toStrictEqual({ deleted: 200, kept: [200, png] });
  });

  it("keeps a rename and a delete across a restart on the same Journal", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const kept = yield* uploaded(served, png, "kept.png");
        const gone = yield* uploaded(served, png, "gone.png");
        const renamed = yield* recordOf(yield* rename(served, kept.id, "renamed.png"));
        const deleted = yield* recordOf(yield* remove(served, gone.id));

        yield* served.restart;

        const read = (id: string) => Effect.flatMap(served.request(`/api/uploads/${id}`), recordOf);

        return {
          after: [yield* read(kept.id), yield* read(gone.id)],
          before: [renamed, deleted],
          gone: statusOf(yield* served.request(`/api/uploads/${gone.id}/content`)),
          listed: (yield* pageOf(yield* served.request("/api/uploads"))).uploads,
        };
      })
    );

    expect(result.after).toStrictEqual(result.before);
    expect(result.gone).toBe(404);
    expect(result.listed).toStrictEqual([result.before[0]]);
  });

  it("renames and deletes only with a key or a Sign-in, and refuses a cookie from another origin", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const record = yield* uploaded(served, png, "cat.png");
        const cookie = yield* signedIn(served);

        const asBrowser = (site: string) => ({
          headers: { cookie, "sec-fetch-site": site },
          key: null,
        });

        const crossSite = [
          yield* statusFrom(rename(served, record.id, "x.png", asBrowser("cross-site"))),
          yield* statusFrom(remove(served, record.id, asBrowser("cross-site"))),
        ];

        const neither = [
          yield* statusFrom(rename(served, record.id, "x.png", { key: null })),
          yield* statusFrom(remove(served, record.id, { key: null })),
        ];

        const journaledBefore = (yield* journaledChanges(served.world)).length;

        const sameOrigin = [
          yield* statusFrom(rename(served, record.id, "x.png", asBrowser("same-origin"))),
          yield* statusFrom(remove(served, record.id, asBrowser("same-origin"))),
        ];

        return {
          crossSite,
          journaled: (yield* journaledChanges(served.world)).map(({ change }) => change._tag),
          journaledBefore,
          neither,
          sameOrigin,
        };
      })
    );

    expect(result).toStrictEqual({
      crossSite: [403, 403],
      journaled: ["Uploaded", "Renamed", "Deleted"],
      journaledBefore: 1,
      neither: [401, 401],
      sameOrigin: [200, 200],
    });
  });

  it("answers an unknown id with 404, an empty name with 400, renaming a deleted Upload with 404, and deleting one again with its record, journaling nothing for any", async () => {
    const never = "0000000000000000";

    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const record = yield* uploaded(served, png, "cat.png");
        const empty = yield* errorFrom(yield* rename(served, record.id, ""));
        const unknownRename = yield* errorFrom(yield* rename(served, never, "x.png"));
        const unknownDelete = yield* errorFrom(yield* remove(served, never));
        const deleted = yield* recordOf(yield* remove(served, record.id));
        const journaled = (yield* journaledChanges(served.world)).length;
        const again = yield* remove(served, record.id);

        return {
          again: [again.status, yield* recordOf(again)],
          deleted,
          empty: empty[0],
          journaled: [journaled, (yield* journaledChanges(served.world)).length],
          renameDeleted: yield* errorFrom(yield* rename(served, record.id, "x.png")),
          unknownDelete,
          unknownRename,
        };
      })
    );

    expect(result).toStrictEqual({
      again: [200, result.deleted],
      deleted: result.deleted,
      empty: 400,
      journaled: [2, 2],
      renameDeleted: [404, { _tag: "UnknownUpload", id: result.deleted.id }],
      unknownDelete: [404, { _tag: "UnknownUpload", id: never }],
      unknownRename: [404, { _tag: "UnknownUpload", id: never }],
    });
  });

  it("pages past deleted Uploads, follows a cursor naming one since deleted, and reads through the latest Change", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const records = yield* uploadedMany(served, 5);
        const first = yield* pageOf(yield* served.request("/api/uploads?limit=2"));

        yield* expecting(remove(served, records[3]?.id ?? ""), 200);
        yield* expecting(remove(served, records[2]?.id ?? ""), 200);

        const after = yield* pageOf(
          yield* served.request(`/api/uploads?limit=2&after=${first.next ?? ""}`)
        );

        const top = yield* pageOf(yield* served.request("/api/uploads?limit=2"));
        const changes = yield* journaledChanges(served.world);

        return { after, latest: changes.at(-1)?.sequence, records, top };
      })
    );

    const one = result.records.at(0);
    const two = result.records.at(1);

    expect(result.after).toStrictEqual({
      more: false,
      next: null,
      through: result.latest,
      uploads: [two, one],
    });
    expect(result.top).toStrictEqual({
      more: true,
      next: two?.id,
      through: result.latest,
      uploads: [result.records.at(4), two],
    });
  });

  it("delivers a rename and a delete as the Upload whole, with their Changes' sequences, and replays them after `after` as it is now", async () => {
    const result = await run((served) =>
      Effect.gen(function* () {
        yield* turnOn(served);
        const live = yield* openChanges(served);
        const record = yield* uploaded(served, png, "cat.png");

        yield* changesOf(live, 1);
        const renamed = yield* recordOf(yield* rename(served, record.id, "dog.png"));

        yield* changesOf(live, 2);
        const deleted = yield* recordOf(yield* remove(served, record.id));
        const seen = yield* changesOf(live, 3);
        const resumed = yield* openChanges(served, { query: `?after=${seen[0]?.id ?? ""}` });

        return {
          journaled: (yield* journaledChanges(served.world)).map(({ sequence }) =>
            String(sequence)
          ),
          resumed: yield* changesOf(resumed, 2),
          seen,
          uploads: [record, renamed, deleted],
        };
      })
    );

    expect(result.seen.map((event) => event.upload)).toStrictEqual(result.uploads);
    expect(result.seen.map((event) => event.id)).toStrictEqual(result.journaled);
    expect(result.resumed).toStrictEqual(
      result.seen.slice(1).map(({ id }) => ({ id, upload: result.uploads[2] }))
    );
  });
});
