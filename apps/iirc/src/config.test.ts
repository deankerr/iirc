import { BunServices } from "@effect/platform-bun";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import type { NetworkSettings } from "@iirc/api";
import { Effect, Fiber, FileSystem, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { appRoot, createKey, freePort, healthyClient, settingsFor, startBinary } from "./binary.ts";
import type { Client } from "./binary.ts";
import { buildBinary, buildTimeout } from "./testing.ts";

// CONF-6 against the real thing: `iirc config` in the minified binary, as a Frontend of a
// running Daemon, with the key only in its environment.

const binary = `${appRoot}/dist/iirc-config`;

const testTimeout = 20_000;

// Nothing listens here, and the Networks are disabled, so no Connection adds an Entry
// while a test compares the Log before and after.
const nowhere = { host: "127.77.2.1", port: 1 };

const pin = `sha256/${"A".repeat(43)}=`;

// A value no export may hold, though `libera.pass` holds it (CRED-1, CONF-6).
const passValue = "the-libera-server-password";

const libera: NetworkSettings = {
  ...settingsFor({
    ...nowhere,
    alternates: ["owner_"],
    connectCommands: ["MODE owner +i", "PRIVMSG Q :AUTH owner {{libera.q}}"],
    credentials: {
      password: "libera.pass",
      service: { account: "owner", nick: "NickServ", password: "libera.nickserv" },
    },
    id: "libera",
    nick: "owner",
    quitReason: "back soon",
    tuning: { drainMillis: 300, reconnectInitialMillis: 1000 },
  }),
  channels: [
    { autojoin: true, name: "#iirc", rejoinOnKick: false },
    { autojoin: true, key: "key.libera.effect", name: "#effect", rejoinOnKick: false },
  ],
  enabled: false,
  ircds: [
    { host: "irc.libera.test", pin, port: 6697, tls: true },
    { host: "irc2.libera.test", port: 6667, tls: false },
  ],
  name: "Libera Chat",
  services: ["NickServ", "ChanServ", "Q"],
};

// A client certificate needs TLS on every Ircd.
const oftc = {
  ...settingsFor({
    ...nowhere,
    credentials: { clientCertificate: "oftc.cert" },
    id: "oftc",
    nick: "owner",
    tls: true,
  }),
  enabled: false,
};

const layers = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

// A Daemon with a key made before it started (AUTH-4), and both Networks added.
const daemonWithNetworks = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const dataDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iirc-config-" });
  const key = yield* createKey(binary, dataDir);
  const httpPort = yield* freePort;

  yield* startBinary(binary, ["daemon", "--http-port", String(httpPort)], {
    IIRC_DATA_DIR: dataDir,
  });

  const client = yield* healthyClient(httpPort, key);

  yield* client.credentials.set({
    params: { name: "libera.pass" },
    payload: { value: Redacted.make(passValue) },
  });
  yield* client.networks.add({ payload: libera });
  yield* client.networks.add({ payload: oftc });

  return { apiUrl: `http://127.0.0.1:${httpPort}`, client, dataDir, key };
});

// Runs `iirc config` to its end, with only the environment given.
const config = (flags: readonly string[], environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const running = yield* startBinary(binary, ["config", ...flags], environment);
    const code = Number(yield* running.child.exitCode);

    yield* Fiber.join(running.reader);

    return { code, output: running.output() };
  }).pipe(Effect.scoped);

const head = (client: Client) => Effect.map(client.daemon.status(), (status) => status.head ?? 0);

const entriesAfter = (client: Client, after: number) =>
  client.daemon.entries({ query: { after, limit: 1000 } });

const writeFile = (directory: string, name: string, text: string) =>
  Effect.gen(function* () {
    const file = `${directory}/${name}`;

    yield* (yield* FileSystem.FileSystem).writeFileString(file, text);

    return file;
  });

describe("the compiled binary's `iirc config` (CONF-6)", () => {
  beforeAll(async () => {
    await Effect.runPromise(buildBinary(binary));
  }, buildTimeout);

  it.live(
    "CONF-4: reaches the Daemon at IIRC_API_URL when no flag says where",
    () =>
      Effect.gen(function* () {
        const { apiUrl, key } = yield* daemonWithNetworks;
        const exported = yield* config(["export"], { IIRC_API_URL: apiUrl, IIRC_KEY: key });

        assert.strictEqual(exported.code, 0, exported.output);
        assert.include(exported.output, "[networks.libera]");
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "CONF-6, CRED-1: exports TOML that imports back as the same Configuration, adding only the Change, with Credentials by name",
    () =>
      Effect.gen(function* () {
        const { apiUrl, client, dataDir, key } = yield* daemonWithNetworks;
        const before = yield* client.configuration.get();
        const exported = yield* config(["export", "--api-url", apiUrl], { IIRC_KEY: key });

        assert.strictEqual(exported.code, 0, exported.output);

        for (const table of [
          "[networks.libera]",
          "[[networks.libera.ircds]]",
          "[[networks.libera.channels]]",
          "[networks.libera.tuning]",
          "[networks.oftc]",
        ]) {
          assert.include(exported.output, table);
        }

        // CRED-1: Credentials go by name, and never by value, though one is set.
        assert.include(exported.output, 'password = "libera.pass"');
        assert.include(exported.output, 'clientCertificate = "oftc.cert"');
        assert.include(exported.output, 'key = "key.libera.effect"');
        assert.include(exported.output, "{{libera.q}}");
        assert.include(exported.output, '"Q"');
        assert.notInclude(exported.output, passValue);

        // Only what the Owner changed, so a Network that changed nothing has no Tuning.
        assert.notInclude(exported.output, "[networks.oftc.tuning]");
        assert.include(exported.output, "drainMillis = 300");
        assert.notInclude(exported.output, "silenceMillis");
        assert.include(exported.output, `pin = "${pin}"`);

        const file = yield* writeFile(dataDir, "exported.toml", exported.output);
        const sequence = yield* head(client);
        const imported = yield* config(["import", "--api-url", apiUrl, file], { IIRC_KEY: key });

        assert.strictEqual(imported.code, 0, imported.output);
        assert.include(imported.output, "the whole Configuration");

        const change = Number(/Change (?<sequence>\d+)/u.exec(imported.output)?.groups?.sequence);
        const added = yield* entriesAfter(client, sequence);

        assert.deepStrictEqual(
          added.map((entry) => [entry._tag, entry.sequence]),
          [["Change", change]]
        );
        assert.deepInclude(added[0], { by: "owner" });
        assert.deepStrictEqual(yield* client.configuration.get(), before);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "says that a file is the whole Configuration, and removes the Network it leaves out",
    () =>
      Effect.gen(function* () {
        const { apiUrl, client, dataDir, key } = yield* daemonWithNetworks;
        const exported = yield* config(["export", "--api-url", apiUrl], { IIRC_KEY: key });
        const withoutOftc = exported.output.slice(0, exported.output.indexOf("[networks.oftc]"));
        const file = yield* writeFile(dataDir, "libera.toml", withoutOftc);
        const imported = yield* config(["import", "--api-url", apiUrl, file], { IIRC_KEY: key });

        assert.strictEqual(imported.code, 0, imported.output);
        assert.include(imported.output, "the Networks it left out were removed: oftc");
        assert.deepStrictEqual(
          (yield* client.configuration.get()).networks.map(({ id }) => id),
          ["libera"]
        );
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "refuses a bad file with its paths, before sending it or after, and changes nothing",
    () =>
      Effect.gen(function* () {
        const { apiUrl, client, dataDir, key } = yield* daemonWithNetworks;
        const exported = yield* config(["export", "--api-url", apiUrl], { IIRC_KEY: key });
        const before = yield* client.configuration.get();
        const sequence = yield* head(client);

        // The published Schema finds these, so nothing is sent.
        const badPin = yield* writeFile(
          dataDir,
          "pin.toml",
          exported.output.replace(`pin = "${pin}"`, 'pin = "sha256/short"')
        );

        const misspelt = yield* writeFile(
          dataDir,
          "misspelt.toml",
          exported.output.replace('quitReason = "back soon"', 'quitreason = "back soon"')
        );

        // Only the Daemon knows its Tuning rules, so this one comes back as a 400.
        const badTuning = yield* writeFile(
          dataDir,
          "tuning.toml",
          exported.output.replace("drainMillis = 300", "drainMillis = -1")
        );

        const notToml = yield* writeFile(dataDir, "broken.toml", "[networks.libera\n");

        const results = yield* Effect.forEach([badPin, misspelt, badTuning, notToml], (file) =>
          config(["import", "--api-url", apiUrl, file], { IIRC_KEY: key })
        );

        const [pinned, spelt, tuned, broken] = results.map(({ code, output }) => {
          assert.notStrictEqual(code, 0, output);

          return output;
        });

        assert.include(pinned, "nothing was sent");
        assert.include(pinned, "networks.libera.ircds[0].pin: ");
        assert.include(spelt, "networks.libera.quitreason: ");
        assert.include(tuned, "(400)");
        assert.include(tuned, "networks.libera.tuning");
        assert.include(tuned, "drainMillis");
        assert.include(broken, "line 1");

        assert.strictEqual(yield* head(client), sequence, "something was recorded");
        assert.deepStrictEqual(yield* client.configuration.get(), before);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "AUTH-1, AUTH-3: says plainly when it has no key, a wrong one, too narrow a one, or no Daemon",
    () =>
      Effect.gen(function* () {
        const { apiUrl, client, dataDir, key } = yield* daemonWithNetworks;
        const exported = yield* config(["export", "--api-url", apiUrl], { IIRC_KEY: key });
        const file = yield* writeFile(dataDir, "exported.toml", exported.output);

        const { key: reader } = yield* client.keys.create({
          payload: { name: "r", scope: "read" },
        });

        const sequence = yield* head(client);

        const noKey = yield* config(["export", "--api-url", apiUrl], {});
        const wrongKey = yield* config(["export", "--api-url", apiUrl], { IIRC_KEY: "iirc_no" });
        const narrow = yield* config(["import", "--api-url", apiUrl, file], { IIRC_KEY: reader });

        const noDaemon = yield* config(
          ["export", "--api-url", `http://127.0.0.1:${yield* freePort}`],
          { IIRC_KEY: key }
        );

        assert.strictEqual(noKey.code, 2, noKey.output);
        assert.include(noKey.output, "IIRC_KEY");
        assert.strictEqual(wrongKey.code, 1, wrongKey.output);
        assert.include(wrongKey.output, "(401)");
        assert.strictEqual(narrow.code, 1, narrow.output);
        assert.include(narrow.output, "(403)");
        assert.include(narrow.output, "admin");
        assert.strictEqual(noDaemon.code, 1, noDaemon.output);
        assert.include(noDaemon.output, "Could not reach the Daemon");

        // A key in a flag would show in `ps`, so there is no such flag.
        const flagged = yield* config(["export", "--api-url", apiUrl, "--key", key], {});

        assert.notStrictEqual(flagged.code, 0);

        for (const { output } of [noKey, wrongKey, narrow, noDaemon]) {
          assert.notInclude(output, "    at ", "a refusal printed a stack trace");
        }

        // The read key's export works, and the refused import recorded nothing.
        assert.strictEqual(
          (yield* config(["export", "--api-url", apiUrl], { IIRC_KEY: reader })).code,
          0
        );
        assert.strictEqual(yield* head(client), sequence);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );
});
