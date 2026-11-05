import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { EntryAlreadyRedacted, EntryNotFound, EntryNotRedactable, Forbidden } from "@iirc/api";
import type { LogEntry, NetworkSettings } from "@iirc/api";
import { eventually, scriptedIrcd } from "@iirc/session/testing";
import type { ScriptedIrcd } from "@iirc/session/testing";
import { Transport } from "@iirc/session/transport";
import { Effect, Redacted } from "effect";

import { channelKeyName } from "./channel-keys.ts";
import {
  clientWith,
  inTempDirectory,
  invalidRequest,
  localKey,
  noKeyring,
  ownerKey,
  rawWith,
  servingWith,
  statusOf,
  version,
} from "./daemon.fixture.ts";
import type { Client, RawRequests } from "./daemon.fixture.ts";
import { DaemonCore } from "./daemon.ts";

// CRED-1 to CRED-4, CONN-2, CONN-6, LOG-6, and LOG-7 through the API, against an Ircd
// scripted here: Credentials reach the hosts by name, and their values reach the wire and
// never the Log.

// Other software on this machine dials 127.0.0.1, and nothing dials this.
const ircdAddress = "127.79.0.2";

const nick = "iirc";
const id = "libera";

// Only a signal that never comes reaches it, so it is far above anything a busy machine takes.
const limit = "30 seconds";

const serverPassword = "server-password-value";
const servicePassword = "service-password-value";
const commandSecret = "connect-command-value";

const brisk = {
  drainMillis: 50,
  loginWaitMillis: 200,
  quitWaitMillis: 100,
  reconnectInitialMillis: 50,
  reconnectMaxMillis: 50,
  rejoinSettleMillis: 0,
};

// Welcomes `nick`, ends the burst at once, and answers each `JOIN` as Self, one Channel to
// a Line and without the key, the way an Ircd does.
const welcomingIrcd = () =>
  scriptedIrcd(
    (line) => {
      const [command = "", channels = ""] = line.split(" ");

      if (command === "USER") {
        return [`:ircd 001 ${nick} :Welcome`, `:ircd 422 ${nick} :No MOTD`];
      }

      return command === "JOIN"
        ? channels.split(",").map((channel) => `:${nick}!~u@host JOIN ${channel}`)
        : [];
    },
    { hostname: ircdAddress }
  );

const settingsFor = (
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
  quitReason: "bye",
  services: ["NickServ"],
  tuning: brisk,
  ...overrides,
});

interface Harness {
  readonly client: Client;
  readonly dataDir: string;
  readonly raw: RawRequests;
}

// The first key comes before the Daemon holds the data directory (AUTH-4).
const withDaemon = <A, E, R>(test: (harness: Harness) => Effect.Effect<A, E, R>) =>
  inTempDirectory((dataDir) =>
    Effect.flatMap(localKey(dataDir), (key) =>
      Effect.gen(function* () {
        const client = yield* clientWith(key);
        const raw = yield* rawWith(key);

        return yield* test({ client, dataDir, raw });
      }).pipe(
        Effect.provide(servingWith(DaemonCore({ dataDir, version }, Transport.layer, noKeyring))),
        Effect.scoped
      )
    )
  );

const setCredential = (client: Client, name: string, value: string) =>
  client.credentials.set({ params: { name }, payload: { value: Redacted.make(value) } });

const everything = { query: { after: 0, limit: 1000 } };

const outbound = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) =>
    entry._tag === "Line" && entry.direction === "outbound" ? [entry] : []
  );

const changes = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) => (entry._tag === "Change" ? [entry] : []));

const untilReceived = (ircd: ScriptedIrcd, line: string) =>
  eventually(ircd.received, (lines) => lines.includes(line), limit);

const untilJoined = (client: Client, channel: string) =>
  eventually(
    statusOf(client, id),
    ({ joined, phase }) => phase === "session" && joined.includes(channel),
    limit
  );

const occurrences = (text: string, part: string) => text.split(part).length - 1;

// Every byte the Log's files hold, the WAL's too, which is where a fresh commit sits.
const logBytes = (dataDir: string) =>
  ["iirc.sqlite", "iirc.sqlite-wal"]
    .map((file) => {
      try {
        return readFileSync(`${dataDir}/${file}`).toString("latin1");
      } catch {
        return "";
      }
    })
    .join("");

describe("Credentials reach the hosts (CRED-1)", () => {
  it.live(
    "CRED-1, CONN-2: a missing Credential holds every attempt back and is in status, and setting it dials at once with `PASS`",
    () =>
      withDaemon(({ client, dataDir }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();

          yield* client.networks.add({
            payload: settingsFor(ircd, { credentials: { password: "libera.pass" } }),
          });

          const waiting = yield* eventually(
            statusOf(client, id),
            ({ missingCredentials }) => missingCredentials.length > 0,
            limit
          );

          yield* Effect.sleep("200 millis");

          assert.deepStrictEqual(waiting.missingCredentials, ["libera.pass"]);
          assert.isNull(waiting.nextAttemptAt);
          assert.strictEqual(yield* ircd.accepted, 0);

          const { change } = yield* setCredential(client, "libera.pass", serverPassword);

          yield* untilReceived(ircd, `PASS ${serverPassword}`);
          yield* eventually(statusOf(client, id), ({ phase }) => phase === "session", limit);

          // An Ircd that says the value back is recorded as it said it: nothing searches for
          // a Credential, and LOG-7 is for the day one gets through (LOG-6).
          yield* ircd.push(`:ircd NOTICE ${nick} :your password was ${serverPassword}`);

          const entries = yield* eventually(
            client.daemon.entries(everything),
            (all) => all.some((entry) => entry._tag === "Line" && entry.text.includes("NOTICE")),
            limit
          );

          const pass = outbound(entries).find(({ text }) => text.startsWith("PASS"));
          const attempt = entries.find((entry) => entry._tag === "Connection");

          const echo = entries.find(
            (entry) => entry._tag === "Line" && entry.text.includes("NOTICE")
          );

          assert.strictEqual(pass?.text, "PASS <redacted>");
          assert.deepStrictEqual(pass?.redacted, ["libera.pass"]);
          assert.isAbove(attempt?.sequence ?? 0, change);
          assert.isUndefined(echo?._tag === "Line" ? echo.redacted : "not a Line");
          assert.include(
            echo?._tag === "Line" ? echo.text : "",
            `your password was ${serverPassword}`
          );
          assert.deepStrictEqual((yield* statusOf(client, id)).missingCredentials, []);

          const bytes = logBytes(dataDir);

          assert.strictEqual(
            occurrences(bytes, serverPassword),
            occurrences(bytes, `your password was ${serverPassword}`)
          );
        })
      )
  );

  it.live(
    "CONN-6, LOG-6: `IDENTIFY` and a connect command go after the burst and before joining, each recorded redacted",
    () =>
      withDaemon(({ client }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();

          yield* setCredential(client, "libera.nickserv", servicePassword);
          yield* setCredential(client, "libera.q", commandSecret);

          yield* client.networks.add({
            payload: settingsFor(ircd, {
              channels: [{ autojoin: true, name: "#iirc", rejoinOnKick: false }],
              connectCommands: ["PRIVMSG Q :AUTH iirc {{libera.q}}"],
              credentials: {
                service: { account: "iirc", nick: "NickServ", password: "libera.nickserv" },
              },
            }),
          });

          yield* untilJoined(client, "#iirc");

          const received = yield* ircd.received;
          const identify = received.indexOf(`PRIVMSG NickServ :IDENTIFY iirc ${servicePassword}`);
          const command = received.indexOf(`PRIVMSG Q :AUTH iirc ${commandSecret}`);
          const join = received.indexOf("JOIN #iirc");

          assert.isAtLeast(identify, 0, received.join(" | "));
          assert.isAbove(command, identify);
          assert.isAbove(join, command);

          const entries = yield* client.daemon.entries(everything);
          const sent = outbound(entries);

          assert.deepInclude(
            sent.find(({ cause }) => cause === "identify"),
            { redacted: ["libera.nickserv"], text: "PRIVMSG NickServ :IDENTIFY iirc <redacted>" }
          );
          assert.deepInclude(
            sent.find(({ cause }) => cause === "connect-command"),
            { redacted: ["libera.q"], text: "PRIVMSG Q :AUTH iirc <redacted>" }
          );
          assert.isTrue(
            entries.some((entry) => entry._tag === "Deadline" && entry.name === "login"),
            "no login Deadline"
          );

          const { login } = yield* statusOf(client, id);

          assert.strictEqual(login.state, "timedOut");
        })
      )
  );
});

describe("Channel keys (CONF-5, CRED-4)", () => {
  it.live(
    "CONF-5, CRED-4: a remembered Join with a key stores it first, then names it, and the reconciler joins with it",
    () =>
      withDaemon(({ client, dataDir }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();
          const keyName = channelKeyName(id, "#Secret");

          yield* client.networks.add({ payload: settingsFor(ircd) });
          yield* eventually(statusOf(client, id), ({ phase }) => phase === "session", limit);

          const joined = yield* client.networks.join({
            params: { id },
            payload: { channel: "#Secret", key: Redacted.make("pizza"), remember: true },
          });

          yield* untilReceived(ircd, "JOIN #Secret pizza");
          yield* untilJoined(client, "#Secret");

          const entries = yield* client.daemon.entries(everything);
          const recorded = changes(entries).slice(-2);
          const { settings } = yield* client.networks.get({ params: { id } });

          assert.match(keyName, /^key\.[0-9a-f]{16}$/u);
          assert.strictEqual(keyName, channelKeyName(id, "#secret"));
          assert.deepStrictEqual(
            recorded.map(({ by, change }) => ({ by, change })),
            [
              { by: ownerKey, change: { _tag: "CredentialSet", name: keyName } },
              {
                by: ownerKey,
                change: {
                  _tag: "ChannelJoined",
                  channel: { key: keyName, name: "#Secret" },
                  network: id,
                },
              },
            ]
          );
          assert.deepStrictEqual(joined, { change: recorded[1]?.sequence ?? 0 });
          assert.deepStrictEqual(settings.channels, [
            { autojoin: true, key: keyName, name: "#Secret", rejoinOnKick: false },
          ]);
          assert.deepInclude(
            outbound(entries).find(({ text }) => text.startsWith("JOIN")),
            { cause: "rejoin", redacted: [keyName], text: "JOIN #Secret <redacted>" }
          );
          assert.notInclude(logBytes(dataDir), "pizza");
        })
      )
  );

  it.live(
    "CRED-4, LOG-6: a Join not to be remembered sends its key, and the Log has `<redacted>` in its place",
    () =>
      withDaemon(({ client }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();

          yield* client.networks.add({ payload: settingsFor(ircd) });
          yield* eventually(statusOf(client, id), ({ phase }) => phase === "session", limit);

          const joined = yield* client.networks.join({
            params: { id },
            payload: { channel: "#passing", key: Redacted.make("calzone"), remember: false },
          });

          yield* untilReceived(ircd, "JOIN #passing calzone");

          const entries = yield* client.daemon.entries(everything);
          const line = outbound(entries).find(({ text }) => text.startsWith("JOIN"));

          assert.strictEqual("line" in joined ? joined.line.status : undefined, "written");
          assert.deepInclude(line, {
            cause: `key:${ownerKey}`,
            redacted: [channelKeyName(id, "#passing")],
            text: "JOIN #passing <redacted>",
          });
          assert.lengthOf((yield* client.credentials.list()).credentials, 0);
          assert.isFalse(
            changes(entries).some(({ change }) => JSON.stringify(change).includes("Credential"))
          );
        })
      )
  );

  it.live(
    "CRED-4, LOG-6: a `MODE +k` stores nothing, leaves the Owner's key as it was, and is recorded as it arrived",
    () =>
      withDaemon(({ client, dataDir }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();
          const keyName = channelKeyName(id, "#kept");

          yield* client.networks.add({ payload: settingsFor(ircd) });
          yield* eventually(statusOf(client, id), ({ phase }) => phase === "session", limit);
          yield* client.networks.join({
            params: { id },
            payload: { channel: "#kept", key: Redacted.make("pizza"), remember: true },
          });
          yield* untilJoined(client, "#kept");

          const before = changes(yield* client.daemon.entries(everything)).length;

          yield* ircd.push(":op!o@host MODE #kept +k first-key");
          yield* ircd.push(":op!o@host MODE #kept -k first-key");
          yield* ircd.push(":op!o@host MODE #kept +k pizza");
          yield* ircd.push(":bob!b@host PRIVMSG #kept :I like pizza");

          const entries = yield* eventually(
            client.daemon.entries(everything),
            (all) =>
              all.some((entry) => entry._tag === "Line" && entry.text.endsWith("I like pizza")),
            limit
          );

          // The next Connection's rejoin still uses the Owner's key.
          yield* ircd.hangUp;
          yield* untilReceived(ircd, "JOIN #kept pizza");

          const inbound = entries.flatMap((entry) =>
            entry._tag === "Line" && /^:(?:op|bob)!/u.test(entry.text)
              ? [{ redacted: entry.redacted, text: entry.text }]
              : []
          );

          assert.lengthOf(changes(entries), before);
          assert.deepStrictEqual(
            (yield* client.credentials.list()).credentials.map(({ name }) => name),
            [keyName]
          );
          assert.deepStrictEqual(inbound, [
            { redacted: undefined, text: ":op!o@host MODE #kept +k first-key" },
            { redacted: undefined, text: ":op!o@host MODE #kept -k first-key" },
            { redacted: undefined, text: ":op!o@host MODE #kept +k pizza" },
            { redacted: undefined, text: ":bob!b@host PRIVMSG #kept :I like pizza" },
          ]);

          // A page of the Log can be in its files more than once, so what counts is that the
          // key is nowhere but in the `MODE`s that carried it.
          const bytes = logBytes(dataDir);

          assert.strictEqual(
            occurrences(bytes, "first-key"),
            occurrences(bytes, "+k first-key") + occurrences(bytes, "-k first-key")
          );
        })
      )
  );
});

describe("settings that name Credentials (CONF-3, API-3)", () => {
  it.live(
    "CONF-3: refuses what cannot be a Credential's name or a connect command, with its path",
    () =>
      withDaemon(({ raw }) =>
        Effect.gen(function* () {
          const base = { id, identity: { nick }, ircds: [{ host: "irc.test", tls: true }] };

          const cases = [
            [
              { ...base, credentials: { password: "Not A Name" } },
              ["payload", "credentials", "password"],
            ],
            [
              { ...base, connectCommands: ["PRIVMSG Q :AUTH {{Bad Name}}"] },
              ["payload", "connectCommands", 0],
            ],
            [
              { ...base, connectCommands: [":src PRIVMSG Q :hi"] },
              ["payload", "connectCommands", 0],
            ],
            [
              { ...base, channels: [{ key: "a key", name: "#a" }] },
              ["payload", "channels", 0, "key"],
            ],
            [
              {
                ...base,
                credentials: { clientCertificate: "libera.cert" },
                ircds: [
                  { host: "irc.test", tls: true },
                  { host: "irc2.test", tls: false },
                ],
              },
              ["payload", "ircds", 1, "tls"],
            ],
            [{ ...base, services: ["Nick Serv"] }, ["payload", "services", 0]],
          ] as const;

          for (const [body, path] of cases) {
            const { issues } = yield* invalidRequest(yield* raw.post("/api/networks", body));

            assert.deepStrictEqual(
              issues.map((issue) => issue.path),
              [path],
              JSON.stringify(issues)
            );
          }
        })
      )
  );

  it.live("CONF-3: fills in the services, and keeps a service login's defaults", () =>
    withDaemon(({ client, raw }) =>
      Effect.gen(function* () {
        const response = yield* raw.post("/api/networks", {
          credentials: { service: { password: "libera.nickserv" } },
          enabled: false,
          id,
          identity: { nick },
          ircds: [{ host: "irc.test" }],
        });

        assert.strictEqual(response.status, 200, yield* Effect.orDie(response.text));

        const { settings } = yield* client.networks.get({ params: { id } });

        assert.deepStrictEqual(settings.credentials, {
          service: { nick: "NickServ", password: "libera.nickserv" },
        });
        assert.deepStrictEqual(settings.services, [
          "NickServ",
          "ChanServ",
          "MemoServ",
          "OperServ",
          "BotServ",
          "HostServ",
          "HelpServ",
        ]);
      })
    )
  );
});

describe("redaction by an admin (LOG-7)", () => {
  it.live(
    "LOG-7: empties a Line's bytes, marks it with the Change, and its Message leaves `/messages`",
    () =>
      withDaemon(({ client }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();

          yield* client.networks.add({ payload: settingsFor(ircd) });
          yield* eventually(statusOf(client, id), ({ phase }) => phase === "session", limit);
          yield* ircd.push(`:friend!f@host PRIVMSG ${nick} :my password is hunter2`);

          const [message] = yield* eventually(
            client.daemon.messages({ query: { after: 0, limit: 100 } }),
            (found) => found.length > 0,
            limit
          );

          const sequence = message?.sequence ?? 0;
          const { change } = yield* client.daemon.redact({ params: { sequence } });
          const entries = yield* client.daemon.entries(everything);
          const redacted = entries.find((entry) => entry.sequence === sequence);
          const recorded = entries.find((entry) => entry.sequence === change);

          assert.deepInclude(redacted, { redactedBy: change, text: "" });
          assert.strictEqual(redacted?._tag === "Line" ? redacted.bytes.length : -1, 0);
          assert.deepInclude(recorded, {
            by: ownerKey,
            change: { _tag: "EntryRedacted", sequence },
          });
          assert.lengthOf(yield* client.daemon.messages({ query: { after: 0, limit: 100 } }), 0);

          // The Session carries on, and what it hears next is recorded as ever.
          yield* ircd.push(`:friend!f@host PRIVMSG ${nick} :sorry about that`);
          yield* eventually(
            client.daemon.messages({ query: { after: 0, limit: 100 } }),
            (found) => found.some(({ text }) => text === "sorry about that"),
            limit
          );
        })
      )
  );

  it.live(
    "LOG-7, API-3: refuses an unknown sequence, another kind, a second time, and a `chat` key",
    () =>
      withDaemon(({ client }) =>
        Effect.gen(function* () {
          const ircd = yield* welcomingIrcd();

          yield* client.networks.add({ payload: settingsFor(ircd) });
          yield* eventually(statusOf(client, id), ({ phase }) => phase === "session", limit);

          const entries = yield* client.daemon.entries(everything);
          const line = entries.find((entry) => entry._tag === "Line")?.sequence ?? 0;
          const change = entries.find((entry) => entry._tag === "Change")?.sequence ?? 0;
          const head = entries.at(-1)?.sequence ?? 0;

          const { change: redaction } = yield* client.daemon.redact({ params: { sequence: line } });

          const { key: chatKey } = yield* client.keys.create({
            payload: { name: "phone", scope: "chat" },
          });

          const chatter = yield* clientWith(chatKey);

          assert.deepStrictEqual(
            yield* Effect.flip(client.daemon.redact({ params: { sequence: head + 1000 } })),
            new EntryNotFound({ sequence: head + 1000 })
          );
          assert.deepStrictEqual(
            yield* Effect.flip(client.daemon.redact({ params: { sequence: change } })),
            new EntryNotRedactable({ kind: "Change", sequence: change })
          );
          assert.deepStrictEqual(
            yield* Effect.flip(client.daemon.redact({ params: { sequence: line } })),
            new EntryAlreadyRedacted({ change: redaction, sequence: line })
          );
          assert.deepStrictEqual(
            yield* Effect.flip(chatter.daemon.redact({ params: { sequence: line } })),
            new Forbidden({ needed: "admin" })
          );
        })
      )
  );
});
