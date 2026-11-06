import { Deferred, Duration, Effect, Exit, FileSystem, Layer, Scope, Semaphore } from "effect";
import { RpcClient, RpcWorker } from "effect/rpc";
import type { RpcClientError } from "effect/rpc";
import { Worker, WorkerError } from "effect/workers";

import { keepBackup } from "./backup.ts";
import type { Backup } from "./backup.ts";
import { ReaderBusy, StorageFailed } from "./errors.ts";
import type { ReadFailed, ReadTimedOut } from "./errors.ts";
import { ReaderRpcs, ReaderStart } from "./reader-protocol.ts";
import type { EntryQuery, NetworkPage } from "./reader-protocol.ts";

/** Where the reader reads, and how long each read may take. */
export interface LogReaderOptions {
  readonly dataDir: string;
  /**
   * How long one read may run before it fails with ReadTimedOut. One second unless set.
   * A read that waits behind others for longer than its caller would fails with
   * ReaderBusy instead.
   */
  readonly budget?: Duration.Input;
  /** Starts the reader's Worker, which only a test replaces. */
  readonly spawn?: () => globalThis.Worker;
}

/** How long a read may take unless its reader is told otherwise. */
export const defaultBudget = Duration.seconds(1);

// How much longer than a read's budget anything waits on the Worker: a caller, for the
// queue ahead of it and the trip there and back, and a close, for the read in flight.
// Past that the Worker is given up on, so a stuck one hangs no one.
const graceMillis = 1000;

/**
 * The longest a read waits for its answer under the default budget, counting the queue
 * and the trip to the Worker. Past this it has failed, so it is how long anything that
 * waits on reads in flight need wait.
 */
export const longestReadMillis = Duration.toMillis(defaultBudget) + graceMillis;

// The first read also waits for the Worker to start, which under test can be slow.
const startTimeout = Duration.seconds(10);

// What a Worker understands as "close", in the protocol `BunWorkerRunner` speaks.
const closeMessage = [1];

// A compiled binary resolves every module's URL against its own root, and the app's build
// puts this file there (`--root`), so this one URL serves source and binary alike.
const spawnReader = () => new globalThis.Worker(new URL("reader-worker.ts", import.meta.url));

const toStorageFailed = (cause: unknown) => new StorageFailed({ cause });

// Stamped as each read runs, not as it is made, because an effect can run many times.
const stamped = <Query>(query: Query) => ({ ...query, queuedAt: Date.now() });

const died = (message: string, cause: unknown) =>
  new WorkerError.WorkerError({ reason: new WorkerError.WorkerUnknownError({ cause, message }) });

/**
 * How Effect's Workers run on Bun, as `BunWorker.layerPlatform` does, with two changes.
 * That one hears only `error`, so a Worker that exits without one, terminated or out of
 * memory, would leave every read it held waiting for ever: here an exit is a death too.
 * And a close waits as long as the read in flight may take, not a fixed 5 seconds.
 * @param closeWait - How long a close waits for the Worker before terminating it.
 * @param report - Says that a Worker died, which a close that was asked for is not.
 * @param name - What a death is reported as.
 * @returns The platform.
 */
const platform = (closeWait: Duration.Input, report: (message: string) => void, name: string) =>
  Worker.makePlatform<globalThis.Worker>()<globalThis.Worker>({
    listen: ({ deferred, emit, port, scope }) => {
      // A Worker that throws also exits, and that is one death, said once.
      const fail = (message: string, cause: unknown) => {
        if (Deferred.doneUnsafe(deferred, Exit.fail(died(message, cause)))) {
          report(message);
        }
      };

      const onMessage = ({ data }: MessageEvent) => {
        emit(data);
      };

      const onError = (event: ErrorEvent) => {
        fail(`${name} failed: ${event.message}`, event.error);
      };

      const onClose = ({ code }: CloseEvent) => {
        fail(`${name} exited with code ${code}`, code);
      };

      port.addEventListener("message", onMessage);
      port.addEventListener("error", onError);
      port.addEventListener("close", onClose);

      // Removed before the Worker is asked to close, so a close that was asked for is no death.
      return Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          port.removeEventListener("message", onMessage);
          port.removeEventListener("error", onError);
          port.removeEventListener("close", onClose);
        })
      );
    },
    setup: ({ scope, worker }) => {
      const closed = Deferred.makeUnsafe<number>();

      worker.addEventListener("close", ({ code }) => {
        Deferred.doneUnsafe(closed, Exit.succeed(code));
      });

      // A Worker inside a statement hears nothing until the statement ends, which its
      // budget bounds. Terminating does not stop the statement, but it frees the Daemon.
      return Effect.as(
        Scope.addFinalizer(
          scope,
          Effect.suspend(() => {
            worker.postMessage(closeMessage, []);

            return Deferred.await(closed);
          }).pipe(
            Effect.interruptible,
            Effect.timeout(closeWait),
            Effect.catchCause(() =>
              Effect.sync(() => {
                worker.terminate();
              })
            )
          )
        ),
        worker
      );
    },
  });

/** What starting a reader's Worker needs. */
interface WorkerOptions {
  readonly budgetMillis: number;
  readonly dataDir: string;
  /** What a death is reported as, such as "The Log's reader". */
  readonly name: string;
  readonly spawn: () => globalThis.Worker;
  /** How long a close waits for the statement in flight before terminating the Worker. */
  readonly waitMillis: number;
}

// Starts a Worker and a client for it, until the enclosing scope closes. A Worker that
// dies is reported, and the calls it held fail.
const connect = Effect.fnUntraced(function* ({
  budgetMillis,
  dataDir,
  name,
  spawn,
  waitMillis,
}: WorkerOptions) {
  const runFork = Effect.runForkWith(yield* Effect.context());

  const report = (message: string) => {
    runFork(Effect.logError(message));
  };

  const protocol = yield* RpcClient.makeProtocolWorker({ size: 1 }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Worker.WorkerPlatform, platform(waitMillis, report, name)),
        Worker.layerSpawner(spawn),
        RpcWorker.layerInitialMessage(
          ReaderStart,
          Effect.succeed({
            budgetMillis,
            filename: `${dataDir}/iirc.sqlite`,
            queueMillis: graceMillis,
          })
        )
      )
    ),
    Effect.mapError(toStorageFailed)
  );

  return yield* RpcClient.make(ReaderRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol)
  );
});

/**
 * Starts the reader's Worker and a client for it, until the enclosing scope closes. A
 * Worker that dies is reported and started again, and the reads it held fail.
 * @param options - Where to read, and for how long.
 * @returns The reads, which fail with ReadTimedOut past their budget, and StorageFailed
 * when the Worker could not answer, and backups, each on a Worker of its own.
 */
export const makeReader = Effect.fnUntraced(function* ({
  budget = defaultBudget,
  dataDir,
  spawn = spawnReader,
}: LogReaderOptions) {
  const budgetMillis = Duration.toMillis(budget);
  const waitMillis = budgetMillis + graceMillis;
  const fileSystem = yield* FileSystem.FileSystem;
  const worker = { budgetMillis, dataDir, spawn, waitMillis };
  const client = yield* connect({ ...worker, name: "The Log's reader" });

  // A read that the Worker started answers within its budget, so one not answered by
  // now spent its time waiting behind others.
  const busy = new ReaderBusy({ waitedMillis: waitMillis });
  const fail = (cause: unknown) => Effect.fail(toStorageFailed(cause));

  const call = <A>(
    read: Effect.Effect<A, ReaderBusy | ReadFailed | ReadTimedOut | RpcClientError.RpcClientError>
  ) =>
    read.pipe(
      Effect.timeoutOrElse({ duration: waitMillis, orElse: () => Effect.fail(busy) }),
      Effect.catchTags({ ReadFailed: fail, RpcClientError: fail })
    );

  // Proves the Worker can read before anything relies on it, so a binary without it, or
  // a database it cannot open, stops the Daemon at once and says why.
  // A Worker slow to start finds that this read waited past its queue's limit, which says
  // nothing of whether it can read, so it is asked again until the start runs out of time.
  yield* Effect.suspend(() => client.entries(stamped({ after: 0, limit: 0 }))).pipe(
    Effect.retry({ while: (error) => error._tag === "ReaderBusy" }),
    Effect.timeoutOrElse({
      duration: startTimeout,
      orElse: () => Effect.fail("The Log's reader did not start in time"),
    }),
    Effect.mapError(toStorageFailed)
  );

  // One backup at a time, because two would only share the disk, and each on a Worker
  // started for it alone, because a copy runs as long as the Log is big and `bun:sqlite`
  // cannot interrupt it: on the reader's Worker, every read would wait behind it (RUN-2).
  const backups = yield* Semaphore.make(1);

  const copyOnOwnWorker = (into: string) =>
    connect({ ...worker, name: "The Log's backup" }).pipe(
      Effect.flatMap((backup) => backup.backup({ into })),
      Effect.mapError(toStorageFailed),
      Effect.scoped
    );

  const backup: Effect.Effect<Backup, StorageFailed> = backups
    .withPermit(keepBackup(dataDir, "iirc", copyOnOwnWorker))
    .pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

  return {
    backup,
    entries: (query: EntryQuery) => call(Effect.suspend(() => client.entries(stamped(query)))),
    gaps: (query: NetworkPage) => call(Effect.suspend(() => client.gaps(stamped(query)))),
    messages: (query: NetworkPage) => call(Effect.suspend(() => client.messages(stamped(query)))),
  };
});
