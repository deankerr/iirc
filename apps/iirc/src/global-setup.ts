import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { TestProject } from "vitest/node";

import { appRoot, testBinary } from "./binary.ts";

// Builds the binary the way a release does. It is always rebuilt, and gone first, so no
// stale binary can pass in its place.
const buildBinary = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* fileSystem.remove(testBinary, { force: true });

  const code = yield* spawner.exitCode(
    ChildProcess.make(process.execPath, ["run", "build", "--outfile", testBinary], {
      cwd: appRoot,
    })
  );

  yield* Number(code) === 0
    ? Effect.void
    : Effect.die(new Error(`the binary did not build: exit code ${Number(code)}`));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/**
 * Builds the binary once for the whole run. Every test file that runs it would otherwise
 * build one of its own, at the same time, and a build takes several times as long on a
 * busy machine as on a quiet one. Watch mode runs this setup only once, so it builds again
 * before every rerun, or a rerun would test the binary of the first run.
 * @param project - The project under test, for its reruns.
 */
export default async function setup(project: TestProject) {
  await Effect.runPromise(buildBinary);

  project.onTestsRerun(async () => {
    await Effect.runPromise(buildBinary);
  });
}
