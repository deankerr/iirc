/**
 * Sign-ins. A browser gives a key once and gets a sign-in, 256 random bits it
 * holds in an `HttpOnly` cookie, which the Daemon keeps only as its SHA-256 in
 * `sign-ins.json` in the data directory, written atomically with mode `0600`, so a
 * sign-in outlives a restart. A sign-in lasts until it is signed out, or its key is no
 * longer held.
 *
 * @packageDocumentation
 */
import { Context, DateTime, Effect, Layer, Option, Schema, SynchronizedRef } from "effect";
import type { FileSystem, Redacted } from "effect";
import type { Digest, SecureRandom } from "effect/crypto";

import { readIfPresent, writeAtomically } from "./files.ts";
import { ApiKeys, KeyName } from "./keys.ts";
import type { HeldKey } from "./keys.ts";
import { makeToken, matching, Sha256Hex } from "./tokens.ts";

/**
 * One sign-in as stored: the SHA-256 of its token, the name of the key it was made with
 * and that key's SHA-256, so a key made again under the same name does not inherit it,
 * and when it was made.
 */
const StoredSignIn = Schema.Struct({
  created: Schema.String,
  key: KeyName,
  keySha256: Sha256Hex,
  sha256: Sha256Hex,
});

type StoredSignIn = typeof StoredSignIn.Type;

// Versioned JSON. A later format is a new version, never a reinterpretation of this one.
const SignInsFile = Schema.fromJsonString(
  Schema.Struct({ signIns: Schema.Array(StoredSignIn), version: Schema.Literal(1) }),
  { space: 2 }
);

const decodeSignInsFile = Schema.decodeUnknownOption(SignInsFile);
const encodeSignInsFile = Schema.encodeSync(SignInsFile);

/** `sign-ins.json` could not be read, or is not a version 1 sign-ins file. */
export class SignInsUnreadable extends Schema.TaggedError<
  SignInsUnreadable,
  { readonly brand: unique symbol }
>()("SignInsUnreadable", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** `sign-ins.json` could not be written. Nothing was changed. */
export class SignInsUnwritable extends Schema.TaggedError<
  SignInsUnwritable,
  { readonly brand: unique symbol }
>()("SignInsUnwritable", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/**
 * The sign-ins in a file. A missing file holds none.
 * @param path - `sign-ins.json`.
 * @returns Every sign-in stored.
 */
const readSignIns = (path: string) =>
  Effect.gen(function* () {
    // Only a fixed phrase or the platform's own message, never what a decoder says about
    // the text, which would quote a hash.
    const text = yield* readIfPresent(path, (reason) => new SignInsUnreadable({ path, reason }));

    if (Option.isNone(text)) {
      return [];
    }

    const file = decodeSignInsFile(text.value);

    return Option.isSome(file)
      ? file.value.signIns
      : yield* new SignInsUnreadable({ path, reason: "it is not a version 1 sign-ins file" });
  });

/** Makes, checks, and ends sign-ins. */
export class SignIns extends Context.Service<
  SignIns,
  {
    /** Makes a sign-in for a key, and gives its token, which nothing will show again. */
    readonly start: (key: HeldKey) => Effect.Effect<Redacted.Redacted, SignInsUnwritable>;
    /** The name of the key a presented sign-in was made with, if it is one. */
    readonly verify: (presented: Redacted.Redacted) => Effect.Effect<Option.Option<string>>;
    /**
     * Forgets a presented sign-in, and gives the name of the key it was made with.
     * Forgetting one that does not exist does nothing.
     */
    readonly end: (
      presented: Redacted.Redacted
    ) => Effect.Effect<Option.Option<string>, SignInsUnwritable>;
  }
>()("@iirc/daemon/SignIns") {
  /**
   * The sign-ins in `sign-ins.json`, read once at start, keeping only those whose key is
   * still held. The running Daemon is the file's only writer, since it holds the data
   * directory, and writes it before each change takes effect.
   * @param dataDir - The data directory.
   * @returns The service.
   */
  static readonly layer = (dataDir: string) =>
    Layer.effect(
      SignIns,
      Effect.gen(function* () {
        const keys = yield* ApiKeys;

        const platform = yield* Effect.context<
          FileSystem.FileSystem | Digest.Digest | SecureRandom.SecureRandom
        >();

        const path = `${dataDir}/sign-ins.json`;

        const write = (signIns: readonly StoredSignIn[]) =>
          writeAtomically(
            dataDir,
            path,
            encodeSignInsFile({ signIns, version: 1 }),
            (reason) => new SignInsUnwritable({ path, reason })
          );

        const read = yield* readSignIns(path);

        const held = read.filter((signIn) => Option.isSome(keys.holding(signIn.keySha256)));

        // A sign-in whose key is gone is dropped from the file too, so no key made later
        // can bring it back.
        if (held.length !== read.length) {
          yield* write(held);
          yield* Effect.logInfo("Dropped sign-ins whose key is no longer held", {
            dropped: read.length - held.length,
          });
        }

        const signIns = yield* SynchronizedRef.make(held);

        // A change is uninterruptible from taking its turn to keeping what it wrote, the
        // write and the memory together. Were the request to go away between them, the file
        // would hold a change that memory never made, and the next write would undo it:
        // a sign-out would bring its token back. A change waits only on the changes ahead
        // of it, each of which is one bounded write.
        return {
          end: (presented) =>
            SynchronizedRef.modifyEffect(signIns, (all) =>
              Effect.gen(function* () {
                const found = yield* matching(all, presented);

                if (Option.isNone(found)) {
                  return [Option.none<string>(), all] as const;
                }

                const rest = all.filter((signIn) => signIn !== found.value);

                yield* write(rest);

                return [Option.some(found.value.key), rest] as const;
              })
            ).pipe(Effect.uninterruptible, Effect.provideContext(platform)),
          start: (key) =>
            SynchronizedRef.modifyEffect(signIns, (all) =>
              Effect.gen(function* () {
                const { sha256, token } = yield* makeToken("iirc_s_");
                const created = DateTime.formatIso(yield* DateTime.now);
                const next = [...all, { created, key: key.name, keySha256: key.sha256, sha256 }];

                yield* write(next);

                return [token, next] as const;
              })
            ).pipe(Effect.uninterruptible, Effect.provideContext(platform)),
          verify: (presented) =>
            SynchronizedRef.get(signIns).pipe(
              Effect.flatMap((all) => matching(all, presented)),
              Effect.map(Option.map((signIn) => signIn.key)),
              Effect.provideContext(platform)
            ),
        };
      })
    );
}
