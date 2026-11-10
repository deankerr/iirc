import { BunFileSystem } from "@effect/platform-bun";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Redacted } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { describe, expect, it } from "vitest";

import { ApiKeys } from "./keys.ts";
import { SignIns } from "./sign-ins.ts";
import { makeKey, storedSignIns, temporaryDirectory } from "./testing/world.ts";

/** Where a write is held: it has reached the rename, and waits to be let through. */
interface Gate {
  readonly reached: Deferred.Deferred<undefined>;
  readonly release: Deferred.Deferred<undefined>;
}

/** The gate the next rename waits at, if any. */
interface Hold {
  gate: Gate | undefined;
}

/**
 * The file system, whose next rename waits at a gate when one is set. The write is
 * staged and not yet in place while it waits, which is when a request can go away.
 * @param current - The gate the next rename waits at, if any.
 * @returns The Layer.
 */
const gatedFileSystem = (current: Hold) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      return {
        ...fs,
        rename: (from: string, to: string) => {
          const { gate } = current;

          return gate === undefined
            ? fs.rename(from, to)
            : Deferred.succeed(gate.reached, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
                Effect.andThen(fs.rename(from, to))
              );
        },
      };
    })
  ).pipe(Layer.provide(BunFileSystem.layer));

/**
 * Runs a test against the sign-ins of a fresh data directory, over a file system whose
 * rename can be held.
 * @param test - The test, given the service, a key's holding, the data directory, and a way to interrupt a call during its write.
 * @returns A promise of its result.
 */
const run = async <A, E>(
  test: (
    signIns: SignIns["Service"],
    held: Parameters<SignIns["Service"]["start"]>[0],
    dataDir: string,
    interruptedDuring: <B, F>(call: Effect.Effect<B, F>) => Effect.Effect<void>
  ) => Effect.Effect<A, E>
) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const current: Hold = { gate: undefined };

        const context = yield* Layer.build(
          SignIns.layer(dataDir).pipe(
            Layer.provideMerge(ApiKeys.layer(dataDir)),
            Layer.provide(
              Layer.mergeAll(
                gatedFileSystem(current),
                Digest.layerWebCrypto,
                SecureRandom.layerWebCrypto
              )
            )
          )
        );

        const signIns = yield* SignIns.pipe(Effect.provide(context));
        const keys = yield* ApiKeys.pipe(Effect.provide(context));
        const held = yield* Effect.flatMap(keys.verify(Redacted.make(key)), Effect.fromOption);

        // Starts the call, interrupts it once its write is staged, and lets the write go.
        const interruptedDuring = <B, F>(call: Effect.Effect<B, F>) =>
          Effect.gen(function* () {
            const gate: Gate = {
              reached: yield* Deferred.make<undefined>(),
              release: yield* Deferred.make<undefined>(),
            };

            current.gate = gate;
            const fiber = yield* Effect.forkChild(call);

            yield* Deferred.await(gate.reached);
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));

            yield* Effect.yieldNow;
            current.gate = undefined;
            yield* Deferred.succeed(gate.release, undefined);
            yield* Fiber.join(interrupting);
          });

        return yield* test(signIns, held, dataDir, interruptedDuring);
      })
    )
  );

describe("sign-ins", () => {
  it("keeps memory and file together when a sign-out is interrupted during its write", async () => {
    const result = await run((signIns, held, dataDir, interruptedDuring) =>
      Effect.gen(function* () {
        const doomed = yield* signIns.start(held);
        const kept = yield* signIns.start(held);

        yield* interruptedDuring(signIns.end(doomed));

        const afterInterrupt = {
          doomed: Option.isSome(yield* signIns.verify(doomed)),
          file: storedSignIns(dataDir).length,
          kept: Option.isSome(yield* signIns.verify(kept)),
        };

        // A later write must not bring the signed-out token back.
        const later = yield* signIns.start(held);

        return {
          afterInterrupt,
          afterLater: {
            doomed: Option.isSome(yield* signIns.verify(doomed)),
            file: storedSignIns(dataDir).length,
            kept: Option.isSome(yield* signIns.verify(kept)),
            later: Option.isSome(yield* signIns.verify(later)),
          },
        };
      })
    );

    expect(result).toStrictEqual({
      afterInterrupt: { doomed: false, file: 1, kept: true },
      afterLater: { doomed: false, file: 2, kept: true, later: true },
    });
  });

  it("keeps memory and file together when a sign-in is interrupted during its write", async () => {
    const result = await run((signIns, held, dataDir, interruptedDuring) =>
      Effect.gen(function* () {
        const first = yield* signIns.start(held);

        // Nobody is left to receive this sign-in's token. The file holds it, and so must memory.
        yield* interruptedDuring(signIns.start(held));
        const afterInterrupt = storedSignIns(dataDir).length;
        const later = yield* signIns.start(held);

        return {
          afterInterrupt,
          afterLater: storedSignIns(dataDir).length,
          first: Option.isSome(yield* signIns.verify(first)),
          later: Option.isSome(yield* signIns.verify(later)),
        };
      })
    );

    // The interrupted sign-in is in the file and is not lost by the next write.
    expect(result).toStrictEqual({
      afterInterrupt: 2,
      afterLater: 3,
      first: true,
      later: true,
    });
  });
});
