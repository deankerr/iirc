import { deadline, phase, step } from "@iirc/lifecycle";
import type { Command, Lane, NetworkSnapshot, Phase } from "@iirc/lifecycle";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { takeFrames } from "@iirc/protocol/frame";
import { encodeLine, outbound, pong } from "@iirc/protocol/outbound";
import type { Outbound } from "@iirc/protocol/outbound";
import {
  Array as Arr,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Redacted,
  Ref,
  Semaphore,
  TxRef,
} from "effect";
import type { Scope } from "effect";
import { Socket } from "effect/socket";

import {
  connectCommandCause,
  connectCommandLine,
  identifyCause,
  identifyLine,
  loginCauses,
  passLine,
} from "./credentials.ts";
import type { Built, CredentialNames } from "./credentials.ts";
import type { Entry, Ircd, NetworkId, NewEntry, TlsDetails } from "./entry.ts";
import { toEvent } from "./events.ts";
import { LineDropped, makeLanes, runPump, WriteFailed, writeTimedOut } from "./lanes.ts";
import type { Lanes, LineFailure, PumpWire, QueuedLine } from "./lanes.ts";
import { reconcile } from "./reconcile.ts";
import { RecordFailed } from "./recorder.ts";
import type { Recorder } from "./recorder.ts";
import type { Secrets, Sensitive } from "./redact.ts";
import { channelKeyChanges } from "./standing.ts";
import type { KeyChange, Standing, WantedChannel } from "./standing.ts";
import { ConnectFailed, describeSocketError } from "./transport.ts";
import type { Transport } from "./transport.ts";

// LOG-4: how much may be pulled and not yet recorded, so that a flood waits in the kernel
// and not in this process, and a close has little left to record. A pull can take more
// than this, so the bound is this plus one pull, which `Transport.layer` keeps to 16 KB.
// What the stream has read and nobody has pulled is the Transport's own bound, and a close
// takes it with `unread`. A flood of bare newlines makes that a Line a byte, and a commit
// for every 1024.
const readAheadBytes = 16 * 1024;

// LOG-4: a flood of tiny Lines cannot hold the writer for longer than this many.
const linesPerCommit = 1024;

// How many scheduler turns the reader gets to deliver what the kernel already holds. Each
// is a turn of the event loop, so this costs no time that a clock could see, and LIVE-2's
// limit holds to the millisecond. It only runs for a silence deadline that is due.
const feedTurns = 32;

// The name the machine gives this deadline, which the Log stores too.
const silenceDeadline = "silence";

/** Why a Connection closed, when the Log is what failed. */
export const logDown = "the Log could not record this Connection";

const ircdClosed = "the Ircd closed the Connection";
const hostFailed = "the host failed";
const dialDied = "the dial died";
const readerDied = "the reader died";
const closingDown = "the Connection is closing";
const hurried = "the host ran out of time to stop";

const encoder = new TextEncoder();

/** A Connection under way, as far as anyone outside its loop may see. */
interface HostedConnection {
  /** Says that settings may have changed, to the loop and to the reconciler. */
  readonly changed: Effect.Effect<void>;
  readonly lanes: Lanes;
  readonly stage: Ref.Ref<Stage>;
  /** The Tuning it was attempted with, which holds until it ends. */
  readonly tuning: Tuning;
  /** Has the loop look at the stage and the stop signal again. */
  readonly wake: Effect.Effect<void>;
}

/**
 * How far a Connection has got. `Draining` is one that is closing and is only read from
 * until `readsUntil`, and its `reason` is the first thing to go wrong.
 */
type Stage =
  | { readonly _tag: "Dialing" }
  | { readonly _tag: "Open" }
  | {
      readonly _tag: "Draining";
      /** The Daemon decided this, so it is recorded as `closing` (LOG-2). */
      readonly local: boolean;
      readonly reason: string;
      readonly readsUntil: number;
      readonly refused: boolean;
    };

/** What a host holds that no fold of the Log can give it. */
export interface Hosted {
  readonly live: HostedConnection | undefined;
  readonly snapshot: NetworkSnapshot;
  /** The loop has ended, so nothing more will happen on this Network. */
  readonly stopped: boolean;
  /**
   * The end of a Connection that the Log could not take, ending with its `closed` Entry. It
   * is recorded before anything else once appends succeed, so that the Connection is
   * never mistaken for one a killed process left open (LOG-2, LOG-9).
   */
  readonly unclosed: readonly NewEntry[];
  /** Why hosting ended, for when no `closed` Entry says so. */
  readonly unrecorded: string | undefined;
}

/**
 * The Phase a host is really in. The machine only hears of what is in the Log, so a
 * Connection whose write has failed still reads as a Session to it, and one whose end
 * could not be recorded reads as whatever it last was.
 * @param hosted - The host's state.
 * @returns The Phase, which is only `session` while a Line can be sent.
 */
export const phaseOf = ({ live, snapshot, stopped, unrecorded }: Hosted): Effect.Effect<Phase> =>
  Effect.gen(function* () {
    const folded = phase(snapshot);

    if (unrecorded !== undefined || stopped || live === undefined) {
      return folded === "idle" && unrecorded === undefined ? "idle" : "closed";
    }

    const leaving = (yield* Ref.get(live.stage))._tag === "Draining";

    return leaving || (folded === "session" && !(yield* live.lanes.isOpen)) ? "closing" : folded;
  });

/**
 * What a Connection sends on the Owner's behalf, as the settings said at its `attempt`, so
 * that it agrees with the `attempt` Entry's count of the login sequence (CONN-6).
 */
export interface ConnectionPlan {
  readonly connectCommands: readonly string[];
  readonly credentials: CredentialNames;
}

/** An `attempt`, recorded, with what the machine asked for when it stepped. */
export interface Attempted {
  readonly commands: readonly Command[];
  readonly connection: number;
  readonly ircd: Ircd;
  readonly plan: ConnectionPlan;
}

/** A Channel's key as an inbound `MODE` set it, or took it away (CRED-4). */
export interface ChannelKey {
  readonly channel: string;
  readonly key: Redacted.Redacted | undefined;
}

/** What every Connection on a Network shares, and the Tuning of this one. */
export interface Host {
  readonly commit: Commit;
  readonly connect: Transport["Service"]["connect"];
  readonly hosted: Ref.Ref<Hosted>;
  readonly id: NetworkId;
  /** Whether the Connection is to be left by choice, read whenever the loop looks up. */
  readonly leaving: Effect.Effect<boolean>;
  /** What `QUIT` says, read as the Connection is left (LIVE-9). */
  readonly quitReason: Effect.Effect<string>;
  /** Told of a Channel key once the `MODE` that set or took it away is recorded (CRED-4). */
  readonly onChannelKey: ((change: ChannelKey) => Effect.Effect<void>) | undefined;
  /** Every Credential there is, read each time one is needed. */
  readonly secrets: Effect.Effect<Secrets>;
  readonly standing: Effect.Effect<Standing, RecordFailed>;
  /** Whether a stop has run out of time, so whatever is left is closed now. */
  readonly hurrying: () => boolean;
  readonly tuning: Tuning;
  /** The Channels to be in, read each time the reconciler plans. */
  readonly wanted: Effect.Effect<readonly WantedChannel[]>;
}

interface Stepped {
  /** Whether what was stepped could have changed the Channels Self is in. */
  readonly channelsMoved: boolean;
  readonly commands: readonly Command[];
  readonly next: NetworkSnapshot;
}

/**
 * What the host runs after a commit: the machine's Commands, and Lines the host builds
 * itself from Credentials, which the machine never sees (LOG-6). `waits` says whether to
 * wait for room in the lane, or to give up on the Line at once.
 */
type Order =
  | Command
  | {
      readonly type: "sendBuilt";
      readonly built: Built;
      readonly cause: string;
      readonly lane: Lane;
      readonly waits: boolean;
    };

type Commit = (
  entries: Arr.NonEmptyReadonlyArray<NewEntry>
) => Effect.Effect<Stepped & { readonly recorded: readonly Entry[] }, RecordFailed>;

type InboxItem =
  | {
      readonly _tag: "Opened";
      readonly pull: Pull;
      readonly tls: TlsDetails | undefined;
      readonly unread: Unread;
      readonly writer: Socket.Writer;
    }
  // `at` is when it was read, which says whether it arrived ahead of a deadline.
  | {
      readonly _tag: "Read";
      readonly at: number;
      readonly bytes: number;
      readonly chunks: readonly Uint8Array[];
    }
  // `local` says that the Daemon is what ended it, as with a reader that died.
  | { readonly _tag: "Ended"; readonly local: boolean; readonly reason: string }
  // The pump stepped the machine with a Line it recorded, and these are what it asked for.
  | { readonly _tag: "Stepped"; readonly commands: readonly Command[] }
  // Says nothing itself: the loop looks again at what could have changed.
  | { readonly _tag: "Wake" };

type LoopItem = InboxItem | { readonly _tag: "Deadline"; readonly name: string };

type Pull = Effect.Effect<readonly Uint8Array[], Socket.SocketError>;

type Unread = Effect.Effect<readonly Uint8Array[]>;

const nothingUnread: Unread = Effect.succeed([]);

interface Framing {
  readonly cutting: boolean;
  readonly pending: Uint8Array;
}

const changesChannels: ReadonlySet<string> = new Set(["JOIN", "KICK", "PART"]);

// A transition that throws leaves the machine where it was and closes the Connection
// (HOST-1).
const stepEntry = (snapshot: NetworkSnapshot, entry: Entry): Stepped => {
  try {
    const event = toEvent(entry);

    return event === undefined
      ? { channelsMoved: false, commands: [], next: snapshot }
      : {
          ...step(snapshot, event),
          channelsMoved: event.type === "LINE" && changesChannels.has(event.command),
        };
  } catch {
    const reason = `the machine threw on Entry ${entry.sequence}`;

    return {
      channelsMoved: false,
      commands: [{ reason, type: "closeConnection" }],
      next: snapshot,
    };
  }
};

const stepEntries = (snapshot: NetworkSnapshot, entries: Iterable<Entry>): Stepped => {
  const commands: Command[] = [];
  let channelsMoved = false;
  let next = snapshot;

  for (const entry of entries) {
    const stepped = stepEntry(next, entry);

    channelsMoved ||= stepped.channelsMoved;
    commands.push(...stepped.commands);
    ({ next } = stepped);
  }

  return { channelsMoved, commands, next };
};

/**
 * Makes the one way a host steps its machine. The loop calls it, and so does the pump for
 * each Line it records, because the login sequence's Lines are what start the login wait
 * (CONN-6). One commit at a time, from reading the snapshot to keeping the next, so that
 * the machine steps in sequence order and neither loses the other's step. A step that a
 * failed commit rolls back never reaches `hosted`, because `within` only works out the
 * next snapshot.
 * @param hosted - The host's state.
 * @param record - Appends Entries.
 * @returns The commit.
 */
export const makeCommit = (
  hosted: Ref.Ref<Hosted>,
  record: Recorder["Service"]["record"]
): Commit => {
  const stepping = Semaphore.makeUnsafe(1);

  return (entries) =>
    stepping.withPermits(1)(
      Effect.gen(function* () {
        const { snapshot } = yield* Ref.get(hosted);

        const stepped = yield* record(entries, (recorded) => ({
          ...stepEntries(snapshot, recorded),
          recorded,
        }));

        yield* Ref.update(hosted, (held) => ({ ...held, snapshot: stepped.next }));

        return stepped;
      })
    );
};

const toEnding = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError"
    ? ircdClosed
    : `read failed: ${describeSocketError(error)}`;

const toWriteFailed = (error: Socket.SocketError) =>
  new WriteFailed({
    reason:
      error.reason._tag === "SocketCloseError"
        ? ircdClosed
        : `write failed: ${describeSocketError(error)}`,
  });

// As much of a `PONG` as there is: the token stays bytes, whatever its encoding.
const pongBytes = (token: Uint8Array | undefined) =>
  Buffer.concat([encoder.encode("PONG "), token ?? new Uint8Array()]);

const isInboundLine = (entry: NewEntry) => entry._tag === "Line" && entry.direction === "inbound";

// The host acts on a `MODE` as recorded. A key that was already a Credential's value was
// scrubbed out of it, so it is that Credential's value again, as long as the Entry names
// the Credential for that very `<redacted>` (LOG-6). The names go in the order their
// placeholders stand, so another scrubbed in the same Line does not hide which it was.
const keyOf = (
  { entry, key, placeholder }: KeyChange,
  secrets: Secrets
): Option.Option<Redacted.Redacted | undefined> => {
  if (key === undefined) {
    return Option.some(undefined);
  }

  const names = entry._tag === "Line" ? (entry.redacted ?? []) : [];

  if (placeholder === undefined || names.length === 0) {
    return Option.some(Redacted.make(key));
  }

  // A `<redacted>` the Ircd sent itself would put every later name out of step.
  const name = names.length === placeholder.of ? names[placeholder.slot] : undefined;

  return name === undefined ? Option.none() : Option.fromUndefinedOr(secrets.get(name));
};

/**
 * How many Lines a Connection's login sequence holds: `IDENTIFY` if a service password is
 * configured, then each connect command (CONN-6).
 * @param plan - What the Connection sends on the Owner's behalf.
 * @returns The count its `attempt` records.
 */
export const loginLinesOf = ({ connectCommands, credentials }: ConnectionPlan): number =>
  (credentials.service === undefined ? 0 : 1) + connectCommands.length;

/**
 * Runs one Connection from its `attempt` until its `closed` Entry, or as near to that as
 * the Log allows. One fiber owns the machine and every step of it, and it is the only
 * one that closes. The dial, the reader, the pump, and the reconciler each run beside it
 * and report through its inbox, so nothing here ever waits on a socket: a stalled write
 * cannot stop the reading, and a close can overtake a dial.
 *
 * A `PING` flood can fill the control lane while the pump is parked on a stalled write,
 * and then this loop waits to offer, and stops reading, which is what backs the flood up
 * into the kernel. The pump's write timeout is what ends that: it shuts the gate, which
 * ends the offer, and the loop goes back to reading what is left.
 * @param host - What every Connection on the Network shares.
 * @param attempted - The recorded `attempt`.
 * @returns An effect that ends when the Connection has, with nothing left running in its
 * Scope.
 */
export const hostConnection: (
  host: Host,
  attempted: Attempted
) => Effect.Effect<void, never, Scope.Scope> = Effect.fn("hostConnection")(function* (
  host: Host,
  { commands, connection, ircd, plan }: Attempted
) {
  const { commit, connect, hosted, id, quitReason, standing, tuning, wanted } = host;
  const { hurrying, leaving, onChannelKey, secrets } = host;

  // Unbounded in items, and bounded in bytes by `held`, so a wake never waits for room.
  const inbox = yield* Queue.unbounded<InboxItem>();
  const held = yield* TxRef.make(0);
  const moved = yield* Queue.sliding<undefined>(1);
  const { lanes, pumpLanes } = yield* makeLanes(tuning);
  const stage = yield* Ref.make<Stage>({ _tag: "Dialing" });

  const wake = Effect.sync(() => {
    Queue.offerUnsafe(inbox, { _tag: "Wake" });
  });

  // The loop looks at whether to leave, and the reconciler plans again.
  const changed = Effect.sync(() => {
    Queue.offerUnsafe(moved, undefined);
    Queue.offerUnsafe(inbox, { _tag: "Wake" });
  });

  const closed = Deferred.makeUnsafe<undefined>();
  let framing: Framing = { cutting: false, pending: new Uint8Array() };
  let pump: Fiber.Fiber<unknown> | undefined;
  let reader: Fiber.Fiber<unknown> | undefined;
  // What the stream has read and the reader has not pulled, for the close to record.
  let unread = nothingUnread;
  let reconciling = false;
  let seen: Pick<Standing, "channels" | "kicked"> | undefined;
  let stopHandled = false;
  let closingRecorded = false;
  // Dropped Entries waiting for a commit: one per batch while the lanes are open, and
  // the close's own once they are not, so that a flood cannot cost a commit for each.
  let unsent: NewEntry[] = [];
  // What the Log would not take, kept for when it will (LOG-4, LOG-9).
  let unrecorded: NewEntry[] = [];
  // Lines recorded as outbound whose write did not complete (LOG-2).
  const unwritten: { readonly queued: QueuedLine; readonly reason: string }[] = [];

  yield* Ref.update(hosted, (state): Hosted => ({
    ...state,
    live: { changed, lanes, stage, tuning, wake },
    unrecorded: undefined,
  }));

  const lineEntry = (bytes: Uint8Array, cut: boolean): NewEntry => ({
    _tag: "Line",
    bytes,
    connection,
    direction: "inbound",
    network: id,
    ...(cut && { cut }),
  });

  const droppedEntry = (
    bytes: Uint8Array,
    cause: string,
    reason: string,
    redacted: readonly string[] = []
  ): NewEntry => ({
    _tag: "Dropped",
    bytes,
    cause,
    connection,
    network: id,
    reason,
    ...(redacted.length > 0 && { redacted }),
  });

  // A Line built from Credentials is recorded in its sensitive form, written or not.
  const droppedOf = ({ cause, line, sensitive }: QueuedLine, reason: string) =>
    droppedEntry(sensitive?.bytes ?? line.bytes, cause, reason, sensitive?.names);

  const closingEntry = (reason: string, chosen: boolean): NewEntry => ({
    _tag: "Connection",
    chosen,
    connection,
    ircd,
    network: id,
    phase: "closing",
    reason,
  });

  const closedEntry = (reason: string, refused: boolean): NewEntry => ({
    _tag: "Connection",
    connection,
    ircd,
    network: id,
    phase: "closed",
    reason,
    ...(refused && { refused: true }),
  });

  const takeLines = (chunks: readonly Uint8Array[]) => {
    const entries: NewEntry[] = [];

    for (const chunk of chunks) {
      const { cut, cutting, frames, pending } = takeFrames(framing.pending, chunk, framing.cutting);

      for (const [index, frame] of frames.entries()) {
        entries.push(lineEntry(frame, cut.has(index)));
      }

      framing = { cutting, pending };
    }

    return entries;
  };

  // How a close starts, from any fiber. The first reason counts, and a later close can
  // only shorten the wait, unless it is a refusal: a Network that bans us at accept
  // closes the socket before we can read why, so its words come second (LOG-2).
  const drain = Effect.fnUntraced(function* (
    reason: string,
    options: {
      readonly limitMillis: number;
      readonly local?: boolean;
      readonly quitting?: boolean;
      readonly refused?: true;
    }
  ) {
    const now = yield* Clock.currentTimeMillis;
    const refused = options.refused === true;

    yield* Ref.update(stage, (current): Stage => {
      if (current._tag === "Draining") {
        const readsUntil = Math.min(current.readsUntil, now + options.limitMillis);

        return refused && !current.refused
          ? { ...current, readsUntil, reason, refused }
          : { ...current, readsUntil };
      }

      return {
        _tag: "Draining",
        local: options.local !== false,
        readsUntil: now + (current._tag === "Dialing" ? 0 : options.limitMillis),
        reason,
        refused,
      };
    });

    if (options.quitting !== true) {
      yield* lanes.shut;
    }

    yield* wake;
  });

  const logFailed = Effect.suspend(() => drain(logDown, { limitMillis: 0 }));

  // A fiber beside the loop has nobody to tell but the loop, or the Session would go on
  // with no pump to send anything, or nothing joining what it should.
  const closingIfItDies = <A, E, R>(fiber: Effect.Effect<A, E, R>) =>
    fiber.pipe(
      Effect.tapDefect((defect) => Effect.logError("A Connection's fiber died", defect)),
      Effect.catchDefect(() => drain(hostFailed, { limitMillis: 0 }))
    );

  const noticeChannels = Effect.gen(function* () {
    const { channels: joined, kicked } = yield* standing;

    if (joined !== seen?.channels || kicked !== seen.kicked) {
      seen = { channels: joined, kicked };
      Queue.offerUnsafe(moved, undefined);
    }
  });

  const join = Effect.fnUntraced(function* (
    line: QueuedLine["line"],
    sensitive: Sensitive | undefined
  ) {
    const outcome = Deferred.makeUnsafe<number, LineFailure>();

    const offered = yield* lanes.offerWaiting({
      cause: "rejoin",
      lane: "background",
      line,
      outcome,
      ...(sensitive !== undefined && { sensitive }),
    });

    return offered && Exit.isSuccess(yield* Effect.exit(Deferred.await(outcome)));
  });

  const startReconciling = Effect.gen(function* () {
    reconciling = true;

    yield* reconcile({ channels: wanted, join, moved, secrets, standing, tuning }).pipe(
      Effect.catchTag("RecordFailed", () => logFailed),
      closingIfItDies,
      Effect.forkScoped
    );
  });

  // An Ircd's own bytes or a bad Configuration can make a Line that cannot be built, and
  // neither can close a Session (HOST-1). The Log says what became of it (OBS-1).
  const unsend = (
    bytes: Uint8Array,
    cause: string,
    reason: string,
    redacted?: readonly string[]
  ) => {
    unsent.push(droppedEntry(bytes, cause, reason, redacted));
  };

  const offerWaiting = (queued: QueuedLine) =>
    Effect.map(lanes.offerWaiting(queued), (offered) => (offered ? "queued" : "shut"));

  // Lines the host builds itself, which may be refused for want of a Credential, or of
  // room in a lane they cannot wait for, and are recorded as Dropped then (OBS-1).
  const offerOwn = Effect.fnUntraced(function* (order: Extract<Order, { type: "sendBuilt" }>) {
    const { built, cause, lane, waits } = order;

    if (built._tag === "Unsendable") {
      unsend(built.recorded.bytes, cause, built.reason, built.recorded.names);

      return;
    }

    const queued: QueuedLine = {
      cause,
      lane,
      line: built.line,
      outcome: Deferred.makeUnsafe(),
      ...(built.sensitive !== undefined && { sensitive: built.sensitive }),
    };

    const offered = waits ? yield* offerWaiting(queued) : yield* lanes.offerNow(queued);

    if (offered !== "queued") {
      unsent.push(droppedOf(queued, offered === "full" ? `the ${lane} lane is full` : closingDown));
    }
  });

  // Once the burst is over, `IDENTIFY` and the connect commands go out in order, through
  // the interactive lane, each built from the Credentials as they are now (CONN-6).
  const sendLoginSequence = Effect.gen(function* () {
    const held = yield* secrets;
    const { service } = plan.credentials;

    const built = [
      ...(service === undefined
        ? []
        : [{ built: identifyLine(service, held), cause: identifyCause }]),
      ...plan.connectCommands.map((template) => ({
        built: connectCommandLine(template, held),
        cause: connectCommandCause,
      })),
    ];

    for (const { built: line, cause } of built) {
      yield* offerOwn({ built: line, cause, lane: "interactive", type: "sendBuilt", waits: false });
    }
  });

  const offerBuilt = Effect.fnUntraced(function* (
    built: Outbound,
    bytes: () => Uint8Array,
    { cause, isQuit, lane }: Pick<QueuedLine, "cause" | "lane"> & { readonly isQuit: boolean }
  ) {
    if (built._tag === "Rejected") {
      unsend(bytes(), cause, built.reason);
    } else {
      const queued: QueuedLine = {
        cause,
        lane,
        line: built.line,
        outcome: Deferred.makeUnsafe(),
      };

      if (!(yield* isQuit ? lanes.offerQuit(queued) : lanes.offerWaiting(queued))) {
        unsend(built.line.bytes, cause, closingDown);
      }
    }
  });

  const unsendCommand = (command: Order) => {
    if (command.type === "sendBuilt") {
      const recorded =
        command.built._tag === "Safe"
          ? (command.built.sensitive ?? { bytes: command.built.line.bytes, names: [] })
          : command.built.recorded;

      unsend(recorded.bytes, command.cause, closingDown, recorded.names);
    } else if (command.type === "sendLine") {
      unsend(
        encoder.encode([command.command, ...command.params].join(" ")),
        command.cause,
        closingDown
      );
    } else if (command.type === "sendPong") {
      unsend(pongBytes(command.token), command.cause, closingDown);
    }
  };

  const runCommand = Effect.fnUntraced(function* (command: Order, drainMillis: number) {
    switch (command.type) {
      case "burstComplete": {
        yield* sendLoginSequence;

        return yield* startReconciling;
      }

      // The reconciler looks again, since what held joining up is over (CONN-6).
      case "loginSettled": {
        return yield* Queue.offer(moved, undefined);
      }

      case "sendBuilt": {
        return yield* offerOwn(command);
      }

      case "closeConnection": {
        return yield* drain(command.reason, {
          limitMillis: drainMillis,
          quitting: stopHandled,
          ...(command.refused && { refused: command.refused }),
        });
      }

      case "sendLine": {
        const { cause, command: name, lane, params } = command;

        return yield* offerBuilt(
          outbound(name, params),
          () => encoder.encode([name, ...params].join(" ")),
          { cause, isQuit: name === "QUIT", lane }
        );
      }

      case "sendPong": {
        const { cause, lane, token } = command;

        return yield* offerBuilt(pong(token), () => pongBytes(token), {
          cause,
          isQuit: false,
          lane,
        });
      }

      default: {
        return command satisfies never;
      }
    }
  });

  // Nothing acts on a Line once the Connection has started to close: what would have been
  // sent is Dropped instead, and only a refusal still counts, for the reason it gives.
  const runCommands = Effect.fnUntraced(function* (toRun: readonly Order[], drainMillis: number) {
    for (const command of toRun) {
      if ((yield* Ref.get(stage))._tag !== "Draining") {
        yield* runCommand(command, drainMillis);
      } else if (command.type === "closeConnection" && command.refused === true) {
        yield* drain(command.reason, { limitMillis: drainMillis, refused: true });
      } else {
        unsendCommand(command);
      }
    }
  });

  // The lanes are open, so nothing is closing, and what was refused can be told now.
  const flushUnsent = Effect.gen(function* () {
    const open = (yield* Ref.get(stage))._tag !== "Draining" && (yield* lanes.isOpen);

    if (open && Arr.isReadonlyArrayNonEmpty(unsent)) {
      const batch = unsent;

      unsent = [];
      yield* commit(batch).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            unsent = [...batch, ...unsent];
          })
        )
      );
    }
  });

  // A key that is a Credential's own value is scrubbed like any other (LOG-6), so the first
  // `+k` the Daemon sees is the one that is recorded as it arrived (CRED-4). A hook that
  // dies is the Daemon's fault, and costs the Connection nothing.
  const announceKeys = Effect.fnUntraced(function* (before: Standing, recorded: readonly Entry[]) {
    const changes = channelKeyChanges(before, recorded);

    if (onChannelKey === undefined || changes.length === 0) {
      return;
    }

    const held = yield* secrets;

    for (const change of changes) {
      const key = keyOf(change, held);

      if (Option.isSome(key)) {
        yield* onChannelKey({ channel: change.channel, key: key.value }).pipe(
          Effect.catchDefect((defect) => Effect.logError("A Channel key could not be kept", defect))
        );
      }
    }
  });

  const onEntries = Effect.fnUntraced(function* (
    entries: Arr.NonEmptyReadonlyArray<NewEntry>,
    drainMillis: number = tuning.drainMillis,
    leading: readonly Order[] = []
  ) {
    // Read only when a `MODE` could be among them, so that each is read as it stood then.
    const before =
      onChannelKey !== undefined && entries.some(isInboundLine)
        ? yield* Effect.option(standing)
        : Option.none<Standing>();

    const committed = yield* commit(entries).pipe(
      Effect.asSome,
      Effect.catchTag("RecordFailed", () => Effect.succeedNone)
    );

    if (Option.isNone(committed)) {
      // Only the Line Entries: a Deadline or a `closing` that did not land never happened.
      unrecorded = [...unrecorded, ...entries.filter(({ _tag }) => _tag === "Line")];
      yield* logFailed;
    } else {
      yield* runCommands([...leading, ...committed.value.commands], drainMillis);

      if (Option.isSome(before)) {
        yield* announceKeys(before.value, committed.value.recorded);
      }

      yield* flushUnsent.pipe(Effect.catchTag("RecordFailed", () => logFailed));

      if (reconciling && committed.value.channelsMoved) {
        yield* noticeChannels.pipe(Effect.catchTag("RecordFailed", () => logFailed));
      }
    }
  });

  // A local close is recorded as soon as it is decided (LOG-2). It steps no machine,
  // because only a chosen leave means anything to one, and a machine still registering
  // has to be able to read a refusal that follows.
  const recordClosing = Effect.gen(function* () {
    const current = yield* Ref.get(stage);

    if (closingRecorded || current._tag !== "Draining" || !current.local) {
      return;
    }

    closingRecorded = true;
    yield* commit([closingEntry(current.reason, false)]).pipe(
      Effect.catchTag("RecordFailed", () => logFailed)
    );
  });

  // Commits what is left in order, and any refusal among it outranks the reason so far.
  const commitInOrder = Effect.fnUntraced(function* (batches: readonly (readonly NewEntry[])[]) {
    for (const [index, batch] of batches.entries()) {
      if (Arr.isReadonlyArrayNonEmpty(batch)) {
        const committed = yield* commit(batch).pipe(
          Effect.asSome,
          Effect.catchTag("RecordFailed", () => Effect.succeedNone)
        );

        if (Option.isNone(committed)) {
          return batches.slice(index).flat();
        }

        for (const command of committed.value.commands) {
          if (command.type === "closeConnection" && command.refused === true) {
            yield* drain(command.reason, { limitMillis: 0, refused: true });
          }
        }
      }
    }

    return [];
  });

  // The one way a Connection ends. Everything read is recorded first (LOG-4), then what
  // could not be sent, the queued Lines, and `closed`, in one commit (SEND-4). The pump
  // has gone before any of it, so nothing can follow `closed`. If the Log is down, the
  // rest is kept, to be recorded before anything else once it is back (LOG-9).
  const close = Effect.fnUntraced(function* (ending: string, local: boolean) {
    const endedAt = yield* Clock.currentTimeMillis;

    yield* drain(ending, { limitMillis: 0, local });
    yield* Fiber.interruptAll([pump, reader].filter((fiber) => fiber !== undefined));

    const opening = yield* Ref.get(stage);
    const backlog = yield* Queue.clear(inbox);

    const lines = takeLines([
      ...backlog.flatMap((item) => (item._tag === "Read" ? item.chunks : [])),
      ...(yield* unread),
    ]);

    if (framing.pending.length > 0) {
      lines.push(lineEntry(framing.pending, true));
    }

    const head =
      opening._tag === "Draining" && opening.local && !closingRecorded
        ? [closingEntry(opening.reason, false)]
        : [];

    closingRecorded = true;

    // A stop out of time has one commit left to make, and the cap on a transaction only
    // ever kept a flood from holding the writer, which nothing else needs now.
    const read = [...unrecorded, ...head, ...lines];
    const left = hurrying() ? read : yield* commitInOrder(Arr.chunksOf(read, linesPerCommit));

    unrecorded = [];
    const queued = yield* lanes.empty;
    const current = yield* Ref.get(stage);
    const reason = current._tag === "Draining" ? current.reason : ending;
    const refused = current._tag === "Draining" && current.refused;
    const dropReason = `the Connection closed: ${reason}`;

    const dropped = [
      ...unsent,
      ...unwritten.map(({ queued: line, reason: why }) => droppedOf(line, why)),
      ...queued.map((line) => droppedOf(line, dropReason)),
    ];

    unsent = [];

    const end = [...dropped, closedEntry(reason, refused)];

    const rest =
      left.length > 0 && !hurrying()
        ? [...left, ...end]
        : yield* commitInOrder([[...left, ...end]]);

    const recorded = rest.length === 0;

    if (!recorded) {
      // Recorded once the Log is back, so it says when the Connection really ended, which
      // is where the Gap starts (LIVE-10).
      const kept = rest.map((entry) =>
        entry._tag === "Connection" && entry.phase === "closed"
          ? { ...closedEntry(logDown, false), endedAt }
          : entry
      );

      yield* Ref.update(hosted, (state) => ({
        ...state,
        unclosed: kept,
        unrecorded: `${reason}, and ${logDown}'s close`,
      }));
    }

    // A Line is only reported Dropped once the Log holds it as Dropped.
    yield* Effect.forEach(
      queued,
      ({ outcome }) =>
        Deferred.fail(
          outcome,
          recorded ? new LineDropped({ reason: dropReason }) : new RecordFailed({ cause: logDown })
        ),
      { discard: true }
    );

    Deferred.doneUnsafe(closed, Exit.succeed(undefined));
    yield* Ref.update(hosted, (state) => ({ ...state, live: undefined }));
  });

  const pumpWire = (writer: Socket.Writer, tls: boolean): PumpWire => ({
    confirmsLater: tls,
    // A Line built from Credentials is recorded as built with each value `<redacted>`,
    // and written as it is (LOG-6). A Line of the login sequence moves the machine, and
    // the loop is told, because only it can carry out what the machine asks for and it
    // may be waiting on a later deadline than the login wait's (CONN-6).
    record: ({ cause, line, sensitive }) =>
      commit([
        {
          _tag: "Line",
          bytes: sensitive?.bytes ?? line.bytes,
          cause,
          connection,
          direction: "outbound",
          network: id,
          ...(sensitive !== undefined &&
            sensitive.names.length > 0 && { redacted: sensitive.names }),
        },
      ]).pipe(
        Effect.tap(({ commands }) =>
          commands.length > 0 || loginCauses.has(cause)
            ? Queue.offer(inbox, { _tag: "Stepped", commands })
            : Effect.void
        ),
        Effect.map(({ recorded }) => recorded[0]?.sequence ?? 0)
      ),
    recordFailed: logFailed,
    unwritten: (queued, reason) =>
      Effect.sync(() => {
        unwritten.push({ queued, reason });
      }),
    write: ({ line }) =>
      writer.write(encodeLine(line)).pipe(
        Effect.mapError(toWriteFailed),
        Effect.timeoutOrElse({
          duration: Duration.millis(tuning.writeTimeoutMillis),
          orElse: () => Effect.fail(new WriteFailed({ reason: writeTimedOut })),
        })
      ),
    writeFailed: (reason) => drain(reason, { limitMillis: tuning.drainMillis }),
  });

  // Waits with `peek`, because a timed `take` can lose its item to the timer. Only the
  // loop takes, so what `peek` saw is still there, and a late Read can stay there.
  const peekWithin = (millis: number): Effect.Effect<Option.Option<InboxItem>> => {
    if (Queue.sizeUnsafe(inbox) > 0) {
      return Effect.asSome(Queue.peek(inbox));
    }

    return millis > 0
      ? Effect.timeoutOption(Queue.peek(inbox), Duration.millis(millis))
      : Effect.succeedNone;
  };

  const takeOr = <A>(peeked: Option.Option<InboxItem>, otherwise: A) =>
    Option.isSome(peeked) ? Queue.take(inbox) : Effect.succeed(otherwise);

  // A deadline already past waits for nothing, but a Read from before it still goes
  // first, so a `001` that arrived in time beats the registration deadline. A Read from
  // after it does not, and neither does anything once the limit on a close has passed, or
  // a flood could hold either off for good.
  //
  // Silence is the exception, because a Read is what it says did not happen. A process
  // suspended, or a clock moved forward, wakes with the deadline long past and the Lines
  // that disprove it still in the kernel, and the timer is what runs first. So the reader
  // gets its turns, and any Read at all, however late, disproves the silence.
  const nextItem = Effect.fnUntraced(function* () {
    const current = yield* Ref.get(stage);
    const now = yield* Clock.currentTimeMillis;

    if (current._tag === "Draining") {
      const { local, reason } = current;
      const ended = { _tag: "Ended", local, reason } as const;

      return now < current.readsUntil && !hurrying()
        ? yield* takeOr(yield* peekWithin(current.readsUntil - now), ended)
        : ended;
    }

    const { snapshot } = yield* Ref.get(hosted);
    const due = deadline(snapshot);

    if (due === undefined) {
      return yield* Queue.take(inbox);
    }

    const elapsed = { _tag: "Deadline", name: due.name } as const;
    const peeked = yield* peekWithin(due.at - now);

    if (due.name === silenceDeadline) {
      if (Option.isSome(peeked)) {
        return yield* Queue.take(inbox);
      }

      yield* Effect.repeat(Effect.yieldNow, { times: feedTurns });

      return yield* takeOr(yield* peekWithin(0), elapsed);
    }

    // A clock set back can put `now` behind a Read's `at`. The deadline is not due then, so
    // the Read goes on, or every Deadline Entry would come to nothing and be written again.
    const isLate =
      due.at <= now &&
      Option.isSome(peeked) &&
      peeked.value._tag === "Read" &&
      peeked.value.at >= due.at;

    return isLate ? elapsed : yield* takeOr(peeked, elapsed);
  });

  // The Daemon chose to leave, which only the machine can act on, so it hears of it the
  // way it hears of anything. The Ircd gets as long as `QUIT` does to say goodbye, and
  // only the control lane leaves from here, so that `QUIT` is the last Line out.
  const beginStop = Effect.gen(function* () {
    stopHandled = true;

    yield* lanes.quit;

    const current = yield* Ref.get(stage);

    if (current._tag === "Draining") {
      return yield* drain(current.reason, { limitMillis: tuning.quitWaitMillis, quitting: true });
    }

    closingRecorded = true;

    return yield* onEntries([closingEntry(yield* quitReason, true)], tuning.quitWaitMillis);
  });

  // Whatever the loop is doing, it looks here between steps. A choice to leave stands
  // once made, whatever the settings say after.
  const attend = Effect.gen(function* () {
    if (!stopHandled && (yield* leaving)) {
      yield* beginStop;
    }

    if (hurrying()) {
      yield* drain(hurried, { limitMillis: 0 });
    }
  });

  // Runs until the socket ends, so a read ending is one more thing the loop takes. It only
  // reads while what it has read and the loop has not recorded is under the bound, and it
  // can only be interrupted while waiting, so a read that has happened is never forgotten.
  const roomToRead = Effect.tx(
    Effect.gen(function* () {
      return (yield* TxRef.get(held)) < readAheadBytes ? undefined : yield* Effect.txRetry;
    })
  );

  const feed = (pull: Pull) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(roomToRead);

        const chunks = yield* restore(pull);
        const at = yield* Clock.currentTimeMillis;
        const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);

        yield* TxRef.update(held, (total) => total + bytes);
        Queue.offerUnsafe(inbox, { _tag: "Read", at, bytes, chunks });
      })
    ).pipe(
      Effect.forever,
      Effect.catch((error) =>
        Queue.offer(inbox, { _tag: "Ended", local: false, reason: toEnding(error) })
      ),
      Effect.catchDefect(() =>
        Queue.offer(inbox, { _tag: "Ended", local: true, reason: readerDied })
      )
    );

  // A client certificate that has gone since the `attempt` fails the dial, and the next
  // `attempt` waits for it to be set again (CRED-1).
  const clientCertificate = Effect.gen(function* () {
    const name = plan.credentials.clientCertificate;
    const certificate = name === undefined ? undefined : (yield* secrets).get(name);

    if (name !== undefined && certificate === undefined) {
      return yield* new ConnectFailed({ cause: name, reason: `the Credential ${name} is not set` });
    }

    return certificate;
  });

  const dial = Effect.gen(function* () {
    const certificate = yield* clientCertificate;

    const opened = yield* connect(ircd, {
      ...tuning,
      ...(certificate !== undefined && { clientCertificate: certificate }),
    });

    const pull = yield* Socket.readerBytes(opened.socket);
    const writer = yield* opened.socket.writer;

    yield* Queue.offer(inbox, {
      _tag: "Opened",
      pull,
      tls: opened.tls,
      unread: opened.unread ?? nothingUnread,
      writer,
    });
  }).pipe(
    Effect.catchTags({
      ConnectFailed: ({ reason }) => Queue.offer(inbox, { _tag: "Ended", local: false, reason }),
      SocketError: (error) =>
        Queue.offer(inbox, {
          _tag: "Ended",
          local: false,
          reason: `could not read: ${describeSocketError(error)}`,
        }),
    }),
    Effect.catchDefect(() => Queue.offer(inbox, { _tag: "Ended", local: true, reason: dialDied }))
  );

  const onOpened = Effect.fnUntraced(function* ({
    pull,
    tls,
    unread: unreadOf,
    writer,
  }: Extract<InboxItem, { readonly _tag: "Opened" }>) {
    yield* Ref.set(stage, { _tag: "Open" });
    unread = unreadOf;

    pump = yield* Effect.forkScoped(
      closingIfItDies(runPump(pumpLanes, tuning, pumpWire(writer, tls !== undefined)))
    );

    // `PASS` goes before the machine's `NICK` and `USER`, on the same lane (CONN-2). The
    // machine never sees a Credential, so the host builds it.
    const pass: readonly Order[] =
      plan.credentials.password === undefined
        ? []
        : [
            {
              built: passLine(plan.credentials.password, yield* secrets),
              cause: "registration",
              lane: "control",
              type: "sendBuilt",
              waits: true,
            },
          ];

    yield* onEntries(
      [
        {
          _tag: "Connection",
          connection,
          ircd,
          network: id,
          phase: "opened",
          ...(tls !== undefined && { tls }),
        },
      ],
      tuning.drainMillis,
      pass
    );
    reader = yield* Effect.forkScoped(feed(pull));
  });

  // Every batch of a read is recorded, stop or not, but a stop is noticed between
  // batches, so that what follows it is recorded with nothing to answer.
  const onRead = Effect.fnUntraced(function* (chunks: readonly Uint8Array[], bytes: number) {
    const batches = Arr.chunksOf(takeLines(chunks), linesPerCommit);

    for (const [index, batch] of batches.entries()) {
      yield* attend;

      // Out of time, so the close records the rest with everything else, in one commit.
      if (hurrying()) {
        unrecorded = [...unrecorded, ...batches.slice(index).flat()];
        break;
      }

      yield* onEntries(batch);
      yield* Effect.yieldNow;
    }

    yield* TxRef.update(held, (total) => total - bytes);
  });

  const onItem = Effect.fnUntraced(function* (item: LoopItem) {
    switch (item._tag) {
      case "Deadline": {
        // A silent Connection is dead, so nothing is coming to wait for (LIVE-2).
        yield* onEntries(
          [{ _tag: "Deadline", name: item.name, network: id }],
          item.name === silenceDeadline ? 0 : tuning.drainMillis
        );
        break;
      }

      case "Ended": {
        yield* close(item.reason, item.local);
        break;
      }

      // Only ever taken while dialing: a close of a dial has no limit left to read until.
      case "Opened": {
        yield* onOpened(item);
        break;
      }

      case "Read": {
        yield* onRead(item.chunks, item.bytes);
        break;
      }

      case "Stepped": {
        yield* runCommands(item.commands, tuning.drainMillis);
        yield* flushUnsent.pipe(Effect.catchTag("RecordFailed", () => logFailed));
        break;
      }

      case "Wake": {
        break;
      }

      default: {
        item satisfies never;
      }
    }
  });

  const serve = Effect.gen(function* () {
    yield* runCommands(commands, tuning.drainMillis);

    if ((yield* Ref.get(stage))._tag === "Dialing") {
      yield* Effect.forkScoped(dial);
    }

    while (!Deferred.isDoneUnsafe(closed)) {
      yield* attend;
      yield* recordClosing;
      yield* onItem(yield* nextItem());
    }
  });

  // A defect here is a bug or a broken Recorder, and either way the Connection ends the
  // way any other does, so that the next one is only a backoff away.
  yield* serve.pipe(
    Effect.catchDefect((defect) =>
      Effect.andThen(Effect.logError("A Connection failed", defect), close(hostFailed, true))
    )
  );
});
