import type { Database } from "bun:sqlite";

import { BunWorkerRunner } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { constVoid } from "effect/Function";
import { RpcServer, RpcWorker } from "effect/rpc";

import { vacuumInto } from "./backup.ts";
import { ReaderBusy, ReadFailed } from "./errors.ts";
import { ReaderRpcs, ReaderStart } from "./reader-protocol.ts";
import { makeReads, openReadConnection } from "./reads.ts";

const handlers = (prepare: (database: Database) => void) =>
  ReaderRpcs.toLayer(
    Effect.gen(function* () {
      const { budgetMillis, filename, queueMillis } = yield* RpcWorker.initialMessage(ReaderStart);
      const database = yield* openReadConnection(filename);

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
        activity: fresh(reads.activity),
        backup: ({ into }) =>
          Effect.try({
            catch: (cause) => new ReadFailed({ reason: String(cause) }),
            try: () => vacuumInto(database, into),
          }),
        encodings: fresh(reads.encodings),
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
