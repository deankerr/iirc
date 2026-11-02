import type { Tuning } from "@iirc/lifecycle/tuning";
import { joinLines } from "@iirc/protocol/join";
import type { OutboundLine } from "@iirc/protocol/outbound";
import { Clock, Duration, Effect, Queue } from "effect";

import type { RecordFailed } from "./recorder.ts";
import { joinPlan } from "./standing.ts";
import type { Standing, WantedChannel } from "./standing.ts";

/** What a reconciler needs from its Connection. */
export interface Reconciling {
  readonly channels: readonly WantedChannel[];
  /** Queues a Line, waits for room, and says whether it was written. */
  readonly join: (line: OutboundLine) => Effect.Effect<boolean>;
  /** Each item says that Standing moved in a way that could bring a retry forward. */
  readonly moved: Queue.Dequeue<void>;
  readonly standing: Effect.Effect<Standing, RecordFailed>;
  readonly tuning: Tuning;
}

/**
 * Carries out `joinPlan` from the end of the burst until the Connection ends (LIVE-7,
 * LIVE-8). It holds no plan: it asks for one, sends one `JOIN` Line of it, waits for the
 * outcome, and asks again. A `JOIN` only counts as asked once recorded, so a plan kept
 * while its Lines wait in the lane would be sent again, and a Channel the Ircd puts us
 * in meanwhile would be asked for needlessly.
 * @param reconciling - The Channels wanted, and how to reach the Connection.
 * @returns An effect that ends when a Line could not be written, as happens when the
 * Connection closes, and fails if Standing cannot be read.
 */
export const reconcile = ({ channels, join, moved, standing, tuning }: Reconciling) =>
  Effect.gen(function* () {
    let joining = true;

    // A Network that kept us attached replays its `JOIN`s just after the burst, in reads of
    // their own, and those Channels are not to be joined again (LIVE-7).
    yield* Effect.sleep(Duration.millis(tuning.rejoinSettleMillis));

    while (joining) {
      const now = yield* Clock.currentTimeMillis;
      const plan = joinPlan(yield* standing, channels, now, tuning);
      const [line] = joinLines(plan.channels).lines;

      if (line !== undefined) {
        joining = yield* join(line);
      } else if (plan.lookAgainAt === undefined) {
        yield* Queue.take(moved);
      } else {
        yield* Effect.raceFirst(
          Queue.take(moved),
          Effect.sleep(Duration.millis(plan.lookAgainAt - now))
        );
      }
    }
  });
