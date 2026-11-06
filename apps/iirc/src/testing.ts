import { assert } from "@effect/vitest";
import type { LogEntry } from "@iirc/api";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { nextAttempt, noStanding, reduceStanding } from "@iirc/session/standing";

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
