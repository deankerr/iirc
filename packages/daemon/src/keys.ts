/**
 * API keys. A key is 256 random bits, given to the Owner once, and kept only as its
 * SHA-256 in `keys.json` in the data directory, written atomically with mode `0600`.
 *
 * @packageDocumentation
 */
// `node:crypto` for `timingSafeEqual`, which `effect/crypto` does not offer.
import { timingSafeEqual } from "node:crypto";

import { Context, DateTime, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import type { PlatformError } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

/** A key's name, which says whose it is, such as `phone` or `agent`. */
export const KeyName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u, {
    message:
      "must be 1 to 64 lower-case letters, digits, `.`, `_`, or `-`, starting with a letter or digit",
  })
);

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** One key as stored: its name, the SHA-256 of the key as hex, and when it was made. */
const StoredKey = Schema.Struct({ created: Schema.String, name: KeyName, sha256: Sha256Hex });

type StoredKey = typeof StoredKey.Type;

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

const mode = 0o600;

const keysPath = (dataDir: string) => `${dataDir}/keys.json`;

/**
 * The keys in a data directory. A missing file holds none.
 * @param dataDir - The data directory.
 * @returns Every key stored.
 */
const readKeys = (dataDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = keysPath(dataDir);

    // Only a fixed phrase or the platform's own message, never what a decoder says about
    // the text, which would quote a hash.
    const text = yield* fs.readFileString(path).pipe(
      Effect.asSome,
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(new KeysUnreadable({ path, reason: error.message }))
      )
    );

    if (Option.isNone(text)) {
      return [];
    }

    const file = decodeKeysFile(text.value);

    return Option.isSome(file)
      ? file.value.keys
      : yield* new KeysUnreadable({ path, reason: "it is not a version 1 keys file" });
  });

/**
 * Writes every key to a temporary file beside `keys.json`, syncs it, and renames it into
 * place, as vault-file writes. A crash leaves the old file or the new one.
 * @param dataDir - The data directory.
 * @param keys - Every key to keep.
 * @returns An Effect that fails with nothing changed, or replaces the file.
 */
const writeKeys = (dataDir: string, keys: readonly StoredKey[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = keysPath(dataDir);
    const temporary = `${path}.tmp`;
    const removeTemporary = fs.remove(temporary, { force: true }).pipe(Effect.ignoreCause);

    const stage = Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporary, { flag: "wx", mode });

        yield* file.writeAll(new TextEncoder().encode(encodeKeysFile({ keys, version: 1 })));
        yield* file.sync;
      })
    );

    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* removeTemporary;
        yield* stage;
        yield* fs.rename(temporary, path);
        yield* Effect.scoped(
          Effect.flatMap(fs.open(dataDir, { flag: "r" }), (dir) => dir.sync)
        ).pipe(Effect.ignoreCause);
      }).pipe(
        Effect.onError(() => removeTemporary),
        Effect.mapError(
          (error: PlatformError.PlatformError) =>
            new KeysUnwritable({ path, reason: error.message })
        ),
        Effect.catchDefect(() =>
          Effect.fail(new KeysUnwritable({ path, reason: "the file system failed" }))
        )
      )
    );
  });

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

const encoder = new TextEncoder();

const hashOf = (key: string) =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;

    return yield* digest.digest(Digest.sha256, encoder.encode(key));
  });

/**
 * Compares two SHA-256 digests in time that does not depend on where they differ.
 * @param left - One digest.
 * @param right - The other.
 * @returns Whether they are equal.
 */
const equalDigests = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

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

    const random = yield* SecureRandom.SecureRandom;
    const bytes = yield* random.randomBytes(32);
    const key = `iirc_${Buffer.from(bytes).toString("base64url")}`;
    const sha256 = toHex(yield* hashOf(key));
    const created = DateTime.formatIso(yield* DateTime.now);

    yield* writeKeys(dataDir, [...stored, { created, name, sha256 }]);

    return Redacted.make(key);
  });

/** Checks the keys a request presents. */
export class ApiKeys extends Context.Service<
  ApiKeys,
  {
    /** The name of the key presented, if it is one. */
    readonly verify: (presented: Redacted.Redacted) => Effect.Effect<Option.Option<string>>;
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

        const hashes = stored.map((key) => ({ hash: fromHex(key.sha256), name: key.name }));

        return {
          verify: (presented) =>
            Effect.map(
              digest.digest(Digest.sha256, encoder.encode(Redacted.value(presented))),
              (hash) => {
                // Every stored hash is compared, so the time taken says nothing of which matched.
                let found: string | undefined;

                for (const key of hashes) {
                  if (equalDigests(hash, key.hash)) {
                    found = key.name;
                  }
                }

                return Option.fromNullishOr(found);
              }
            ),
        };
      })
    );
}
