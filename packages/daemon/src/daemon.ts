/**
 * The composition root: the data directory, the production adapters, the Runtime driving
 * the real Client, the keys and sign-ins, and the API served over HTTP.
 *
 * @packageDocumentation
 */
import { BunFileSystem, BunHttpServer, BunPath } from "@effect/platform-bun";
import { client } from "@iirc/client";
import { layerSqliteJournal } from "@iirc/journal-sqlite";
import type { Pacing } from "@iirc/outbox";
import { layerRuntime } from "@iirc/runtime";
import { layerSqliteTimelineStore } from "@iirc/timeline-store-sqlite";
import { layer as layerTransport } from "@iirc/transport-bun";
import type { BunTransportOptions } from "@iirc/transport-bun";
import { layerBun as layerVault } from "@iirc/vault-file";
import { Context, Duration, Effect, Exit, FileSystem, Latch, Layer, Logger, Scope } from "effect";
import type { Path } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { HttpRouter } from "effect/http";
import type { HttpPlatform } from "effect/http";

import { ApiRoutes, Heartbeat, Stopping } from "./handlers.ts";
import { ApiKeys } from "./keys.ts";
import { DataDirectoryFailed, holdDataDirectory } from "./lock.ts";
import { layerProjector } from "./projector.ts";
import { SignIns } from "./sign-ins.ts";
import { layerUiConfiguration } from "./ui.ts";

/** What a Daemon needs besides where to listen. */
export interface DaemonOptions {
  /** Where the Journal, the Timelines, the Credentials, the keys, and the sign-ins live. Made, owner-only, if missing. */
  readonly dataDir: string;
  /** The Transport's options, such as extra roots to `trust`. */
  readonly transport?: BunTransportOptions | undefined;
  /** How often the News stream sends a heartbeat. 15 seconds unless given. */
  readonly heartbeat?: Duration.Input | undefined;
  /** How fast Lines may leave each Connection. A burst of 5, then one every 2 s, unless given. */
  readonly pacing?: Pacing | undefined;
  /** How long a hang-up lets queued Lines leave at pace before it hangs up anyway. 5 seconds unless given. */
  readonly hangupDrain?: Duration.Input | undefined;
  /** How long stopping waits for each Network's Connections to close. 5 seconds unless given. */
  readonly stopTimeout?: Duration.Input | undefined;
}

/** Where the API listens. */
export interface Listen {
  readonly host: string;
  readonly port: number;
}

/** Loopback only, as ADR 0006 says: remote access goes through a proxy. */
export const defaultListen: Listen = { host: "127.0.0.1", port: 7667 };

/**
 * How long serving waits for requests in flight once asked to stop. By then the Runtime
 * has stopped and every stream a Frontend follows has ended, so this only covers reads.
 */
const gracefulShutdownTimeout = Duration.millis(500);

/** Closes the Runtime's Scope. Closing it again does nothing. */
class StopRuntime extends Context.Service<StopRuntime, Effect.Effect<void>>()(
  "@iirc/daemon/StopRuntime"
) {}

/** Completes {@link Stopping}. Saying it again does nothing. */
class SayStopping extends Context.Service<SayStopping, Effect.Effect<void>>()(
  "@iirc/daemon/SayStopping"
) {}

/** {@link Stopping}, which {@link SayStopping} completes. */
const layerStopping = Layer.effectContext(
  Effect.gen(function* () {
    const stopping = yield* Latch.make();

    return Context.make(Stopping, stopping.await).pipe(
      Context.add(SayStopping, Effect.asVoid(stopping.open))
    );
  })
);

/**
 * Makes the data directory if it is missing, owner-only, and holds it for as long as the
 * Layer lives.
 * @param dataDir - The data directory.
 * @returns The Layer.
 */
const dataDirectory = (dataDir: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* fs
        .makeDirectory(dataDir, { mode: 0o700, recursive: true })
        .pipe(
          Effect.mapError((error) => new DataDirectoryFailed({ dataDir, reason: error.message }))
        );

      yield* holdDataDirectory(dataDir);
    })
  ).pipe(Layer.provide(BunFileSystem.layer));

/**
 * The Runtime in a Scope of its own, which {@link StopRuntime} closes, so the Daemon can
 * stop it before serving stops.
 * @param options - The pacing, and how long endings may take.
 * @returns The Layer.
 */
const runtimeFirstToStop = (options: DaemonOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const close = Scope.close(scope, Exit.void);

      yield* Effect.addFinalizer(() => close);

      const runtime = layerRuntime(client, {
        hangupDrain: options.hangupDrain,
        pacing: options.pacing,
        stopTimeout: options.stopTimeout,
      });

      const built = yield* Layer.buildWithScope(runtime, scope);

      return Context.add(built, StopRuntime, close);
    })
  );

/**
 * Everything but HTTP: the data directory held, the Journal, the Vault, the Transport,
 * the Runtime, the Timeline store and its projector, the keys, and the sign-ins. Each is
 * opened only once the directory is held.
 * @param options - The data directory and the Transport's options.
 * @returns The core.
 */
const layerCore = (options: DaemonOptions) => {
  const { dataDir } = options;

  const ports = Layer.mergeAll(
    layerSqliteJournal(`${dataDir}/journal.sqlite`),
    layerVault(`${dataDir}/credentials.json`),
    layerTransport(options.transport)
  );

  const platform = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    Digest.layerWebCrypto,
    SecureRandom.layerWebCrypto
  );

  const access = SignIns.layer(dataDir).pipe(
    Layer.provideMerge(ApiKeys.layer(dataDir)),
    Layer.provide(platform)
  );

  const heartbeat =
    options.heartbeat === undefined
      ? Layer.empty
      : Layer.succeed(Heartbeat, Duration.fromInputUnsafe(options.heartbeat));

  // The projector is built after the Runtime and the store, so it is interrupted before
  // either closes, and the Journal closes after all three.
  const timelines = layerProjector.pipe(
    Layer.provideMerge(
      layerSqliteTimelineStore(`${dataDir}/views.sqlite`).pipe(Layer.provide(BunFileSystem.layer))
    )
  );

  // The `ui` options are folded from the Journal's Changes, beside the Runtime.
  const owned = Layer.merge(timelines, layerUiConfiguration);

  return Layer.mergeAll(
    owned.pipe(Layer.provideMerge(runtimeFirstToStop(options).pipe(Layer.provideMerge(ports)))),
    access,
    heartbeat,
    layerStopping
  ).pipe(Layer.provide(dataDirectory(dataDir)));
};

// Built after serving, so it closes first: the Runtime stops, every Owner input still
// waiting fails with `NetworkStopped`, and every stream a Frontend follows ends, and only
// then does serving stop. The streams end after the Runtime stops, not before: a Frontend
// whose stream ended would follow again while the Runtime stops, and that stream be cut.
const stopsFirst = Layer.effectDiscard(
  Effect.gen(function* () {
    const stop = yield* StopRuntime;
    const say = yield* SayStopping;

    yield* Effect.addFinalizer(() => Effect.ensuring(stop, say));
  })
);

/**
 * Routes served beside the API on its origin, which the Daemon knows nothing of. They may
 * use the server's file system and file responses.
 */
export type Beside<E> = Layer.Layer<
  never,
  E,
  HttpRouter.HttpRouter | HttpPlatform.HttpPlatform | FileSystem.FileSystem | Path.Path
>;

/**
 * The Daemon: the core, provided outside `HttpRouter.serve`, which forks the MemoMap and
 * would build anything shared inside it twice, and the API served on `listen`.
 * @param options - The data directory and the Transport's options.
 * @param listen - Where to listen.
 * @param beside - Routes to serve beside the API, none unless given.
 * @returns The Daemon, which runs for as long as the Layer lives, and its `HttpServer`.
 */
export const layerDaemon = <E = never>(
  options: DaemonOptions,
  listen: Listen = defaultListen,
  beside: Beside<E> = Layer.empty
) =>
  stopsFirst.pipe(
    Layer.provideMerge(
      HttpRouter.serve(Layer.merge(ApiRoutes, beside), { disableLogger: true }).pipe(
        Layer.provideMerge(
          BunHttpServer.layer({ gracefulShutdownTimeout, hostname: listen.host, port: listen.port })
        )
      )
    ),
    Layer.provide(layerCore(options))
  );

/** Logs as logfmt to stderr, so stdout holds only what a command was asked for. */
export const layerLogger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);
