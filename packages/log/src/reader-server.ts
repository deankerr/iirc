import { Database } from "bun:sqlite";

import { BunWorkerRunner } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { constVoid } from "effect/Function";
import { RpcServer, RpcWorker } from "effect/rpc";

import { vacuumInto } from "./backup.ts";
import { allowBudgets } from "./budget.ts";
import { ReaderBusy, ReadFailed } from "./errors.ts";
import { ReaderRpcs, ReaderStart } from "./reader-protocol.ts";
import { makeReads } from "./reads.ts";

// A reader never waits on the writer in WAL mode, but SQLite can still answer busy while
// the WAL index is rebuilt, and that wait is outside any budget, so it is short.
const busyTimeoutMillis = 50;

const open = (filename: string) =>
  Effect.acquireRelease(
    Effect.try({
      catch: (cause) => new ReadFailed({ reason: String(cause) }),
      try: () => {
        // Read-only, so nothing here can ever take the writer's lock.
        const database = new Database(filename, { readonly: true });

        database.run(`PRAGMA busy_timeout = ${busyTimeoutMillis}`);
        allowBudgets(database);

        return database;
      },
    }),
    (database) =>
      Effect.sync(() => {
        database.close();
      })
  );

const handlers = (prepare: (database: Database) => void) =>
  ReaderRpcs.toLayer(
    Effect.gen(function* () {
      const { budgetMillis, filename, queueMillis } = yield* RpcWorker.initialMessage(ReaderStart);
      const database = yield* open(filename);

      prepare(database);

      const reads = makeReads(database, budgetMillis);

      // A read that waited this long behind others would outlast what its caller waits
      // for, so it is refused, and the queue behind it moves on (LOG-11).
      const fresh =
        <Query, A, E>(read: (query: Query) => Effect.Effect<A, E>) =>
        (query: Query & { readonly queuedAt: number }): Effect.Effect<A, E | ReaderBusy> => {
          const waitedMillis = Math.round(Date.now() - query.queuedAt);

          return waitedMillis > queueMillis
            ? Effect.fail(new ReaderBusy({ waitedMillis }))
            : read(query);
        };

      return ReaderRpcs.of({
        backup: ({ into }) =>
          Effect.try({
            catch: (cause) => new ReadFailed({ reason: String(cause) }),
            try: () => vacuumInto(database, into),
          }),
        entries: fresh(reads.entries),
        gaps: fresh(reads.gaps),
        messages: fresh(reads.messages),
      });
    })
  );

/**
 * Serves the Log's reads over RPC from inside a Worker, on its own read-only connection,
 * until the Worker is asked to close (LOG-11).
 * @param prepare - Called on the connection once it is open, which only a test needs.
 * @returns An effect to run as the Worker's whole program.
 */
export const serveReader = (prepare: (database: Database) => void = constVoid) =>
  RpcServer.layer(ReaderRpcs).pipe(
    Layer.provide(handlers(prepare)),
    Layer.provide(RpcServer.layerProtocolWorkerRunner),
    Layer.provide(BunWorkerRunner.layer),
    Layer.launch,
    Effect.tapCause((cause) => Effect.logError("The Log's reader stopped", cause))
  );
