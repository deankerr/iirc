import type { Log, StorageFailed } from "@iirc/log";
import type { NewEntry } from "@iirc/session/entry";
import type { Recorder } from "@iirc/session/recorder";
import { Data, Effect, Result } from "effect";

import { decodeChange, encodeChange, networkOf } from "./change.ts";
import type { Change } from "./change.ts";
import { noConfiguration, reduceConfiguration } from "./configuration.ts";
import type { Configuration } from "./configuration.ts";

// As many Changes as are held in memory at once. Each holds a Network's settings whole,
// and those can run to a megabyte.
const pageSize = 100;

/**
 * A Change in the Log that this Daemon cannot read, which it will not start past, because
 * Configuration without it would not be what the Owner asked for (CONF-1).
 */
export class UndecodableChange extends Data.TaggedError("UndecodableChange")<{
  readonly reason: string;
  readonly sequence: number;
}> {
  override readonly message = `The Change at sequence ${this.sequence} cannot be read, so the Daemon will not start: ${this.reason}`;
}

/**
 * Folds every Change in the Log into Configuration, a page at a time on the writer's own
 * connection. Only startup and `iirc key create` do this, when nothing else appends, so
 * no read budget applies, and a long history only takes longer (CONF-1, RUN-3).
 * @param log - The Log.
 * @returns Configuration as the Log has it, or the first Change that cannot be read.
 */
export const readConfiguration = (
  log: Log["Service"]
): Effect.Effect<Configuration, StorageFailed | UndecodableChange> =>
  Effect.gen(function* () {
    let configuration = noConfiguration;
    let after = 0;
    let full = false;

    do {
      const entries = yield* log.changes({ after, limit: pageSize });

      for (const { at, change, sequence } of entries) {
        const decoded = decodeChange(change);

        if (Result.isFailure(decoded)) {
          return yield* new UndecodableChange({ reason: decoded.failure.message, sequence });
        }

        configuration = reduceConfiguration(configuration, {
          at,
          change: decoded.success,
          sequence,
        });
      }

      full = entries.length === pageSize;
      after = entries.at(-1)?.sequence ?? after;
    } while (full);

    return configuration;
  });

/**
 * Records one Change and folds it, in the same transaction, so what is returned is
 * Configuration exactly as of that Entry.
 * @param record - The Recorder's `record`.
 * @param current - Configuration before the Change.
 * @param by - The key that made it, or `local` (LOG-2).
 * @param change - The Change.
 * @returns Its sequence, and Configuration after it.
 */
export const recordChange = (
  record: Recorder["Service"]["record"],
  current: Configuration,
  by: string,
  change: Change
) => {
  const network = networkOf(change);

  const entry: NewEntry = {
    _tag: "Change",
    by,
    change: encodeChange(change),
    ...(network !== undefined && { network }),
  };

  return record([entry], ([{ at, sequence }]) => ({
    after: reduceConfiguration(current, { at, change, sequence }),
    sequence,
  }));
};
