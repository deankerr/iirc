import { BunServices } from "@effect/platform-bun";
import { assert } from "@effect/vitest";
import { DaemonApi } from "@iirc/api";
import { Effect, FileSystem, Schedule, Stream } from "effect";
import { constVoid } from "effect/Function";
import { HttpApiClient } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Where this package's sources sit above. */
export const appRoot = `${import.meta.dirname}/..`;

/** How long a build takes, far past what it needs. */
export const buildTimeout = 30_000;

/**
 * Builds the binary the way a release does. Always rebuilt, and gone first, so no stale
 * binary can pass in its place.
 * @param binary - Where to put it, which test files must not share, as they run at once.
 * @returns Nothing, once it is there.
 */
export const buildBinary = (binary: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    yield* fileSystem.remove(binary, { force: true });

    const code = yield* spawner.exitCode(
      ChildProcess.make(process.execPath, ["run", "build", "--outfile", binary], { cwd: appRoot })
    );

    assert.strictEqual(Number(code), 0, "the binary did not build");
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** Asks the kernel for a port nothing is using. */
export const freePort = Effect.acquireUseRelease(
  Effect.sync(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: constVoid } })),
  ({ port }) => Effect.succeed(port),
  (listening) =>
    Effect.sync(() => {
      listening.stop(true);
    })
);

/**
 * Starts a binary in the enclosing scope, which kills whatever is left of it, and keeps
 * everything it prints. The environment is empty so that nothing leaks in.
 * @param binary - The binary to run.
 * @param flags - Its arguments.
 * @param environment - All of its environment, but for `PATH`.
 * @returns The child, and what it has printed so far.
 */
export const startBinary = Effect.fnUntraced(function* (
  binary: string,
  flags: readonly string[],
  environment: Readonly<Record<string, string>>
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output: string[] = [];

  const child = yield* spawner.spawn(
    ChildProcess.make(binary, flags, {
      env: { PATH: process.env.PATH, ...environment },
      extendEnv: false,
    })
  );

  const reader = yield* child.all.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        output.push(text);
      })
    ),
    Effect.ignore,
    Effect.forkScoped
  );

  return { child, output: () => output.join(""), reader };
});

/**
 * Builds a client for a Daemon's API, once that API is answering.
 * @param httpPort - The Daemon's API port.
 * @returns The client.
 */
export const healthyClient = (httpPort: number) =>
  Effect.tap(
    HttpApiClient.make(DaemonApi, { baseUrl: `http://127.0.0.1:${httpPort}` }),
    ({ health }) =>
      health
        .health()
        .pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }), Effect.orDie)
  );
