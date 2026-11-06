import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { testBinary, createKey, freePort, healthyClient, startBinary } from "./binary.ts";
import { withoutFinalLineEnding } from "./credential-command.ts";

// CRED-2, RUN-2, and RUN-5 against the real thing: `iirc credential` and `iirc backup` in
// the minified binary, as Frontends of a running Daemon (API-1), and `iirc daemon`
// refusing a Log or Credentials it must not use, in one plain line.

// Only a hang reaches it: a binary is started and stopped, and on a busy machine that takes
// several times what it does alone.
const testTimeout = 60_000;

const secret = "hunter2-correct-horse-battery";

const layers = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

const newDataDir = FileSystem.FileSystem.use((fileSystem) =>
  fileSystem.makeTempDirectoryScoped({ directory: "/var/tmp", prefix: "iirc-credential-" })
);

// A Daemon with a key made before it started (AUTH-4), until the enclosing scope closes.
const runningDaemonIn = Effect.fnUntraced(function* (dataDir: string) {
  const key = yield* createKey(testBinary, dataDir);
  const httpPort = yield* freePort;

  yield* startBinary(testBinary, ["daemon", "--http-port", String(httpPort)], {
    IIRC_DATA_DIR: dataDir,
  });

  const client = yield* healthyClient(httpPort, key);

  return {
    client,
    dataDir,
    environment: { IIRC_API_URL: `http://127.0.0.1:${httpPort}`, IIRC_KEY: key },
  };
});

const runningDaemon = newDataDir.pipe(Effect.flatMap(runningDaemonIn));

// Runs the binary to its end, with only the environment and stdin given.
const run = (
  flags: readonly string[],
  environment: Readonly<Record<string, string>>,
  stdin?: string
) =>
  Effect.gen(function* () {
    const running = yield* startBinary(testBinary, flags, environment, stdin);
    const code = Number(yield* running.child.exitCode);

    yield* Fiber.join(running.reader);

    return { code, output: running.output(), stderr: running.stderr(), stdout: running.stdout() };
  }).pipe(Effect.scoped);

describe("the compiled binary's Credentials and backups", () => {
  it("CRED-2: a value piped in loses only the line ending the pipe added", () => {
    assert.strictEqual(withoutFinalLineEnding(`${secret}\n`), secret);
    assert.strictEqual(withoutFinalLineEnding(`${secret}\r\n`), secret);
    assert.strictEqual(withoutFinalLineEnding("a\nb\n\n"), "a\nb\n");
    assert.strictEqual(withoutFinalLineEnding(secret), secret);
  });

  it.live(
    "CRED-2: `iirc credential` sets from stdin, lists names only, and deletes, and never prints a value",
    () =>
      Effect.gen(function* () {
        const { client, environment } = yield* runningDaemon;
        const pem = `-----BEGIN CERTIFICATE-----\n${secret}\n-----END CERTIFICATE-----\n`;

        const set = yield* run(["credential", "set", "libera.sasl"], environment, `${secret}\n`);
        const setPem = yield* run(["credential", "set", "libera.cert"], environment, pem);
        const listed = yield* run(["credential", "list"], environment);

        assert.strictEqual(set.code, 0, set.output);
        assert.match(set.stdout, /^Change \d+ set the Credential libera\.sasl\.\n$/u);
        assert.strictEqual(setPem.code, 0, setPem.output);
        assert.strictEqual(listed.code, 0, listed.output);
        assert.include(listed.stdout, "Credentials are kept in the file.");
        assert.match(listed.stdout, /^libera\.cert\tset \d{4}-\d\d-\d\dT/mu);
        assert.match(listed.stdout, /^libera\.sasl\tset \d{4}-\d\d-\d\dT/mu);

        const deleted = yield* run(["credential", "delete", "libera.sasl"], environment);
        const again = yield* run(["credential", "delete", "libera.sasl"], environment);

        assert.strictEqual(deleted.code, 0, deleted.output);
        assert.strictEqual(again.code, 1);
        assert.strictEqual(
          again.stderr,
          "There is no Credential named libera.sasl, so nothing changed.\n"
        );

        for (const { output } of [set, setPem, listed, deleted, again]) {
          assert.notInclude(output, secret);
        }

        const changes = (yield* client.daemon.entries({
          query: { after: 0, kind: ["Change"], limit: 100 },
        })).flatMap((entry) => (entry._tag === "Change" ? [entry.change] : []));

        assert.includeDeepMembers(changes, [
          { _tag: "CredentialSet", name: "libera.sasl" },
          { _tag: "CredentialSet", name: "libera.cert" },
          { _tag: "CredentialDeleted", name: "libera.sasl" },
        ]);
        assert.notInclude(JSON.stringify(changes), secret);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "CRED-2: a bad name and an empty value are refused before anything changes",
    () =>
      Effect.gen(function* () {
        const { environment } = yield* runningDaemon;
        const badName = yield* run(["credential", "set", "Not.A.Name"], environment, secret);
        const empty = yield* run(["credential", "set", "empty"], environment, "\n");

        assert.notStrictEqual(badName.code, 0);
        assert.notInclude(badName.output, secret);
        assert.strictEqual(empty.code, 1);
        assert.strictEqual(empty.stderr, "The value must not be empty, so nothing was set.\n");
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "RUN-2: `iirc backup` writes a whole backup into backups/ and says where",
    () =>
      Effect.gen(function* () {
        const { dataDir, environment } = yield* runningDaemon;

        yield* run(["credential", "set", "a"], environment, secret);

        const backup = yield* run(["backup"], environment);
        const path = /in (?<path>\S+\.sqlite)/u.exec(backup.stdout)?.groups?.path ?? "";

        assert.strictEqual(backup.code, 0, backup.output);
        assert.isTrue(path.startsWith(`${dataDir}/backups/iirc-`), backup.stdout);
        assert.isTrue(existsSync(path));
        assert.isFalse(readFileSync(path).includes(secret), "no Credential in it");
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "RUN-5: `iirc daemon` refuses a Log a newer iirc migrated, in one plain line",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* newDataDir;

        yield* createKey(testBinary, dataDir);

        // What a newer binary would have left: a migration this one does not know.
        const database = new Database(`${dataDir}/iirc.sqlite`);

        database.run(
          "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'future')"
        );
        database.close();

        const refused = yield* run(["daemon", "--http-port", String(yield* freePort)], {
          IIRC_DATA_DIR: dataDir,
        });

        assert.strictEqual(refused.code, 1, refused.output);
        assert.strictEqual(refused.stdout, "");
        assert.match(
          refused.stderr,
          /^The Log in .+ was written by a newer iirc, .*99_future.*\n$/u
        );
        assert.strictEqual(refused.stderr.split("\n").length, 2, "one line");
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );

  it.live(
    "CRED-1: `iirc daemon` refuses a Credentials file other users may read, in one plain line",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* newDataDir;

        // The first Daemon sets a Credential, and is gone with its scope.
        yield* runningDaemonIn(dataDir).pipe(
          Effect.flatMap(({ environment }) => run(["credential", "set", "a"], environment, secret)),
          Effect.scoped
        );

        chmodSync(`${dataDir}/credentials.json`, 0o644);

        const refused = yield* run(["daemon", "--http-port", String(yield* freePort)], {
          IIRC_DATA_DIR: dataDir,
        });

        assert.strictEqual(refused.code, 1, refused.output);
        assert.match(refused.stderr, /mode 0644, so other users may have read it/u);
        assert.strictEqual(refused.stderr.split("\n").length, 2, "one line");
        assert.notInclude(refused.output, secret);
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );
});
