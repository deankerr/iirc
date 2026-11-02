import { start } from "@iirc/lifecycle";
import type { Phase } from "@iirc/lifecycle";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { joinLines } from "@iirc/protocol/join";
import type { JoinChannel, JoinRejection } from "@iirc/protocol/join";
import type { OutboundLine } from "@iirc/protocol/outbound";
import {
  Array as Arr,
  Cause,
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Stream,
} from "effect";
import type { Scope } from "effect";

import { hostConnection, logDown, makeCommit, phaseOf } from "./connection.ts";
import type { Host, Hosted } from "./connection.ts";
import type { Ircd, NetworkId } from "./entry.ts";
import { LaneFull } from "./lanes.ts";
import type { LaneDepths, LineFailure, QueuedLine } from "./lanes.ts";
import { Recorder, RecordFailed } from "./recorder.ts";
import {
  candidateNicks,
  channelKey,
  consecutiveFailures,
  kickStanding,
  nextAttempt,
  noStanding,
} from "./standing.ts";
import type { HeldJoinFailure, Standing, WantedChannel } from "./standing.ts";
import { Transport } from "./transport.ts";

export { LaneFull, LineDropped, WriteFailed } from "./lanes.ts";

// Past `quitWaitMillis`, a stop that has not finished is told to close at once, and past
// this again, its loop is let go of. A clean stop never waits either, because the loop's
// own limit is `quitWaitMillis`, and what it has read and not recorded is bounded.
const stopMarginMillis = 500;

const hostStopped = "the host stopped";
const hostLost = "the host lost a Connection and could not record it";

const noLanes: LaneDepths = { background: 0, control: 0, interactive: 0 };

/** Who to be on a Network. */
export interface Identity {
  readonly alternates: readonly string[];
  readonly nick: string;
  readonly realname: string;
  readonly username: string;
}

/**
 * What Configuration wants of a Network now. A host reads these whenever it decides
 * something, so Ircds, Identity, and Tuning apply at the next Connection, and the rest at
 * once (CONF-2).
 */
export interface NetworkSettings {
  /** The Channels to be in, each spelled as it should be sent. */
  readonly channels: readonly WantedChannel[];
  /** A disabled host makes no `attempt`, and leaves a live Connection by choice (LIVE-9). */
  readonly enabled: boolean;
  readonly identity: Identity;
  /** Tried in turn, starting after whichever the last `attempt` used (LIVE-4). */
  readonly ircds: Arr.NonEmptyReadonlyArray<Ircd>;
  /** What `QUIT` says when the host leaves (LIVE-9). */
  readonly quitReason: string;
  /** The sequence of the Change that last asked for a retry (LIVE-4). */
  readonly retrySince?: number;
  readonly tuning: Tuning;
}

/** Everything a host needs to stay on a Network. */
export interface NetworkOptions {
  /**
   * Has the host read its settings again, once per element, whatever it holds. A Stream,
   * because every Effect source of change already is one or becomes one in a call, such
   * as `SubscriptionRef.changes` or `Stream.fromPubSub`, and its elements carry nothing
   * the host keeps, so the host never holds a copy of its settings. It runs in the host's
   * Scope, and when it ends, the host goes on with no more news.
   */
  readonly changes: Stream.Stream<unknown>;
  readonly id: NetworkId;
  /** What the Network should be now, read whenever the host decides something. */
  readonly settings: Effect.Effect<NetworkSettings>;
}

/**
 * Hosting options for settings that never change, as a library user or a test wants.
 * @param id - The Network.
 * @param settings - What it should be, for as long as it is hosted.
 * @returns The options for `hostNetwork`.
 */
export const constantNetwork = (id: NetworkId, settings: NetworkSettings): NetworkOptions => ({
  changes: Stream.empty,
  id,
  settings: Effect.succeed(settings),
});

/** A Line could not be sent because there is no Session on the Network (API-10). */
export class NotInSession extends Data.TaggedError("NotInSession")<{ readonly phase: Phase }> {}

/** Everything `send` can refuse with. */
export type SendFailure = LaneFull | LineFailure | NotInSession;

/** What became of a Line that was not refused (API-9). */
export type Sent =
  /** The Line left, and this is the sequence of its Entry. */
  | { readonly _tag: "Written"; readonly sequence: number }
  /** The Line is still waiting its turn, and it stays in its lane. */
  | { readonly _tag: "StillQueued" };

/** A Channel's latest `JOIN` failure, by the name it is compared under. */
export interface ChannelFailure extends HeldJoinFailure {
  readonly channel: string;
}

/** A Channel no `JOIN` Line can carry, so it is never tried. */
export interface RejectedChannel {
  readonly channel: JoinChannel;
  readonly reason: JoinRejection;
}

/** Why the Log could not be appended to has not been resolved (LOG-9). */
export interface LogFault {
  /** The outage, and each try to resume since. */
  readonly failures: number;
  /** When a `record` will next be tried, in epoch milliseconds. */
  readonly retryAt: number;
  /** The wait `retryAt` stands for, which caps it if the clock is set back (LOG-8). */
  readonly retryMillis: number;
}

/** A Channel Self was kicked from, and when (LIVE-8). */
export interface KickedChannel {
  readonly at: number;
  readonly channel: string;
}

/** What a Frontend needs to know about a Network, derived each time it is asked for. */
export interface NetworkStatus {
  /** Why the last Connection closed, while nothing has replaced it. */
  readonly closeReason: string | undefined;
  readonly consecutiveFailures: number;
  /** Whether the settings want the Network on at all. */
  readonly enabled: boolean;
  /** Channels Self is in now. */
  readonly joined: readonly string[];
  readonly joinFailures: readonly ChannelFailure[];
  /** Kicks that still keep Self out, which the Owner wanting a Channel again clears. */
  readonly kicked: readonly KickedChannel[];
  readonly lagMillis: number | undefined;
  readonly lanes: LaneDepths;
  /** Set from a failed `record` until one succeeds. */
  readonly logFault: LogFault | undefined;
  /**
   * When the next `attempt` is due, in epoch milliseconds, unless a Connection is under way,
   * the host is stopping, or the Network is disabled.
   */
  readonly nextAttemptAt: number | undefined;
  /** Only `session` while a Line can be sent. */
  readonly phase: Phase;
  /** The Network's own words, verbatim, while its refusal stands (LIVE-5). */
  readonly refusal: string | undefined;
  readonly refused: boolean;
  /** Wanted Channels no `JOIN` can carry, from the settings as they are now. */
  readonly rejectedChannels: readonly RejectedChannel[];
  /** Self's nick in the current Session. */
  readonly self: string | undefined;
}

/** A Network being hosted. Stopping it is closing the Scope it was started in. */
export interface NetworkHost {
  /**
   * Queues a Line on the interactive lane and waits for it to be written. Never held
   * for later: with no Session it fails at once, and a full lane refuses at once. A
   * caller who walks away leaves the Line queued.
   */
  readonly send: (line: OutboundLine, cause: string) => Effect.Effect<Sent, SendFailure>;
  readonly status: Effect.Effect<NetworkStatus>;
}

const isKept = (channels: readonly RejectedChannel[], { name }: WantedChannel) =>
  !channels.some(({ channel }) => channel.name === name);

const joinable = (channels: readonly WantedChannel[]) => {
  const { rejected } = joinLines(channels);

  return channels.filter((channel) => isKept(rejected, channel));
};

// A kick the Owner has since wanted the Channel back from keeps nobody out (LIVE-8).
const isStillKicked = (standing: Standing, wanted: readonly WantedChannel[], key: string) => {
  const want = wanted.find(({ name }) => channelKey(name) === key);

  return want === undefined || kickStanding(standing, want) !== undefined;
};

const retryDelay = (failures: number, tuning: Tuning) =>
  Math.min(tuning.reconnectInitialMillis * 2 ** (failures - 1), tuning.reconnectMaxMillis);

// What the machine runs a Connection with, which its `attempt` records, so that Identity
// and Tuning apply at the next `attempt` and a replay sees what it saw.
const inputOf = ({ identity, tuning }: NetworkSettings) => ({
  realname: identity.realname,
  tuning,
  username: identity.username,
});

/**
 * Stays on a Network for as long as the enclosing Scope lasts: one loop reads its
 * settings and `Standing`, waits until the next `attempt` is due, and runs one Connection
 * after another, each in its own Scope. It never fails. A failed `record` or a defect ends
 * a Connection and backs off like anything else, and `status` says so. Should the loop
 * itself ever die, `status` reads `closed` with no next attempt, and the cause is logged.
 *
 * A change wakes whatever waits, so that a retry happens at once (LIVE-4), and the
 * reconciler joins what is newly wanted. Disabled, the host leaves any Connection by
 * choice, as a stop does, and waits to be enabled again (LIVE-9).
 *
 * Closing the Scope records `closing`, says `QUIT`, and waits up to `quitWaitMillis` for
 * the queue and the Ircd. That all happens on the loop's own fiber, which is detached so
 * that closing the Scope cannot interrupt it first, and the finalizer here is the only
 * thing that ends it.
 * @param options - Which Network, how to read its settings, and what says they changed.
 * @returns The running host.
 */
export const hostNetwork: (
  options: NetworkOptions
) => Effect.Effect<NetworkHost, never, Recorder | Scope.Scope | Transport> = Effect.fn(
  "hostNetwork"
)(function* ({ changes, id, settings }: NetworkOptions) {
  const recorder = yield* Recorder;
  const { connect } = yield* Transport;

  // Only an `attempt` gives the machine anything to act on, and it brings its own input.
  const hosted = yield* Ref.make<Hosted>({
    live: undefined,
    snapshot: start(inputOf(yield* settings)),
    stopped: false,
    unclosed: [],
    unrecorded: undefined,
  });

  const logFault = yield* Ref.make<LogFault | undefined>(undefined);
  const stop = yield* Deferred.make<undefined>();
  const hurry = yield* Deferred.make<undefined>();
  // One item stands for any number of changes, and a stale one costs one more look.
  const wakes = yield* Queue.sliding<undefined>(1);
  const stopping = () => Deferred.isDoneUnsafe(stop);
  const hurrying = () => Deferred.isDoneUnsafe(hurry);

  // One outage is one failure, however many appends fail during it. Each try to resume
  // after it is another, which is what the backoff counts.
  const faultFrom = Effect.fnUntraced(function* (failures: number) {
    const now = yield* Clock.currentTimeMillis;
    const { tuning } = yield* settings;

    return {
      failures,
      retryAt: now + retryDelay(failures, tuning),
      retryMillis: retryDelay(failures, tuning),
    } satisfies LogFault;
  });

  const noteFault = Effect.gen(function* () {
    const first = yield* faultFrom(1);

    yield* Ref.update(logFault, (held) => held ?? first);
  });

  // `before` is the fault as the try began, so the try that finds an outage counts once.
  const noteFailedResume = (before: LogFault | undefined) =>
    Effect.gen(function* () {
      const first = yield* faultFrom(1);
      const next = before === undefined ? first : yield* faultFrom(before.failures + 1);

      yield* Ref.update(logFault, (held) => (before === undefined ? (held ?? first) : next));
    });

  const record: Host["record"] = (entries, within) =>
    recorder.record(entries, within).pipe(
      Effect.tapError(() => noteFault),
      Effect.tap(() => Ref.set(logFault, undefined))
    );

  const standing = Effect.tapError(recorder.standing(id), () => noteFault);
  const commit = makeCommit(hosted, record);

  const shared: Omit<Host, "tuning"> = {
    commit,
    connect,
    hosted,
    hurrying,
    id,
    leaving: settings.pipe(Effect.map(({ enabled }) => stopping() || !enabled)),
    quitReason: settings.pipe(Effect.map(({ quitReason }) => quitReason)),
    record,
    standing,
    wanted: settings.pipe(Effect.map(({ channels }) => joinable(channels))),
  };

  // The Log has no say while it is down, so a fault adds to what `Standing` works out. No
  // wait is longer than its own delay from now, so a clock set back cannot keep the
  // Network offline (LOG-8).
  const attemptDue = (
    held: Standing,
    fault: LogFault | undefined,
    now: number,
    current: NetworkSettings
  ) => {
    const next = nextAttempt(held, current);
    const afterStanding = Math.min(next.at, now + next.delayMillis);
    const afterFault = fault === undefined ? 0 : Math.min(fault.retryAt, now + fault.retryMillis);

    return { ...next, at: Math.max(afterStanding, afterFault) };
  };

  // What a Log outage left unrecorded goes first, so that its Connection is closed for the
  // reason it really closed, and not taken for one a killed process left (LOG-2).
  const recordUnclosed = Effect.gen(function* () {
    const { unclosed } = yield* Ref.get(hosted);

    for (const batch of Arr.chunksOf(unclosed, 1024)) {
      yield* commit(batch);
    }

    yield* Ref.update(hosted, (state) => ({ ...state, unclosed: [] }));
  });

  const untilStopped = Deferred.await(stop);

  // Only a stop cuts this short, so a stream of changes cannot hurry a Log outage along.
  const sleepUntil = Effect.fnUntraced(function* (at: number) {
    const now = yield* Clock.currentTimeMillis;

    if (at > now) {
      yield* Effect.raceFirst(Effect.sleep(Duration.millis(at - now)), untilStopped);
    }
  });

  // Says whether something cut the wait short, which means deciding again.
  const waitForChange = Effect.fnUntraced(function* (at: number | undefined) {
    const now = yield* Clock.currentTimeMillis;
    const due = at === undefined ? Effect.never : Effect.sleep(Duration.millis(at - now));

    return yield* Effect.raceFirst(
      Effect.as(due, false),
      Effect.as(Effect.raceFirst(Queue.take(wakes), untilStopped), true)
    );
  });

  // A wait that runs out is not decided again, because a clock set back would put the
  // next answer as far ahead as the last (LOG-8). Nothing that could change it has.
  const tryConnection = Effect.gen(function* () {
    const current = yield* settings;
    const held = yield* standing;
    const now = yield* Clock.currentTimeMillis;

    if (!current.enabled) {
      yield* waitForChange(undefined);

      return;
    }

    const { at, ircd } = attemptDue(held, yield* Ref.get(logFault), now, current);

    if ((at > now && (yield* waitForChange(at))) || stopping()) {
      return;
    }

    yield* recordUnclosed;

    const { commands, recorded } = yield* commit([
      {
        _tag: "Connection",
        ircd,
        network: id,
        nicks: candidateNicks(held, current.identity, current.tuning),
        phase: "attempt",
        ...inputOf(current),
      },
    ]);

    const connection = recorded[0]?.sequence ?? 0;

    yield* Effect.scoped(
      hostConnection({ ...shared, tuning: current.tuning }, { commands, connection, ircd })
    );
  });

  const oneConnection = Effect.gen(function* () {
    const faultBefore = yield* Ref.get(logFault);

    return yield* tryConnection.pipe(
      // No dial without a recorded `attempt`, so this waits out the fault and tries again.
      Effect.catchTag("RecordFailed", () =>
        Effect.gen(function* () {
          yield* noteFailedResume(faultBefore);
          yield* Ref.update(hosted, (state) => ({
            ...state,
            unrecorded: state.unrecorded ?? logDown,
          }));

          const fault = yield* Ref.get(logFault);
          const now = yield* Clock.currentTimeMillis;

          yield* sleepUntil(
            fault === undefined ? 0 : Math.min(fault.retryAt, now + fault.retryMillis)
          );
        })
      ),
      // A defect `hostConnection` could not turn into a `closed` Entry: most likely the
      // Recorder died on that as well. It counts as a fault, so this cannot spin.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("A Connection could not be recorded", cause);
            yield* noteFailedResume(faultBefore);
            yield* Ref.update(hosted, (state) => ({
              ...state,
              live: undefined,
              unrecorded: state.unrecorded ?? hostLost,
            }));
          })
      )
    );
  });

  const loop = Effect.gen(function* () {
    while (!stopping()) {
      yield* oneConnection;
    }

    // One last chance for an outage's end to reach the Log before the host goes.
    yield* Effect.ignore(recordUnclosed);
  }).pipe(
    Effect.tapDefect((defect) => Effect.logError("The Network host died", defect)),
    Effect.onExit(() =>
      Ref.update(hosted, (held): Hosted => ({
        ...held,
        live: undefined,
        stopped: true,
        unrecorded: held.live === undefined ? held.unrecorded : (held.unrecorded ?? hostStopped),
      }))
    )
  );

  const changed = Effect.gen(function* () {
    yield* Queue.offer(wakes, undefined);
    yield* (yield* Ref.get(hosted)).live?.changed ?? Effect.void;
  });

  yield* Stream.runForEach(changes, () => changed).pipe(
    Effect.tapDefect((defect) => Effect.logError("A Network's changes died", defect)),
    Effect.forkScoped
  );

  // Finalizers run uninterruptibly, so this has to ask for a timeout to be able to win.
  const finish = Effect.fnUntraced(function* (fiber: Fiber.Fiber<void>) {
    yield* Deferred.succeed(stop, undefined);

    const { live } = yield* Ref.get(hosted);
    const { quitWaitMillis } = live?.tuning ?? (yield* settings).tuning;

    if (live !== undefined) {
      yield* live.lanes.quit;
      yield* live.wake;
    }

    const awaited = (millis: number) =>
      Fiber.await(fiber).pipe(Effect.timeoutOption(Duration.millis(millis)), Effect.interruptible);

    // Past its wait, a stop closes at once, recording what it read and its `closed`. Only a
    // Recorder that never returns is left behind.
    if (Option.isNone(yield* awaited(quitWaitMillis + stopMarginMillis))) {
      yield* Deferred.succeed(hurry, undefined);

      const { live: hurried } = yield* Ref.get(hosted);

      yield* hurried?.wake ?? Effect.void;

      if (Option.isNone(yield* awaited(stopMarginMillis))) {
        fiber.interruptUnsafe();
      }
    }
  });

  yield* Effect.acquireRelease(Effect.forkDetach(loop), finish);

  const send = Effect.fnUntraced(function* (line: OutboundLine, cause: string) {
    const held = yield* Ref.get(hosted);
    const phase = yield* phaseOf(held);

    // The fault is why there is no Session, and nothing can be recorded to send one.
    if (phase !== "session" && (yield* Ref.get(logFault)) !== undefined) {
      return yield* new RecordFailed({ cause: logDown });
    }

    if (held.live === undefined || phase !== "session") {
      return yield* new NotInSession({ phase });
    }

    const outcome = Deferred.makeUnsafe<number, LineFailure>();
    const queued: QueuedLine = { cause, lane: "interactive", line, outcome };
    const offered = yield* held.live.lanes.offerNow(queued);

    if (offered === "full") {
      return yield* new LaneFull({ lane: queued.lane });
    }

    if (offered === "shut") {
      return yield* new NotInSession({ phase: "closing" });
    }

    const written = yield* Deferred.await(outcome).pipe(
      Effect.timeoutOption(Duration.millis(held.live.tuning.sendWaitMillis))
    );

    return Option.match(written, {
      onNone: (): Sent => ({ _tag: "StillQueued" }),
      onSome: (sequence): Sent => ({ _tag: "Written", sequence }),
    });
  });

  // Between Connections, what the last one came to is in `Standing`, so a restart reads the
  // same. A Connection the Log could not close still holds a Session there, and none of it
  // is current once its host has let go of it (LOG-9, OBS-1).
  const status = Effect.gen(function* () {
    const held = yield* Ref.get(hosted);
    const fault = yield* Ref.get(logFault);
    const current = yield* settings;
    const { live, stopped, unrecorded } = held;
    const known = yield* Effect.orElseSucceed(recorder.standing(id), () => noStanding);
    const now = yield* Clock.currentTimeMillis;
    const lastClose = known.recent.at(-1);
    const between = live === undefined;
    const waiting = between && !stopped && !stopping() && current.enabled;

    const phaseBetween =
      unrecorded === undefined && !stopped && lastClose === undefined ? "idle" : "closed";

    return {
      closeReason: unrecorded ?? (between ? lastClose?.reason : undefined),
      consecutiveFailures: consecutiveFailures(known, current.tuning, now),
      enabled: current.enabled,
      joinFailures: [...known.joinFailures].map(([channel, failure]) => ({ ...failure, channel })),
      joined: between ? [] : [...known.channels.values()],
      kicked: [...known.kicked].flatMap(([channel, { at }]) =>
        isStillKicked(known, current.channels, channel) ? [{ at, channel }] : []
      ),
      lagMillis: between ? undefined : known.lagMillis,
      lanes: between ? noLanes : yield* live.lanes.depths,
      logFault: fault,
      nextAttemptAt: waiting ? Math.max(attemptDue(known, fault, now, current).at, now) : undefined,
      phase: between ? phaseBetween : yield* phaseOf(held),
      refusal: known.refusal?.reason,
      refused: known.refusal !== undefined,
      rejectedChannels: joinLines(current.channels).rejected,
      self: between ? undefined : known.self,
    } satisfies NetworkStatus;
  });

  return { send, status };
});
