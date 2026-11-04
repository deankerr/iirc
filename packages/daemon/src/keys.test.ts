import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SecureRandom } from "effect/crypto";
import type { Digest } from "effect/crypto";

import type { Key } from "./configuration.ts";
import { findKey, hashKey, keyCrypto, newKey, reaches } from "./keys.ts";

const keyOf = (key: string, scope: Key["scope"] = "admin") =>
  Effect.map(hashKey(key), (hash): Key => ({ created: 0, hash, scope }));

describe("a new key", () => {
  it.effect("AUTH-2: is `iirc_` and 32 random bytes in base64url, never the same twice", () =>
    Effect.gen(function* () {
      const keys = yield* Effect.replicateEffect(newKey, 50);

      for (const key of keys) {
        assert.match(key, /^iirc_[A-Za-z0-9_-]{43}$/u);
        assert.lengthOf(Buffer.from(key.slice("iirc_".length), "base64url"), 32);
      }

      assert.strictEqual(new Set(keys).size, keys.length);
    }).pipe(Effect.provide(keyCrypto))
  );

  it.effect("AUTH-2: is drawn from SecureRandom, and nothing else", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* newKey, `iirc_${"A".repeat(43)}`);
    }).pipe(
      Effect.provideService(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size))
      )
    )
  );
});

describe(hashKey, () => {
  // These are what Logs already hold, including a running Daemon's, so they must never
  // change.
  it.effect("AUTH-2: is the SHA-256 of the key's UTF-8, in lowercase hex", () =>
    Effect.gen(function* () {
      // What `printf iirc_test | sha256sum` says.
      assert.strictEqual(
        yield* hashKey("iirc_test"),
        "5fc91a6706c6d679b4228723bcee429bea1916e837344032a054bf76d384d175"
      );
      // What `printf 'iirc_\xc3\xa9' | sha256sum` says.
      assert.strictEqual(
        yield* hashKey("iirc_é"),
        "8fa66da4c468ce883802e61779ebb360fd160416eb4003f05699d277b3b0460d"
      );
    }).pipe(Effect.provide(keyCrypto))
  );
});

const withKeys = <A>(
  test: (
    keys: ReadonlyMap<string, Key>,
    phone: string,
    owner: string
  ) => Effect.Effect<A, never, Digest.Digest>
) =>
  Effect.gen(function* () {
    const phone = yield* newKey;
    const owner = yield* newKey;

    const keys = new Map([
      ["owner", yield* keyOf(owner)],
      ["phone", yield* keyOf(phone, "chat")],
    ]);

    return yield* test(keys, phone, owner);
  }).pipe(Effect.provide(keyCrypto));

describe(findKey, () => {
  it.effect("AUTH-2: finds whose key it is, with its scope", () =>
    withKeys((keys, phone, owner) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* findKey(keys, phone), { name: "phone", scope: "chat" });
        assert.deepStrictEqual(yield* findKey(keys, owner), { name: "owner", scope: "admin" });
      })
    )
  );

  it.effect("AUTH-2: finds a key by a hash a Log already holds", () =>
    Effect.gen(function* () {
      const keys = new Map<string, Key>([
        [
          "owner",
          {
            created: 0,
            hash: "5fc91a6706c6d679b4228723bcee429bea1916e837344032a054bf76d384d175",
            scope: "admin",
          },
        ],
      ]);

      assert.deepStrictEqual(yield* findKey(keys, "iirc_test"), {
        name: "owner",
        scope: "admin",
      });
    }).pipe(Effect.provide(keyCrypto))
  );

  it.effect(
    "AUTH-2: finds nobody for a key one character off, or of another length, or empty",
    () =>
      withKeys((keys, phone) =>
        Effect.gen(function* () {
          const last = phone.at(-1) === "A" ? "B" : "A";
          const hash = yield* hashKey(phone);

          for (const wrong of [
            `${phone.slice(0, -1)}${last}`,
            `${phone}A`,
            phone.slice(0, -1),
            "",
            hash,
          ]) {
            assert.isUndefined(yield* findKey(keys, wrong));
          }
        })
      )
  );

  it.effect("finds nobody when there are no keys, or by a stored hash that is not hex", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* findKey(new Map(), "iirc_test"));
      assert.isUndefined(
        yield* findKey(new Map([["bad", { created: 0, hash: "not hex", scope: "admin" }]]), "")
      );
    }).pipe(Effect.provide(keyCrypto))
  );
});

describe(reaches, () => {
  it("AUTH-3: gives each scope everything the one below it has", () => {
    const scopes = ["read", "chat", "admin"] as const;

    assert.deepStrictEqual(
      scopes.map((scope) => scopes.filter((needed) => reaches(scope, needed))),
      [["read"], ["read", "chat"], ["read", "chat", "admin"]]
    );
  });
});
