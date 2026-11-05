import type { Login, Phase } from "@iirc/lifecycle";
import type { Tuning } from "@iirc/lifecycle/tuning";
import type { JoinRejection } from "@iirc/protocol/join";
import { nickCandidates } from "@iirc/protocol/nick";
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

import { hostConnection, loginLinesOf, logDown, makeCommit, phaseOf } from "./connection.ts";
import type { Host, Hosted } from "./connection.ts";
import { keyedJoins, missingCredentials } from "./credentials.ts";
import type { CredentialNames } from "./credentials.ts";
import type { Ircd, NetworkId } from "./entry.ts";
import { LaneFull } from "./lanes.ts";
import type { LaneDepths, LineFailure, QueuedLine } from "./lanes.ts";
import { Recorder, RecordFailed } from "./recorder.ts";
import { boundReasons } from "./redact.ts";
import type { Secrets, Sensitive } from "./redact.ts";
import { consecutiveFailures, kicksInForce, loginOf, nextAttempt } from "./standing.ts";
import type { HeldJoinFailure, Standing, WantedChannel } from "./standing.ts";
import { Transport } from "./transport.ts";

export type { CredentialNames, ServiceLogin } from "./credentials.ts";

export { LaneFull, LineDropped, WriteFailed } from "./lanes.ts";

export type { Secrets, Sensitive } from "./redact.ts";

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
  /** The Channels to be in, each spelled as it should be sent, with a key by name. */
  readonly channels: readonly WantedChannel[];
  /**
   * Lines to send after registration, once `IDENTIFY` has gone, in which `{{name}}` stands
   * for the Credential of that name (CONN-6). They apply at the next Connection.
   */
  readonly connectCommands: readonly string[];
  /** The Credentials the Network uses, by name. They apply at the next Connection. */
  readonly credentials: CredentialNames;
  /** A disabled host makes no `attempt`, and leaves a live Connection by choice (LIVE-9). */
  readonly enabled: boolean;
  readonly identity: Identity;
  /** Tried in turn, starting after whichever the last `attempt` used (LIVE-4). */
  readonly ircds: Arr.NonEmptyReadonlyArray<Ircd>;
  /** What `QUIT` says when the host leaves (LIVE-9). */
  readonly quitReason: string;
  /** The sequence of the Change that last asked for a retry (LIVE-4). */
  readonly retrySince?: number;
  /**
   * Every Credential the Daemon holds, by name, and not only this Network's. Names are
   * looked up here whenever one is needed.
   */
  readonly secrets: Secrets;
  /** The nicks that are services, whose `NOTICE` can be a sign of login (CONN-6). */
  readonly services: readonly string[];
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
  /** The Channel as wanted, with its key by name. */
  readonly channel: WantedChannel;
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
  /** How the current Connection's login to services went, in the service's own words. */
  readonly login: Login;
  /** Credentials the settings refer to that are not set, which keep it from any `attempt`. */
  readonly missingCredentials: readonly string[];
  /**
   * When the next `attempt` is due, in epoch milliseconds, unless a Connection is under way,
   * the host is stopping, or the Network is disabled.
   */
  readonly nextAttemptAt: number | undefined;
  /** Only `session` while a Line can be sent. */
  readonly phase: Phase;
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
   * caller who walks away leaves the Line queued. A Line built from a secret comes with
   * what the Log records in its place, written or Dropped (LOG-6).
   */
  readonly send: (
    line: OutboundLine,
    cause: string,
    sensitive?: Sensitive
  ) => Effect.Effect<Sent, SendFailure>;
  readonly status: Effect.Effect<NetworkStatus>;
}

// Whether a key can go in a `JOIN` depends on its value, so it is read to say. A Channel
// is reported as wanted, with its key by name, so no value leaves here (CRED-3).
const rejectedOf = (
  channels: readonly WantedChannel[],
  secrets: Secrets
): readonly RejectedChannel[] =>
  keyedJoins(channels, secrets).rejected.flatMap(({ channel: { name }, reason }) => {
    const wanted = channels.find((channel) => channel.name === name);

    return wanted === undefined ? [] : [{ channel: wanted, reason }];
  });

const joinable = (channels: readonly WantedChannel[], secrets: Secrets) => {
  const rejected = new Set(rejectedOf(channels, secrets).map(({ channel }) => channel.name));

  return channels.filter(({ name }) => !rejected.has(name));
};

const retryDelay = (failures: number, tuning: Tuning) =>
  Math.min(tuning.reconnectInitialMillis * 2 ** (failures - 1), tuning.reconnectMaxMillis);

// What the machine runs a Connection with, which its `attempt` records, so that Identity
// and Tuning apply at the next `attempt` and a replay sees what it saw.
const inputOf = (settings: NetworkSettings) => ({
  loginLines: loginLinesOf(settings),
  realname: settings.identity.realname,
  services: settings.services,
  tuning: settings.tuning,
  username: settings.identity.username,
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

  const hosted = yield* Ref.make<Hosted>({
    live: undefined,
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

  const secrets = settings.pipe(Effect.map((current) => current.secrets));

  // Every append goes through here. A Line built from Credentials arrives already as the
  // Log records it, so nothing here looks for their values (LOG-6).
  const record: Recorder["Service"]["record"] = (entries, within) =>
    recorder.record(boundReasons(entries), within).pipe(
      Effect.tapError(() => noteFault),
      Effect.tap(() => Ref.set(logFault, undefined))
    );

  const standing = recorder.standing(id);
  const commit = makeCommit(standing, record);

  const shared: Omit<Host, "tuning"> = {
    commit,
    connect,
    hosted,
    hurrying,
    id,
    leaving: settings.pipe(Effect.map(({ enabled }) => stopping() || !enabled)),
    quitReason: settings.pipe(Effect.map(({ quitReason }) => quitReason)),
    secrets,
    standing,
    wanted: settings.pipe(Effect.map((current) => joinable(current.channels, current.secrets))),
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

    // Each batch leaves the list in the unit that records it, or a cancelled stop would
    // record it again.
    for (const batch of Arr.chunksOf(unclosed, 1024)) {
      yield* commit(batch, () =>
        Ref.update(hosted, (state) => ({ ...state, unclosed: state.unclosed.slice(batch.length) }))
      );
    }
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

    // A Credential the settings name and nobody has set yet blocks any `attempt`, until a
    // change sets it (CRED-1).
    if (!current.enabled || missingCredentials(current).length > 0) {
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
        nicks: nickCandidates(current.identity),
        phase: "attempt",
        ...inputOf(current),
      },
    ]);

    const connection = recorded[0]?.sequence ?? 0;

    const plan = { connectCommands: current.connectCommands, credentials: current.credentials };

    yield* Effect.scoped(
      hostConnection({ ...shared, tuning: current.tuning }, { commands, connection, ircd, plan })
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

  const send = Effect.fnUntraced(function* (
    line: OutboundLine,
    cause: string,
    sensitive?: Sensitive
  ) {
    const held = yield* Ref.get(hosted);
    const phase = yield* phaseOf(held, yield* standing);

    // The fault is why there is no Session, and nothing can be recorded to send one.
    if (phase !== "session" && (yield* Ref.get(logFault)) !== undefined) {
      return yield* new RecordFailed({ cause: logDown });
    }

    if (held.live === undefined || phase !== "session") {
      return yield* new NotInSession({ phase });
    }

    const outcome = Deferred.makeUnsafe<number, LineFailure>();

    const queued: QueuedLine = {
      cause,
      lane: "interactive",
      line,
      outcome,
      ...(sensitive !== undefined && { sensitive }),
    };

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
    const known = yield* standing;
    const now = yield* Clock.currentTimeMillis;
    const lastClose = known.recent.at(-1);
    const between = live === undefined;
    const missing = missingCredentials(current);
    const waiting = between && !stopped && !stopping() && current.enabled && missing.length === 0;

    const phaseBetween =
      unrecorded === undefined && !stopped && lastClose === undefined ? "idle" : "closed";

    return {
      closeReason: unrecorded ?? (between ? lastClose?.reason : undefined),
      consecutiveFailures: consecutiveFailures(known, current.tuning, now),
      enabled: current.enabled,
      joinFailures: [...known.joinFailures].map(([channel, failure]) => ({ ...failure, channel })),
      joined: between ? [] : [...known.irc.channels.values()].map(({ name }) => name),
      kicked: kicksInForce(known, current.channels),
      lagMillis: between ? undefined : known.lagMillis,
      lanes: between ? noLanes : yield* live.lanes.depths,
      logFault: fault,
      login: between ? { state: "none" } : loginOf(known),
      missingCredentials: missing,
      nextAttemptAt: waiting ? Math.max(attemptDue(known, fault, now, current).at, now) : undefined,
      phase: between ? phaseBetween : yield* phaseOf(held, known),
      rejectedChannels: rejectedOf(current.channels, current.secrets),
      self: between ? undefined : known.irc.self,
    } satisfies NetworkStatus;
  });

  return { send, status };
});
