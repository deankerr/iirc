import { inspect } from "node:util";

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { CredentialName } from "@iirc/protocol/line";
import { Vault } from "@iirc/runtime/vault";
import type { VaultFailed, VaultService } from "@iirc/runtime/vault";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Redacted,
} from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { layer, layerBun } from "./index.ts";

// Each value, and what a failing platform says, is distinct, so a rendering that holds
// any of them is found.
const earlier = "earlier-v4lue-QWER";
const later = "later-v4lue-ASDF";
const whatTheDefectSays = "close-defect-says-ZXCV";
const name = CredentialName.make("libera-password");
const other = CredentialName.make("oftc-password");
const third = CredentialName.make("rizon-password");

interface Gate {
  readonly at: "writeAll" | "afterRename";
  readonly reached: Deferred.Deferred<undefined>;
  readonly release: Deferred.Deferred<undefined>;
}

interface Faults {
  readonly closeDirectory: boolean;
  readonly closeTemporary: boolean;
  readonly gate: Gate | undefined;
  readonly open: boolean;
  readonly remove: boolean;
  readonly rename: boolean;
  readonly sync: boolean;
  readonly syncDirectory: boolean;
  readonly writeAll: "fail" | "half" | "whole";
}

const healthy: Faults = {
  closeDirectory: false,
  closeTemporary: false,
  gate: undefined,
  open: false,
  remove: false,
  rename: false,
  sync: false,
  syncDirectory: false,
  writeAll: "whole",
};

const broke = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", method, module: "FileSystem" });

const passThrough = (gate: Gate | undefined, at: Gate["at"]) =>
  gate?.at === at
    ? Effect.andThen(Deferred.succeed(gate.reached, undefined), Deferred.await(gate.release))
    : Effect.void;

// The platform's `FileSystem`, with the failures `faults` asks for at the write boundaries,
// and a record of the calls made.
const faulty = (
  fs: FileSystem.FileSystem,
  temporary: string,
  faults: { current: Faults },
  calls: string[]
): FileSystem.FileSystem => ({
  ...fs,
  open: (target, options) =>
    Effect.gen(function* () {
      const isTemporary = target === temporary;
      const which = isTemporary ? "temporary" : "directory";

      calls.push(`open ${which}`);

      if (isTemporary && faults.current.open) {
        return yield* broke("open");
      }

      const file = yield* fs.open(target, options);

      if (isTemporary ? faults.current.closeTemporary : faults.current.closeDirectory) {
        // Bun's `FileSystem` closes a file in a finalizer that dies when the close fails.
        yield* Effect.addFinalizer(() => Effect.die(new Error(whatTheDefectSays)));
      }

      return {
        ...file,
        sync: Effect.suspend(() => {
          calls.push(`sync ${which}`);

          return (isTemporary ? faults.current.sync : faults.current.syncDirectory)
            ? Effect.fail(broke("sync"))
            : file.sync;
        }),
        writeAll: (bytes: Uint8Array) =>
          Effect.gen(function* () {
            calls.push("writeAll");

            if (faults.current.writeAll === "fail") {
              return yield* broke("writeAll");
            }

            if (faults.current.writeAll === "half") {
              yield* file.writeAll(bytes.subarray(0, Math.floor(bytes.length / 2)));

              return yield* broke("writeAll");
            }

            yield* passThrough(faults.current.gate, "writeAll");

            return yield* file.writeAll(bytes);
          }),
      };
    }),
  remove: (target, options) =>
    Effect.suspend(() => {
      calls.push("remove");

      return faults.current.remove ? Effect.fail(broke("remove")) : fs.remove(target, options);
    }),
  rename: (from, to) =>
    Effect.gen(function* () {
      calls.push("rename");

      if (faults.current.rename) {
        return yield* broke("rename");
      }

      yield* fs.rename(from, to);

      return yield* passThrough(faults.current.gate, "afterRename");
    }),
});

const openOn = (build: Layer.Layer<Vault>) =>
  Effect.map(Layer.build(build), (context) => Context.get(context, Vault));

// A Vault on a faulty file system, holding `earlier` under `name`, in a fresh directory.
const scenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "iirc-vault-file-" });
  const file = `${directory}/credentials.json`;
  const temporary = `${file}.tmp`;
  const faults = { current: healthy };
  const calls: string[] = [];

  const platform = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, faulty(fs, temporary, faults, calls)),
    BunPath.layer
  );

  const vault = yield* openOn(layer(file).pipe(Layer.provide(platform)));

  yield* vault.hold(name, Redacted.make(earlier));
  calls.length = 0;

  const before = yield* fs.readFileString(file);

  // What a fresh start reads, on the real file system.
  const reopened = yield* openOn(layerBun(file));

  return { before, calls, directory, faults, file, fs, reopened, temporary, vault };
});

type Scenario = Effect.Success<typeof scenario>;

const run = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
  await Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(BunFileSystem.layer)));

const inScenario = async <A, E>(
  body: (scenario: Scenario) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>
) => await run(scenario.pipe(Effect.flatMap(body)));

// A Vault as `name=value` pairs.
const contents = (vault: VaultService) =>
  Effect.gen(function* () {
    const names = [...(yield* vault.names)].toSorted();

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
    return yield* Effect.forEach(names, (each) =>
      vault.reveal(each).pipe(Effect.map((value) => `${each}=${Redacted.value(value)}`))
    );
  });

// The memory of the Vault that was written to, and what a start would read from the file.
const settled = (given: Scenario) =>
  Effect.gen(function* () {
    // A start reads the file whole, or fails.
    const reread = yield* openOn(layerBun(given.file));

    return {
      disk: yield* contents(reread),
      files: (yield* given.fs.readDirectory(given.directory)).toSorted(),
      memory: yield* contents(given.vault),
      text: yield* given.fs.readFileString(given.file),
    };
  });

const rendered = (error: VaultFailed) =>
  [inspect(error, { depth: null, showHidden: true }), JSON.stringify(error), error.message].join(
    "\n"
  );

const expectNoValue = (error: VaultFailed) => {
  const shown = rendered(error);

  for (const value of [earlier, later, whatTheDefectSays]) {
    expect(shown).not.toContain(value);
  }
};

const old = [`${name}=${earlier}`];
const both = [`${name}=${earlier}`, `${other}=${later}`];

describe("a write whose temporary file fails before the rename", () => {
  const before = [
    ["opening the temporary file", { open: true }],
    ["writing it", { writeAll: "fail" }],
    ["writing half of it", { writeAll: "half" }],
    ["syncing it", { sync: true }],
    ["closing it, which is a defect", { closeTemporary: true }],
    ["renaming it", { rename: true }],
  ] as const;

  it.each(before)(
    "is VaultFailed, and leaves the old Vault whole, in the file and in memory: %s",
    async (_what, inject) => {
      const result = await inScenario((given) =>
        Effect.gen(function* () {
          given.faults.current = { ...healthy, ...inject };

          const error = yield* Effect.flip(given.vault.hold(other, Redacted.make(later)));

          return { error, ...(yield* settled(given)), before: given.before };
        })
      );

      expect(result.error._tag).toBe("VaultFailed");
      expect(result.text).toBe(result.before);
      expect(result.memory).toStrictEqual(old);
      expect(result.disk).toStrictEqual(old);
      // The temporary file is removed.
      expect(result.files).toStrictEqual(["credentials.json"]);

      expectNoValue(result.error);
    }
  );

  it("is the same for a forget", async () => {
    const result = await inScenario((given) =>
      Effect.gen(function* () {
        given.faults.current = { ...healthy, sync: true };

        const error = yield* Effect.flip(given.vault.forget(name));

        return { error: error._tag, ...(yield* settled(given)) };
      })
    );

    expect(result).toMatchObject({ disk: old, error: "VaultFailed", memory: old });
  });

  it("can be tried again once the platform recovers", async () => {
    const result = await inScenario((given) =>
      Effect.gen(function* () {
        given.faults.current = { ...healthy, writeAll: "half" };
        yield* Effect.flip(given.vault.hold(other, Redacted.make(later)));
        given.faults.current = healthy;
        yield* given.vault.hold(other, Redacted.make(later));

        return yield* settled(given);
      })
    );

    expect(result.memory).toStrictEqual(both);
    expect(result.disk).toStrictEqual(both);
    expect(result.files).toStrictEqual(["credentials.json"]);
  });
});

describe("a write whose directory fails after the rename", () => {
  const after = [
    ["closing the directory, which is a defect", { closeDirectory: true }],
    ["syncing the directory", { syncDirectory: true }],
  ] as const;

  it.each(after)("succeeds, and the memory follows the file: %s", async (_what, inject) => {
    const result = await inScenario((given) =>
      Effect.gen(function* () {
        given.faults.current = { ...healthy, ...inject };
        yield* given.vault.hold(other, Redacted.make(later));

        return yield* settled(given);
      })
    );

    expect(result.memory).toStrictEqual(both);
    expect(result.disk).toStrictEqual(both);
    expect(result.files).toStrictEqual(["credentials.json"]);
  });

  it("does not let a later write erase what was committed", async () => {
    const result = await inScenario((given) =>
      Effect.gen(function* () {
        given.faults.current = { ...healthy, closeDirectory: true };
        yield* given.vault.hold(other, Redacted.make(later));
        given.faults.current = healthy;
        yield* given.vault.hold(third, Redacted.make("third"));

        return yield* settled(given);
      })
    );

    const expected = [...both, `${third}=third`].toSorted();

    expect(result.memory).toStrictEqual(expected);
    expect(result.disk).toStrictEqual(expected);
  });

  it("does not bring a forgotten value back", async () => {
    const result = await inScenario((given) =>
      Effect.gen(function* () {
        yield* given.vault.hold(other, Redacted.make(later));
        given.faults.current = { ...healthy, closeDirectory: true };
        yield* given.vault.forget(other);
        given.faults.current = healthy;
        yield* given.vault.forget(third);
        yield* given.vault.hold(third, Redacted.make("third"));

        return yield* settled(given);
      })
    );

    const expected = [...old, `${third}=third`].toSorted();

    expect(result.memory).toStrictEqual(expected);
    expect(result.disk).toStrictEqual(expected);
  });
});

describe("the order of a write", () => {
  it("syncs the temporary file before it renames it, and then syncs the directory", async () => {
    const calls = await inScenario((given) =>
      Effect.gen(function* () {
        yield* given.vault.hold(other, Redacted.make(later));

        return given.calls;
      })
    );

    expect(calls).toStrictEqual([
      "remove",
      "open temporary",
      "writeAll",
      "sync temporary",
      "rename",
      "open directory",
      "sync directory",
    ]);
  });

  it("writes nothing for a forget of what is not held", async () => {
    const calls = await inScenario((given) =>
      Effect.gen(function* () {
        yield* given.vault.forget(other);

        return given.calls;
      })
    );

    expect(calls).toStrictEqual([]);
  });
});

describe("cleaning up the temporary file", () => {
  it("is best effort: the failure reported is the write's, and the next write removes it", async () => {
    const result = await inScenario((given) =>
      Effect.gen(function* () {
        given.faults.current = { ...healthy, remove: true, sync: true };

        const error = yield* Effect.flip(given.vault.hold(other, Redacted.make(later)));
        const left = yield* given.fs.readDirectory(given.directory);

        given.faults.current = healthy;
        yield* given.vault.hold(other, Redacted.make(later));

        return { error: error.reason, left: left.toSorted(), ...(yield* settled(given)) };
      })
    );

    expect(result.error).toContain("sync");
    expect(result.left).toStrictEqual(["credentials.json", "credentials.json.tmp"]);
    expect(result.memory).toStrictEqual(both);
    expect(result.files).toStrictEqual(["credentials.json"]);
  });

  it("leaves a stale file alone when it cannot remove it, and writes nothing", async () => {
    const result = await inScenario((given) =>
      Effect.gen(function* () {
        yield* given.fs.writeFileString(given.temporary, "half a vault");

        given.faults.current = { ...healthy, remove: true };

        const error = yield* Effect.flip(given.vault.hold(other, Redacted.make(later)));

        const failed = {
          stale: yield* given.fs.readFileString(given.temporary),
          ...(yield* settled(given)),
        };

        given.faults.current = healthy;
        yield* given.vault.hold(other, Redacted.make(later));

        return { error: error._tag, failed, healed: yield* settled(given) };
      })
    );

    expect(result.error).toBe("VaultFailed");
    expect(result.failed.stale).toBe("half a vault");
    expect([result.failed.memory, result.failed.disk]).toStrictEqual([old, old]);
    expect(result.healed.memory).toStrictEqual(both);
    expect(result.healed.files).toStrictEqual(["credentials.json"]);
  });
});

// Interrupts a `hold` while it is blocked at the gate, and lets it go only after the
// interruption has been asked for.
const interrupted = async (at: Gate["at"]) =>
  await inScenario((given) =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();

      given.faults.current = { ...healthy, gate: { at, reached, release } };

      const writing = yield* Effect.forkChild(given.vault.hold(other, Redacted.make(later)));

      yield* Deferred.await(reached);

      const interrupting = yield* Effect.forkChild(Fiber.interrupt(writing));

      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);

      given.faults.current = healthy;

      return yield* settled(given);
    })
  );

describe("a write that is interrupted", () => {
  it("while staging leaves a whole Vault, and memory that agrees with it", async () => {
    const result = await interrupted("writeAll");

    expect(result.memory).toStrictEqual(result.disk);
    expect([old, both]).toContainEqual(result.disk);
    expect(result.files).toStrictEqual(["credentials.json"]);
  });

  it("after the rename still updates the memory", async () => {
    const result = await interrupted("afterRename");

    expect(result.disk).toStrictEqual(both);
    expect(result.memory).toStrictEqual(both);
    expect(result.files).toStrictEqual(["credentials.json"]);
  });
});
