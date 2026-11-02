import { Database } from "bun:sqlite";

import { DaemonApi } from "@iirc/api";
import { Effect, Schedule, Stream } from "effect";
import { constVoid } from "effect/Function";
import { HttpApiClient } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Where this package's sources sit above. */
export const appRoot = `${import.meta.dirname}/..`;

/** Asks the kernel for a port nothing is using. */
export const freePort = Effect.acquireUseRelease(
  Effect.sync(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: constVoid } })),
  ({ port }) => Effect.succeed(port),
  (listening) =>
    Effect.sync(() => {
      listening.stop(true);
    })
);

/**
 * Starts a binary in the enclosing scope, which kills whatever is left of it, and keeps
 * everything it prints. The environment is empty so that nothing leaks in.
 * @param binary - The binary to run.
 * @param flags - Its arguments.
 * @param environment - All of its environment, but for `PATH`.
 * @returns The child, and what it has printed so far.
 */
export const startBinary = Effect.fnUntraced(function* (
  binary: string,
  flags: readonly string[],
  environment: Readonly<Record<string, string>>
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output: string[] = [];

  const child = yield* spawner.spawn(
    ChildProcess.make(binary, flags, {
      env: { PATH: process.env.PATH, ...environment },
      extendEnv: false,
    })
  );

  const reader = yield* child.all.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        output.push(text);
      })
    ),
    Effect.ignore,
    Effect.forkScoped
  );

  return { child, output: () => output.join(""), reader };
});

/**
 * Reads the end of a Log no Daemon has open, one word for each Entry: a Line's text, or
 * an Entry's kind and phase. What a stopped Daemon left is out of reach of its API.
 * @param dataDir - The Daemon's data directory.
 * @param length - How many Entries to read.
 * @returns The last Entries, oldest first.
 */
export const logTail = (dataDir: string, length: number) =>
  Effect.sync(() => {
    const database = new Database(`${dataDir}/iirc.sqlite`, { readonly: true });

    const rows = database
      .query<{ bytes: Uint8Array | null; kind: string; phase: string | null }, [number]>(
        "SELECT bytes, kind, phase FROM entries ORDER BY sequence DESC LIMIT ?"
      )
      .all(length);

    database.close();

    return rows
      .toReversed()
      .map(({ bytes, kind, phase }) =>
        kind === "Line" ? Buffer.from(bytes ?? []).toString("latin1") : `${kind} ${phase}`
      );
  });

/**
 * Builds a client for a Daemon's API, once that API is answering.
 * @param httpPort - The Daemon's API port.
 * @returns The client.
 */
export const healthyClient = (httpPort: number) =>
  Effect.tap(
    HttpApiClient.make(DaemonApi, { baseUrl: `http://127.0.0.1:${httpPort}` }),
    ({ health }) =>
      health
        .health()
        .pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }), Effect.orDie)
  );
