import { assert, describe, it } from "@effect/vitest";
import {
  ChannelNotFound,
  defaultServices,
  LaneFull,
  NetworkExists,
  NetworkNotFound,
  NotInSession,
} from "@iirc/api";
import type { LogEntry, NetworkSettings } from "@iirc/api";
import { eventually, scriptedIrcd } from "@iirc/session/testing";
import type { ScriptedIrcd, ScriptedIrcdOptions } from "@iirc/session/testing";
import { Effect, Fiber } from "effect";
import type { Schema } from "effect";

import {
  clientWith,
  coreFor,
  inTempDirectory,
  invalidRequest,
  localKey,
  ownerKey,
  rawWith,
  servingWith,
  statusOf,
  version,
} from "./daemon.fixture.ts";
import type { Client, RawRequests } from "./daemon.fixture.ts";

// Other software on this machine dials 127.0.0.1, and nothing dials this.
const ircdAddress = "127.79.0.1";

const nick = "iirc";
const quitReason = "back soon";

// Quick to reconnect and to leave, and quick to join after the burst, so that nothing
// here waits on the spec's numbers.
const brisk = {
  drainMillis: 50,
  quitWaitMillis: 100,
  reconnectInitialMillis: 50,
  reconnectMaxMillis: 50,
  rejoinSettleMillis: 0,
};

// Only a signal that never comes reaches it, so it is far above anything a busy machine takes.
const limit = "30 seconds";

// An Ircd that welcomes `nick`, ends the burst at once, and answers each `JOIN` and `PART`
// as Self, one Channel to a Line, the way an Ircd does, unless `respond` says otherwise. It
// hangs up on `QUIT` unless `ignoresQuit` says it does not.
const welcomingIrcd = (
  respond?: (line: string) => readonly string[] | undefined,
  { ignoresQuit }: Pick<ScriptedIrcdOptions, "ignoresQuit"> = {}
) =>
  scriptedIrcd(
    (line) => {
      const scripted = respond?.(line);

      if (scripted !== undefined) {
        return scripted;
      }

      const [command = "", channels = ""] = line.split(" ");

      if (command === "USER") {
        return [`:ircd 001 ${nick} :Welcome`, `:ircd 422 ${nick} :No MOTD`];
      }

      return command === "JOIN" || command === "PART"
        ? channels.split(",").map((channel) => `:${nick}!~u@host ${command} ${channel}`)
        : [];
    },
    { hostname: ircdAddress, ...(ignoresQuit !== undefined && { ignoresQuit }) }
  );

type Channels = NetworkSettings["channels"];

const channelsNamed = (...names: readonly string[]): Channels =>
  names.map((name) => ({ autojoin: true, name, rejoinOnKick: false }));

const settingsFor = (
  id: string,
  ircd: { readonly port: number },
  overrides: Partial<NetworkSettings> = {}
): NetworkSettings => ({
  channels: [],
  connectCommands: [],
  credentials: {},
  enabled: true,
  id,
  identity: { alternates: [], nick, realname: "iirc", username: "iirc" },
  ircds: [{ host: ircdAddress, port: ircd.port, tls: false }],
  name: id,
  quitReason,
  services: [],
  tuning: brisk,
  ...overrides,
});

interface Harness {
  readonly client: Client;
  readonly dataDir: string;
  readonly raw: RawRequests;
}

const withDaemonIn = <A, E, R>(
  dataDir: string,
  key: string,
  test: (harness: Harness) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const client = yield* clientWith(key);
    const raw = yield* rawWith(key);

    return yield* test({ client, dataDir, raw });
  }).pipe(Effect.provide(servingWith(coreFor({ dataDir, version }))), Effect.scoped);

// A Daemon on the real Transport, with an `admin` key named `owner`.
const withDaemon = <A, E, R>(test: (harness: Harness) => Effect.Effect<A, E, R>) =>
  inTempDirectory((dataDir) =>
    Effect.flatMap(localKey(dataDir), (key) => withDaemonIn(dataDir, key, test))
  );

const untilPhase = (client: Client, id: string, phase: string) =>
  eventually(statusOf(client, id), (status) => status.phase === phase, limit);

const untilJoined = (client: Client, id: string, channel: string) =>
  eventually(statusOf(client, id), ({ joined }) => joined.includes(channel), limit);

const untilReceived = (ircd: ScriptedIrcd, line: string) =>
  eventually(ircd.received, (lines) => lines.includes(line), limit);

const everything = { query: { after: 0, limit: 1000 } };

const outbound = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) =>
    entry._tag === "Line" && entry.direction === "outbound" ? [entry] : []
  );

const changes = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) => (entry._tag === "Change" ? [entry] : []));

const causeOf = (entries: readonly LogEntry[], text: string) =>
  outbound(entries).find((line) => line.text === text)?.cause;

// What a restart must give back exactly as it was.
const readBack = ({ client }: Harness) =>
  Effect.all({
    configuration: client.configuration.get(),
    keys: client.keys.list(),
    networks: Effect.map(client.networks.list(), (views) =>
      views.map(({ settings, status }) => ({ enabled: status.enabled, settings }))
    ),
  });

describe("Networks through the API", () => {
  it.live("CONF-3: adds a Network, which connects, joins, and shows its settings", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();
        const settings = settingsFor("libera", ircd, { channels: channelsNamed("#iirc") });

        const { change } = yield* client.networks.add({ payload: settings });

        yield* untilJoined(client, "libera", "#iirc");

        const view = yield* client.networks.get({ params: { id: "libera" } });
        const entries = yield* client.daemon.entries(everything);

        assert.deepStrictEqual(view.settings, settings);
        assert.deepInclude(view.status, { enabled: true, id: "libera", name: "libera" });
        assert.deepStrictEqual(yield* client.configuration.get(), { networks: [settings] });
        assert.deepInclude(changes(entries).at(-1), {
          by: ownerKey,
          network: "libera",
          sequence: change,
        });
        assert.include(yield* ircd.received, `NICK ${nick}`);
      })
    )
  );

  it.live("CONF-3: fills in what settings leave out, with the display name as the ID", () =>
    withDaemon(({ client, raw }) =>
      Effect.gen(function* () {
        const response = yield* raw.post("/api/networks", {
          enabled: false,
          id: "oftc",
          identity: { nick },
          ircds: [{ host: "irc.oftc.net" }],
        });

        assert.strictEqual(response.status, 200, yield* Effect.orDie(response.text));
        assert.deepStrictEqual((yield* client.configuration.get()).networks, [
          {
            channels: [],
            connectCommands: [],
            credentials: {},
            enabled: false,
            id: "oftc",
            identity: { alternates: [], nick, realname: "iirc", username: "iirc" },
            ircds: [{ host: "irc.oftc.net", port: 6697, tls: true }],
            name: "oftc",
            quitReason: "iirc",
            services: [...defaultServices],
            tuning: {},
          },
        ]);
      })
    )
  );

  it.live("API-3: refuses an ID taken, and an ID that is not there, typed", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const settings = settingsFor("libera", { port: 1 }, { enabled: false });

        yield* client.networks.add({ payload: settings });

        assert.deepStrictEqual(
          yield* Effect.flip(client.networks.add({ payload: settings })),
          new NetworkExists({ network: "libera" })
        );

        const missing = new NetworkNotFound({ network: "oftc" });
        const params = { params: { id: "oftc" } };

        assert.deepStrictEqual(yield* Effect.flip(client.networks.get(params)), missing);
        assert.deepStrictEqual(yield* Effect.flip(client.networks.remove(params)), missing);
        assert.deepStrictEqual(yield* Effect.flip(client.networks.connect(params)), missing);
        assert.deepStrictEqual(
          yield* Effect.flip(
            client.networks.change({ ...params, payload: { ...settings, id: "oftc" } })
          ),
          missing
        );
        assert.deepStrictEqual(
          yield* Effect.flip(
            client.daemon.send({ payload: { network: "oftc", target: "#a", text: "hi" } })
          ),
          missing
        );
      })
    )
  );

  it.live("API-3: refuses settings the Daemon will not run, saying where, and keeps nothing", () =>
    withDaemon(({ client, raw }) =>
      Effect.gen(function* () {
        const base = settingsFor("libera", { port: 1 });

        const refused = [
          [
            { ...base, tuning: { silenceMilis: 5000 } },
            ["payload", "tuning", "silenceMilis"],
            "excess",
          ],
          [
            { ...base, tuning: { silenceMillis: 1000 } },
            ["payload", "tuning", "silenceMillis"],
            "must be above lagCheckMillis, which is 60000",
          ],
          [
            { ...base, tuning: { reconnectMaxMillis: 1000 } },
            ["payload", "tuning", "reconnectMaxMillis"],
            "must not be below reconnectInitialMillis, which is 5000",
          ],
          [
            { ...base, tuning: { quitWaitMillis: 60_000 } },
            ["payload", "tuning", "quitWaitMillis"],
            "Expected a value between 1 and 10000",
          ],
          [{ ...base, tuning: "soon" }, ["payload", "tuning"], ""],
          [{ ...base, channels: [{ name: "bad name" }] }, ["payload", "channels", 0, "name"], ""],
          [
            { ...base, channels: [{ name: "#a" }, { name: "#A" }] },
            ["payload", "channels", 1, "name"],
            "same Channel",
          ],
          [{ ...base, identity: { nick: "9lives" } }, ["payload", "identity", "nick"], ""],
          [{ ...base, ircds: [] }, ["payload", "ircds"], ""],
          [
            { ...base, ircds: [{ host: "h", pin: "sha256/short" }] },
            ["payload", "ircds", 0, "pin"],
            "",
          ],
          [
            { ...base, ircds: [{ host: "h", pin: `sha256/${"A".repeat(43)}=`, tls: false }] },
            ["payload", "ircds", 0, "pin"],
            "a pin needs TLS",
          ],
          [{ ...base, id: "Libera Chat" }, ["payload", "id"], ""],
          // `JOIN 0` leaves every Channel, so no Channel can be `0`, or lack a prefix.
          [{ ...base, channels: [{ name: "0" }] }, ["payload", "channels", 0, "name"], "#, &"],
          [{ ...base, channels: [{ name: "foo" }] }, ["payload", "channels", 0, "name"], "#, &"],
          [{ ...base, identity: { nick: "#abc" } }, ["payload", "identity", "nick"], "not a nick"],
          [
            { ...base, identity: { alternates: ["-dash"], nick: "ok" } },
            ["payload", "identity", "alternates", 0],
            "not a nick",
          ],
          [
            { ...base, identity: { alternates: ["x".repeat(600)], nick: "ok" } },
            ["payload", "identity", "alternates", 0],
            "too long",
          ],
          [
            { ...base, identity: { nick: "ok", realname: "x".repeat(600) } },
            ["payload", "identity", "realname"],
            "`USER`",
          ],
          [
            { ...base, identity: { nick: "ok", username: "two words" } },
            ["payload", "identity", "username"],
            "one word",
          ],
          [{ ...base, quitReason: "x".repeat(600) }, ["payload", "quitReason"], "`QUIT`"],
          [
            { ...base, ircds: [{ host: "irc\u0000.example" }] },
            ["payload", "ircds", 0, "host"],
            "control character",
          ],
          [
            { ...base, ircds: [{ host: "irc\u0007.example" }] },
            ["payload", "ircds", 0, "host"],
            "control character",
          ],
          // A misspelt key is refused with its path, never dropped, so TLS stays as asked.
          [{ ...base, ircds: [{ host: "h", tsl: false }] }, ["payload", "ircds", 0, "tsl"], ""],
          [{ ...base, quitreason: "bye" }, ["payload", "quitreason"], ""],
        ] as const;

        for (const [body, path, message] of refused) {
          const { issues } = yield* invalidRequest(yield* raw.post("/api/networks", body));
          const where = JSON.stringify(path);

          const issue = issues.find(
            (each) => JSON.stringify(each.path.slice(0, path.length)) === where
          );

          assert.isDefined(issue, `${where} in ${JSON.stringify(issues)}`);
          assert.include(issue?.message, message);
        }

        assert.deepStrictEqual(yield* client.networks.list(), []);
      })
    )
  );

  it.live("API-3, CONF-6: holds a change and a replacement to the same rules, saying where", () =>
    withDaemon(({ client, raw }) =>
      Effect.gen(function* () {
        const base = settingsFor("libera", { port: 1 }, { enabled: false });

        yield* client.networks.add({ payload: base });

        const before = yield* client.configuration.get();

        const changedIssues = (settings: { readonly [key: string]: Schema.Json }) =>
          Effect.map(
            Effect.flatMap(
              raw.put("/api/networks/libera", { ...base, ...settings }),
              invalidRequest
            ),
            ({ issues }) => issues
          );

        const replaced = yield* invalidRequest(
          yield* raw.put("/api/configuration", {
            networks: [base, { ...base, id: "oftc", tuning: { floodBurst: 0 } }, base],
          })
        );

        assert.deepStrictEqual(
          yield* changedIssues({ channels: [{ name: "#a" }, { name: "#A" }] }),
          [{ message: "is the same Channel as another", path: ["payload", "channels", 1, "name"] }]
        );
        assert.deepStrictEqual(yield* changedIssues({ tuning: { lagCheckMillis: 90_000 } }), [
          {
            message: "must be below silenceMillis, which is 90000",
            path: ["payload", "tuning", "lagCheckMillis"],
          },
        ]);
        assert.deepStrictEqual(
          replaced.issues.map(({ path }) => path),
          [["payload", "networks", 1, "tuning", "floodBurst"]]
        );
        assert.deepStrictEqual(
          (yield* invalidRequest(yield* raw.put("/api/configuration", { networks: [base, base] })))
            .issues,
          [{ message: "is another Network's ID", path: ["payload", "networks", 1, "id"] }]
        );
        assert.deepStrictEqual(yield* client.configuration.get(), before);
      })
    )
  );

  it.live("CONF-2: a change applies its Channels at once: joins the new, parts the gone", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();
        const settings = settingsFor("libera", ircd, { channels: channelsNamed("#old") });

        yield* client.networks.add({ payload: settings });
        yield* untilJoined(client, "libera", "#old");

        yield* client.networks.change({
          params: { id: "libera" },
          payload: { ...settings, channels: channelsNamed("#new") },
        });

        yield* untilReceived(ircd, "PART #old");
        yield* untilJoined(client, "libera", "#new");

        const status = yield* statusOf(client, "libera");
        const entries = yield* client.daemon.entries(everything);

        assert.deepStrictEqual(status.joined, ["#new"]);
        assert.strictEqual(yield* ircd.accepted, 1, "Channels never cost a reconnect");
        assert.strictEqual(causeOf(entries, "PART #old"), `key:${ownerKey}`);
      })
    )
  );

  it.live("API-3: refuses a change whose body names another Network", () =>
    withDaemon(({ client, raw }) =>
      Effect.gen(function* () {
        const settings = settingsFor("libera", { port: 1 }, { enabled: false });

        yield* client.networks.add({ payload: settings });

        const { issues } = yield* invalidRequest(
          yield* raw.put("/api/networks/libera", { ...settings, id: "oftc" })
        );

        assert.deepStrictEqual(issues[0].path, ["payload", "id"]);
        assert.deepStrictEqual((yield* client.configuration.get()).networks, [settings]);
      })
    )
  );

  it.live("LIVE-9: disconnect says `QUIT` and stays off, and connect comes back at once", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();
        const params = { params: { id: "libera" } };

        yield* client.networks.add({ payload: settingsFor("libera", ircd) });
        yield* untilPhase(client, "libera", "session");
        yield* client.networks.disconnect(params);
        yield* untilReceived(ircd, `QUIT :${quitReason}`);

        const off = yield* untilPhase(client, "libera", "closed");

        assert.deepInclude(off, { enabled: false, nextAttemptAt: null });

        yield* Effect.sleep(300);

        assert.strictEqual(yield* ircd.accepted, 1, "a disconnected Network dialled again");
        assert.deepInclude((yield* client.configuration.get()).networks[0], { enabled: false });

        yield* client.networks.connect(params);

        const on = yield* untilPhase(client, "libera", "session");

        assert.isTrue(on.enabled);
        assert.strictEqual(yield* ircd.accepted, 2);
      })
    )
  );

  it.live("LIVE-9: removing a Network says `QUIT`, and it is gone from everything", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();

        yield* client.networks.add({ payload: settingsFor("libera", ircd) });
        yield* untilPhase(client, "libera", "session");
        yield* client.networks.remove({ params: { id: "libera" } });

        assert.include(yield* ircd.received, `QUIT :${quitReason}`);
        assert.deepStrictEqual((yield* client.daemon.status()).networks, []);
        assert.deepStrictEqual(yield* client.networks.list(), []);
        assert.deepStrictEqual(yield* client.configuration.get(), { networks: [] });

        yield* Effect.sleep(300);

        assert.strictEqual(yield* ircd.accepted, 1, "a removed Network dialled again");
      })
    )
  );

  it.live("LIVE-9: removing a Network holds up no other Change while it says `QUIT`", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd(undefined, { ignoresQuit: true });
        const params = { params: { id: "libera" } };
        // An Ircd that never hangs up keeps the host in its `QUIT` wait for as long as the
        // test likes, and the wait is as long as the Tuning allows, ten seconds.
        const lingering = { ...brisk, drainMillis: 10_000, quitWaitMillis: 10_000 };

        yield* client.networks.add({ payload: settingsFor("libera", ircd, { tuning: lingering }) });
        yield* untilPhase(client, "libera", "session");

        const removing = yield* Effect.forkChild(client.networks.remove(params));

        // The `QUIT` is on the wire, so the removal is in its wait.
        yield* untilReceived(ircd, `QUIT :${quitReason}`);

        yield* client.keys.create({ payload: { name: "meanwhile", scope: "read" } });

        assert.isUndefined(
          removing.pollUnsafe(),
          "the removal answered before its host had gone, or another Change waited for it"
        );

        yield* ircd.finish;
        yield* Fiber.join(removing);

        assert.include(yield* ircd.received, `QUIT :${quitReason}`);
      })
    )
  );

  it.live("LIVE-9: a Network added again while its old host leaves waits for it to go", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd(undefined, { ignoresQuit: true });
        const params = { params: { id: "libera" } };
        const lingering = { ...brisk, drainMillis: 500, quitWaitMillis: 500 };
        const settings = settingsFor("libera", ircd, { tuning: lingering });

        yield* client.networks.add({ payload: settings });
        yield* untilPhase(client, "libera", "session");

        const removing = yield* Effect.forkChild(client.networks.remove(params));

        // The `QUIT` is on the wire, so the old host is leaving.
        yield* untilReceived(ircd, `QUIT :${quitReason}`);
        yield* client.networks.add({ payload: settings });

        assert.isDefined(yield* Fiber.join(removing));

        // The fake Ircd counts a close when its own socket hears of it, which can come a
        // moment after the Daemon has let go of it.
        yield* eventually(ircd.closed, (closed) => closed === 1, limit);

        yield* untilPhase(client, "libera", "session");

        assert.strictEqual(yield* ircd.accepted, 2);
      })
    )
  );

  it.live("stays on two Networks at once, each with its own status and Sends", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const libera = yield* welcomingIrcd();

        const oftc = yield* welcomingIrcd((line) =>
          line.startsWith("USER ") ? ["ERROR :Banned here"] : undefined
        );

        // Added out of order, because status is ordered by ID.
        yield* client.networks.add({
          payload: settingsFor("oftc", oftc, {
            tuning: { ...brisk, reconnectInitialMillis: 60_000, reconnectMaxMillis: 60_000 },
          }),
        });
        yield* client.networks.add({ payload: settingsFor("libera", libera) });
        yield* untilPhase(client, "libera", "session");
        yield* eventually(
          statusOf(client, "oftc"),
          ({ closeReason }) => closeReason === "Banned here",
          limit
        );

        const sent = yield* client.daemon.send({
          payload: { network: "libera", target: "#iirc", text: "only here" },
        });

        const refused = yield* Effect.flip(
          client.daemon.send({ payload: { network: "oftc", target: "#iirc", text: "not here" } })
        );

        const { networks } = yield* client.daemon.status();

        assert.strictEqual(sent.status, "written");
        assert.instanceOf(refused, NotInSession);
        assert.deepStrictEqual(
          networks.map(({ closeReason, id, phase }) => ({ closeReason, id, phase })),
          [
            { closeReason: null, id: "libera", phase: "session" },
            { closeReason: "Banned here", id: "oftc", phase: "closed" },
          ]
        );
        assert.include(yield* libera.received, "PRIVMSG #iirc :only here");
        assert.notInclude((yield* oftc.received).join("\n"), "PRIVMSG");
      })
    )
  );

  it.live("CONF-2: a change to the Ircds retries at once, even during a long backoff", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const banning = yield* welcomingIrcd((line) =>
          line.startsWith("USER ") ? ["ERROR :You are banned"] : undefined
        );

        const welcoming = yield* welcomingIrcd();
        const tuning = { ...brisk, reconnectInitialMillis: 600_000, reconnectMaxMillis: 600_000 };
        const settings = settingsFor("libera", banning, { tuning });

        yield* client.networks.add({ payload: settings });

        const waiting = yield* eventually(
          statusOf(client, "libera"),
          ({ closeReason, nextAttemptAt }) =>
            closeReason === "You are banned" && nextAttemptAt !== null,
          limit
        );

        assert.isAbove(waiting.nextAttemptAt ?? 0, Date.now() + 60_000);

        yield* client.networks.change({
          params: { id: "libera" },
          payload: {
            ...settings,
            ircds: [{ host: ircdAddress, port: welcoming.port, tls: false }],
          },
        });

        yield* untilPhase(client, "libera", "session");

        assert.strictEqual(yield* welcoming.accepted, 1);
        assert.strictEqual(yield* banning.accepted, 1);
      })
    )
  );

  it.live("CONF-6: replacing Configuration adds, removes, and parts what it dropped", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const kept = yield* welcomingIrcd();
        const gone = yield* welcomingIrcd();
        const fresh = yield* welcomingIrcd();
        const keptSettings = settingsFor("kept", kept, { channels: channelsNamed("#stay", "#go") });

        yield* client.networks.add({ payload: keptSettings });
        yield* client.networks.add({ payload: settingsFor("gone", gone) });
        yield* untilJoined(client, "kept", "#go");
        yield* untilJoined(client, "kept", "#stay");
        yield* untilPhase(client, "gone", "session");

        const replaced = {
          // In ID order, which is how Configuration reads back.
          networks: [
            settingsFor("fresh", fresh),
            { ...keptSettings, channels: channelsNamed("#stay") },
          ],
        };

        const { change } = yield* client.configuration.replace({ payload: replaced });

        yield* untilReceived(kept, "PART #go");
        yield* untilPhase(client, "fresh", "session");

        const entries = yield* client.daemon.entries(everything);

        assert.include(yield* gone.received, `QUIT :${quitReason}`);
        assert.deepStrictEqual(yield* client.configuration.get(), replaced);
        assert.deepStrictEqual(
          (yield* client.daemon.status()).networks.map(({ id }) => id),
          ["fresh", "kept"]
        );
        assert.deepStrictEqual((yield* statusOf(client, "kept")).joined, ["#stay"]);
        assert.strictEqual(yield* kept.accepted, 1, "an unchanged Network is not reconnected");
        assert.deepInclude(
          changes(entries).find(({ sequence }) => sequence === change),
          {
            by: ownerKey,
          }
        );
        assert.notProperty(
          changes(entries).find(({ sequence }) => sequence === change),
          "network"
        );
      })
    )
  );

  it.live("RUN-3: a restart rebuilds the same Configuration and keys from the Log", () =>
    inTempDirectory((dataDir) =>
      Effect.gen(function* () {
        const key = yield* localKey(dataDir);
        const ircd = yield* welcomingIrcd();

        const before = yield* withDaemonIn(dataDir, key, (harness) =>
          Effect.gen(function* () {
            const { client } = harness;

            yield* client.networks.add({
              payload: settingsFor("libera", ircd, { channels: channelsNamed("#a") }),
            });
            yield* client.networks.add({ payload: settingsFor("oftc", ircd, { enabled: false }) });
            yield* client.networks.join({
              params: { id: "libera" },
              payload: { channel: "#b", remember: true },
            });
            yield* client.networks.part({ params: { id: "libera" }, payload: { channel: "#a" } });
            yield* client.keys.create({ payload: { name: "phone", scope: "chat" } });
            yield* client.keys.create({ payload: { name: "old", scope: "read" } });
            yield* client.keys.revoke({ params: { name: "old" } });

            return yield* readBack(harness);
          })
        );

        const after = yield* withDaemonIn(dataDir, key, readBack);

        assert.deepStrictEqual(after, before);
        assert.deepStrictEqual(
          before.configuration.networks.map(({ channels }) => channels.map(({ name }) => name)),
          [["#b"], []]
        );
        assert.deepStrictEqual(
          before.keys.map(({ name }) => name),
          [ownerKey, "phone"]
        );
      })
    )
  );
});

describe("Join and Part (CONF-5)", () => {
  it.live("a remembered Join with no Session records it, and the next Session joins", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();
        const params = { params: { id: "libera" } };

        yield* client.networks.add({ payload: settingsFor("libera", ircd, { enabled: false }) });

        const joined = yield* client.networks.join({
          ...params,
          payload: { channel: "#later", remember: true },
        });

        const [network] = (yield* client.configuration.get()).networks;

        assert.property(joined, "change");
        assert.notProperty(joined, "line");
        assert.deepStrictEqual(network?.channels, channelsNamed("#later"));

        yield* client.networks.connect(params);
        yield* untilJoined(client, "libera", "#later");

        const entries = yield* client.daemon.entries(everything);

        // The reconciler sends it, so that nothing else can send it twice.
        assert.strictEqual(causeOf(entries, "JOIN #later"), "rejoin");
        assert.lengthOf(
          (yield* ircd.received).filter((line) => line === "JOIN #later"),
          1
        );
      })
    )
  );

  it.live("a remembered Join during a Session joins at once, without a second `JOIN`", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();

        yield* client.networks.add({ payload: settingsFor("libera", ircd) });
        yield* untilPhase(client, "libera", "session");
        yield* client.networks.join({
          params: { id: "libera" },
          payload: { channel: "#now", remember: true },
        });
        yield* untilJoined(client, "libera", "#now");
        yield* Effect.sleep(200);

        assert.lengthOf(
          (yield* ircd.received).filter((line) => line.startsWith("JOIN")),
          1
        );
      })
    )
  );

  it.live("API-10: a Join not remembered sends `JOIN` now, and needs a Session for it", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();
        const params = { params: { id: "libera" } };
        const once = { ...params, payload: { channel: "#once", remember: false } };

        yield* client.networks.add({ payload: settingsFor("libera", ircd, { enabled: false }) });

        assert.deepStrictEqual(
          yield* Effect.flip(client.networks.join(once)),
          new NotInSession({ phase: "closed" })
        );

        yield* client.networks.connect(params);
        yield* untilPhase(client, "libera", "session");

        const joined = yield* client.networks.join(once);

        yield* untilJoined(client, "libera", "#once");

        const entries = yield* client.daemon.entries(everything);

        assert.deepStrictEqual(joined, {
          line: {
            sequence: outbound(entries).find(({ text }) => text === "JOIN #once")?.sequence ?? 0,
            status: "written",
          },
        });
        assert.strictEqual(causeOf(entries, "JOIN #once"), `key:${ownerKey}`);
        assert.deepStrictEqual((yield* client.configuration.get()).networks[0]?.channels, []);
      })
    )
  );

  it.live("LIVE-8: a Join after a kick clears it, even with no Session", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();
        const params = { params: { id: "libera" } };

        yield* client.networks.add({
          payload: settingsFor("libera", ircd, { channels: channelsNamed("#kicked") }),
        });
        yield* untilJoined(client, "libera", "#kicked");
        yield* ircd.push(`:op!u@h KICK #kicked ${nick} :out`);
        yield* eventually(statusOf(client, "libera"), ({ kicked }) => kicked.length === 1, limit);
        yield* client.networks.disconnect(params);
        yield* untilPhase(client, "libera", "closed");

        assert.lengthOf(
          (yield* statusOf(client, "libera")).kicked,
          1,
          "a kick outlasts its Session"
        );

        yield* client.networks.join({ ...params, payload: { channel: "#kicked", remember: true } });

        assert.deepStrictEqual((yield* statusOf(client, "libera")).kicked, []);

        yield* client.networks.connect(params);
        yield* untilJoined(client, "libera", "#kicked");

        assert.lengthOf(
          (yield* ircd.receivedOn(1)).filter((line) => line === "JOIN #kicked"),
          1
        );
      })
    )
  );

  it.live("Part sends `PART` with its reason, and takes the Channel out of Configuration", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();

        yield* client.networks.add({
          payload: settingsFor("libera", ircd, { channels: channelsNamed("#leaving", "#staying") }),
        });
        yield* untilJoined(client, "libera", "#leaving");

        const parted = yield* client.networks.part({
          params: { id: "libera" },
          payload: { channel: "#LEAVING", reason: "good night" },
        });

        yield* eventually(
          statusOf(client, "libera"),
          ({ joined }) => !joined.includes("#leaving"),
          limit
        );

        const entries = yield* client.daemon.entries(everything);
        const part = outbound(entries).find(({ text }) => text === "PART #LEAVING :good night");

        assert.deepStrictEqual(parted, {
          change: changes(entries).at(-1)?.sequence ?? 0,
          line: { sequence: part?.sequence ?? 0, status: "written" },
        });
        assert.strictEqual(part?.cause, `key:${ownerKey}`);
        assert.deepStrictEqual(
          (yield* client.configuration.get()).networks[0]?.channels,
          channelsNamed("#staying")
        );
      })
    )
  );

  it.live("Part with no Session only changes Configuration, and one of nothing is refused", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const params = { params: { id: "libera" } };

        yield* client.networks.add({
          payload: settingsFor(
            "libera",
            { port: 1 },
            { channels: channelsNamed("#a"), enabled: false }
          ),
        });

        const parted = yield* client.networks.part({ ...params, payload: { channel: "#a" } });

        assert.property(parted, "change");
        assert.notProperty(parted, "line");
        assert.deepStrictEqual(
          yield* Effect.flip(client.networks.part({ ...params, payload: { channel: "#a" } })),
          new ChannelNotFound({ channel: "#a", network: "libera" })
        );
      })
    )
  );

  it.live("Part leaves a Channel Self is in but never configured, changing nothing else", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();

        yield* client.networks.add({ payload: settingsFor("libera", ircd) });
        yield* untilPhase(client, "libera", "session");
        yield* ircd.push(`:${nick}!~u@host JOIN #forced`);
        yield* untilJoined(client, "libera", "#forced");

        const parted = yield* client.networks.part({
          params: { id: "libera" },
          payload: { channel: "#forced" },
        });

        yield* untilReceived(ircd, "PART #forced");

        assert.notProperty(parted, "change");
        assert.strictEqual(parted.line?.status, "written");
      })
    )
  );

  it.live("LIVE-7: refuses to join `0` or a name with no Channel prefix, and records nothing", () =>
    withDaemon(({ client, raw }) =>
      Effect.gen(function* () {
        yield* client.networks.add({
          payload: settingsFor("libera", { port: 1 }, { enabled: false }),
        });

        for (const channel of ["0", "foo"]) {
          for (const remember of [true, false]) {
            const { issues } = yield* invalidRequest(
              yield* raw.post("/api/networks/libera/join", { channel, remember })
            );

            assert.deepStrictEqual(
              issues.map(({ path }) => path),
              [["payload", "channel"]]
            );
          }
        }

        assert.lengthOf(changes(yield* client.daemon.entries(everything)), 2);
      })
    )
  );

  it.live(
    "LOG-5: a Join not remembered sends nothing while Self is in the Channel, and says so",
    () =>
      withDaemon(({ client }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();

          yield* client.networks.add({
            payload: settingsFor("libera", ircd, { channels: channelsNamed("#Here") }),
          });
          yield* untilJoined(client, "libera", "#Here");

          const joined = yield* client.networks.join({
            params: { id: "libera" },
            payload: { channel: "#here", remember: false },
          });

          yield* Effect.sleep(200);

          assert.deepStrictEqual(joined, { line: { reason: "AlreadyJoined", status: "skipped" } });
          assert.deepStrictEqual(
            (yield* ircd.received).filter((line) => line.startsWith("JOIN")),
            ["JOIN #Here"]
          );
        })
      )
  );

  it.live(
    "API-9: a Part whose `PART` fails answers with its Change, and the failure beside it",
    () =>
      withDaemon(({ client }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();
          const params = { params: { id: "libera" } };

          // The `JOIN` spends the only token, so each Line after it waits, one at most.
          yield* client.networks.add({
            payload: settingsFor("libera", ircd, {
              channels: channelsNamed("#full"),
              tuning: {
                ...brisk,
                floodBurst: 1,
                floodIntervalMillis: 600_000,
                laneLimit: 1,
                sendWaitMillis: 1,
              },
            }),
          });
          yield* untilJoined(client, "libera", "#full");

          const send = client.daemon.send({
            payload: { network: "libera", target: "#full", text: "waiting" },
          });

          yield* send;
          assert.deepStrictEqual(yield* Effect.flip(send), new LaneFull({ lane: "interactive" }));

          const parted = yield* client.networks.part({ ...params, payload: { channel: "#full" } });
          const entries = yield* client.daemon.entries(everything);

          assert.deepStrictEqual(parted, {
            change: changes(entries).at(-1)?.sequence ?? 0,
            line: { error: new LaneFull({ lane: "interactive" }), status: "failed" },
          });
          assert.deepInclude(changes(entries).at(-1)?.change, { _tag: "ChannelParted" });
          assert.deepStrictEqual((yield* client.configuration.get()).networks[0]?.channels, []);
        })
      )
  );

  it.live("LOG-5: everything a key asks for carries its name as the cause", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const ircd = yield* welcomingIrcd();
        const { key } = yield* client.keys.create({ payload: { name: "phone", scope: "chat" } });
        const phone = yield* clientWith(key);
        const params = { params: { id: "libera" } };

        yield* client.networks.add({ payload: settingsFor("libera", ircd) });
        yield* untilPhase(client, "libera", "session");
        yield* phone.daemon.send({ payload: { network: "libera", target: "#a", text: "hello" } });
        yield* phone.networks.join({ ...params, payload: { channel: "#b", remember: false } });
        yield* untilJoined(client, "libera", "#b");
        yield* phone.networks.part({ ...params, payload: { channel: "#b" } });
        yield* phone.networks.join({ ...params, payload: { channel: "#c", remember: true } });
        yield* untilReceived(ircd, "PART #b");

        const entries = yield* client.daemon.entries(everything);

        assert.deepStrictEqual(
          ["PRIVMSG #a hello", "JOIN #b", "PART #b"].map((text) => causeOf(entries, text)),
          ["key:phone", "key:phone", "key:phone"]
        );
        assert.deepInclude(changes(entries).at(-1), { by: "phone", network: "libera" });
      })
    )
  );
});
