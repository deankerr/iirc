import type { Tuning } from "@iirc/lifecycle/tuning";
import type { OutboundLine } from "@iirc/protocol/outbound";
import { Clock, Duration, Effect, Queue } from "effect";

import { joinSensitive, keyedJoins } from "./credentials.ts";
import { readCause, readPlan } from "./reads.ts";
import type { Secrets, Sensitive } from "./redact.ts";
import { joinPlan } from "./standing.ts";
import type { Standing, WantedChannel } from "./standing.ts";

/** The cause a rejoin's `JOIN` is recorded with. */
const rejoinCause = "rejoin";

/** What a reconciler needs from its Connection. */
export interface Reconciling {
  /** The Channels wanted now, read for every plan, so a change reaches a Session (LIVE-8). */
  readonly channels: Effect.Effect<readonly WantedChannel[]>;
  /** Each item says that Standing or the Channels wanted moved, which could change a plan. */
  readonly moved: Queue.Dequeue<void>;
  /** Every Credential there is, read for every `JOIN`, so a key set since is used (CRED-4). */
  readonly secrets: Effect.Effect<Secrets>;
  /**
   * Queues a Line in the background lane, waits for room, and says whether it was written.
   * A `JOIN` that carries keys comes with what the Log records in its place (LOG-6).
   */
  readonly send: (
    line: OutboundLine,
    cause: string,
    sensitive: Sensitive | undefined
  ) => Effect.Effect<boolean>;
  readonly standing: Effect.Effect<Standing>;
  readonly tuning: Tuning;
}

const earlier = (one: number | undefined, other: number | undefined) =>
  one === undefined ? other : Math.min(one, other ?? one);

/**
 * Carries out `joinPlan` and then `readPlan` from the end of the burst until the Connection
 * ends (LIVE-7, LIVE-8, KNOW-5, KNOW-6). It holds no plan: it asks for one, sends one Line
 * of it, waits for the outcome, and asks again. A `JOIN` or a read only counts as asked once
 * recorded, so a plan kept while its Lines wait in the lane would be sent again, and a
 * Channel the Ircd puts us in meanwhile would be asked for needlessly. Joining comes first,
 * because a read is only of a Channel Self is in. Each key is read from its Credential as
 * the Line is built, and a Channel whose key is not set is joined without one (CRED-4).
 * @param reconciling - The Channels wanted, and how to reach the Connection.
 * @returns An effect that ends when a Line could not be written, as happens when the
 * Connection closes.
 */
export const reconcile = ({ channels, moved, secrets, send, standing, tuning }: Reconciling) =>
  Effect.gen(function* () {
    let sending = true;

    // A Network that kept us attached replays its `JOIN`s just after the burst, in reads of
    // their own, and those Channels are not to be joined again (LIVE-7).
    yield* Effect.sleep(Duration.millis(tuning.rejoinSettleMillis));

    while (sending) {
      const now = yield* Clock.currentTimeMillis;
      const current = yield* standing;
      const joins = joinPlan(current, yield* channels, now, tuning);
      const [batch] = keyedJoins(joins.channels, yield* secrets).batches;
      const reads = batch === undefined ? readPlan(current, now) : undefined;
      const [read] = reads?.reads ?? [];
      const lookAgainAt = earlier(joins.lookAgainAt, reads?.lookAgainAt);

      if (batch !== undefined) {
        sending = yield* send(batch.line, rejoinCause, joinSensitive(batch));
      } else if (read !== undefined) {
        sending = yield* send(read.line, readCause, undefined);
      } else if (lookAgainAt === undefined) {
        yield* Queue.take(moved);
      } else {
        yield* Effect.raceFirst(
          Queue.take(moved),
          Effect.sleep(Duration.millis(lookAgainAt - now))
        );
      }
    }
  });
