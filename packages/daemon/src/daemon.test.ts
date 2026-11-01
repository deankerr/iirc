import { Database } from "bun:sqlite";

import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { DaemonApi, InvalidMessage, NotInSession } from "@iirc/api";
import type { LogEntry } from "@iirc/api";
import { DataDirectoryLocked } from "@iirc/log";
import { eventually, fakeIrcd } from "@iirc/session/testing";
import type { FakeIrcd } from "@iirc/session/testing";
import { Transport } from "@iirc/session/transport";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { DaemonCore } from "./daemon.ts";
import type { DaemonConfig } from "./daemon.ts";
import { ApiRoutes } from "./routes.ts";

const encoder = new TextEncoder();
const version = "1.2.3";
const welcome = ":ircd 001 iirc :Welcome\r\n";

const configIn = (dataDir: string): DaemonConfig => ({
  dataDir,
  input: { channels: [], nick: "iirc", realname: "I IRC", username: "user" },
  ircd: { host: "irc.test", port: 6697, tls: false },
  network: "libera",
  version,
});

const makeClient = HttpClient.HttpClient.pipe(
  Effect.flatMap((httpClient) => HttpApiClient.makeWith(DaemonApi, { httpClient }))
);

type Client = Effect.Success<typeof makeClient>;

// Loose on purpose, because some of these are what the API must refuse.
type PostBody = Readonly<Record<string, string | number>>;

interface Harness {
  readonly client: Client;
  readonly ircd: FakeIrcd;
  // Reaches past the typed client, which would refuse to encode a bad request.
  readonly raw: (path: string) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly post: (body: PostBody) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}

// The same order as `apps/iirc`, so this is also what proves the Log is built once.
const serving = (dataDir: string, ircd: FakeIrcd) =>
  HttpRouter.serve(ApiRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provide(DaemonCore(configIn(dataDir), Layer.succeed(Transport, ircd.transport)))
  );

const inTempDirectory = <A, E, R>(test: (dataDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return yield* test(
      yield* fileSystem.makeTempDirectoryScoped({ directory: "/var/tmp", prefix: "iirc-daemon-" })
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const withDaemonIn = <A, E, R>(
  dataDir: string,
  test: (harness: Harness) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const ircd = yield* fakeIrcd();

    return yield* Effect.gen(function* () {
      const client = yield* makeClient;
      const httpClient = yield* HttpClient.HttpClient;

      return yield* test({
        client,
        ircd,
        post: (body) =>
          HttpClientRequest.post("/api/messages").pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
            httpClient.execute,
            Effect.orDie
          ),
        raw: (path) => Effect.orDie(httpClient.get(path)),
      });
    }).pipe(Effect.provide(serving(dataDir, ircd)));
  }).pipe(Effect.scoped);

const withDaemon = <A, E, R>(test: (harness: Harness) => Effect.Effect<A, E, R>) =>
  inTempDirectory((dataDir) => withDaemonIn(dataDir, test));

// Waits for the host to have recorded what the fake Ircd just said.
const untilPhase = ({ client }: Harness, phase: string) =>
  eventually(client.daemon.status(), (status) => status.phase === phase);

const inSession = (harness: Harness) =>
  Effect.gen(function* () {
    yield* untilPhase(harness, "registering");
    yield* harness.ircd.read(welcome);
    yield* untilPhase(harness, "session");
  });

const everything = { query: { after: 0, limit: 1000 } };

const untilEntries = ({ client }: Harness, done: (entries: readonly LogEntry[]) => boolean) =>
  eventually(client.daemon.entries(everything), done);

const lines = (entries: readonly LogEntry[], direction: "inbound" | "outbound") =>
  entries.flatMap((entry) =>
    entry._tag === "Line" && entry.direction === direction ? [entry] : []
  );

const toBase64Lines = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ bytes: Schema.String }))
);

const pageLength = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown));

const restart = (harness: Harness) =>
  Effect.gen(function* () {
    yield* untilPhase(harness, "registering");

    return yield* harness.client.daemon.entries(everything);
  });

// Runs a statement with no Daemon running, as the Owner would with the `sqlite3` shell.
const vandalise = (dataDir: string, statement: string) =>
  Effect.sync(() => {
    const database = new Database(`${dataDir}/iirc.sqlite`);

    database.run(statement);
    database.close();
  });

const tableNames = (dataDir: string) =>
  Effect.sync(() => {
    const database = new Database(`${dataDir}/iirc.sqlite`, { readonly: true });
    const names = database.query("SELECT name FROM sqlite_master").all();

    database.close();

    return JSON.stringify(names);
  });

describe("the Daemon", () => {
  describe("/health", () => {
    it.live("answers with no Session and no key", () =>
      withDaemon(({ client, raw }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* client.health.health(), { status: "ok" });
          assert.strictEqual((yield* raw("/api/health")).status, 200);
        })
      )
    );

    it.live("lives under /api, like everything else", () =>
      withDaemon(({ raw }) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* raw("/health")).status, 404);
          assert.strictEqual((yield* raw("/status")).status, 404);
        })
      )
    );
  });

  describe("/status", () => {
    it.live("reports the Network, its phase, and the Log's head", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);

          const entries = yield* harness.client.daemon.entries(everything);

          assert.deepStrictEqual(yield* harness.client.daemon.status(), {
            closeReason: null,
            head: entries.at(-1)?.sequence ?? 0,
            network: "libera",
            phase: "session",
          });
        })
      )
    );

    it.live("agrees with the fold on who Self is, through every `001`", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          const { client, ircd } = harness;

          yield* untilPhase(harness, "registering");
          yield* ircd.read(":ircd 001\r\n");
          yield* untilEntries(harness, (all) => lines(all, "inbound").length === 1);

          // A welcome that names nobody starts no Session, and names no Self.
          assert.strictEqual((yield* client.daemon.status()).phase, "registering");

          yield* ircd.read(welcome);
          yield* untilPhase(harness, "session");
          yield* ircd.read(":x 001 mallory :Welcome\r\n");
          yield* untilEntries(harness, (all) => lines(all, "inbound").length === 3);
          yield* client.daemon.send({ payload: { target: "#iirc", text: "still me" } });

          const messages = yield* client.daemon.messages(everything);

          assert.strictEqual((yield* client.daemon.status()).phase, "session");
          assert.deepStrictEqual(
            messages.map(({ sender }) => sender),
            ["iirc"]
          );
        })
      )
    );

    it.live("says why the Connection closed", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.read("ERROR :Closing Link\r\n");
          yield* harness.ircd.hangUp;

          const status = yield* untilPhase(harness, "closed");

          assert.strictEqual(status.closeReason, "Closing Link");
        })
      )
    );
  });

  describe("/entries", () => {
    it.live("records its start with its version, before it connects", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* untilPhase(harness, "registering");

          const [first, second] = yield* harness.client.daemon.entries(everything);

          assert.deepInclude(first, { _tag: "Daemon", phase: "started", sequence: 1, version });
          assert.deepInclude(second, { _tag: "Connection", phase: "attempt", sequence: 2 });
        })
      )
    );

    it.live("API-4: returns bytes that are not UTF-8 as base64, beside the text", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          const hostile = new Uint8Array([0x3a, 0x62, 0x20, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);

          yield* inSession(harness);
          yield* harness.ircd.read(hostile, "\r\n");

          const entries = yield* untilEntries(harness, (all) => lines(all, "inbound").length === 2);
          const line = lines(entries, "inbound").at(-1);

          assert.deepStrictEqual(line?.bytes, hostile);
          assert.strictEqual(line?.text, new TextDecoder("latin1").decode(hostile));

          // What a Frontend that is not this typed client gets.
          const response = yield* harness.raw(`/api/entries?after=${(line?.sequence ?? 0) - 1}`);
          const [wire] = toBase64Lines(yield* response.json);

          assert.strictEqual(wire?.bytes, Buffer.from(hostile).toString("base64"));
        })
      )
    );

    it.live("HOST-1: says why a Line could not be parsed, beside its text", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.read(":only-a-source\r\n\r\nNOTICE * :fine\r\n");

          const entries = yield* untilEntries(harness, (all) => lines(all, "inbound").length === 4);
          const [, noCommand, empty, fine] = lines(entries, "inbound");

          assert.deepInclude(noCommand, { reason: "NoCommand", text: ":only-a-source" });
          assert.deepInclude(empty, { reason: "Empty", text: "" });
          assert.deepInclude(fine, { text: "NOTICE * :fine" });
          assert.notProperty(fine, "reason");
        })
      )
    );

    it.live("keeps a cut Line, marked, with its bytes", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.read(":b!u@h PRIVMSG #iirc :no line ending");
          yield* harness.ircd.hangUp;

          const entries = yield* untilEntries(harness, (all) =>
            lines(all, "inbound").some((line) => line.cut === true)
          );

          assert.deepInclude(lines(entries, "inbound").at(-1), {
            bytes: encoder.encode(":b!u@h PRIVMSG #iirc :no line ending"),
            cut: true,
            text: ":b!u@h PRIVMSG #iirc :no line ending",
          });
          assert.deepStrictEqual(yield* harness.client.daemon.messages(everything), []);
        })
      )
    );

    it.live("pages by cursor, and defaults to the first 100", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.read(":ircd NOTICE * :padding\r\n".repeat(150));
          yield* untilEntries(harness, (all) => lines(all, "inbound").length === 151);

          const firstPage = pageLength(yield* (yield* harness.raw("/api/entries")).json);
          const page = yield* harness.client.daemon.entries({ query: { after: 3, limit: 2 } });

          assert.lengthOf(firstPage, 100);
          assert.deepStrictEqual(
            page.map(({ sequence }) => sequence),
            [4, 5]
          );
        })
      )
    );
  });

  describe("/messages", () => {
    it.live("returns what was said, with the sequence of its Line", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.read(
            ":bob!u@h PRIVMSG #iirc :hi\r\n",
            ":bob!u@h NOTICE iirc :psst\r\n"
          );

          const entries = yield* untilEntries(harness, (all) => lines(all, "inbound").length === 3);
          const [, hi, psst] = lines(entries, "inbound");
          const messages = yield* harness.client.daemon.messages(everything);

          assert.deepStrictEqual(
            messages.map(({ kind, network, sender, sequence, target, text }) => ({
              kind,
              network,
              sender,
              sequence,
              target,
              text,
            })),
            [
              {
                kind: "PRIVMSG",
                network: "libera",
                sender: "bob",
                sequence: hi?.sequence ?? 0,
                target: "#iirc",
                text: "hi",
              },
              {
                kind: "NOTICE",
                network: "libera",
                sender: "bob",
                sequence: psst?.sequence ?? 0,
                target: "iirc",
                text: "psst",
              },
            ]
          );

          const after = yield* harness.client.daemon.messages({
            query: { after: hi?.sequence ?? 0, limit: 1 },
          });

          assert.deepStrictEqual(
            after.map(({ text }) => text),
            ["psst"]
          );
        })
      )
    );

    it.live("sends a PRIVMSG, recorded with its cause, and writes it", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.client.daemon.send({ payload: { target: "#iirc", text: "hello there" } });

          const entries = yield* harness.client.daemon.entries(everything);
          const written = yield* harness.ircd.written;

          assert.deepInclude(lines(entries, "outbound").at(-1), {
            cause: "api",
            text: "PRIVMSG #iirc :hello there",
          });
          assert.deepStrictEqual(written.at(-1), encoder.encode("PRIVMSG #iirc :hello there\r\n"));

          const messages = yield* harness.client.daemon.messages(everything);

          assert.deepInclude(messages.at(-1), { sender: "iirc", target: "#iirc" });
        })
      )
    );

    it.live("API-3: refuses a Message that cannot be a Line, with a 422", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);

          const refused = (target: string, text: string) =>
            Effect.flip(harness.client.daemon.send({ payload: { target, text } }));

          assert.deepStrictEqual(
            yield* refused("#a,#b", "two Targets"),
            new InvalidMessage({ reason: "InvalidTarget" })
          );
          assert.deepStrictEqual(
            yield* refused("#iirc", ""),
            new InvalidMessage({ reason: "EmptyText" })
          );
          assert.deepStrictEqual(
            yield* refused("#iirc", "two\r\nQUIT :Lines"),
            new InvalidMessage({ reason: "InvalidParameter" })
          );
          assert.deepStrictEqual(
            yield* refused("#iirc", "x".repeat(600)),
            new InvalidMessage({ reason: "TooLong" })
          );

          const response = yield* harness.post({ target: "#a,#b", text: "two Targets" });

          assert.strictEqual(response.status, 422);
        })
      )
    );

    it.live("API-10: refuses a send with no Session, with a 409", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* untilPhase(harness, "registering");

          const failure = yield* Effect.flip(
            harness.client.daemon.send({ payload: { target: "#iirc", text: "too early" } })
          );

          assert.deepStrictEqual(failure, new NotInSession({ phase: "registering" }));
          assert.strictEqual((yield* harness.post({ target: "#iirc", text: "hi" })).status, 409);
        })
      )
    );

    it.live("API-10: refuses a send once the Connection has closed", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.hangUp;
          yield* untilPhase(harness, "closed");

          const failure = yield* Effect.flip(
            harness.client.daemon.send({ payload: { target: "#iirc", text: "too late" } })
          );

          assert.deepStrictEqual(failure, new NotInSession({ phase: "closed" }));
        })
      )
    );

    it.live("refuses a body that is not a Message, with a 400", () =>
      withDaemon(({ post }) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* post({ target: "#iirc" })).status, 400);
          assert.strictEqual((yield* post({ target: 1, text: "hi" })).status, 400);
        })
      )
    );
  });

  describe("query bounds", () => {
    const refused = [
      "limit=-1",
      "limit=0",
      "limit=1001",
      "limit=1.5",
      "limit=lots",
      "limit=",
      "limit=1&limit=2",
      "after=-1",
      "after=0.5",
      "after=soon",
      "after=9007199254740993",
    ];

    const accepted = ["limit=1", "limit=1000", "after=0", "after=1", "after=1&limit=1"];

    for (const path of ["/api/entries", "/api/messages"]) {
      it.live(`refuses anything out of bounds on ${path}, with a 400`, () =>
        withDaemon(({ raw }) =>
          Effect.forEach(
            refused,
            (query) =>
              Effect.map(raw(`${path}?${query}`), ({ status }) => {
                assert.strictEqual(status, 400, query);
              }),
            { discard: true }
          )
        )
      );

      it.live(`accepts the bounds themselves on ${path}`, () =>
        withDaemon(({ raw }) =>
          Effect.forEach(
            accepted,
            (query) =>
              Effect.map(raw(`${path}?${query}`), ({ status }) => {
                assert.strictEqual(status, 200, query);
              }),
            { discard: true }
          )
        )
      );
    }
  });

  describe("starting", () => {
    it.live("RUN-4: fails when another Daemon holds the data directory", () =>
      inTempDirectory((dataDir) =>
        withDaemonIn(dataDir, () =>
          Effect.gen(function* () {
            const second = yield* Layer.build(DaemonCore(configIn(dataDir))).pipe(
              Effect.scoped,
              Effect.flip
            );

            assert.deepStrictEqual(second, new DataDirectoryLocked({ dataDir }));
            assert.include(second.message, "locked");
          })
        )
      )
    );

    it.live("RUN-3: carries on the same Log after a restart, recording each start", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const before = yield* withDaemonIn(dataDir, restart);
          const after = yield* withDaemonIn(dataDir, restart);

          assert.deepStrictEqual(after.slice(0, before.length), before);
          assert.lengthOf(
            after.filter(({ _tag }) => _tag === "Daemon"),
            2
          );
        })
      )
    );

    for (const vandalism of ["DELETE FROM messages", "DROP TABLE messages"]) {
      it.live(`LOG-10: serves identical Messages after \`${vandalism}\` and a restart`, () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const before = yield* withDaemonIn(dataDir, (harness) =>
              Effect.gen(function* () {
                yield* inSession(harness);
                yield* harness.ircd.read(":bob!u@h PRIVMSG #iirc :hi\r\n");
                yield* untilEntries(harness, (all) => lines(all, "inbound").length === 2);
                yield* harness.client.daemon.send({ payload: { target: "#iirc", text: "hello" } });

                return yield* harness.client.daemon.messages(everything);
              })
            );

            assert.lengthOf(before, 2);

            yield* vandalise(dataDir, vandalism);

            // Proves the damage was done, so that the rest proves it was mended.
            assert.strictEqual(
              (yield* tableNames(dataDir)).includes("messages"),
              vandalism.startsWith("DELETE")
            );

            const after = yield* withDaemonIn(dataDir, ({ client }) =>
              client.daemon.messages(everything)
            );

            assert.deepStrictEqual(after, before);
          })
        )
      );
    }
  });
});
