import { closeReason, deadline, phase, start, step } from "@iirc/lifecycle";
import type { Command, NetworkInput, NetworkSnapshot, Phase } from "@iirc/lifecycle";
import { takeFrames } from "@iirc/protocol/frame";
import { encodeLine, outbound } from "@iirc/protocol/outbound";
import type { OutboundLine } from "@iirc/protocol/outbound";
import { Clock, Data, Duration, Effect, Option, Queue, Ref, Semaphore } from "effect";
import type { Scope } from "effect";
import { constVoid } from "effect/Function";
import { Socket } from "effect/socket";

import type { Entry, Ircd, NetworkId, NewEntry } from "./entry.ts";
import { toEvent } from "./events.ts";
import { Recorder } from "./recorder.ts";
import type { RecordFailed } from "./recorder.ts";
import { describeSocketError, Transport } from "./transport.ts";

// CONN-1.
const writeTimeout = Duration.seconds(10);

// Small, so that a flood waits in the kernel and not in this process.
const inboxCapacity = 16;

// A Line Entry holds a frame, and `takeFrames` drops the line ending from those, so
// an outbound Entry holds what was written minus the CRLF that `encodeLine` adds.
const lineEndingBytes = 2;

const pingReply = "ping-reply";
const logDown = "the Log could not record this Connection";
const hostStopped = "the host stopped";

/** Who to be on which Network, and where to reach it. */
export interface NetworkOptions {
  readonly id: NetworkId;
  readonly input: NetworkInput;
  readonly ircd: Ircd;
  /** This Network's earlier Entries, oldest first, so the machine resumes as a fold. */
  readonly history: Iterable<Entry>;
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
  | { readonly _tag: "Read"; readonly chunks: readonly Uint8Array[] }
  | { readonly _tag: "Ended"; readonly reason: string };

// An open Connection, as `send` needs it.
interface Link {
  readonly connection: number;
  readonly writer: Socket.Writer;
}

interface Hosted {
  // Why hosting ended. Only this can say so when the `closed` Entry never landed.
  readonly ended: string | undefined;
  readonly link: Link | undefined;
  readonly snapshot: NetworkSnapshot;
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
// (HOST-1). Live and replayed Entries both come through here, so they agree.
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

const statusOf = ({ ended, snapshot }: Hosted) => ({
  closeReason: ended ?? closeReason(snapshot),
  phase: ended === undefined ? phase(snapshot) : ("closed" satisfies Phase),
});

const toEnding = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError"
    ? "the Ircd closed the Connection"
    : `read failed: ${describeSocketError(error)}`;

/**
 * Starts hosting a Network in the enclosing Scope, which releases the socket when it
 * closes. One fiber owns the machine and every step of it, a second feeds it what the
 * socket reads, and `send` may come from any other fiber. It never fails: every
 * ending is an Entry, or `status` says that the Log could not take one.
 * @param options - Who to be on which Network, and what already happened there.
 * @returns The running host.
 */
export const hostNetwork: (
  options: NetworkOptions
) => Effect.Effect<NetworkHost, never, Recorder | Scope.Scope | Transport> = Effect.fn(
  "hostNetwork"
)(function* ({ history, id, input, ircd }: NetworkOptions) {
  const { record } = yield* Recorder;
  const { connect } = yield* Transport;

  const state = yield* Ref.make<Hosted>({
    ended: undefined,
    link: undefined,
    snapshot: stepEntries(start(input), history).next,
  });

  const inbox = yield* Queue.bounded<InboxItem>(inboxCapacity);

  // Held across record and write, so Log order is wire order (LOG-4), and across the
  // close, so nothing is recorded on a Connection after its `closed` Entry.
  const outboundLock = yield* Semaphore.make(1);

  // Only the loop's fiber calls this. A step that a failed commit rolls back never
  // reaches `state`, because `within` only works out the next snapshot.
  const commit = Effect.fnUntraced(function* (entries: readonly NewEntry[]) {
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
    { connection, writer }: Link,
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
      Effect.mapError(
        (error) => new WriteFailed({ reason: `write failed: ${describeSocketError(error)}` })
      ),
      Effect.timeoutOrElse({
        duration: writeTimeout,
        orElse: () => Effect.fail(new WriteFailed({ reason: "write timed out" })),
      })
    );
  });

  // Runs until the socket ends, so a read ending is one more thing the loop takes.
  const feed = (pull: Effect.Effect<readonly Uint8Array[], Socket.SocketError>) =>
    pull.pipe(
      Effect.flatMap((chunks) => Queue.offer(inbox, { _tag: "Read", chunks })),
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
    // Connection to run on.
    const close = Effect.fnUntraced(function* (reason: string) {
      yield* outboundLock.withPermit(
        Effect.gen(function* () {
          if ((yield* Ref.get(state)).ended !== undefined) {
            return;
          }

          const backlog = yield* Queue.clear(inbox);

          const entries = takeLines(
            backlog.flatMap((item) => (item._tag === "Read" ? item.chunks : []))
          );

          if (framing.pending.length > 0) {
            entries.push(lineEntry(framing.pending, true));
          }

          entries.push(connectionEntry("closed", reason));

          // With the Log down there is nothing left to try, so only `status` knows.
          const ended = yield* commit(entries).pipe(
            Effect.as(reason),
            Effect.catchTag("RecordFailed", () =>
              Effect.succeed(`${reason}, and ${logDown}'s close`)
            )
          );

          yield* Ref.update(state, (hosted) => ({ ...hosted, ended, link: undefined }));
        })
      );
    });

    const runCommand = Effect.fnUntraced(function* (command: Command) {
      if (command.type === "closeConnection") {
        return yield* close(command.reason);
      }

      const built = outbound(command.command, command.params);

      if (built._tag === "Safe") {
        return yield* outboundLock
          .withPermit(
            Effect.flatMap(Ref.get(state), ({ link }) =>
              link === undefined ? Effect.void : transmit(link, built.line, command.cause)
            )
          )
          .pipe(
            Effect.catchTags({
              RecordFailed: () => close(logDown),
              WriteFailed: ({ reason }) => close(reason),
            })
          );
      }

      // A `PONG` echoes the Ircd's own token, so one that cannot be built is the
      // Ircd's bad bytes, and those never close a Session (HOST-1).
      return command.cause === pingReply
        ? yield* Effect.logWarning(`Dropped a ${command.command}: ${built.reason}`)
        : yield* close(`could not send a ${command.command} Line: ${built.reason}`);
    });

    const runCommands = Effect.fnUntraced(function* (commands: readonly Command[]) {
      yield* Effect.forEach(commands, runCommand, { discard: true });
    });

    const onEntries = Effect.fnUntraced(
      function* (entries: readonly NewEntry[]) {
        const { commands } = yield* commit(entries);

        yield* runCommands(commands);
      },
      Effect.catchTag("RecordFailed", () => close(logDown))
    );

    // A deadline already past waits for nothing, but a Read queued ahead of it still
    // goes first, so a `001` that arrived in time beats the registration deadline.
    const nextItem = Effect.fnUntraced(function* () {
      const due = deadline((yield* Ref.get(state)).snapshot);

      if (due === undefined) {
        return yield* Queue.take(inbox);
      }

      const wait = due.at - (yield* Clock.currentTimeMillis);

      const item = yield* Queue.take(inbox).pipe(
        Effect.timeoutOption(Duration.millis(Math.max(wait, 0)))
      );

      return Option.getOrElse(item, () => ({ _tag: "Deadline", name: due.name }) as const);
    });

    const serve = Effect.fnUntraced(function* () {
      while ((yield* Ref.get(state)).ended === undefined) {
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

            if (entries.length > 0) {
              yield* onEntries(entries);
            }

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
      const link = { connection, writer };

      yield* Ref.update(state, (hosted) => ({ ...hosted, link }));

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
    Effect.flatMap(({ recorded }) => hostConnection(recorded[0]?.sequence ?? 0)),
    Effect.catchTag("RecordFailed", () =>
      Ref.update(state, (hosted) => ({ ...hosted, ended: logDown }))
    ),
    Effect.scoped,
    Effect.tapDefect((defect) => Effect.logError("The Network host died", defect)),
    Effect.ensuring(
      Effect.andThen(
        Queue.shutdown(inbox),
        Ref.update(state, (hosted) => ({
          ...hosted,
          ended: hosted.ended ?? hostStopped,
          link: undefined,
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

          if (phase !== "session" || hosted.link === undefined) {
            return yield* new NotInSession({ phase });
          }

          return yield* transmit(hosted.link, line, cause);
        })
      );
    },
    // Only the loop may close, and it may be waiting for the lock, so these are
    // offered after the lock is released. A failed write means the Session is over.
    Effect.catchTags({
      RecordFailed: (failed) =>
        Effect.andThen(Queue.offer(inbox, { _tag: "Ended", reason: logDown }), Effect.fail(failed)),
      WriteFailed: ({ reason }) =>
        Effect.andThen(
          Queue.offer(inbox, { _tag: "Ended", reason }),
          Effect.fail(new NotInSession({ phase: "closed" }))
        ),
    })
  );

  return { send, status: Effect.map(Ref.get(state), statusOf) };
});
