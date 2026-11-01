import { closeReason, deadline, phase, start, step } from "@iirc/lifecycle";
import type { Command, NetworkInput, NetworkSnapshot, Phase } from "@iirc/lifecycle";
import { takeFrames } from "@iirc/protocol/frame";
import { encodeLine, outbound } from "@iirc/protocol/outbound";
import type { OutboundLine } from "@iirc/protocol/outbound";
import { Array as Arr, Clock, Data, Duration, Effect, Option, Queue, Ref, Semaphore } from "effect";
import type { Scope } from "effect";
import { constFalse, constVoid } from "effect/Function";
import { Socket } from "effect/socket";

import type { Entry, Ircd, NetworkId, NewEntry } from "./entry.ts";
import { toEvent } from "./events.ts";
import { Recorder } from "./recorder.ts";
import type { RecordFailed } from "./recorder.ts";
import { describeSocketError, Transport } from "./transport.ts";

// CONN-1.
const writeTimeout = Duration.seconds(10);

// How long a Connection that is closing has to finish delivering what the Ircd already
// sent. An Ircd that hangs up ends this far sooner, so it only stops one that never does.
const drainLimit = Duration.seconds(5);

// Small, so that a flood waits in the kernel and not in this process.
const inboxCapacity = 16;

// A Line Entry holds a frame, and `takeFrames` drops the line ending from those, so
// an outbound Entry holds what was written minus the CRLF that `encodeLine` adds.
const lineEndingBytes = 2;

const pingReply = "ping-reply";
const ircdClosed = "the Ircd closed the Connection";
const logDown = "the Log could not record this Connection";
const hostStopped = "the host stopped";

/** Who to be on which Network, and where to reach it. */
export interface NetworkOptions {
  readonly id: NetworkId;
  readonly input: NetworkInput;
  readonly ircd: Ircd;
}

/** A Line could not be sent because there is no Session on the Network. */
export class NotInSession extends Data.TaggedError("NotInSession")<{ readonly phase: Phase }> {}

/** A Network being hosted. */
export interface NetworkHost {
  /** Records a Line, then writes it. Fails unless the Network is in a Session. */
  readonly send: (
    line: OutboundLine,
    cause: string
  ) => Effect.Effect<void, NotInSession | RecordFailed>;
  readonly status: Effect.Effect<{
    readonly closeReason: string | undefined;
    readonly phase: Phase;
  }>;
}

class WriteFailed extends Data.TaggedError("WriteFailed")<{ readonly reason: string }> {}

type InboxItem =
  // `at` is when it was read, which says whether it arrived ahead of a deadline.
  | { readonly _tag: "Read"; readonly at: number; readonly chunks: readonly Uint8Array[] }
  | { readonly _tag: "Ended"; readonly reason: string }
  // Says nothing itself: the loop looks at `writes` again before its next wait.
  | { readonly _tag: "Wake" };

interface OpenWrites {
  readonly _tag: "Open";
  readonly connection: number;
  readonly writer: Socket.Writer;
}

// Whether Lines can leave. `Draining` is a Connection that is closing, and only read
// from until `readsUntil`, and its `reason` is the first thing to go wrong.
type Writes =
  | { readonly _tag: "None" }
  | OpenWrites
  | { readonly _tag: "Draining"; readonly reason: string; readonly readsUntil: number };

const noWrites: Writes = { _tag: "None" };

interface Hosted {
  readonly snapshot: NetworkSnapshot;
  // Why hosting ended, for when no `closed` Entry says so.
  readonly unrecorded: string | undefined;
  readonly writes: Writes;
}

interface Stepped {
  readonly commands: readonly Command[];
  readonly next: NetworkSnapshot;
}

interface Framing {
  readonly cutting: boolean;
  readonly pending: Uint8Array;
}

// A transition that throws leaves the machine where it was and closes the Connection
// (HOST-1).
const stepEntry = (snapshot: NetworkSnapshot, entry: Entry): Stepped => {
  const event = toEvent(entry);

  if (event === undefined) {
    return { commands: [], next: snapshot };
  }

  try {
    return step(snapshot, event);
  } catch {
    const reason = `the machine threw on Entry ${entry.sequence}`;

    return { commands: [{ reason, type: "closeConnection" }], next: snapshot };
  }
};

const stepEntries = (snapshot: NetworkSnapshot, entries: Iterable<Entry>) => {
  const commands: Command[] = [];
  let next = snapshot;

  for (const entry of entries) {
    const stepped = stepEntry(next, entry);

    commands.push(...stepped.commands);
    ({ next } = stepped);
  }

  return { commands, next };
};

const isClosed = ({ snapshot, unrecorded }: Hosted) =>
  unrecorded !== undefined || phase(snapshot) === "closed";

// Status is the fold, and only says otherwise where the Log could not record the end.
const statusOf = ({ snapshot, unrecorded }: Hosted): Effect.Success<NetworkHost["status"]> => ({
  closeReason: unrecorded ?? closeReason(snapshot),
  phase: unrecorded === undefined ? phase(snapshot) : "closed",
});

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

/**
 * Starts hosting a Network in the enclosing Scope, which releases the socket when it
 * closes. One fiber owns the machine and every step of it, a second feeds it what the
 * socket reads, and `send` may come from any other fiber. It never fails: every
 * ending is an Entry, or `status` says that the Log could not take one. The machine
 * starts afresh, because the `attempt` this records resets it whatever came before.
 * @param options - Who to be on which Network.
 * @returns The running host.
 */
export const hostNetwork: (
  options: NetworkOptions
) => Effect.Effect<NetworkHost, never, Recorder | Scope.Scope | Transport> = Effect.fn(
  "hostNetwork"
)(function* ({ id, input, ircd }: NetworkOptions) {
  const { record } = yield* Recorder;
  const { connect } = yield* Transport;

  const state = yield* Ref.make<Hosted>({
    snapshot: start(input),
    unrecorded: undefined,
    writes: noWrites,
  });

  const inbox = yield* Queue.bounded<InboxItem>(inboxCapacity);

  // Held across record and write, so Log order is wire order (LOG-4), and across the
  // close, so nothing is recorded on a Connection after its `closed` Entry.
  const outboundLock = yield* Semaphore.make(1);

  // Only the loop's fiber calls this. A step that a failed commit rolls back never
  // reaches `state`, because `within` only works out the next snapshot.
  const commit = Effect.fnUntraced(function* (entries: Arr.NonEmptyReadonlyArray<NewEntry>) {
    const { snapshot } = yield* Ref.get(state);

    const stepped = yield* record(entries, (recorded) => ({
      ...stepEntries(snapshot, recorded),
      recorded,
    }));

    yield* Ref.update(state, (hosted) => ({ ...hosted, snapshot: stepped.next }));

    return stepped;
  });

  // Must run under `outboundLock`. Its Entry steps nothing, because `toEvent` has no
  // event for an outbound Line, which is why any fiber may do this.
  const transmit = Effect.fnUntraced(function* (
    { connection, writer }: OpenWrites,
    line: OutboundLine,
    cause: string
  ) {
    const wire = encodeLine(line);

    yield* record(
      [
        {
          _tag: "Line",
          bytes: wire.subarray(0, -lineEndingBytes),
          cause,
          connection,
          direction: "outbound",
          network: id,
        },
      ],
      constVoid
    );

    yield* writer.write(wire).pipe(
      Effect.mapError(toWriteFailed),
      Effect.timeoutOrElse({
        duration: writeTimeout,
        orElse: () => Effect.fail(new WriteFailed({ reason: "write timed out" })),
      })
    );
  });

  // How every close starts, whatever caused it. Nothing more is written or acted on,
  // and only the first reason counts. The loop reads on from here, because what the
  // Ircd sent is still worth recording (HOST-1), and calls `close` when that ends.
  const drain = Effect.fnUntraced(function* (reason: string) {
    const now = yield* Clock.currentTimeMillis;
    const readsUntil = now + Duration.toMillis(drainLimit);

    yield* Ref.update(state, (hosted): Hosted =>
      hosted.writes._tag === "Open"
        ? { ...hosted, writes: { _tag: "Draining", readsUntil, reason } }
        : hosted
    );
  });

  const whileOpen = <E, R>(act: (writes: OpenWrites) => Effect.Effect<void, E, R>) =>
    Effect.flatMap(Ref.get(state), ({ writes }) =>
      writes._tag === "Open" ? act(writes) : Effect.void
    );

  // Waits with `peek`, because a timed `take` can lose its item to the timer. Only the
  // loop takes, so what `peek` saw is still there, and `late` can leave it there.
  const takeUnless = Effect.fnUntraced(function* <A>(
    millis: number,
    otherwise: A,
    late: (item: InboxItem) => boolean = constFalse
  ) {
    const waited = yield* Queue.peek(inbox).pipe(
      Effect.timeoutOption(Duration.millis(Math.max(millis, 0)))
    );

    return Option.isSome(waited) && !late(waited.value) ? yield* Queue.take(inbox) : otherwise;
  });

  // Runs until the socket ends, so a read ending is one more thing the loop takes.
  const feed = (pull: Effect.Effect<readonly Uint8Array[], Socket.SocketError>) =>
    Effect.gen(function* () {
      const chunks = yield* pull;
      const at = yield* Clock.currentTimeMillis;

      yield* Queue.offer(inbox, { _tag: "Read", at, chunks });
    }).pipe(
      Effect.forever,
      Effect.catch((error) => Queue.offer(inbox, { _tag: "Ended", reason: toEnding(error) })),
      Effect.catchDefect(() => Queue.offer(inbox, { _tag: "Ended", reason: "the reader died" }))
    );

  const hostConnection = Effect.fn("hostConnection")(function* (connection: number) {
    let framing: Framing = { cutting: false, pending: new Uint8Array() };

    const lineEntry = (bytes: Uint8Array, cut: boolean): NewEntry => ({
      _tag: "Line",
      bytes,
      connection,
      direction: "inbound",
      network: id,
      ...(cut && { cut }),
    });

    const connectionEntry = (phase: "opened" | "closed", reason?: string): NewEntry => ({
      _tag: "Connection",
      connection,
      ircd,
      network: id,
      phase,
      ...(reason !== undefined && { reason }),
    });

    const takeLines = (chunks: readonly Uint8Array[]) => {
      const entries: NewEntry[] = [];

      for (const chunk of chunks) {
        const { cut, cutting, frames, pending } = takeFrames(
          framing.pending,
          chunk,
          framing.cutting
        );

        for (const [index, frame] of frames.entries()) {
          entries.push(lineEntry(frame, cut.has(index)));
        }

        framing = { cutting, pending };
      }

      return entries;
    };

    // The one way a Connection ends, and the first reason wins. Whatever was read and
    // not yet framed goes down with it, so no Line is lost, but its Commands have no
    // Connection to run on. Only a read side that has ended, or a Log that has gone,
    // comes here directly, and everything else goes through `drain`.
    const close = Effect.fnUntraced(function* (reason: string) {
      yield* outboundLock.withPermit(
        Effect.gen(function* () {
          const hosted = yield* Ref.get(state);

          if (isClosed(hosted)) {
            return;
          }

          const first = hosted.writes._tag === "Draining" ? hosted.writes.reason : reason;
          const backlog = yield* Queue.clear(inbox);

          const entries = takeLines(
            backlog.flatMap((item) => (item._tag === "Read" ? item.chunks : []))
          );

          if (framing.pending.length > 0) {
            entries.push(lineEntry(framing.pending, true));
          }

          // With the Log down there is nothing left to try, so only `status` knows.
          yield* commit(Arr.append(entries, connectionEntry("closed", first))).pipe(
            Effect.catchTag("RecordFailed", () =>
              Ref.update(state, (latest) => ({
                ...latest,
                unrecorded: `${first}, and ${logDown}'s close`,
              }))
            )
          );

          yield* Ref.update(state, (latest) => ({ ...latest, writes: noWrites }));
        })
      );
    });

    const runCommand = Effect.fnUntraced(function* (command: Command) {
      if (command.type === "closeConnection") {
        return yield* drain(command.reason);
      }

      const built = outbound(command.command, command.params);

      if (built._tag === "Safe") {
        return yield* outboundLock
          .withPermit(whileOpen((writes) => transmit(writes, built.line, command.cause)))
          .pipe(
            Effect.catchTags({
              RecordFailed: () => close(logDown),
              WriteFailed: ({ reason }) => drain(reason),
            })
          );
      }

      // A `PONG` echoes the Ircd's own token, so one that cannot be built is the
      // Ircd's bad bytes, and those never close a Session (HOST-1).
      return command.cause === pingReply
        ? yield* Effect.logWarning(`Dropped a ${command.command}: ${built.reason}`)
        : yield* drain(`could not send a ${command.command} Line: ${built.reason}`);
    });

    // Nothing acts on a Line once the Connection has started to close.
    const runCommands = Effect.fnUntraced(function* (commands: readonly Command[]) {
      yield* Effect.forEach(commands, (command) => whileOpen(() => runCommand(command)), {
        discard: true,
      });
    });

    const onEntries = Effect.fnUntraced(
      function* (entries: Arr.NonEmptyReadonlyArray<NewEntry>) {
        const { commands } = yield* commit(entries);

        yield* runCommands(commands);
      },
      Effect.catchTag("RecordFailed", () => close(logDown))
    );

    // A deadline already past waits for nothing, but a Read from before it still goes
    // first, so a `001` that arrived in time beats the registration deadline. A Read
    // from after it does not, and neither does anything once the limit on a close has
    // passed, or a flood could hold either off for good.
    const nextItem = Effect.fnUntraced(function* () {
      const { snapshot, writes } = yield* Ref.get(state);
      const now = yield* Clock.currentTimeMillis;

      if (writes._tag === "Draining") {
        const ended = { _tag: "Ended", reason: writes.reason } as const;

        return now < writes.readsUntil ? yield* takeUnless(writes.readsUntil - now, ended) : ended;
      }

      const due = deadline(snapshot);

      return due === undefined
        ? yield* Queue.take(inbox)
        : yield* takeUnless(
            due.at - now,
            { _tag: "Deadline", name: due.name } as const,
            (item) => item._tag === "Read" && item.at >= due.at
          );
    });

    const serve = Effect.fnUntraced(function* () {
      while (!isClosed(yield* Ref.get(state))) {
        const item = yield* nextItem();

        switch (item._tag) {
          case "Deadline": {
            yield* onEntries([{ _tag: "Deadline", name: item.name, network: id }]);
            break;
          }

          case "Ended": {
            yield* close(item.reason);
            break;
          }

          case "Read": {
            const entries = takeLines(item.chunks);

            if (Arr.isReadonlyArrayNonEmpty(entries)) {
              yield* onEntries(entries);
            }

            break;
          }

          case "Wake": {
            break;
          }

          default: {
            item satisfies never;
          }
        }
      }
    });

    const open = Effect.gen(function* () {
      const socket = yield* connect(ircd);
      const pull = yield* Socket.readerBytes(socket);
      const writer = yield* socket.writer;

      yield* Ref.update(state, (hosted): Hosted => ({
        ...hosted,
        writes: { _tag: "Open", connection, writer },
      }));

      const { commands } = yield* commit([connectionEntry("opened")]);

      yield* Effect.forkScoped(feed(pull));
      yield* runCommands(commands);
      yield* serve();
    });

    yield* open.pipe(
      Effect.catchTags({
        ConnectFailed: ({ reason }) => close(reason),
        RecordFailed: () => close(logDown),
        SocketError: (error) => close(`could not read: ${describeSocketError(error)}`),
      })
    );
  });

  // One Connection for now. A reconnect is a loop around this, and `Effect.scoped`
  // is what releases each socket as its Connection ends.
  yield* commit([{ _tag: "Connection", ircd, network: id, phase: "attempt" }]).pipe(
    Effect.flatMap(({ recorded: [attempt] }) => hostConnection(attempt.sequence)),
    Effect.catchTag("RecordFailed", () =>
      Ref.update(state, (hosted) => ({ ...hosted, unrecorded: logDown }))
    ),
    Effect.scoped,
    Effect.tapDefect((defect) => Effect.logError("The Network host died", defect)),
    Effect.ensuring(
      Effect.andThen(
        Queue.shutdown(inbox),
        Ref.update(state, (hosted) => ({
          ...hosted,
          unrecorded: isClosed(hosted) ? hosted.unrecorded : hostStopped,
          writes: noWrites,
        }))
      )
    ),
    Effect.forkScoped
  );

  const send = Effect.fnUntraced(
    function* (line: OutboundLine, cause: string) {
      yield* outboundLock.withPermit(
        Effect.gen(function* () {
          const hosted = yield* Ref.get(state);
          const { phase } = statusOf(hosted);

          if (hosted.writes._tag === "Draining") {
            return yield* new NotInSession({ phase: "closed" });
          }

          if (phase !== "session" || hosted.writes._tag !== "Open") {
            return yield* new NotInSession({ phase });
          }

          return yield* transmit(hosted.writes, line, cause);
        })
      );
    },
    // Only the loop may close, and it may be parked on the inbox or waiting for the
    // lock, so each of these wakes it after the lock is released. A caller who has
    // gone away must not take that with them, or the Connection would never end.
    Effect.catchTags({
      RecordFailed: (failed) =>
        Effect.andThen(
          Effect.uninterruptible(Queue.offer(inbox, { _tag: "Ended", reason: logDown })),
          Effect.fail(failed)
        ),
      WriteFailed: ({ reason }) =>
        Effect.andThen(
          Effect.uninterruptible(
            Effect.andThen(drain(reason), Queue.offer(inbox, { _tag: "Wake" }))
          ),
          Effect.fail(new NotInSession({ phase: "closed" }))
        ),
    })
  );

  return { send, status: Effect.map(Ref.get(state), statusOf) };
});
