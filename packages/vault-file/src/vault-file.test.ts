import { inspect } from "node:util";

import { BunFileSystem } from "@effect/platform-bun";
import { CredentialName } from "@iirc/protocol/line";
import { holds, vaultLaws } from "@iirc/runtime/testing";
import { Vault } from "@iirc/runtime/vault";
import type { VaultService } from "@iirc/runtime/vault";
import { Context, Effect, FileSystem, Layer, Logger, Redacted, References, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it, vi } from "vitest";

import { layerBun } from "./index.ts";

// A law carries its own ten-second guard against a hang (`holds`), so Vitest must wait longer
// than that, or a law that is only slow under a loaded machine fails as Vitest's timeout.
vi.setConfig({ testTimeout: 20_000 });

const secret = "s3cr3t-v4lue-ZXCV";
const name = CredentialName.make("libera-password");
const other = CredentialName.make("oftc-password");

interface Harness {
  readonly directory: string;
  readonly file: string;
  readonly fs: FileSystem.FileSystem;
  // Opens the file again, as a second start of the Daemon would.
  readonly open: Effect.Effect<VaultService, never, Scope.Scope>;
  readonly vault: VaultService;
}

const openOn = (build: Layer.Layer<Vault>) =>
  Effect.map(Layer.build(build), (context) => Context.get(context, Vault));

// A fresh directory with a file path in it, removed when the Scope closes.
const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "iirc-vault-file-" });
  const file = `${directory}/credentials.json`;
  const open = openOn(layerBun(file));

  return { directory, file, fs, open, vault: yield* open } satisfies Harness;
});

const run = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
  await Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(BunFileSystem.layer)));

const withHarness = async <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>
) => await run(harness.pipe(Effect.flatMap(body)));

const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

const readDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ credentials: Schema.Record(Schema.String, Schema.String) }))
);

const mode = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(Effect.map((info) => info.mode % 0o1000));

describe("the file Vault keeps the Vault laws", () => {
  it.each(vaultLaws)("$name", async (law) => {
    await expect(
      run(
        holds(
          law,
          harness.pipe(
            Effect.map(({ vault }) => vault),
            Effect.provide(BunFileSystem.layer)
          )
        )
      )
    ).resolves.toBeUndefined();
  });
});

describe("the file", () => {
  it("is created with mode 0600 on the first hold", async () => {
    const result = await withHarness(({ file, fs, vault }) =>
      Effect.gen(function* () {
        const before = yield* fs.exists(file);

        yield* vault.hold(name, Redacted.make(secret));

        return { before, mode: yield* mode(fs, file) };
      })
    );

    expect(result).toStrictEqual({ before: false, mode: 0o600 });
  });

  it("stays mode 0600 when it replaces a file that was more open", async () => {
    const result = await withHarness(({ file, fs, vault }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, '{"version":1,"credentials":{}}', { mode: 0o644 });
        yield* fs.chmod(file, 0o644);
        yield* vault.hold(name, Redacted.make(secret));

        return yield* mode(fs, file);
      })
    );

    expect(result).toBe(0o600);
  });

  it("is a versioned JSON document", async () => {
    const text = await withHarness(({ file, fs, vault }) =>
      Effect.gen(function* () {
        yield* vault.hold(name, Redacted.make(secret));
        yield* vault.hold(other, Redacted.make("two"));

        return yield* fs.readFileString(file);
      })
    );

    expect(JSON.parse(text)).toStrictEqual({
      credentials: { "libera-password": secret, "oftc-password": "two" },
      version: 1,
    });
  });

  it("means an empty Vault when it is missing, and is not made by reading", async () => {
    const result = await withHarness(({ file, fs, vault }) =>
      Effect.gen(function* () {
        const names = yield* vault.names;
        const missing = yield* failure(vault.reveal(name));

        yield* vault.forget(name);

        return { exists: yield* fs.exists(file), missing: missing._tag, names: [...names] };
      })
    );

    expect(result).toStrictEqual({ exists: false, missing: "CredentialMissing", names: [] });
  });

  it("is read again by a later start", async () => {
    const value = await withHarness(({ open, vault }) =>
      Effect.gen(function* () {
        yield* vault.hold(name, Redacted.make(secret));
        yield* vault.hold(other, Redacted.make("two"));
        yield* vault.forget(other);

        const again = yield* open;

        return {
          names: [...(yield* again.names)],
          value: Redacted.value(yield* again.reveal(name)),
        };
      })
    );

    expect(value).toStrictEqual({ names: [name], value: secret });
  });

  it("leaves no temporary file behind, even from an earlier crash", async () => {
    const files = await withHarness(({ directory, file, fs, vault }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${file}.tmp`, "half a vault", { mode: 0o644 });
        yield* vault.hold(name, Redacted.make(secret));
        yield* vault.forget(name);
        yield* vault.hold(other, Redacted.make("two"));

        return yield* fs.readDirectory(directory);
      })
    );

    expect(files).toStrictEqual(["credentials.json"]);
  });
});

describe("a directory that does not exist", () => {
  const missingDirectory = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "iirc-vault-file-" });
    const inside = `${directory}/not-made`;
    const vault = yield* openOn(layerBun(`${inside}/credentials.json`));

    return { fs, inside, vault };
  });

  it("fails every call with VaultFailed, and is not created", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { fs, inside, vault } = yield* missingDirectory;
        const held = yield* failure(vault.hold(name, Redacted.make(secret)));
        const revealed = yield* failure(vault.reveal(name));
        const names = yield* failure(vault.names);

        return {
          created: yield* fs.exists(inside),
          tags: [held._tag, revealed._tag, names._tag],
        };
      })
    );

    expect(result).toStrictEqual({
      created: false,
      tags: ["VaultFailed", "VaultFailed", "VaultFailed"],
    });
  });

  it("is a Vault again once the Owner makes the directory", async () => {
    const value = await run(
      Effect.gen(function* () {
        const { fs, inside, vault } = yield* missingDirectory;

        yield* failure(vault.hold(name, Redacted.make(secret)));
        yield* fs.makeDirectory(inside);
        yield* vault.hold(name, Redacted.make(secret));

        return Redacted.value(yield* vault.reveal(name));
      })
    );

    expect(value).toBe(secret);
  });
});

describe("a file that is not a Vault", () => {
  const bad = [
    ["not JSON", `hunter2 ${secret}`],
    ["a different version", `{"version":2,"credentials":{"${name}":"${secret}"}}`],
    ["no version", `{"credentials":{"${name}":"${secret}"}}`],
    ["a value that is not a string", `{"version":1,"credentials":{"${name}":["${secret}"]}}`],
    ["a list", `["${secret}"]`],
    ["something other than a Vault", `{"version":1,"credentials":"${secret}"}`],
  ] as const;

  it.each(bad)("is VaultFailed with no value in its reason: %s", async (_what, text) => {
    const result = await withHarness(({ file, fs, vault }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, text);

        const errors = [
          yield* failure(vault.reveal(name)),
          yield* failure(vault.names),
          yield* failure(vault.hold(name, Redacted.make("new"))),
          yield* failure(vault.forget(name)),
        ];

        return { after: yield* fs.readFileString(file), errors };
      })
    );

    for (const error of result.errors) {
      expect(error._tag).toBe("VaultFailed");
      expect(inspect(error, { depth: null })).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }

    // A file it cannot read is never overwritten.
    expect(result.after).toBe(text);
  });

  it("is read again once the Owner fixes it", async () => {
    const value = await withHarness(({ file, fs, vault }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, "oops");
        yield* failure(vault.names);
        yield* fs.writeFileString(file, `{"version":1,"credentials":{"${name}":"${secret}"}}`);

        return Redacted.value(yield* vault.reveal(name));
      })
    );

    expect(value).toBe(secret);
  });

  it("is VaultFailed when the path is a directory", async () => {
    const tag = await withHarness(({ file, fs, vault }) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(file);

        return (yield* failure(vault.names))._tag;
      })
    );

    expect(tag).toBe("VaultFailed");
  });
});

describe("concurrent changes", () => {
  it("never lose an update", async () => {
    const result = await withHarness(({ file, fs, open, vault }) =>
      Effect.gen(function* () {
        const names = Array.from({ length: 60 }, (_unused, index) =>
          CredentialName.make(`network-${index}`)
        );

        yield* Effect.forEach(
          names,
          (each, index) =>
            Effect.andThen(
              vault.hold(each, Redacted.make(`value-${index}`)),
              // Every third one is forgotten straight after, racing the holds of the rest.
              index % 3 === 0 ? vault.forget(each) : Effect.void
            ),
          { concurrency: "unbounded", discard: true }
        );

        const kept = names.filter((_each, index) => index % 3 !== 0);
        const again = yield* open;

        const onDisk = readDocument(yield* fs.readFileString(file));

        return {
          disk: Object.keys(onDisk.credentials).toSorted(),
          expected: [...kept].toSorted(),
          fromDisk: [...(yield* again.names)].toSorted(),
          held: [...(yield* vault.names)].toSorted(),
        };
      })
    );

    expect(result.held).toStrictEqual(result.expected);
    expect(result.disk).toStrictEqual(result.expected);
    expect(result.fromDisk).toStrictEqual(result.expected);
  });

  it("keep the last of many holds of one name", async () => {
    const value = await withHarness(({ vault }) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          ["a", "b", "c", "d", "e"],
          (each) => vault.hold(name, Redacted.make(each)),
          { concurrency: "unbounded", discard: true }
        );

        return Redacted.value(yield* vault.reveal(name));
      })
    );

    expect(value).toBe("e");
  });
});

describe("a value", () => {
  it("never appears in an error, a log, or a rendering of the Vault", async () => {
    const lines: string[] = [];

    const capture = Logger.make<unknown, undefined>((options) => {
      lines.push(inspect(options, { depth: null }));
    });

    const shown = await run(
      // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.flatMap takes the effect first; it has no thisArg.
      Effect.flatMap(harness, ({ directory, file, fs, vault }) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("before");
          yield* vault.hold(name, Redacted.make(secret));

          const value = yield* vault.reveal(name);
          const names = yield* vault.names;
          const missing = yield* failure(vault.reveal(other));

          yield* fs.writeFileString(file, `{"version":9,"credentials":{"${name}":"${secret}"}}`);

          const broken = yield* failure(
            Effect.scoped(openOn(layerBun(file)).pipe(Effect.flatMap((again) => again.names)))
          );

          const nowhere = yield* openOn(layerBun(`${directory}/missing/credentials.json`));
          const unwritable = yield* failure(nowhere.hold(name, Redacted.make(secret)));

          yield* Effect.logDebug("after");

          return [vault, value, names, missing, broken, unwritable].flatMap((each) => [
            // oxlint-disable-next-line typescript/no-base-to-string -- Its default rendering is what is under test.
            String(each),
            inspect(each, { depth: null, showHidden: true }),
            JSON.stringify(each),
          ]);
        })
      ).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "All")
      )
    );

    expect(shown.length).toBeGreaterThan(0);
    expect(shown.join("\n")).not.toContain(secret);

    // The Logger saw every level, and so the check above is not empty.
    expect(lines.join("\n")).toContain("before");
    expect(lines.join("\n")).not.toContain(secret);
  });
});
