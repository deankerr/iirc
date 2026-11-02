import { Database } from "bun:sqlite";

import { assert, describe, it } from "@effect/vitest";
import {
  DaemonApi,
  InvalidMessage,
  LaneFull,
  LineDropped,
  LogUnavailable,
  NotInSession,
  ReadTimedOut,
  Stopping,
  WriteFailed,
} from "@iirc/api";
import type { LogEntry, NetworkStatus } from "@iirc/api";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning } from "@iirc/lifecycle/tuning";
import {
  DataDirectoryLocked,
  Log,
  LogReader,
  ReaderBusy as ReaderQueueFull,
  ReadTimedOut as ReaderTimedOut,
  StorageFailed,
} from "@iirc/log";
import { RecordFailed, Recorder } from "@iirc/session/recorder";
import { eventually, fakeIrcd } from "@iirc/session/testing";
import type { FakeIrcd, FakeIrcdOptions } from "@iirc/session/testing";
import { Transport } from "@iirc/session/transport";
import { Context, Duration, Effect, Exit, Fiber, Layer, Ref, Schema, Scope } from "effect";
import { constVoid } from "effect/Function";
import type { HttpClientResponse } from "effect/http";
import { OpenApi } from "effect/http-api";

import {
  clientWith,
  credentialsIn,
  inTempDirectory,
  invalidRequest,
  localKey,
  ownerKey,
  noKeyring,
  rawWith,
  servingWith,
  statusOf,
  version,
} from "./daemon.fixture.ts";
import type { Client } from "./daemon.fixture.ts";
import { Daemon, DaemonCore, UndecodableChange } from "./daemon.ts";
import type { DaemonConfig } from "./daemon.ts";

const encoder = new TextEncoder();
const welcome = ":ircd 001 iirc :Welcome\r\n";
const network = "libera";
const cause = `key:${ownerKey}`;

/** What a test changes about the Network it runs on. */
interface Scenario {
  readonly alternates?: readonly string[];
  readonly channels?: readonly { readonly name: string; readonly rejoinOnKick?: boolean }[];
  readonly ircd?: FakeIrcdOptions;
  readonly tuning?: Partial<Tuning>;
}

const configIn = (dataDir: string): DaemonConfig => ({ dataDir, version });

// The Network every test here runs on. The fake Ircd answers whatever is dialled.
const settingsFor = (scenario: Scenario = {}) => ({
  channels: (scenario.channels ?? []).map(({ name, rejoinOnKick = false }) => ({
    autojoin: true,
    name,
    rejoinOnKick,
  })),
  connectCommands: [],
  credentials: {},
  enabled: true,
  id: network,
  identity: {
    alternates: scenario.alternates ?? [],
    nick: "iirc",
    realname: "I IRC",
    username: "user",
  },
  ircds: [{ host: "irc.test", port: 6697, tls: false }] as const,
  name: "Libera",
  quitReason: "going",
  services: [],
  tuning: scenario.tuning ?? {},
});

// Loose on purpose, because some of these are what the API must refuse.
type PostBody = Readonly<Record<string, string | number>>;

interface Harness {
  readonly client: Client;
  readonly ircd: FakeIrcd;
  // Reaches past the typed client, which would refuse to encode a bad request.
  readonly raw: (path: string) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly post: (body: PostBody) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly postText: (text: string) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
  readonly status: ReturnType<typeof statusOf>;
}

// What status says of the last close, which a restart must not change.
const lastClose = ({ closeReason, consecutiveFailures, nextAttemptAt, phase }: NetworkStatus) => ({
  closeReason,
  consecutiveFailures,
  nextAttemptAt,
  phase,
});

// Each data directory's first key, made once before its first Daemon, as `iirc key create`
// would, and used by every Daemon that runs on it after.
const keys = new Map<string, string>();

const keyFor = (dataDir: string) =>
  Effect.gen(function* () {
    const held = keys.get(dataDir);

    if (held !== undefined) {
      return held;
    }

    const key = yield* localKey(dataDir);

    keys.set(dataDir, key);

    return key;
  });

const serving = (dataDir: string, ircd: FakeIrcd) =>
  servingWith(DaemonCore(configIn(dataDir), Layer.succeed(Transport, ircd.transport), noKeyring));

// Adds the Network through the API unless an earlier run on this Log already did, since
// Configuration outlives a restart.
const harnessOn = (ircd: FakeIrcd, key: string, scenario?: Scenario) =>
  Effect.gen(function* () {
    const client = yield* clientWith(key);
    const raw = yield* rawWith(key);

    const configured = yield* client.networks.list();

    if (!configured.some(({ settings }) => settings.id === network)) {
      yield* client.networks.add({ payload: settingsFor(scenario) });
    }

    return {
      client,
      ircd,
      post: (body: PostBody) => raw.post("/api/messages", { network, ...body }),
      postText: (text: string) => raw.postText("/api/messages", text),
      raw: raw.get,
      status: statusOf(client, network),
    } satisfies Harness;
  });

const withDaemonIn = <A, E, R>(
  dataDir: string,
  test: (harness: Harness) => Effect.Effect<A, E, R>,
  scenario?: Scenario
) =>
  Effect.gen(function* () {
    const key = yield* keyFor(dataDir);
    const ircd = yield* fakeIrcd(scenario?.ircd);

    return yield* Effect.flatMap(harnessOn(ircd, key, scenario), test).pipe(
      Effect.provide(serving(dataDir, ircd))
    );
  }).pipe(Effect.scoped);

// A Daemon whose reader fails every read a Frontend makes, in one way, so that its mapping
// shows. Its own read of Configuration at startup goes through.
const withFailingReader = <A, E, R>(
  failure: ReaderQueueFull | ReaderTimedOut | StorageFailed,
  test: (harness: Harness) => Effect.Effect<A, E, R>
) =>
  inTempDirectory((dataDir) =>
    Effect.gen(function* () {
      const key = yield* keyFor(dataDir);
      const ircd = yield* fakeIrcd();
      const failing = yield* Ref.make(false);

      const unlessFailing = <A2>(
        read: Effect.Effect<A2, ReaderQueueFull | ReaderTimedOut | StorageFailed>
      ): Effect.Effect<A2, ReaderQueueFull | ReaderTimedOut | StorageFailed> =>
        Effect.flatMap(Ref.get(failing), (fails) => (fails ? Effect.fail(failure) : read));

      const reader = Layer.effect(
        LogReader,
        Effect.gen(function* () {
          const real = yield* LogReader;

          return {
            backup: real.backup,
            entries: (query) => unlessFailing(real.entries(query)),
            gaps: (query) => unlessFailing(real.gaps(query)),
            messages: (query) => unlessFailing(real.messages(query)),
          } satisfies LogReader["Service"];
        })
      ).pipe(Layer.provide(LogReader.layer({ dataDir })));

      const core = Daemon.layer(configIn(dataDir)).pipe(
        Layer.provide(Layer.merge(reader, credentialsIn(dataDir))),
        Layer.provideMerge(Log.layer({ dataDir })),
        Layer.provide(Layer.succeed(Transport, ircd.transport))
      );

      return yield* Effect.gen(function* () {
        const harness = yield* harnessOn(ircd, key);

        yield* Ref.set(failing, true);

        return yield* test(harness);
      }).pipe(Effect.provide(servingWith(core)));
    }).pipe(Effect.scoped)
  );

const withDaemon = <A, E, R>(
  test: (harness: Harness) => Effect.Effect<A, E, R>,
  scenario?: Scenario
) => inTempDirectory((dataDir) => withDaemonIn(dataDir, test, scenario));

// Waits for the host to have recorded what the fake Ircd just said.
const untilPhase = ({ status }: Harness, phase: string) =>
  eventually(status, (current) => current.phase === phase);

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

const connections = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) => (entry._tag === "Connection" ? [entry] : []));

const dropped = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) => (entry._tag === "Dropped" ? [entry] : []));

const restart = (harness: Harness) =>
  Effect.gen(function* () {
    yield* untilPhase(harness, "registering");

    return yield* harness.client.daemon.entries(everything);
  });

// What is at the end of a Log no Daemon has open, one word for each Entry.
// Appends Change Entries as raw JSON text, as only a broken or older writer could.
const appendRaw = (dataDir: string, changes: readonly string[]) =>
  Effect.sync(() => {
    const database = new Database(`${dataDir}/iirc.sqlite`);
    const head = database.query<{ head: number }, []>("SELECT MAX(sequence) AS head FROM entries");
    let sequence = head.get()?.head ?? 0;

    const insert = database.query(
      "INSERT INTO entries (sequence, at, kind, \"by\", change) VALUES (?, ?, 'Change', ?, ?)"
    );

    database.transaction(() => {
      for (const change of changes) {
        sequence += 1;
        insert.run(sequence, Date.now(), ownerKey, change);
      }
    })();

    database.close();
  });

const logTail = (dataDir: string, length: number) =>
  Effect.sync(() => {
    const database = new Database(`${dataDir}/iirc.sqlite`, { readonly: true });

    const rows = database
      .query<{ bytes: Uint8Array | null; kind: string; phase: string | null }, [number]>(
        "SELECT bytes, kind, phase FROM entries ORDER BY sequence DESC LIMIT ?"
      )
      .all(length);

    database.close();

    return rows
      .toReversed()
      .map(({ bytes, kind, phase }) =>
        kind === "Line" ? Buffer.from(bytes ?? []).toString() : `${kind} ${phase}`
      );
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
    it.live("OBS-1: reports everything about a Session, typed", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);

          const entries = yield* harness.client.daemon.entries(everything);
          const status = yield* harness.client.daemon.status();

          assert.deepStrictEqual(status, {
            apiVersion: 1,
            credentials: { store: "file" },
            head: entries.at(-1)?.sequence ?? 0,
            networks: [
              {
                closeReason: null,
                consecutiveFailures: 0,
                enabled: true,
                id: "libera",
                joinFailures: [],
                joined: [],
                kicked: [],
                lagMillis: null,
                lanes: { background: 0, control: 0, interactive: 0 },
                logFault: null,
                login: { state: "none", text: null },
                missingCredentials: [],
                name: "Libera",
                nextAttemptAt: null,
                phase: "session",
                refusal: null,
                refused: false,
                rejectedChannels: [],
                self: "iirc",
              },
            ],
            version,
          });
        })
      )
    );

    it.live("API-5: reports the API's version, and the Daemon's, with no Network at all", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const key = yield* keyFor(dataDir);
          const ircd = yield* fakeIrcd();

          const status = yield* Effect.flatMap(clientWith(key), (client) =>
            client.daemon.status()
          ).pipe(Effect.provide(serving(dataDir, ircd)));

          assert.deepStrictEqual(status, {
            apiVersion: 1,
            credentials: { store: "file" },
            head: 2,
            networks: [],
            version,
          });
        }).pipe(Effect.scoped)
      )
    );

    it.live("LIVE-7: reports Channels joined, and each failure with the Network's words", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { client, ircd } = harness;

            yield* inSession(harness);
            yield* ircd.read(":ircd 422 iirc :No MOTD\r\n");
            yield* eventually(ircd.written, (all) => all.length >= 3);
            yield* ircd.read(":iirc!u@h JOIN #in\r\n");
            yield* ircd.read(":ircd 474 iirc #out :Cannot join channel (+b)\r\n");

            const status = yield* eventually(
              harness.status,
              ({ joinFailures, joined }) => joined.length === 1 && joinFailures.length === 1
            );

            const attempt = connections(yield* client.daemon.entries(everything)).at(0);

            assert.deepStrictEqual(status.joined, ["#in"]);
            assert.deepInclude(status.joinFailures[0], {
              channel: "#out",
              connection: attempt?.sequence ?? 0,
              numeric: "474",
              text: "Cannot join channel (+b)",
            });
          }),
        { channels: [{ name: "#in" }, { name: "#out" }] }
      )
    );

    it.live("SEND-1: a rejoin waits on the background lane, not the interactive one", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { client, ircd } = harness;

            yield* inSession(harness);
            // Spends the only token, so the `JOIN` has to wait in its lane, where it shows.
            yield* client.daemon.send({
              payload: { network, target: "#elsewhere", text: "first" },
            });
            yield* ircd.read(":ircd 376 iirc :End of MOTD\r\n");

            const { lanes } = yield* eventually(
              harness.status,
              (status) => status.lanes.background + status.lanes.interactive > 0
            );

            assert.deepStrictEqual(lanes, { background: 1, control: 0, interactive: 0 });
          }),
        {
          channels: [{ name: "#iirc" }],
          tuning: { floodBurst: 1, floodIntervalMillis: 60_000, rejoinSettleMillis: 0 },
        }
      )
    );

    it.live("LIVE-8: reports a kick, and leaves the Channel out of what is joined", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { ircd } = harness;

            yield* inSession(harness);
            yield* ircd.read(":ircd 422 iirc :No MOTD\r\n");
            yield* eventually(ircd.written, (all) => all.length >= 3);
            yield* ircd.read(":iirc!u@h JOIN #in\r\n", ":op!u@h KICK #in iirc :out\r\n");

            const { joined, kicked } = yield* eventually(
              harness.status,
              (status) => status.kicked.length === 1
            );

            assert.deepStrictEqual(joined, []);
            assert.strictEqual(kicked[0]?.channel, "#in");
          }),
        { channels: [{ name: "#in" }] }
      )
    );

    it.live("LIVE-3: reports the Network's lag", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { ircd } = harness;

            yield* inSession(harness);

            const written = yield* eventually(ircd.written, (all) =>
              all.some((bytes) => Buffer.from(bytes).includes("PING "))
            );

            const ping = written.find((bytes) => Buffer.from(bytes).includes("PING "));

            const token = Buffer.from(ping ?? [])
              .toString()
              .trim()
              .split(" ")
              .at(-1);

            yield* ircd.read(`:ircd PONG ircd :${token}\r\n`);

            const { lagMillis } = yield* eventually(
              harness.status,
              (status) => status.lagMillis !== null
            );

            assert.isAtLeast(lagMillis ?? -1, 0);
          }),
        { tuning: { lagCheckMillis: 100 } }
      )
    );

    it.live("LIVE-5: reports a refusal in the Network's words, and when it will try again", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { client, ircd } = harness;

            yield* untilPhase(harness, "registering");
            yield* ircd.read(":ircd 465 * :You are banned: go away\r\n");
            yield* ircd.hangUp;

            const status = yield* eventually(
              harness.status,
              ({ nextAttemptAt }) => nextAttemptAt !== null
            );

            const closed = connections(yield* client.daemon.entries(everything)).at(-1);

            assert.deepInclude(closed, {
              phase: "closed",
              reason: "You are banned: go away",
              refused: true,
            });
            assert.deepInclude(status, {
              consecutiveFailures: 1,
              phase: "closed",
              refusal: "You are banned: go away",
              refused: true,
            });
            assert.strictEqual(status.nextAttemptAt, (closed?.at ?? 0) + 60_000);
          }),
        { tuning: { refusalBackoffMillis: 60_000 } }
      )
    );

    it.live("LOG-9: reports a fault in the Log, and still answers", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const failing = yield* Ref.make(false);
          const ircd = yield* fakeIrcd();

          const brittle = Layer.effect(
            Recorder,
            Effect.gen(function* () {
              const { record, standing } = yield* Recorder;

              return {
                record: (entries, within) =>
                  Effect.flatMap(Ref.get(failing), (fails) =>
                    fails
                      ? Effect.fail(new RecordFailed({ cause: "the disk is full" }))
                      : record(entries, within)
                  ),
                standing,
              };
            })
          );

          const core = Daemon.layer(configIn(dataDir)).pipe(
            Layer.provide(brittle),
            Layer.provide(Layer.merge(LogReader.layer({ dataDir }), credentialsIn(dataDir))),
            Layer.provideMerge(Log.layer({ dataDir })),
            Layer.provide(Layer.succeed(Transport, ircd.transport))
          );

          const key = yield* keyFor(dataDir);

          yield* Effect.gen(function* () {
            const harness = yield* harnessOn(ircd, key);

            yield* inSession(harness);
            yield* harness.ircd.read(":iirc!u@h JOIN #c\r\n");
            yield* eventually(harness.status, ({ joined }) => joined.length > 0);
            yield* Ref.set(failing, true);

            const failure = yield* Effect.flip(
              harness.client.daemon.send({
                payload: { network, target: "#iirc", text: "unrecorded" },
              })
            );

            assert.instanceOf(failure, LogUnavailable);

            // The fault is why there is no Session, and that is what a Frontend is told (LOG-9).
            assert.strictEqual((yield* harness.post({ target: "#iirc", text: "hi" })).status, 503);

            const status = yield* eventually(
              harness.status,
              ({ logFault, phase }) => logFault !== null && phase === "closed"
            );

            assert.isAtLeast(status.logFault?.failures ?? 0, 1);
            assert.isAbove(status.logFault?.retryMillis ?? 0, 0);
            assert.isNotNull((yield* harness.client.daemon.status()).head);

            // The Log still holds that Session open, and none of it is current (OBS-1).
            assert.deepInclude(status, { joined: [], lagMillis: null, self: null });
            assert.lengthOf(
              (yield* harness.ircd.written).filter((bytes) =>
                Buffer.from(bytes).includes("unrecorded")
              ),
              0,
              "LOG-4: nothing may reach the wire unrecorded"
            );

            // Lets the host's stop reach the Log again.
            yield* Ref.set(failing, false);
          }).pipe(Effect.provide(servingWith(core)));
        }).pipe(Effect.scoped)
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
          assert.strictEqual((yield* harness.status).phase, "registering");

          yield* ircd.read(welcome);
          yield* untilPhase(harness, "session");
          yield* ircd.read(":x 001 mallory :Welcome\r\n");
          yield* untilEntries(harness, (all) => lines(all, "inbound").length === 3);
          yield* client.daemon.send({ payload: { network, target: "#iirc", text: "still me" } });

          const messages = yield* client.daemon.messages(everything);

          assert.strictEqual((yield* harness.status).phase, "session");
          assert.deepStrictEqual(
            messages.map(({ sender }) => sender),
            ["iirc"]
          );
        })
      )
    );

    it.live("LOG-10: between Connections, reads the last close the same after a restart", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const waiting = {
            tuning: { reconnectInitialMillis: 120_000, reconnectMaxMillis: 120_000 },
          };

          const before = yield* withDaemonIn(
            dataDir,
            (harness) =>
              Effect.gen(function* () {
                yield* inSession(harness);
                yield* harness.ircd.read("ERROR :Closing Link: banned for a while\r\n");
                yield* harness.ircd.hangUp;

                return lastClose(yield* untilPhase(harness, "closed"));
              }),
            waiting
          );

          const after = yield* withDaemonIn(
            dataDir,
            ({ status }) => status.pipe(Effect.map(lastClose)),
            waiting
          );

          assert.deepStrictEqual(before, {
            closeReason: "Closing Link: banned for a while",
            consecutiveFailures: 1,
            nextAttemptAt: before.nextAttemptAt,
            phase: "closed",
          });
          assert.isNotNull(before.nextAttemptAt);
          assert.deepStrictEqual(after, before);
        })
      )
    );

    it.live("LIVE-4: shows no failures once a Session has lasted long enough", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            yield* inSession(harness);
            yield* harness.ircd.hangUp;
            yield* inSession(harness);

            assert.strictEqual((yield* harness.status).consecutiveFailures, 1);

            yield* eventually(
              harness.status,
              ({ consecutiveFailures, phase }) => phase === "session" && consecutiveFailures === 0
            );
          }),
        { tuning: { reconnectInitialMillis: 1, reconnectMaxMillis: 1, stableAfterMillis: 1000 } }
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

          const [key, started, added, attempt] = yield* harness.client.daemon.entries(everything);

          // AUTH-4: the first key was made before any Daemon ran, by `local`.
          assert.deepInclude(key, { _tag: "Change", by: "local", sequence: 1 });
          assert.deepInclude(started, { _tag: "Daemon", phase: "started", sequence: 2, version });
          assert.deepInclude(added, { _tag: "Change", by: ownerKey, network, sequence: 3 });
          assert.deepInclude(attempt, { _tag: "Connection", phase: "attempt", sequence: 4 });
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

    it.live("LOG-11: filters by kind, repeated or comma-separated, and by Network", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.read(":bob!u@h PRIVMSG #iirc :hi\r\n");

          const all = yield* untilEntries(harness, (found) => lines(found, "inbound").length === 2);

          const ofKinds = (...kinds: readonly LogEntry["_tag"][]) =>
            all.filter(({ _tag }) => kinds.includes(_tag));

          const daemonAndLine = yield* harness.client.daemon.entries({
            query: { after: 0, kind: ["Daemon", "Line"], limit: 100 },
          });

          assert.deepStrictEqual(daemonAndLine, ofKinds("Daemon", "Line"));
          assert.sameMembers(
            [...new Set(daemonAndLine.map(({ _tag }) => _tag))],
            ["Daemon", "Line"]
          );

          for (const query of [
            "kind=Daemon,Line",
            "kind=Line&kind=Daemon",
            "kind=Daemon,Line&kind=Line",
          ]) {
            const response = yield* harness.raw(`/api/entries?${query}`);

            assert.strictEqual(response.status, 200, query);
            assert.lengthOf(pageLength(yield* response.json), daemonAndLine.length, query);
          }

          // The Daemon's own Entries are no Network's, and nor is the first key.
          assert.deepStrictEqual(
            yield* harness.client.daemon.entries({
              query: { after: 0, limit: 100, network: "libera" },
            }),
            all.filter((entry) => "network" in entry && entry.network === network)
          );
          assert.sameMembers(
            all.flatMap((entry) => ("network" in entry ? [] : [entry._tag])),
            ["Change", "Daemon"]
          );
          assert.deepStrictEqual(
            yield* harness.client.daemon.entries({
              query: { after: 0, kind: ["Connection"], limit: 1, network: "libera" },
            }),
            ofKinds("Connection").slice(0, 1)
          );
          assert.deepStrictEqual(
            yield* harness.client.daemon.entries({
              query: { after: 0, limit: 100, network: "oftc" },
            }),
            []
          );
          assert.lengthOf(
            yield* harness.client.daemon.messages({
              query: { after: 0, limit: 100, network: "libera" },
            }),
            1
          );
          assert.deepStrictEqual(
            yield* harness.client.daemon.messages({
              query: { after: 0, limit: 100, network: "oftc" },
            }),
            []
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

    it.live("API-9: sends a PRIVMSG, recorded with its cause, and gives its sequence", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);

          const sent = yield* harness.client.daemon.send({
            payload: { network, target: "#iirc", text: "hello there" },
          });

          const entries = yield* harness.client.daemon.entries(everything);
          const written = yield* harness.ircd.written;

          assert.deepStrictEqual(sent, {
            sequence: lines(entries, "outbound").at(-1)?.sequence ?? 0,
            status: "written",
          });

          assert.deepInclude(lines(entries, "outbound").at(-1), {
            cause,
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
            Effect.flip(harness.client.daemon.send({ payload: { network, target, text } }));

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
            harness.client.daemon.send({ payload: { network, target: "#iirc", text: "too early" } })
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
            harness.client.daemon.send({ payload: { network, target: "#iirc", text: "too late" } })
          );

          assert.deepStrictEqual(failure, new NotInSession({ phase: "closed" }));
        })
      )
    );

    it.live("API-9: reports a Line still waiting its turn as queued, which then leaves", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { client } = harness;

            yield* inSession(harness);
            yield* client.daemon.send({ payload: { network, target: "#iirc", text: "the token" } });

            assert.deepStrictEqual(
              yield* client.daemon.send({ payload: { network, target: "#iirc", text: "waiting" } }),
              { status: "queued" }
            );
            assert.strictEqual((yield* harness.status).lanes.interactive, 1);

            yield* eventually(harness.status, ({ lanes }) => lanes.interactive === 0);
            yield* untilEntries(harness, (all) =>
              lines(all, "outbound").some(({ text }) => text.endsWith("waiting"))
            );
          }),
        { tuning: { floodBurst: 1, floodIntervalMillis: 100, sendWaitMillis: 10 } }
      )
    );

    it.live("SEND-3: refuses a send to a full lane, with a 429, and queues nothing", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { client, post } = harness;

            const send = client.daemon.send({
              payload: { network, target: "#iirc", text: "more" },
            });

            yield* inSession(harness);
            yield* send;
            yield* send;
            yield* send;

            const failure = yield* Effect.flip(send);

            assert.deepStrictEqual(failure, new LaneFull({ lane: "interactive" }));
            assert.strictEqual((yield* post({ target: "#iirc", text: "more" })).status, 429);
            assert.strictEqual((yield* harness.status).lanes.interactive, 2);
          }),
        {
          tuning: {
            floodBurst: 1,
            floodIntervalMillis: 60_000,
            laneLimit: 2,
            sendWaitMillis: 1,
          },
        }
      )
    );

    it.live("SEND-4: says a queued Line was Dropped, and the Log holds it as base64", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { client, ircd, raw } = harness;

            const send = client.daemon.send({
              payload: { network, target: "#iirc", text: "stranded" },
            });

            yield* inSession(harness);
            yield* send;

            const stranded = yield* Effect.forkChild(Effect.flip(send));

            yield* eventually(harness.status, ({ lanes }) => lanes.interactive === 1);
            yield* ircd.hangUp;

            const failure = yield* Fiber.join(stranded);

            assert.instanceOf(failure, LineDropped);

            const entries = yield* client.daemon.entries(everything);
            const [line] = dropped(entries);
            const closed = connections(entries).at(-1);

            assert.deepInclude(line, {
              bytes: encoder.encode("PRIVMSG #iirc stranded"),
              cause,
              reason: `the Connection closed: ${closed?.phase === "closed" ? closed.reason : ""}`,
              text: "PRIVMSG #iirc stranded",
            });
            assert.strictEqual((line?.sequence ?? 0) + 1, closed?.sequence);

            const response = yield* raw(`/api/entries?after=${(line?.sequence ?? 0) - 1}&limit=1`);
            const [wire] = toBase64Lines(yield* response.json);

            assert.strictEqual(
              wire?.bytes,
              Buffer.from("PRIVMSG #iirc stranded").toString("base64")
            );
          }),
        { tuning: { floodBurst: 1, floodIntervalMillis: 60_000 } }
      )
    );

    it.live("LIVE-11: refuses a send once a close has begun, and status says so", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.read("ERROR :Closing Link\r\n");

          yield* untilPhase(harness, "closing");

          const failure = yield* Effect.flip(
            harness.client.daemon.send({ payload: { network, target: "#iirc", text: "too late" } })
          );

          assert.deepStrictEqual(failure, new NotInSession({ phase: "closing" }));
        })
      )
    );

    it.live("says a write failed, with a 502, and not that the Daemon broke", () =>
      withDaemon((harness) =>
        Effect.gen(function* () {
          yield* inSession(harness);
          yield* harness.ircd.setWrites("fail");

          const failure = yield* Effect.flip(
            harness.client.daemon.send({ payload: { network, target: "#iirc", text: "lost" } })
          );

          assert.instanceOf(failure, WriteFailed);
          assert.include(failure.reason, "broken pipe");
        })
      )
    );

    it.live("API-3: refuses a body that is not a Message, saying what was wrong", () =>
      withDaemon(({ post, postText }) =>
        Effect.gen(function* () {
          const missing = yield* invalidRequest(yield* post({ target: "#iirc" }));
          const mistyped = yield* invalidRequest(yield* post({ target: 1, text: "hi" }));
          const unreadable = yield* invalidRequest(yield* postText("{not json"));

          assert.deepStrictEqual(missing.issues[0].path, ["payload", "text"]);
          assert.deepStrictEqual(mistyped.issues[0].path, ["payload", "target"]);
          assert.deepStrictEqual(unreadable.issues[0].path, ["payload"]);
          assert.include(unreadable.issues[0].message, "JSON");
        })
      )
    );
  });

  describe("/gaps", () => {
    const reconnecting = { tuning: { reconnectInitialMillis: 1, reconnectMaxMillis: 1 } };

    it.live(
      "LIVE-10: shows an open Gap, then what closed it, and a Line can be traced to both",
      () =>
        withDaemon(
          (harness) =>
            Effect.gen(function* () {
              const { client, ircd } = harness;

              yield* inSession(harness);
              yield* ircd.read("ERROR :Closing Link\r\n");
              yield* ircd.hangUp;

              const [open] = yield* eventually(
                client.daemon.gaps({ query: { after: 0, limit: 10 } }),
                (gaps) => gaps.length === 1
              );

              assert.deepInclude(open, { network: "libera", reason: "Closing Link" });
              assert.notProperty(open, "ended");

              yield* eventually(ircd.dials, (dials) => dials.length === 2);
              yield* untilPhase(harness, "registering");
              yield* ircd.read(welcome);
              yield* untilPhase(harness, "session");

              const [closed] = yield* client.daemon.gaps({ query: { after: 0, limit: 10 } });
              const welcomes = lines(yield* client.daemon.entries(everything), "inbound");

              assert.deepInclude(closed, { reason: "Closing Link", sequence: open?.sequence ?? 0 });
              assert.deepStrictEqual(closed?.ended, {
                at: welcomes.at(-1)?.at ?? 0,
                sequence: welcomes.at(-1)?.sequence ?? 0,
              });
            }),
          reconnecting
        )
    );

    it.live("pages by cursor, and filters by Network", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            const { client, ircd } = harness;

            yield* inSession(harness);
            yield* ircd.hangUp;
            yield* eventually(ircd.dials, (dials) => dials.length === 2);
            yield* untilPhase(harness, "registering");
            yield* ircd.read(welcome);
            yield* untilPhase(harness, "session");
            yield* ircd.hangUp;

            const [first, second] = yield* eventually(
              client.daemon.gaps({ query: { after: 0, limit: 10 } }),
              (gaps) => gaps.length === 2
            );

            const page = yield* client.daemon.gaps({
              query: { after: first?.sequence ?? 0, limit: 1 },
            });

            assert.deepStrictEqual(page, second === undefined ? [] : [second]);
            assert.lengthOf(yield* client.daemon.gaps({ query: { after: 0, limit: 1 } }), 1);
            assert.lengthOf(
              yield* client.daemon.gaps({ query: { after: 0, limit: 10, network: "libera" } }),
              2
            );
            assert.lengthOf(
              yield* client.daemon.gaps({ query: { after: 0, limit: 10, network: "other" } }),
              0
            );
          }),
        reconnecting
      )
    );
  });

  describe("/entries, for what the host records", () => {
    it.live("CONN-4: an `attempt` names its nicks", () =>
      withDaemon(
        (harness) =>
          Effect.gen(function* () {
            yield* untilPhase(harness, "registering");

            const [attempt] = connections(yield* harness.client.daemon.entries(everything));

            assert.deepInclude(attempt, { phase: "attempt" });
            assert.deepStrictEqual(attempt?.phase === "attempt" ? attempt.nicks.slice(0, 3) : [], [
              "iirc",
              "other",
              "iirc_",
            ]);
          }),
        { alternates: ["other"] }
      )
    );

    it.live(
      "ADR 0003: an `attempt` gives everything its machine ran with, the whole Tuning too",
      () =>
        withDaemon(
          (harness) =>
            Effect.gen(function* () {
              yield* untilPhase(harness, "registering");

              const [attempt] = connections(yield* harness.client.daemon.entries(everything));

              assert.deepInclude(attempt, {
                phase: "attempt",
                realname: "I IRC",
                tuning: { ...defaultTuning, drainMillis: 1234 },
                username: "user",
              });
            }),
          { tuning: { drainMillis: 1234 } }
        )
    );
  });

  describe("stopping", () => {
    it.live("LIVE-9: says `QUIT`, records `closing` then `closed`, and then that it stopped", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* withDaemonIn(dataDir, inSession);

          assert.deepStrictEqual(yield* logTail(dataDir, 4), [
            "Connection closing",
            "QUIT going",
            "Connection closed",
            "Daemon stopped",
          ]);
        })
      )
    );

    it.live("RUN-3: with no Connection under way, only says that it stopped", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* withDaemonIn(
            dataDir,
            (harness) =>
              Effect.gen(function* () {
                yield* inSession(harness);
                yield* harness.ircd.hangUp;
                yield* untilPhase(harness, "closed");
              }),
            { tuning: { reconnectInitialMillis: 60_000 } }
          );

          assert.deepStrictEqual((yield* logTail(dataDir, 2))[1], "Daemon stopped");
        })
      )
    );

    it.live("LIVE-9: stops within its limit on a socket that has stopped taking writes", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const quitWaitMillis = 100;
          let stopping = 0;

          yield* withDaemonIn(
            dataDir,
            (harness) =>
              Effect.gen(function* () {
                yield* inSession(harness);
                yield* harness.ircd.setWrites("hang");
                stopping = Date.now();
              }),
            { tuning: { quitWaitMillis } }
          );

          assert.isAtMost(Date.now() - stopping, quitWaitMillis + 1000);

          // The `QUIT` was recorded and its write never finished, so it is Dropped too (LOG-2).
          assert.deepStrictEqual(yield* logTail(dataDir, 5), [
            "Connection closing",
            "QUIT going",
            "Dropped null",
            "Connection closed",
            "Daemon stopped",
          ]);
        })
      )
    );

    it.live("stops the Network before anything that serves a Frontend, and only once", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const ircd = yield* fakeIrcd();
          const seen: string[] = [];

          // Where `HttpRouter.serve` goes, so it closes where that closes.
          const frontend = Layer.effectDiscard(
            Effect.gen(function* () {
              const { status } = yield* Daemon;

              yield* Effect.addFinalizer(() =>
                status.pipe(
                  Effect.tap(({ networks }) =>
                    Effect.succeed(seen.push(...networks.map(({ phase }) => phase)))
                  )
                )
              );
            })
          );

          const scope = yield* Scope.make();

          const core = DaemonCore(
            configIn(dataDir),
            Layer.succeed(Transport, ircd.transport),
            noKeyring
          );

          const context = yield* Layer.buildWithScope(
            Daemon.stopsFirst.pipe(Layer.provide(frontend), Layer.provideMerge(core)),
            scope
          );

          const { addNetwork, status, stop } = Context.get(context, Daemon);

          yield* addNetwork(ownerKey, settingsFor());
          yield* eventually(status, ({ networks }) => networks[0]?.phase === "registering");
          yield* stop;
          yield* stop;
          yield* Scope.close(scope, Exit.void);

          assert.deepStrictEqual(seen, ["closed"]);
          assert.strictEqual((yield* logTail(dataDir, 1))[0], "Daemon stopped");
          assert.lengthOf(
            (yield* logTail(dataDir, 1000)).filter((entry) => entry === "Daemon stopped"),
            1
          );
        }).pipe(Effect.scoped)
      )
    );
  });

  describe("once stopped", () => {
    it.live("RUN-3: records no Change after its `stopped` Entry, and says it is stopping", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* keyFor(dataDir);

          const ircd = yield* fakeIrcd();
          const scope = yield* Scope.make();

          const context = yield* Layer.buildWithScope(
            DaemonCore(configIn(dataDir), Layer.succeed(Transport, ircd.transport), noKeyring),
            scope
          );

          const { addNetwork, stop } = Context.get(context, Daemon);

          yield* stop;

          assert.instanceOf(yield* Effect.flip(addNetwork(ownerKey, settingsFor())), Stopping);

          yield* Scope.close(scope, Exit.void);

          assert.deepStrictEqual(yield* logTail(dataDir, 1), ["Daemon stopped"]);
        }).pipe(Effect.scoped)
      )
    );
  });

  describe("reading through the reader", () => {
    for (const path of ["/api/entries", "/api/messages", "/api/gaps"]) {
      it.live(`API-3: a read past its budget is a 503 ReadTimedOut on ${path}`, () =>
        withFailingReader(new ReaderTimedOut({ budgetMillis: 1000 }), ({ raw }) =>
          Effect.gen(function* () {
            const response = yield* raw(path);

            assert.strictEqual(response.status, 503);
            assert.deepStrictEqual(yield* Effect.orDie(response.json), {
              _tag: "ReadTimedOut",
              budgetMillis: 1000,
            });
          })
        )
      );
    }

    for (const path of ["/api/entries", "/api/messages", "/api/gaps"]) {
      it.live(
        `LOG-11: a read that never left the reader's queue is a 503 ReaderBusy on ${path}`,
        () =>
          withFailingReader(new ReaderQueueFull({ waitedMillis: 1200 }), ({ raw }) =>
            Effect.gen(function* () {
              const response = yield* raw(path);

              assert.strictEqual(response.status, 503);
              assert.deepStrictEqual(yield* Effect.orDie(response.json), {
                _tag: "ReaderBusy",
                waitedMillis: 1200,
              });
            })
          )
      );
    }

    it.live("API-3: the typed client tells a read past its budget from one that failed", () =>
      Effect.gen(function* () {
        const timedOut = yield* withFailingReader(
          new ReaderTimedOut({ budgetMillis: 5 }),
          ({ client }) => Effect.flip(client.daemon.entries(everything))
        );

        const unavailable = yield* withFailingReader(
          new StorageFailed({ cause: "the Worker died" }),
          ({ client }) => Effect.flip(client.daemon.messages(everything))
        );

        assert.deepStrictEqual(timedOut, new ReadTimedOut({ budgetMillis: 5 }));
        assert.instanceOf(unavailable, LogUnavailable);
      })
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

    for (const path of ["/api/entries", "/api/messages", "/api/gaps"]) {
      it.live(`refuses anything out of bounds on ${path}, with a 400`, () =>
        withDaemon(({ raw }) =>
          Effect.forEach(
            refused,
            (query) =>
              Effect.gen(function* () {
                const { issues } = yield* invalidRequest(yield* raw(`${path}?${query}`));
                const [name = ""] = query.split("=");

                assert.deepStrictEqual(issues[0].path.slice(0, 2), ["query", name], query);
              }),
            { discard: true }
          )
        )
      );

      it.live(`API-3: refuses a Network named nothing on ${path}, with a 400`, () =>
        withDaemon(({ raw }) =>
          Effect.forEach(
            ["network=", "network=a&network=b"],
            (query) =>
              Effect.gen(function* () {
                const { issues } = yield* invalidRequest(yield* raw(`${path}?${query}`));

                assert.deepStrictEqual(issues[0].path.slice(0, 2), ["query", "network"], query);
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

  describe("kind filters", () => {
    it.live("API-3: refuses a kind that is not an Entry's tag, with a 400", () =>
      withDaemon(({ raw }) =>
        Effect.forEach(
          [
            "kind=",
            "kind=Bogus",
            "kind=line",
            "kind=Line,",
            "kind=Line,,Daemon",
            "kind=Line&kind=Nope",
          ],
          (query) =>
            Effect.gen(function* () {
              const { issues } = yield* invalidRequest(yield* raw(`/api/entries?${query}`));

              assert.deepStrictEqual(issues[0].path.slice(0, 2), ["query", "kind"], query);
            }),
          { discard: true }
        )
      )
    );

    it.live("accepts every kind there is", () =>
      withDaemon(({ raw }) =>
        Effect.map(
          raw("/api/entries?kind=Change,Connection,Daemon,Deadline,Dropped,Line"),
          ({ status }) => {
            assert.strictEqual(status, 200);
          }
        )
      )
    );
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

    it.live("CONF-1: will not start on a Change it cannot read, and says which", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* localKey(dataDir);
          yield* Recorder.use(({ record }) =>
            record(
              [{ _tag: "Change", by: ownerKey, change: { _tag: "NetworkRenamed" } }],
              constVoid
            )
          ).pipe(Effect.provide(Log.layer({ dataDir })), Effect.orDie);

          const failure = yield* Layer.build(DaemonCore(configIn(dataDir))).pipe(
            Effect.scoped,
            Effect.flip
          );

          assert.instanceOf(failure, UndecodableChange);
          assert.strictEqual(failure instanceof UndecodableChange ? failure.sequence : 0, 2);
          assert.include(failure.message, "The Change at sequence 2 cannot be read");
          assert.deepStrictEqual(
            yield* logTail(dataDir, 10),
            ["Change null", "Change null"],
            "it recorded no start"
          );
        })
      )
    );

    it.live("CONF-1: will not start on a Change that is not JSON, and says which", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          yield* localKey(dataDir);
          yield* appendRaw(dataDir, ["this is not JSON"]);

          const failure = yield* Layer.build(DaemonCore(configIn(dataDir))).pipe(
            Effect.scoped,
            Effect.flip
          );

          assert.instanceOf(failure, StorageFailed);
          assert.include(
            String(failure instanceof StorageFailed ? failure.cause : failure),
            "The Entry at sequence 2 cannot be read"
          );
        })
      )
    );

    it.live(
      "RUN-3: starts promptly on thousands of large Changes, reading them on the writer with no budget",
      () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const changes = 3000;

            const channels = Array.from({ length: 300 }, (_unused, index) => ({
              autojoin: true,
              name: `#channel-number-${index}`,
              rejoinOnKick: false,
            }));

            yield* localKey(dataDir);
            yield* appendRaw(
              dataDir,
              Array.from({ length: changes }, (_unused, index) =>
                JSON.stringify({
                  _tag: index === 0 ? "NetworkAdded" : "NetworkChanged",
                  settings: {
                    ...settingsFor({ channels }),
                    enabled: false,
                    quitReason: `change ${index}`,
                  },
                })
              )
            );

            // A reader that can read nothing in time, so startup cannot depend on it.
            const core = Daemon.layer(configIn(dataDir)).pipe(
              Layer.provide(
                Layer.merge(
                  LogReader.layer({ budget: Duration.millis(1), dataDir }),
                  credentialsIn(dataDir)
                ).pipe(Layer.provideMerge(Log.layer({ dataDir })))
              ),
              Layer.provide(Transport.layer)
            );

            const started = Date.now();

            const settings = yield* Effect.scoped(
              Effect.gen(function* () {
                const context = yield* Layer.build(core);

                return (yield* Context.get(context, Daemon).configuration).networks;
              })
            );

            const millis = Date.now() - started;

            assert.deepStrictEqual(
              settings.map(({ quitReason }) => quitReason),
              [`change ${changes - 1}`]
            );
            assert.lengthOf(settings[0]?.channels ?? [], 300);
            assert.isBelow(millis, 10_000, `took ${millis} ms`);
          })
        ),
      { timeout: 60_000 }
    );

    it.live("RUN-3: carries on the same Log after a restart, recording each start", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const before = yield* withDaemonIn(dataDir, restart);
          const after = yield* withDaemonIn(dataDir, restart);

          assert.deepStrictEqual(after.slice(0, before.length), before);
          assert.deepStrictEqual(
            after.flatMap((entry) => (entry._tag === "Daemon" ? [entry.phase] : [])),
            ["started", "stopped", "started"]
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
                yield* harness.client.daemon.send({
                  payload: { network, target: "#iirc", text: "hello" },
                });

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

  describe("the contract", () => {
    it("API-3: declares the typed 400 on every operation", () => {
      const { paths } = OpenApi.fromApi(DaemonApi);

      const methods = ["get", "post", "put", "patch", "delete"] as const;

      const operations = Object.entries(paths).flatMap(([path, item]) =>
        methods.flatMap((method) => {
          const operation = item[method];

          return operation === undefined
            ? []
            : [
                {
                  declares: JSON.stringify(operation.responses["400"] ?? null).includes(
                    "InvalidRequest"
                  ),
                  operation: `${method} ${path}`,
                },
              ];
        })
      );

      assert.isAtLeast(operations.length, 17);
      assert.deepStrictEqual(
        operations.filter(({ declares }) => !declares).map(({ operation }) => operation),
        []
      );
    });

    it("AUTH-2: declares the typed 401 and 403 on every operation but /health", () => {
      const { paths } = OpenApi.fromApi(DaemonApi);
      const methods = ["get", "post", "put", "patch", "delete"] as const;

      const undeclared = Object.entries(paths).flatMap(([path, item]) =>
        methods.flatMap((method) => {
          const responses = JSON.stringify(item[method]?.responses ?? null);

          return item[method] === undefined ||
            path === "/api/health" ||
            (responses.includes("Unauthorized") && responses.includes("Forbidden"))
            ? []
            : [`${method} ${path}`];
        })
      );

      assert.deepStrictEqual(undeclared, []);
      assert.notInclude(JSON.stringify(paths["/api/health"]), "Unauthorized");
    });
  });
});
