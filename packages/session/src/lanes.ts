import type { Lane } from "@iirc/lifecycle";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { fullBucket, nextSendAt, takeToken } from "@iirc/protocol/flood";
import type { OutboundLine } from "@iirc/protocol/outbound";
import {
  Cause,
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  TxQueue,
  TxRef,
} from "effect";

import { RecordFailed } from "./recorder.ts";
import type { Sensitive } from "./redact.ts";

/** The lane has no room, so the Line was refused and nothing was queued (SEND-3). */
export class LaneFull extends Data.TaggedError("LaneFull")<{ readonly lane: Lane }> {}

/** A queued Line outlived its Connection, and the Log holds it as a Dropped Entry (SEND-4). */
export class LineDropped extends Data.TaggedError("LineDropped")<{ readonly reason: string }> {}

/** A Line was recorded and its write did not finish, so it may not have reached the Ircd. */
export class WriteFailed extends Data.TaggedError("WriteFailed")<{ readonly reason: string }> {}

/** What a Line came to, once it has left its lane. */
export type LineFailure = LineDropped | RecordFailed | WriteFailed;

/** A Line waiting to leave. */
export interface QueuedLine {
  readonly cause: string;
  readonly lane: Lane;
  readonly line: OutboundLine;
  /** Gives the sequence of the Line's Entry, once it is written. */
  readonly outcome: Deferred.Deferred<number, LineFailure>;
  /** What the Log records in place of a Line built from Credentials (LOG-6). */
  readonly sensitive?: Sensitive;
}

/** How many Lines wait in each lane. */
export type LaneDepths = Readonly<Record<Lane, number>>;

/**
 * One Connection's queues, in strict priority (SEND-1). Everything here changes in one
 * transaction with the gate, so an offer or a waiting pump cannot miss a close.
 */
export interface Lanes {
  readonly depths: Effect.Effect<LaneDepths>;
  /** Shuts the gate and hands over what was queued, in the order it would have left. */
  readonly empty: Effect.Effect<readonly QueuedLine[]>;
  /** Whether a Frontend's Line would still be taken. */
  readonly isOpen: Effect.Effect<boolean>;
  /** Refuses at once if the lane has no room, because a Frontend decides what to do (SEND-3). */
  readonly offerNow: (queued: QueuedLine) => Effect.Effect<"full" | "queued" | "shut">;
  /** The one Line a close may add. It has a place of its own, so a full lane cannot lose it. */
  readonly offerQuit: (queued: QueuedLine) => Effect.Effect<boolean>;
  /** Waits for room, and gives up with `false` if the gate stops being open. */
  readonly offerWaiting: (queued: QueuedLine) => Effect.Effect<boolean>;
  /** Only the control lane leaves from here on, so that `QUIT` is what goes out last. */
  readonly quit: Effect.Effect<void>;
  /** Nothing leaves from here on. */
  readonly shut: Effect.Effect<void>;
}

// `open` lets every lane out, `quitting` only control, and `shut` nothing.
type Gate = "open" | "quitting" | "shut";

interface PumpLanes {
  /** Waits until there is a Line the pump may take, and leaves it there. */
  readonly awaitLine: (mayFlood: boolean) => Effect.Effect<void>;
  /** Whether there is a Line the pump may take now. */
  readonly hasLine: (mayFlood: boolean) => Effect.Effect<boolean>;
  /** Takes the next Line the pump may take. */
  readonly takeNext: (mayFlood: boolean) => Effect.Effect<Option.Option<QueuedLine>>;
}

/**
 * Makes one Connection's lanes.
 * @param tuning - The Network's Tuning, for each lane's limit.
 * @returns The lanes, and what only the pump uses.
 */
export const makeLanes = Effect.fnUntraced(function* (tuning: Tuning) {
  // One more than the limit, which is the place `offerQuit` keeps for itself.
  const control = yield* TxQueue.bounded<QueuedLine>(tuning.controlLaneLimit + 1);
  const interactive = yield* TxQueue.bounded<QueuedLine>(tuning.laneLimit);
  const background = yield* TxQueue.bounded<QueuedLine>(tuning.laneLimit);
  const gate = yield* TxRef.make<Gate>("open");
  const queues = { background, control, interactive };

  const limits: LaneDepths = {
    background: tuning.laneLimit,
    control: tuning.controlLaneLimit,
    interactive: tuning.laneLimit,
  };

  const hasRoom = (lane: Lane) =>
    Effect.map(TxQueue.size(queues[lane]), (size) => size < limits[lane]);

  const offerNow = (queued: QueuedLine) =>
    Effect.tx(
      Effect.gen(function* () {
        if ((yield* TxRef.get(gate)) !== "open") {
          return "shut" as const;
        }

        if (!(yield* hasRoom(queued.lane))) {
          return "full" as const;
        }

        yield* TxQueue.offer(queues[queued.lane], queued);

        return "queued" as const;
      })
    );

  const offerWaiting = (queued: QueuedLine) =>
    Effect.tx(
      Effect.gen(function* () {
        if ((yield* TxRef.get(gate)) !== "open") {
          return false;
        }

        return (yield* hasRoom(queued.lane))
          ? yield* TxQueue.offer(queues[queued.lane], queued)
          : yield* Effect.txRetry;
      })
    );

  const offerQuit = (queued: QueuedLine) =>
    Effect.tx(
      Effect.gen(function* () {
        return (yield* TxRef.get(gate)) === "shut" ? false : yield* TxQueue.offer(control, queued);
      })
    );

  const hasLine = (mayFlood: boolean) =>
    Effect.tx(
      Effect.gen(function* () {
        const current = yield* TxRef.get(gate);

        if (current === "shut") {
          return false;
        }

        const flooded =
          mayFlood &&
          current === "open" &&
          ((yield* TxQueue.isNonEmpty(interactive)) || (yield* TxQueue.isNonEmpty(background)));

        return flooded || (yield* TxQueue.isNonEmpty(control));
      })
    );

  const awaitLine = (mayFlood: boolean) =>
    Effect.tx(Effect.flatMap(hasLine(mayFlood), (ready) => (ready ? Effect.void : Effect.txRetry)));

  const takeNext = (mayFlood: boolean) =>
    Effect.tx(
      Effect.gen(function* () {
        const current = yield* TxRef.get(gate);

        if (current === "shut") {
          return Option.none<QueuedLine>();
        }

        const first = yield* TxQueue.poll(control);

        if (Option.isSome(first) || !mayFlood || current === "quitting") {
          return first;
        }

        const second = yield* TxQueue.poll(interactive);

        return Option.isSome(second) ? second : yield* TxQueue.poll(background);
      })
    );

  const lanes: Lanes = {
    depths: Effect.tx(
      Effect.all({
        background: TxQueue.size(background),
        control: TxQueue.size(control),
        interactive: TxQueue.size(interactive),
      })
    ),
    empty: Effect.tx(
      Effect.gen(function* () {
        yield* TxRef.set(gate, "shut");

        return [
          ...(yield* TxQueue.clear(control)),
          ...(yield* TxQueue.clear(interactive)),
          ...(yield* TxQueue.clear(background)),
        ];
      })
    ),
    isOpen: Effect.map(TxRef.get(gate), (current) => current === "open"),
    offerNow,
    offerQuit,
    offerWaiting,
    quit: TxRef.update(gate, (current) => (current === "open" ? "quitting" : current)),
    shut: TxRef.set(gate, "shut"),
  };

  const pumpLanes: PumpLanes = { awaitLine, hasLine, takeNext };

  return { lanes, pumpLanes };
});

/** What the pump needs from the Connection it serves. */
export interface PumpWire {
  /**
   * Whether the kernel surely has a write's bytes only once a later write has been taken.
   * Bun's TLS reports a write done with the end of its record still in the process, and
   * takes no later write until that has reached the kernel. A close throws it away.
   */
  readonly confirmsLater: boolean;
  /** Appends a Line's Entry, and gives its sequence. It runs uninterruptibly. */
  readonly record: (queued: QueuedLine) => Effect.Effect<number, RecordFailed>;
  /** The Log took no Line, so the Connection cannot go on (LOG-9). */
  readonly recordFailed: Effect.Effect<void>;
  /** Puts a Line on the wire. Being interrupted is how a close lets go of a stalled write. */
  readonly write: (queued: QueuedLine) => Effect.Effect<void, WriteFailed>;
  /** A write failed, and only the first reason will count. */
  readonly writeFailed: (reason: string) => Effect.Effect<void>;
  /** A recorded Line whose write did not complete, which the close records as Dropped. */
  readonly unwritten: (queued: QueuedLine, reason: string) => Effect.Effect<void>;
}

/** Why a write that the kernel would not take for too long failed. */
export const writeTimedOut = "write timed out";

/** Why a Line whose write was reported done is Dropped: over TLS, it may not have left. */
export const mayNotHaveReached = "the write may not have reached the Ircd";

const writeFailureOf = (cause: Cause.Cause<WriteFailed>) => {
  const [failure] = cause.reasons;

  if (failure !== undefined && Cause.isFailReason(failure)) {
    return failure.error;
  }

  return new WriteFailed({
    reason: Cause.hasInterruptsOnly(cause) ? "the Connection closed" : "the write died",
  });
};

/**
 * Sends Lines until interrupted, one at a time, which is what keeps Log order and wire
 * order the same (LOG-4). It waits for a flood token without taking anything, so a
 * control Line that turns up meanwhile goes straight past it. A Line leaves its lane only
 * while this cannot be interrupted, and from there it is recorded, so closing can wait
 * for this fiber and know that it holds every Line that is neither written nor queued.
 * @param pumpLanes - The Connection's lanes.
 * @param tuning - The Network's Tuning, for the bucket's limit.
 * @param wire - How to record and write a Line.
 * @returns An effect that only stops by being interrupted.
 */
export const runPump = (pumpLanes: PumpLanes, tuning: Tuning, wire: PumpWire) =>
  Effect.uninterruptibleMask((restore) => {
    const limit = { burst: tuning.floodBurst, intervalMillis: tuning.floodIntervalMillis };
    let bucket = fullBucket;
    // With `confirmsLater`, the last Line written, until a later write is taken. Its
    // outcome waits for that, or for the pump to have nothing to write at once.
    let lastWritten: { readonly queued: QueuedLine; readonly sequence: number } | undefined;

    const confirm = Effect.suspend(() =>
      lastWritten === undefined
        ? Effect.void
        : Deferred.succeed(lastWritten.queued.outcome, lastWritten.sequence)
    );

    // A later write was still waiting for the kernel when it gave up, so the one before it
    // may still be in the process, and the close that follows throws that away. Its caller
    // may already have been told it was written, because nothing in Bun says when the rest
    // of it leaves. A write that failed outright found the Connection broken, and then the
    // kernel's own buffer is lost as well, over TLS or not.
    const unconfirm = Effect.fnUntraced(function* (cause: Cause.Cause<WriteFailed>) {
      const stalled =
        Cause.hasInterruptsOnly(cause) || writeFailureOf(cause).reason === writeTimedOut;

      if (lastWritten !== undefined && stalled) {
        const { queued } = lastWritten;

        lastWritten = undefined;
        yield* wire.unwritten(queued, mayNotHaveReached);
        yield* Deferred.fail(queued.outcome, new WriteFailed({ reason: mayNotHaveReached }));
      }
    });

    const transmit = Effect.fnUntraced(function* (queued: QueuedLine) {
      const recorded = yield* Effect.exit(wire.record(queued));

      // Each of these says what happened to the Connection before telling the caller, who
      // would otherwise be free to ask, and be told, that all is still well.
      if (Exit.isFailure(recorded)) {
        yield* wire.recordFailed;

        return yield* Deferred.fail(queued.outcome, new RecordFailed({ cause: recorded.cause }));
      }

      const written = yield* Effect.exit(restore(wire.write(queued)));

      if (Exit.isSuccess(written)) {
        if (!wire.confirmsLater) {
          return yield* Deferred.succeed(queued.outcome, recorded.value);
        }

        // Taken, so the one before it has reached the kernel, and this one waits its turn.
        yield* confirm;
        lastWritten = { queued, sequence: recorded.value };

        return false;
      }

      yield* unconfirm(written.cause);
      lastWritten = undefined;

      const failure = writeFailureOf(written.cause);

      yield* wire.unwritten(queued, failure.reason);

      if (!Cause.hasInterruptsOnly(written.cause)) {
        yield* wire.writeFailed(failure.reason);
      }

      return yield* Deferred.fail(queued.outcome, failure);
    });

    const cycle = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const sendAt = nextSendAt(bucket, limit, now);

      // About to wait, so no later write is coming soon to confirm the last.
      if (sendAt > now || !(yield* pumpLanes.hasLine(true))) {
        yield* confirm;
      }

      yield* restore(
        sendAt > now
          ? Effect.raceFirst(
              pumpLanes.awaitLine(false),
              Effect.sleep(Duration.millis(sendAt - now))
            )
          : pumpLanes.awaitLine(true)
      );

      const token = takeToken(bucket, limit, yield* Clock.currentTimeMillis);
      const taken = yield* pumpLanes.takeNext(token !== undefined);

      if (Option.isSome(taken)) {
        bucket = taken.value.lane === "control" ? bucket : (token ?? bucket);
        yield* transmit(taken.value);
      }
    });

    // Interrupted with no write under way, so nothing stands behind the last one.
    return Effect.forever(cycle).pipe(Effect.ensuring(confirm));
  });
