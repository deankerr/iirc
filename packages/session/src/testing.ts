import { Effect, Queue, Schedule } from "effect";
import type { Scope } from "effect";
import { Socket } from "effect/socket";

import type { Transport } from "./transport.ts";
import { ConnectFailed } from "./transport.ts";

/** A local stand-in for an Ircd that answers each Line it receives from a script. */
export interface ScriptedIrcd {
  /** How many Connections have been accepted, ever. */
  readonly accepted: Effect.Effect<number>;
  readonly hangUp: Effect.Effect<void>;
  readonly port: number;
  readonly push: (text: string) => Effect.Effect<void>;
  readonly received: Effect.Effect<readonly string[]>;
}

/**
 * Scripts an Ircd that answers `USER` and `JOIN` the way a welcoming one does.
 * @param nick - The nick to welcome.
 * @returns The script.
 */
export const welcoming =
  (nick: string) =>
  (line: string): readonly string[] => {
    if (line.startsWith("USER ")) {
      return [`:ircd 001 ${nick} :Welcome`];
    }

    return line.startsWith("JOIN ") ? [`:${nick}!~u@host ${line}`] : [];
  };

/**
 * Listens on a local port until the enclosing scope closes.
 * @param respond - Maps each received Line to the Lines to send back.
 * @returns The running Ircd.
 */
export const scriptedIrcd = (
  respond: (line: string) => readonly string[]
): Effect.Effect<ScriptedIrcd, never, Scope.Scope> =>
  Effect.gen(function* () {
    const received: string[] = [];
    const connections = new Set<Bun.Socket>();
    let accepted = 0;
    let buffered = "";

    const writeAll = (text: string) => {
      for (const connection of connections) {
        connection.write(`${text}\r\n`);
      }
    };

    const listener = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            close: (connection) => {
              connections.delete(connection);
            },
            data: (_connection, data) => {
              const lines = `${buffered}${data.toString()}`.split("\r\n");
              buffered = lines.pop() ?? "";

              for (const line of lines) {
                received.push(line);

                for (const reply of respond(line)) {
                  writeAll(reply);
                }
              }
            },
            open: (connection) => {
              accepted += 1;
              connections.add(connection);
            },
          },
        })
      ),
      (listening) =>
        Effect.sync(() => {
          listening.stop(true);
        })
    );

    return {
      accepted: Effect.sync(() => accepted),
      hangUp: Effect.sync(() => {
        for (const connection of connections) {
          connection.terminate();
        }
      }),
      port: listener.port,
      push: (text) =>
        Effect.sync(() => {
          writeAll(text);
        }),
      received: Effect.sync(() => [...received]),
    };
  });

/**
 * Re-runs an effect until its value satisfies a predicate.
 * @param check - The effect to re-run.
 * @param done - Whether a value is the one being waited for.
 * @returns The satisfying value.
 */
export const eventually = <A, E, R>(check: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 millis"), until: done }),
    Effect.timeout("2 seconds"),
    Effect.orDie
  );

/** How a {@link FakeIrcd}'s socket treats the next writes. */
export type FakeWrites = "accept" | "fail" | "hang" | "jitter";

/** An Ircd that exists only in memory, so tests can run on `TestClock`. */
export interface FakeIrcd {
  /** Ends the socket the way a peer closing it does. */
  readonly hangUp: Effect.Effect<void>;
  /** Fails the next pull with a read error. */
  readonly breakRead: Effect.Effect<void>;
  /** Kills the next pull with a defect, as a broken socket implementation would. */
  readonly dieOnRead: Effect.Effect<void>;
  /** Delivers one pull's batch, with each argument its own chunk. */
  readonly read: (
    first: Uint8Array | string,
    ...rest: readonly (Uint8Array | string)[]
  ) => Effect.Effect<void>;
  /** Whether the socket's Scope has closed. */
  readonly released: Effect.Effect<boolean>;
  readonly setWrites: (writes: FakeWrites) => Effect.Effect<void>;
  /** Connects to this Ircd, whatever `Ircd` is asked for. */
  readonly transport: Transport["Service"];
  /** What was written, one item per write. */
  readonly written: Effect.Effect<readonly Uint8Array[]>;
}

type Pull = Socket.Reader["pull"];

const textEncoder = new TextEncoder();

const socketError = (reason: Socket.SocketError["reason"]) => new Socket.SocketError({ reason });

/**
 * Builds an Ircd that exists only in memory.
 * @param options - Set `refuses` to fail the dial, `unreadable` to fail the reader, or
 * `onWrite` to watch each write land.
 * @returns The Ircd, with no real socket behind it.
 */
export const fakeIrcd = Effect.fnUntraced(function* (options?: {
  readonly onWrite?: () => void;
  readonly refuses?: boolean;
  readonly unreadable?: boolean;
}) {
  const reads = yield* Queue.unbounded<Pull>();
  const written: Uint8Array[] = [];
  let writes: FakeWrites = "accept";
  let released = false;
  let jitter = 0;

  const accept = (chunk: Uint8Array | string) =>
    Effect.sync(() => {
      written.push(chunk instanceof Uint8Array ? chunk : textEncoder.encode(chunk));
      options?.onWrite?.();
    });

  // Each write yields a different number of times, so writes that are not
  // serialised overtake each other.
  const jittered = (chunk: Uint8Array | string) =>
    Effect.suspend(() => {
      jitter += 1;

      return Effect.andThen(
        Effect.forEach(Array.from({ length: (jitter * 7) % 5 }), () => Effect.yieldNow, {
          discard: true,
        }),
        accept(chunk)
      );
    });

  const write = (chunk: Uint8Array | string | Socket.CloseEvent) => {
    if (Socket.isCloseEvent(chunk)) {
      return Effect.void;
    }

    switch (writes) {
      case "accept": {
        return accept(chunk);
      }

      case "fail": {
        return Effect.fail(
          socketError(new Socket.SocketWriteError({ cause: new Error("broken pipe") }))
        );
      }

      case "hang": {
        return Effect.never;
      }

      case "jitter": {
        return jittered(chunk);
      }

      default: {
        return writes satisfies never;
      }
    }
  };

  const socket = Socket.make({
    reader:
      options?.unreadable === true
        ? Effect.fail(socketError(new Socket.SocketCloseError({ code: 1006 })))
        : Effect.succeed({
            pull: Effect.flatten(Queue.take(reads)),
            upgrade: Socket.SocketUpgradeError.unsupported,
          }),
    writer: Effect.succeed({
      write: (chunk) => Effect.suspend(() => write(chunk)),
      writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
    }),
  });

  return {
    breakRead: Effect.asVoid(
      Queue.offer(
        reads,
        Effect.fail(socketError(new Socket.SocketReadError({ cause: new Error("reset") })))
      )
    ),
    dieOnRead: Effect.asVoid(Queue.offer(reads, Effect.die("the reader broke"))),
    hangUp: Effect.asVoid(
      Queue.offer(reads, Effect.fail(socketError(new Socket.SocketCloseError({ code: 1000 }))))
    ),
    read: (first, ...rest) => Effect.asVoid(Queue.offer(reads, Effect.succeed([first, ...rest]))),
    released: Effect.sync(() => released),
    setWrites: (next) =>
      Effect.sync(() => {
        writes = next;
      }),
    transport: {
      connect: () =>
        options?.refuses === true
          ? Effect.fail(new ConnectFailed({ cause: "refused", reason: "refused" }))
          : Effect.acquireRelease(Effect.succeed(socket), () =>
              Effect.sync(() => {
                released = true;
              })
            ),
    },
    written: Effect.sync(() => [...written]),
  } satisfies FakeIrcd;
});
