import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { CredentialName } from "@iirc/protocol/line";
import { CredentialMissing, Vault, VaultFailed } from "@iirc/runtime/vault";
import type { VaultService } from "@iirc/runtime/vault";
import { Effect, FileSystem, Layer, Path, Redacted, Ref, Schema, Semaphore } from "effect";

// The file is versioned JSON. A later format is a new version, never a reinterpretation.
const VaultFile = Schema.fromJsonString(
  Schema.Struct({
    credentials: Schema.Record(CredentialName, Schema.String),
    version: Schema.Literal(1),
  }),
  { space: 2 }
);

const readVaultFile = Schema.decodeUnknownOption(VaultFile);
const writeVaultFile = Schema.encodeSync(VaultFile);

type Held = ReadonlyMap<CredentialName, Redacted.Redacted>;

// Only ever a fixed phrase, a path, or the platform's own message, which names a syscall and
// a path. Never what a decoder says about the text it was given, which quotes it.
const failed = (reason: string) => new VaultFailed({ reason });

const mode = 0o600;

const fail = (what: string) => (error: { readonly message: string }) =>
  failed(`${what}: ${error.message}`);

const make = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const loaded = yield* Ref.make<Held | undefined>(undefined);

    const directory = paths.dirname(path);
    const temporary = `${path}.tmp`;

    const parse = (text: string) => {
      const file = readVaultFile(text);

      return file._tag === "Some"
        ? Effect.succeed<Held>(
            new Map(
              Object.entries(file.value.credentials).map(
                ([name, value]) => [CredentialName.make(name), Redacted.make(value)] as const
              )
            )
          )
        : Effect.fail(failed(`${path} is not a version 1 vault file`));
    };

    // A missing file is an empty Vault, but only in a directory that exists.
    const empty = Effect.flatMap(fs.exists(directory), (exists) =>
      exists
        ? Effect.succeed<Held>(new Map())
        : Effect.fail(failed(`the directory ${directory} does not exist`))
    );

    const read = fs.readFileString(path).pipe(
      Effect.flatMap(parse),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? empty : Effect.fail(fail("read")(error))
      ),
      Effect.catchTag("PlatformError", (error) => Effect.fail(fail("read")(error)))
    );

    // Only a successful load is kept, so a bad file that the Owner fixes is read again.
    const current = Effect.gen(function* () {
      const held = yield* Ref.get(loaded);

      if (held !== undefined) {
        return held;
      }

      const fresh = yield* read;

      yield* Ref.set(loaded, fresh);

      return fresh;
    });

    const stage = (text: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporary, { flag: "wx", mode });

          yield* file.writeAll(new TextEncoder().encode(text));
          yield* file.sync;
        })
      );

    // A directory that cannot be synced leaves the new file in place. Only a power cut can
    // then lose the rename, which the next start reads as the Vault before it.
    const syncDirectory = Effect.scoped(
      Effect.flatMap(fs.open(directory, { flag: "r" }), (dir) => dir.sync)
    ).pipe(Effect.ignore);

    const removeTemporary = fs.remove(temporary, { force: true }).pipe(Effect.ignore);

    // Writes the whole Vault beside the file, then renames it into place. A crash leaves
    // the old file or the new one, never half of either.
    const save = (next: Held) =>
      Effect.gen(function* () {
        const credentials = Object.fromEntries(
          [...next].map(([name, value]) => [name, Redacted.value(value)])
        );

        yield* removeTemporary;
        yield* stage(writeVaultFile({ credentials, version: 1 }));
        yield* fs.rename(temporary, path);
        yield* syncDirectory;
      }).pipe(
        Effect.onError(() => removeTemporary),
        Effect.mapError(fail("write"))
      );

    // The memory changes only once the file has, and a change is never interrupted between
    // the two.
    const replace = (next: Held) =>
      Effect.uninterruptible(Effect.andThen(save(next), Ref.set(loaded, next)));

    const locked = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermit(effect);

    const service: VaultService = {
      forget: (name) =>
        locked(
          Effect.gen(function* () {
            const held = yield* current;

            if (held.has(name)) {
              yield* replace(new Map([...held].filter(([other]) => other !== name)));
            }
          })
        ),
      hold: (name, value) =>
        locked(
          Effect.gen(function* () {
            const held = yield* current;

            yield* replace(new Map(held).set(name, value));
          })
        ),
      names: locked(current.pipe(Effect.map((held) => new Set(held.keys())))),
      reveal: (name) =>
        locked(
          current.pipe(
            Effect.flatMap((held) => {
              const value = held.get(name);

              return value === undefined
                ? Effect.fail(new CredentialMissing({ credential: name }))
                : Effect.succeed(value);
            })
          )
        ),
    };

    return service;
  });

/**
 * A Vault held in the file at `path`, on the platform's `FileSystem` and `Path`. The
 * file's directory must exist, and the file need not. The file is read when first needed.
 * @param path - Where the file is, or will be.
 * @returns The Vault port.
 */
export const layer = (path: string): Layer.Layer<Vault, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Vault, make(path));

/**
 * {@link layer} on Bun's `FileSystem` and `Path`, for the composition root.
 * @param path - Where the file is, or will be.
 * @returns The Vault port.
 */
export const layerBun = (path: string): Layer.Layer<Vault> =>
  layer(path).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)));
