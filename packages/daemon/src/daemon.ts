/**
 * The composition root: the data directory, the production adapters, the Runtime driving
 * the real Client, the Uploads and their link listener, the keys and sign-ins, and the API
 * served over HTTP.
 *
 * @packageDocumentation
 */
import { BunFileSystem, BunHttpServer, BunPath } from "@effect/platform-bun";
import { makeS3ByteStore } from "@iirc/byte-store-s3";
import { client } from "@iirc/client";
import { layerSqliteJournal } from "@iirc/journal-sqlite";
import type { LinkFetch } from "@iirc/link-fetch";
import { layerBunLinkFetch } from "@iirc/link-fetch-bun";
import type { Pacing } from "@iirc/outbox";
import { layerSqlitePreviewCache } from "@iirc/preview-cache-sqlite";
import { layerRuntime } from "@iirc/runtime";
import { layerSqliteTimelineStore } from "@iirc/timeline-store-sqlite";
import { layer as layerTransport } from "@iirc/transport-bun";
import type { BunTransportOptions } from "@iirc/transport-bun";
import { layerBun as layerVault } from "@iirc/vault-file";
import {
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Latch,
  Layer,
  LogLevel,
  Logger,
  Random,
  Scope,
} from "effect";
import type { Path } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { HttpRouter } from "effect/http";
import type { HttpPlatform } from "effect/http";

import { layerAwayWhenClosed } from "./away-when-closed.ts";
import { ApiRoutes, Heartbeat, Stopping } from "./handlers.ts";
import { ApiKeys } from "./keys.ts";
import { layerLinkListener } from "./link-listener.ts";
import { DataDirectoryFailed, holdDataDirectory } from "./lock.ts";
import { OwnerConfiguration, layerOwnerConfiguration } from "./options.ts";
import { layerPreviews } from "./previews/previews.ts";
import { layerProjector } from "./projector.ts";
import { SignIns } from "./sign-ins.ts";
import { layerStoreBytes } from "./store-bytes.ts";
import { layerTailLogging } from "./tail.ts";
import { layerUiConfiguration } from "./ui.ts";
import type { UiConfiguration } from "./ui.ts";
import { ByteStoreMaker, layerUploads } from "./uploads/uploads.ts";

/** iirc's version, which `iirc --version` prints and the Daemon logs as it starts. */
export const version = "0.0.0";

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
  /** iirc's version, which the link fetch names in its user agent and the Tail says. {@link version} unless given. */
  readonly version?: string | undefined;
  /**
   * How Previews fetch a stranger's link. The guard under the fixed policy unless given, as
   * production always has it. A test gives a fake, or the guard under a loopback policy.
   */
  readonly linkFetch?: Layer.Layer<LinkFetch> | undefined;
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
 * has stopped and every stream still being read has ended, so this only covers reads and
 * a stream whose reader has stopped reading, which are cut.
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

// The most a double from Random can hold exactly: 53 bits.
const doubleBits = 2 ** 53;

// A number below `2 ** 53` from seven secure random bytes, the last giving five bits.
const secureBits = (): number =>
  SecureRandom.randomBytesUnsafe(7).reduce(
    (sum, byte, index) => sum + (index === 6 ? byte % 32 : byte) * 256 ** index,
    0
  );

/**
 * Effect's Random from the platform's secure source rather than `Math.random`, for the
 * Runtime, which makes a SASL `SCRAM-SHA-256` nonce from it, so no Ircd can predict one.
 */
const secureRandom: Random.Random = {
  nextDoubleUnsafe: () => secureBits() / doubleBits,
  nextIntUnsafe: secureBits,
};

/**
 * The Runtime in a Scope of its own, which {@link StopRuntime} closes, so the Daemon can
 * stop it before serving stops. It spares the Credentials the Owner's options name when it
 * forgets a removed Network's, so it needs those options, folded before it starts.
 * @param options - The pacing, and how long endings may take.
 * @returns The Layer.
 */
const runtimeFirstToStop = (options: DaemonOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const close = Scope.close(scope, Exit.void);

      yield* Effect.addFinalizer(() => close);

      const owner = yield* OwnerConfiguration;

      const runtime = layerRuntime(client, {
        hangupDrain: options.hangupDrain,
        pacing: options.pacing,
        spared: owner.spared,
        stopTimeout: options.stopTimeout,
      });

      const built = yield* Layer.buildWithScope(runtime, scope).pipe(
        Effect.provideService(Random.Random, secureRandom)
      );

      return Context.add(built, StopRuntime, close);
    })
  );

/**
 * Everything but the API's HTTP: the data directory held, the Journal, the Vault, the
 * Transport, the Runtime, the Timeline store and its projector, the Uploads and their link
 * listener, the keys, and the sign-ins. Each is opened only once the directory is held.
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

  // The Uploads keep their bytes in the bucket the options name, and the link listener
  // follows the options, binding while Uploads are on.
  const uploads = layerLinkListener.pipe(
    Layer.provideMerge(layerUploads(dataDir)),
    Layer.provide(Layer.merge(Layer.succeed(ByteStoreMaker, makeS3ByteStore), platform))
  );

  const linkFetch = options.linkFetch ?? layerBunLinkFetch({ version: options.version ?? version });

  // Previews read the Timelines and the `ui` options, fetch through the link fetch, are
  // kept in the Preview cache, and keep their images in the bucket the options name.
  const previews = layerPreviews.pipe(
    Layer.provide(Layer.merge(linkFetch, Layer.succeed(ByteStoreMaker, makeS3ByteStore)))
  );

  // Uploads and Previews share the bytes in the store, which leave it only once neither
  // refers to them, so both are given the one record of what is claimed and released.
  const shared = layerStoreBytes.pipe(
    Layer.provideMerge(
      layerSqlitePreviewCache(`${dataDir}/previews.sqlite`).pipe(Layer.provide(BunFileSystem.layer))
    )
  );

  // The `ui` options are folded from the Journal's Changes, beside the Runtime, and so are
  // the Uploads, and the aways marked when no Frontend is open. The options beyond `ui` are folded before it starts, since
  // it spares the Credentials they name, even as it finishes a removal cut short.
  const owned = previews.pipe(
    Layer.provideMerge(
      Layer.mergeAll(timelines, layerUiConfiguration, uploads, layerAwayWhenClosed)
    ),
    Layer.provideMerge(shared)
  );

  const runtime = runtimeFirstToStop(options).pipe(
    Layer.provideMerge(layerOwnerConfiguration),
    Layer.provideMerge(ports)
  );

  return Layer.mergeAll(
    owned.pipe(Layer.provideMerge(runtime)),
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
 * use the server's file system and file responses, and read the `ui` options in force.
 */
export type Beside<E> = Layer.Layer<
  never,
  E,
  | HttpRouter.HttpRouter
  | HttpPlatform.HttpPlatform
  | FileSystem.FileSystem
  | Path.Path
  | UiConfiguration
>;

/**
 * The Daemon: the core, provided outside `HttpRouter.serve`, which forks the MemoMap and
 * would build anything shared inside it twice, and the API served on `listen`. Outermost
 * is the Tail with its Logger, so everything the Daemon builds and runs logs into it.
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
    Layer.provide(layerCore(options)),
    Layer.provideMerge(layerTailLogging(options.version ?? version))
  );

const logfmtToStderr = Logger.withConsoleError(Logger.formatLogFmt);

/**
 * Logs as logfmt to stderr, so stdout holds only what a command was asked for. It writes
 * `Info` and above whatever the minimum level in force is, since the Daemon lowers that to
 * keep the Tail's `Debug` lines, and they are not for stderr.
 */
export const layerLogger = Logger.layer([
  Logger.make((options: Logger.Options<unknown>) => {
    if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Info")) {
      logfmtToStderr.log(options);
    }
  }),
]);
