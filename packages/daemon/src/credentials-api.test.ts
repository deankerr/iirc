import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import {
  CredentialNotFound,
  CredentialsUnavailable,
  Forbidden,
  maxCredentialBytes,
} from "@iirc/api";
import type { LogEntry } from "@iirc/api";
import { Effect, Logger, Redacted, References } from "effect";
import type { HttpClientResponse } from "effect/http";

import { credentialsFile } from "./credentials.ts";
import {
  clientWith,
  coreFor,
  inTempDirectory,
  invalidRequest,
  localKey,
  noKeyring,
  ownerKey,
  rawWith,
  servingWith,
  version,
} from "./daemon.fixture.ts";
import type { Client, RawRequests } from "./daemon.fixture.ts";

// CRED-1 to CRED-3 and RUN-2 through the API: a value goes in, only names come out, each
// write is a Change that names it, and a backup holds the Log and no Credential.

const secret = "hunter2-correct-horse-battery";

const replacement = "staple-the-second-secret";

interface Harness {
  readonly client: Client;
  readonly dataDir: string;
  readonly raw: RawRequests;
}

// A Daemon with no Networks, keeping Credentials in the file, and a client with `key`.
const servingIn = <A, E, R>(
  dataDir: string,
  key: string,
  test: (harness: Harness) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const client = yield* clientWith(key);
    const raw = yield* rawWith(key);

    return yield* test({ client, dataDir, raw });
  }).pipe(
    Effect.provide(servingWith(coreFor({ dataDir, version }, { keyring: noKeyring }))),
    Effect.scoped
  );

// The same, with an `admin` key made before the first start (AUTH-4).
const withDaemon = <A, E, R>(test: (harness: Harness) => Effect.Effect<A, E, R>) =>
  inTempDirectory((dataDir) =>
    Effect.flatMap(localKey(dataDir), (key) => servingIn(dataDir, key, test))
  );

const changes = (client: Client) =>
  Effect.map(
    client.daemon.entries({ query: { after: 0, kind: ["Change"], limit: 100 } }),
    (entries) => entries.flatMap((entry) => (entry._tag === "Change" ? [entry] : []))
  );

const credentialChanges = (entries: readonly Extract<LogEntry, { _tag: "Change" }>[]) =>
  entries.flatMap(({ by, change }) =>
    JSON.stringify(change).includes("Credential") ? [{ by, change }] : []
  );

const bodyOf = (response: HttpClientResponse.HttpClientResponse) => Effect.orDie(response.text);

const quickCheck = (filename: string) => {
  const database = new Database(filename, { readonly: true });

  try {
    return database.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
  } finally {
    database.close();
  }
};

describe("Credentials through the API (CRED-1 to CRED-3)", () => {
  it.live(
    "CRED-2: sets, replaces, and deletes a Credential, and lists only its name and when it was set",
    () =>
      withDaemon(({ client }) =>
        Effect.gen(function* () {
          const name = "libera.sasl";

          yield* client.credentials.set({
            params: { name },
            payload: { value: Redacted.make(secret) },
          });

          const first = yield* client.credentials.list();

          yield* client.credentials.set({
            params: { name },
            payload: { value: Redacted.make(replacement) },
          });

          const second = yield* client.credentials.list();

          assert.strictEqual(first.store, "file");
          assert.deepStrictEqual(
            first.credentials.map(({ name: listed }) => listed),
            [name]
          );
          assert.isAtLeast(second.credentials[0]?.set ?? 0, first.credentials[0]?.set ?? 0);
          assert.deepStrictEqual(Object.keys(second.credentials[0] ?? {}).toSorted(), [
            "name",
            "set",
          ]);

          yield* client.credentials.delete({ params: { name } });

          assert.deepStrictEqual((yield* client.credentials.list()).credentials, []);
          assert.deepStrictEqual(
            yield* Effect.flip(client.credentials.delete({ params: { name } })),
            new CredentialNotFound({ credential: name })
          );
        })
      )
  );

  it.live(
    "CRED-1: each set and delete is a Change that names the Credential and the key, never the value",
    () =>
      withDaemon(({ client }) =>
        Effect.gen(function* () {
          const set = yield* client.credentials.set({
            params: { name: "oftc.pass" },
            payload: { value: Redacted.make(secret) },
          });

          const deleted = yield* client.credentials.delete({ params: { name: "oftc.pass" } });
          const recorded = yield* changes(client);

          assert.deepStrictEqual(credentialChanges(recorded), [
            { by: ownerKey, change: { _tag: "CredentialSet", name: "oftc.pass" } },
            { by: ownerKey, change: { _tag: "CredentialDeleted", name: "oftc.pass" } },
          ]);
          assert.deepStrictEqual(
            recorded.slice(-2).map(({ sequence }) => sequence),
            [set.change, deleted.change]
          );
          assert.notProperty(recorded.at(-1), "network");
        })
      )
  );

  it.live("CRED-1: status says where Credentials are kept", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual((yield* client.daemon.status()).credentials, { store: "file" });
      })
    )
  );

  it.live(
    "CRED-2: refuses a bad name, an empty value, and one past 16 KB, as bad requests that never repeat the value",
    () =>
      withDaemon(({ client, raw }) =>
        Effect.gen(function* () {
          for (const name of ["Libera", ".hidden", "-x", "a".repeat(65), "two words", "a/b"]) {
            const response = yield* raw.put(`/api/credentials/${encodeURIComponent(name)}`, {
              value: secret,
            });

            const { issues } = yield* invalidRequest(response);

            assert.deepStrictEqual(issues[0]?.path, ["params", "name"], name);
          }

          // Two bytes a character, so the limit is counted in bytes, not characters.
          const atLimit = "é".repeat(maxCredentialBytes / 2);
          const pastLimit = `${secret}${"x".repeat(maxCredentialBytes)}`;

          for (const value of ["", pastLimit]) {
            const response = yield* raw.put("/api/credentials/a", { value });
            const { issues } = yield* invalidRequest(response);

            assert.deepStrictEqual(issues[0]?.path, ["payload", "value"]);
            assert.notInclude(JSON.stringify(issues), secret);
          }

          yield* client.credentials.set({
            params: { name: "pem" },
            payload: { value: Redacted.make(atLimit) },
          });

          assert.deepStrictEqual(
            (yield* client.credentials.list()).credentials.map(({ name }) => name),
            ["pem"]
          );
        })
      )
  );

  it.live("CRED-1: a store that cannot be written refuses with a 503, and records no Change", () =>
    withDaemon(({ client, dataDir }) =>
      Effect.gen(function* () {
        const before = yield* changes(client);

        chmodSync(dataDir, 0o500);

        const refused = yield* Effect.flip(
          client.credentials.set({
            params: { name: "a" },
            payload: { value: Redacted.make(secret) },
          })
        );

        chmodSync(dataDir, 0o700);

        assert.instanceOf(refused, CredentialsUnavailable);
        assert.include(
          refused instanceof CredentialsUnavailable ? refused.reason : "",
          credentialsFile
        );
        assert.deepStrictEqual(yield* changes(client), before);
        assert.deepStrictEqual((yield* client.credentials.list()).credentials, []);
      })
    )
  );

  it.live(
    "CRED-1: a delete the store took and the Log missed, as a crash between them leaves, is recorded when asked again",
    () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const key = yield* localKey(dataDir);

          yield* servingIn(dataDir, key, ({ client }) =>
            client.credentials.set({
              params: { name: "a" },
              payload: { value: Redacted.make(secret) },
            })
          );

          // The store has already let it go, and the Log still says it is set.
          writeFileSync(`${dataDir}/${credentialsFile}`, "{}\n", { mode: 0o600 });

          yield* servingIn(dataDir, key, ({ client }) =>
            Effect.gen(function* () {
              assert.deepStrictEqual((yield* client.credentials.list()).credentials, []);

              const { change } = yield* client.credentials.delete({ params: { name: "a" } });

              assert.deepStrictEqual((yield* changes(client)).at(-1)?.sequence, change);
              assert.deepStrictEqual(
                yield* Effect.flip(client.credentials.delete({ params: { name: "a" } })),
                new CredentialNotFound({ credential: "a" })
              );
            })
          );
        })
      )
  );

  it.live("AUTH-3: Credentials and backups need an admin key", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const { key } = yield* client.keys.create({ payload: { name: "chatter", scope: "chat" } });
        const chatter = yield* clientWith(key);
        const needed = new Forbidden({ needed: "admin" });

        assert.deepStrictEqual(yield* Effect.flip(chatter.credentials.list()), needed);
        assert.deepStrictEqual(
          yield* Effect.flip(
            chatter.credentials.set({
              params: { name: "a" },
              payload: { value: Redacted.make(secret) },
            })
          ),
          needed
        );
        assert.deepStrictEqual(
          yield* Effect.flip(chatter.credentials.delete({ params: { name: "a" } })),
          needed
        );
        assert.deepStrictEqual(yield* Effect.flip(chatter.daemon.backup()), needed);
      })
    )
  );

  it.live(
    "RUN-2: a backup through the API is in backups/, whole, holds every Entry to its head, and no Credential",
    () =>
      withDaemon(({ client, dataDir }) =>
        Effect.gen(function* () {
          yield* client.credentials.set({
            params: { name: "a" },
            payload: { value: Redacted.make(secret) },
          });

          const backup = yield* client.daemon.backup();
          const entries = yield* client.daemon.entries({ query: { after: 0, limit: 1000 } });

          assert.isTrue(backup.path.startsWith(`${dataDir}/backups/iirc-${backup.head}-`));
          assert.isTrue(existsSync(backup.path));
          assert.deepStrictEqual(quickCheck(backup.path), [{ quick_check: "ok" }]);

          const copy = new Database(backup.path, { readonly: true });

          const sequences = copy
            .query<{ sequence: number }, []>("SELECT sequence FROM entries ORDER BY sequence")
            .all()
            .map(({ sequence }) => sequence);

          copy.close();

          assert.deepStrictEqual(
            sequences,
            entries.flatMap(({ sequence }) => (sequence <= backup.head ? [sequence] : []))
          );
          assert.isFalse(readFileSync(backup.path).includes(secret), "no Credential in it");
        })
      )
  );

  it.live("CRED-3: no value reaches a response, a log line, or an Entry", () =>
    Effect.gen(function* () {
      const logged: string[] = [];

      const logger = Logger.layer([
        Logger.make((options) => {
          logged.push(Logger.formatSimple.log(options));
        }),
      ]);

      yield* withDaemon(({ dataDir, raw }) =>
        Effect.gen(function* () {
          const bodies: string[] = [];

          const keep = Effect.fnUntraced(function* (
            response: Effect.Effect<HttpClientResponse.HttpClientResponse>
          ) {
            const answered = yield* response;

            bodies.push(yield* bodyOf(answered));

            return answered.status;
          });

          assert.strictEqual(yield* keep(raw.put("/api/credentials/a", { value: secret })), 200);
          assert.strictEqual(
            yield* keep(raw.put("/api/credentials/a", { value: replacement })),
            200
          );
          assert.strictEqual(yield* keep(raw.put("/api/credentials/b", { value: secret })), 200);

          // Refusals of every kind, each carrying a value.
          assert.strictEqual(yield* keep(raw.put("/api/credentials/Bad", { value: secret })), 400);
          assert.strictEqual(
            yield* keep(raw.put("/api/credentials/a", { value: `${secret}${"x".repeat(20_000)}` })),
            400
          );
          assert.strictEqual(
            yield* keep(raw.put("/api/credentials/a", { extra: secret, value: secret })),
            400
          );
          assert.strictEqual(yield* keep(raw.post("/api/credentials/a", { value: secret })), 404);

          for (const path of [
            "/api/credentials",
            "/api/status",
            "/api/entries?limit=1000",
            "/api/configuration",
          ]) {
            assert.strictEqual(yield* keep(raw.get(path)), 200, path);
          }

          assert.strictEqual(yield* keep(raw.post("/api/backup", {})), 200);
          assert.strictEqual(yield* keep(raw.delete("/api/credentials/b")), 200);

          for (const body of bodies) {
            assert.notInclude(body, secret);
            assert.notInclude(body, replacement);
          }

          // Nor in any byte the Log has written, in its database or its WAL.
          for (const file of ["iirc.sqlite", "iirc.sqlite-wal"]) {
            const written = readFileSync(`${dataDir}/${file}`);

            assert.isFalse(written.includes(secret), file);
            assert.isFalse(written.includes(replacement), file);
          }
        })
      ).pipe(Effect.provide(logger), Effect.provideService(References.MinimumLogLevel, "All"));

      for (const line of logged) {
        assert.notInclude(line, secret);
        assert.notInclude(line, replacement);
      }
    })
  );
});
