/**
 * API keys. A key is 256 random bits, given to the Owner once, and kept only as its
 * SHA-256 in `keys.json` in the data directory, written atomically with mode `0600`.
 *
 * @packageDocumentation
 */
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import type { Redacted } from "effect";
import { Digest } from "effect/crypto";

import { readIfPresent, writeAtomically } from "./files.ts";
import { makeToken, matching, Sha256Hex } from "./tokens.ts";

/** A key's name, which says whose it is, such as `phone` or `agent`. */
export const KeyName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u, {
    message:
      "must be 1 to 64 lower-case letters, digits, `.`, `_`, or `-`, starting with a letter or digit",
  })
);

/** One key as stored: its name, the SHA-256 of the key as hex, and when it was made. */
const StoredKey = Schema.Struct({ created: Schema.String, name: KeyName, sha256: Sha256Hex });

// Versioned JSON. A later format is a new version, never a reinterpretation of this one.
const KeysFile = Schema.fromJsonString(
  Schema.Struct({ keys: Schema.Array(StoredKey), version: Schema.Literal(1) }),
  { space: 2 }
);

const decodeKeysFile = Schema.decodeUnknownOption(KeysFile);
const encodeKeysFile = Schema.encodeSync(KeysFile);

/** `keys.json` could not be read, or is not a version 1 keys file. */
export class KeysUnreadable extends Schema.TaggedError<
  KeysUnreadable,
  { readonly brand: unique symbol }
>()("KeysUnreadable", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** `keys.json` could not be written. Nothing was changed. */
export class KeysUnwritable extends Schema.TaggedError<
  KeysUnwritable,
  { readonly brand: unique symbol }
>()("KeysUnwritable", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** A key by this name already exists. */
export class KeyExists extends Schema.TaggedError<KeyExists, { readonly brand: unique symbol }>()(
  "KeyExists",
  {
    key: Schema.String,
  }
) {}

const keysPath = (dataDir: string) => `${dataDir}/keys.json`;

/**
 * The keys in a data directory. A missing file holds none.
 * @param dataDir - The data directory.
 * @returns Every key stored.
 */
const readKeys = (dataDir: string) =>
  Effect.gen(function* () {
    const path = keysPath(dataDir);

    // Only a fixed phrase or the platform's own message, never what a decoder says about
    // the text, which would quote a hash.
    const text = yield* readIfPresent(path, (reason) => new KeysUnreadable({ path, reason }));

    if (Option.isNone(text)) {
      return [];
    }

    const file = decodeKeysFile(text.value);

    return Option.isSome(file)
      ? file.value.keys
      : yield* new KeysUnreadable({ path, reason: "it is not a version 1 keys file" });
  });

/**
 * Makes a key and stores its hash. Call it with the data directory held, so no Daemon is
 * reading the file.
 * @param dataDir - The data directory, which must exist.
 * @param name - The key's name.
 * @returns The key, which nothing will show again.
 */
export const createKey = (dataDir: string, name: typeof KeyName.Type) =>
  Effect.gen(function* () {
    const stored = yield* readKeys(dataDir);

    if (stored.some((key) => key.name === name)) {
      return yield* new KeyExists({ key: name });
    }

    const { sha256, token } = yield* makeToken("iirc_");
    const created = DateTime.formatIso(yield* DateTime.now);
    const path = keysPath(dataDir);

    yield* writeAtomically(
      dataDir,
      path,
      encodeKeysFile({ keys: [...stored, { created, name, sha256 }], version: 1 }),
      (reason) => new KeysUnwritable({ path, reason })
    );

    return token;
  });

/** A key held: its name, and its SHA-256 as hex, which says exactly which key it is. */
export interface HeldKey {
  readonly name: string;
  readonly sha256: string;
}

/** Checks the keys a request presents. */
export class ApiKeys extends Context.Service<
  ApiKeys,
  {
    /** The key presented, if it is one. */
    readonly verify: (presented: Redacted.Redacted) => Effect.Effect<Option.Option<HeldKey>>;
    /** The name of the key with this SHA-256, if it is still held. */
    readonly holding: (sha256: string) => Option.Option<string>;
  }
>()("@iirc/daemon/ApiKeys") {
  /**
   * The keys in `keys.json`, read once at start. Keys are created only while the Daemon
   * is stopped, so the file cannot change under it.
   * @param dataDir - The data directory.
   * @returns The service.
   */
  static readonly layer = (dataDir: string) =>
    Layer.effect(
      ApiKeys,
      Effect.gen(function* () {
        const stored = yield* readKeys(dataDir);
        const digest = yield* Digest.Digest;

        if (stored.length === 0) {
          yield* Effect.logWarning(
            "No API keys, so every request is refused. Create one with `iirc key create` while the Daemon is stopped.",
            { dataDir }
          );
        }

        const names = new Map(stored.map((key) => [key.sha256, key.name]));

        return {
          holding: (sha256) => Option.fromNullishOr(names.get(sha256)),
          verify: (presented) =>
            matching(stored, presented).pipe(
              Effect.map(Option.map(({ name, sha256 }) => ({ name, sha256 }))),
              Effect.provideService(Digest.Digest, digest)
            ),
        };
      })
    );
}
