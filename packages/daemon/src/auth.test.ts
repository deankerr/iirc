import { assert, describe, it } from "@effect/vitest";
import { DaemonApi, Forbidden, KeyExists, KeyNotFound, Unauthorized } from "@iirc/api";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { OpenApi } from "effect/http-api";

import {
  clientWith,
  inTempDirectory,
  invalidRequest,
  localKey,
  ownerKey,
  rawWith,
  servingWith,
  version,
} from "./daemon.fixture.ts";
import type { Client, RawRequests } from "./daemon.fixture.ts";
import { DaemonCore } from "./daemon.ts";
import { hashKey } from "./keys.ts";
import { maxBodySize } from "./routes.ts";

interface Harness {
  readonly anonymous: RawRequests;
  readonly client: Client;
  readonly key: string;
  readonly raw: RawRequests;
}

// A Daemon with no Networks, and an `admin` key named `owner` made as `iirc key create` does.
const withDaemon = <A, E, R>(test: (harness: Harness) => Effect.Effect<A, E, R>) =>
  inTempDirectory((dataDir) =>
    Effect.gen(function* () {
      const key = yield* localKey(dataDir);

      return yield* Effect.gen(function* () {
        const client = yield* clientWith(key);
        const raw = yield* rawWith(key);
        const anonymous = yield* rawWith();

        return yield* test({ anonymous, client, key, raw });
      }).pipe(Effect.provide(servingWith(DaemonCore({ dataDir, version }))), Effect.scoped);
    })
  );

const methods = ["get", "post", "put", "patch", "delete"] as const;

// Every operation in the contract, as a request with nothing in it but its path.
const operations = Object.entries(OpenApi.fromApi(DaemonApi).paths).flatMap(([path, item]) =>
  methods.flatMap((method) =>
    item[method] === undefined
      ? []
      : [{ method, path: path.replace("{id}", "libera").replace("{name}", "phone") }]
  )
);

const requestFor = (method: (typeof methods)[number], path: string) => {
  switch (method) {
    case "get": {
      return HttpClientRequest.get(path);
    }

    case "post": {
      return HttpClientRequest.post(path);
    }

    case "put": {
      return HttpClientRequest.put(path);
    }

    case "patch": {
      return HttpClientRequest.patch(path);
    }

    case "delete": {
      return HttpClientRequest.delete(path);
    }

    default: {
      return method satisfies never;
    }
  }
};

const Tagged = Schema.Struct({ _tag: Schema.String });

const tagOf = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.orDie(response.json).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Tagged)),
    Effect.map(({ _tag }) => _tag),
    Effect.orDie
  );

const needs = (scope: "chat" | "admin") => new Forbidden({ needed: scope });

// The same length as a real key, and one character off it.
const nearMiss = (key: string) => `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;

describe("keys and access", () => {
  it.live("AUTH-1: every operation but /health needs a key, and gets a typed 401 without one", () =>
    withDaemon(({ key }) =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;

        assert.isAtLeast(operations.length, 17);

        for (const { method, path } of operations) {
          const send = (
            decorate: (
              request: HttpClientRequest.HttpClientRequest
            ) => HttpClientRequest.HttpClientRequest
          ) => Effect.orDie(httpClient.execute(decorate(requestFor(method, path))));

          const bare = yield* send((request) => request);

          if (path === "/api/health") {
            assert.strictEqual(bare.status, 200);
          } else {
            const label = `${method} ${path}`;

            assert.strictEqual(bare.status, 401, label);
            assert.strictEqual(yield* tagOf(bare), "Unauthorized", label);

            // AUTH-6: only `Authorization: Bearer` carries a key, never a URL or another header.
            for (const elsewhere of [
              (request: HttpClientRequest.HttpClientRequest) =>
                HttpClientRequest.setUrlParam(request, "key", key),
              (request: HttpClientRequest.HttpClientRequest) =>
                HttpClientRequest.setHeader(request, "x-api-key", key),
              (request: HttpClientRequest.HttpClientRequest) =>
                HttpClientRequest.basicAuth(request, ownerKey, key),
              (request: HttpClientRequest.HttpClientRequest) =>
                HttpClientRequest.bearerToken(request, nearMiss(key)),
            ]) {
              assert.strictEqual((yield* send(elsewhere)).status, 401, label);
            }
          }
        }
      })
    )
  );

  it.live("AUTH-2: refuses a key one character off, or one that was never made", () =>
    withDaemon(({ key }) =>
      Effect.gen(function* () {
        for (const wrong of [nearMiss(key), `${key}A`, key.slice(0, -1), "iirc_", hashKey(key)]) {
          const client = yield* clientWith(wrong);

          assert.deepStrictEqual(yield* Effect.flip(client.daemon.status()), new Unauthorized());
        }
      })
    )
  );

  it.live("AUTH-3: each scope reaches its own operations, and a 403 names the scope needed", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const reader = yield* clientWith(
          (yield* client.keys.create({ payload: { name: "reader", scope: "read" } })).key
        );

        const chatter = yield* clientWith(
          (yield* client.keys.create({ payload: { name: "chatter", scope: "chat" } })).key
        );

        const settings = {
          channels: [],
          connectCommands: [],
          credentials: {},
          enabled: false,
          id: "libera",
          identity: { alternates: [], nick: "iirc", realname: "iirc", username: "iirc" },
          ircds: [{ host: "irc.test", port: 6697, tls: true }] as const,
          name: "libera",
          quitReason: "iirc",
          services: [],
          tuning: {},
        };

        yield* client.networks.add({ payload: settings });

        const params = { params: { id: "libera" } };
        const join = { ...params, payload: { channel: "#a", remember: true } };

        // `read` sees, and does nothing.
        assert.strictEqual((yield* reader.daemon.status()).networks.length, 1);
        assert.isNotEmpty(yield* reader.daemon.entries({ query: { after: 0, limit: 10 } }));
        assert.lengthOf(yield* reader.networks.list(), 1);
        assert.lengthOf((yield* reader.configuration.get()).networks, 1);
        assert.deepStrictEqual(
          yield* Effect.flip(
            reader.daemon.send({ payload: { network: "libera", target: "#a", text: "hi" } })
          ),
          needs("chat")
        );
        assert.deepStrictEqual(yield* Effect.flip(reader.networks.join(join)), needs("chat"));
        assert.deepStrictEqual(yield* Effect.flip(reader.networks.connect(params)), needs("admin"));
        assert.deepStrictEqual(yield* Effect.flip(reader.keys.list()), needs("admin"));

        // `chat` adds joining and parting, and nothing of Networks, Configuration, or keys.
        assert.property(yield* chatter.networks.join(join), "change");
        assert.property(
          yield* chatter.networks.part({ ...params, payload: { channel: "#a" } }),
          "change"
        );
        assert.deepStrictEqual(
          yield* Effect.flip(chatter.networks.add({ payload: settings })),
          needs("admin")
        );
        assert.deepStrictEqual(
          yield* Effect.flip(chatter.networks.change({ ...params, payload: settings })),
          needs("admin")
        );
        assert.deepStrictEqual(yield* Effect.flip(chatter.networks.remove(params)), needs("admin"));
        assert.deepStrictEqual(
          yield* Effect.flip(chatter.networks.disconnect(params)),
          needs("admin")
        );
        assert.deepStrictEqual(
          yield* Effect.flip(chatter.configuration.replace({ payload: { networks: [] } })),
          needs("admin")
        );
        assert.deepStrictEqual(
          yield* Effect.flip(chatter.keys.create({ payload: { name: "more", scope: "admin" } })),
          needs("admin")
        );
        assert.deepStrictEqual(
          yield* Effect.flip(chatter.keys.revoke({ params: { name: ownerKey } })),
          needs("admin")
        );
      })
    )
  );

  it.live("AUTH-3: a 403 is a typed body that says which scope it needed", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const { key } = yield* client.keys.create({ payload: { name: "reader", scope: "read" } });
        const response = yield* (yield* rawWith(key)).get("/api/keys");

        assert.strictEqual(response.status, 403);
        assert.deepStrictEqual(yield* Effect.orDie(response.json), {
          _tag: "Forbidden",
          needed: "admin",
        });
      })
    )
  );

  it.live("AUTH-2: a revoked key stops working on its next request", () =>
    withDaemon(({ client }) =>
      Effect.gen(function* () {
        const { key } = yield* client.keys.create({ payload: { name: "phone", scope: "read" } });
        const phone = yield* clientWith(key);

        yield* phone.daemon.status();

        const { change } = yield* client.keys.revoke({ params: { name: "phone" } });

        assert.deepStrictEqual(yield* Effect.flip(phone.daemon.status()), new Unauthorized());
        // Its name, scope, and SHA-256, as its creation recorded, and never the key.
        assert.deepInclude(
          (yield* client.daemon.entries({ query: { after: 0, kind: ["Change"], limit: 10 } })).at(
            -1
          ),
          {
            change: { _tag: "KeyRevoked", hash: hashKey(key), name: "phone", scope: "read" },
            sequence: change,
          }
        );
        assert.deepStrictEqual(
          yield* Effect.flip(client.keys.revoke({ params: { name: "phone" } })),
          new KeyNotFound({ keyName: "phone" })
        );
      })
    )
  );

  it.live(
    "AUTH-2: shows a key once, lists it by name and scope, and the Log keeps only its hash",
    () =>
      withDaemon(({ client, raw }) =>
        Effect.gen(function* () {
          const created = yield* client.keys.create({ payload: { name: "phone", scope: "chat" } });
          const listed = yield* client.keys.list();
          const listing = yield* Effect.orDie((yield* raw.get("/api/keys")).text);
          const log = yield* Effect.orDie((yield* raw.get("/api/entries?kind=Change")).text);

          const change = (yield* client.daemon.entries({
            query: { after: 0, kind: ["Change"], limit: 10 },
          })).at(-1);

          assert.match(created.key, /^iirc_[A-Za-z0-9_-]{43}$/u);
          assert.deepInclude(created, { name: "phone", scope: "chat" });
          assert.deepStrictEqual(
            listed.map(({ name, scope }) => ({ name, scope })),
            [
              { name: ownerKey, scope: "admin" },
              { name: "phone", scope: "chat" },
            ]
          );
          assert.isAbove(listed[1]?.created ?? 0, 0);
          assert.notInclude(listing, created.key);
          assert.notInclude(listing, hashKey(created.key));
          assert.notInclude(log, created.key);
          assert.deepInclude(change, {
            _tag: "Change",
            by: ownerKey,
            change: {
              _tag: "KeyCreated",
              hash: hashKey(created.key),
              name: "phone",
              scope: "chat",
            },
            sequence: created.change,
          });
        })
      )
  );

  it.live("AUTH-2, CRED-4: refuses a name taken, `local`, `mode`, or one that is no name", () =>
    withDaemon(({ client, raw }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* Effect.flip(client.keys.create({ payload: { name: ownerKey, scope: "read" } })),
          new KeyExists({ keyName: ownerKey })
        );

        for (const name of ["local", "mode", "Phone", "-phone", "a".repeat(33), "two words", ""]) {
          const { issues } = yield* invalidRequest(
            yield* raw.post("/api/keys", { name, scope: "read" })
          );

          assert.deepStrictEqual(issues[0].path, ["payload", "name"], name);
        }

        const { issues } = yield* invalidRequest(
          yield* raw.post("/api/keys", { name: "x", scope: "root" })
        );

        assert.deepStrictEqual(issues[0].path, ["payload", "scope"]);
      })
    )
  );

  it.live("AUTH-5: refuses a body over its limit with a 413, and reads none without a key", () =>
    withDaemon(({ anonymous, raw }) =>
      Effect.gen(function* () {
        const huge = { networks: [], padding: "x".repeat(Number(maxBodySize) + 1) };
        const fits = { networks: [], padding: "x".repeat(Number(maxBodySize) - 100) };

        assert.strictEqual((yield* raw.put("/api/configuration", huge)).status, 413);
        // Read, and refused for what it holds rather than for its size.
        assert.deepStrictEqual(
          (yield* invalidRequest(yield* raw.put("/api/configuration", fits))).issues.map(
            ({ path }) => path
          ),
          [["payload", "padding"]]
        );
        assert.strictEqual((yield* anonymous.put("/api/configuration", huge)).status, 401);
      })
    )
  );
});
