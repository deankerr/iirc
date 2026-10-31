import { Effect, Schedule } from "effect";
import type { Scope } from "effect";

/** A local stand-in for an Ircd that answers each Line it receives from a script. */
export interface ScriptedIrcd {
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
