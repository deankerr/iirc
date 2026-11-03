import { BunServices } from "@effect/platform-bun";
import { assert } from "@effect/vitest";
import type { LogEntry } from "@iirc/api";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { nextAttempt, noStanding, reduceStanding } from "@iirc/session/standing";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { appRoot } from "./binary.ts";

/**
 * How long a build may take, far past what it needs: it compiles the whole app, and
 * every test file builds a binary of its own, at once, on a machine that may be busy.
 */
export const buildTimeout = 180_000;

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

/**
 * What LIVE-4 lets the Nth failure in a row wait, at the least: the first half of its
 * delay, because jitter only moves it within the upper half.
 * @param failures - How many have failed in a row.
 * @param tuning - The Network's Tuning.
 * @returns The shortest wait, in milliseconds.
 */
export const shortestWait = (
  failures: number,
  { reconnectInitialMillis, reconnectMaxMillis }: Tuning
) => Math.ceil(Math.min(reconnectInitialMillis * 2 ** (failures - 1), reconnectMaxMillis) / 2);

/**
 * Checks that every `attempt` after a run that was killed waited as long as it should.
 * `nextAttempt` is what the Daemon obeys, and the floor beneath it comes from the spec's
 * own numbers, or a broken `nextAttempt` would pass itself.
 * @param entries - The whole Log, with every run before the last ending in a kill.
 * @param tuningOf - The Tuning in force for an `attempt`, counting from 0.
 */
export const assertBackoff = (
  entries: readonly LogEntry[],
  tuningOf: (attempt: number) => Tuning
) => {
  let standing = noStanding;
  let failures = 0;
  let previous: LogEntry | undefined;

  for (const entry of entries) {
    if (entry._tag === "Connection" && entry.phase === "attempt") {
      const tuning = tuningOf(failures);
      const label = `attempt ${failures + 1}, Entry ${entry.sequence}`;

      if (failures > 0) {
        assert.isAtLeast(
          entry.at,
          nextAttempt(standing, { ircds: [entry.ircd], tuning }).at,
          `${label} came before Standing allowed it`
        );
        assert.isAtLeast(
          entry.at - (previous?.at ?? 0),
          shortestWait(failures, tuning),
          `${label} did not wait out the first half of its delay`
        );
      }

      failures += 1;
    }

    // A `started` Entry comes after the kill, and is no part of what was killed.
    previous = entry._tag === "Daemon" ? previous : entry;
    standing = reduceStanding(standing, entry);
  }
};
