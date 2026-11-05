import type { Tuning } from "@iirc/lifecycle/tuning";
import type { OutboundLine } from "@iirc/protocol/outbound";
import { Clock, Duration, Effect, Queue } from "effect";

import { joinSensitive, keyedJoins } from "./credentials.ts";
import type { Secrets, Sensitive } from "./redact.ts";
import { joinPlan } from "./standing.ts";
import type { Standing, WantedChannel } from "./standing.ts";

/** What a reconciler needs from its Connection. */
export interface Reconciling {
  /** The Channels wanted now, read for every plan, so a change reaches a Session (LIVE-8). */
  readonly channels: Effect.Effect<readonly WantedChannel[]>;
  /**
   * Queues a Line, waits for room, and says whether it was written. A `JOIN` that carries
   * keys comes with what the Log records in its place (LOG-6).
   */
  readonly join: (line: OutboundLine, sensitive: Sensitive | undefined) => Effect.Effect<boolean>;
  /** Each item says that Standing or the Channels wanted moved, which could change a plan. */
  readonly moved: Queue.Dequeue<void>;
  /** Every Credential there is, read for every `JOIN`, so a key set since is used (CRED-4). */
  readonly secrets: Effect.Effect<Secrets>;
  readonly standing: Effect.Effect<Standing>;
  readonly tuning: Tuning;
}

/**
 * Carries out `joinPlan` from the end of the burst until the Connection ends (LIVE-7,
 * LIVE-8). It holds no plan: it asks for one, sends one `JOIN` Line of it, waits for the
 * outcome, and asks again. A `JOIN` only counts as asked once recorded, so a plan kept
 * while its Lines wait in the lane would be sent again, and a Channel the Ircd puts us
 * in meanwhile would be asked for needlessly. Each key is read from its Credential as the
 * Line is built, and a Channel whose key is not set is joined without one (CRED-4).
 * @param reconciling - The Channels wanted, and how to reach the Connection.
 * @returns An effect that ends when a Line could not be written, as happens when the
 * Connection closes.
 */
export const reconcile = ({ channels, join, moved, secrets, standing, tuning }: Reconciling) =>
  Effect.gen(function* () {
    let joining = true;

    // A Network that kept us attached replays its `JOIN`s just after the burst, in reads of
    // their own, and those Channels are not to be joined again (LIVE-7).
    yield* Effect.sleep(Duration.millis(tuning.rejoinSettleMillis));

    while (joining) {
      const now = yield* Clock.currentTimeMillis;
      const plan = joinPlan(yield* standing, yield* channels, now, tuning);
      const [batch] = keyedJoins(plan.channels, yield* secrets).batches;

      if (batch !== undefined) {
        joining = yield* join(batch.line, joinSensitive(batch));
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
