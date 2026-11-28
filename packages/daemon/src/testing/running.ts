/**
 * A real Daemon for a test, in this process, on an ephemeral loopback port, and a typed
 * client of its API. Everything a test does to the Daemon goes through that client.
 *
 * @packageDocumentation
 */
import { DaemonApi } from "@iirc/api";
import { Context, Data, Effect, Exit, Layer, Schedule, Scope } from "effect";
import type { Duration } from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { layerDaemon } from "../daemon.ts";
import type { DaemonOptions } from "../daemon.ts";
import { presenting } from "./world.ts";

/** The API's typed client. */
type Api = HttpApiClient.ForApi<typeof DaemonApi>;

/** A Daemon that runs until `stop`, or until the Scope it was started in closes. */
interface Running {
  readonly api: Api;
  readonly base: string;
  /** Stops the Daemon as SIGTERM would: the Runtime first, then serving, then the rest. */
  readonly stop: Effect.Effect<void>;
}

/**
 * Starts a Daemon on a data directory, with a key made beforehand.
 * @param options - The data directory and the Transport's options.
 * @param key - The key its client presents.
 * @returns The running Daemon.
 */
export const startDaemon = (options: DaemonOptions, key: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    // A run that fails before its `stop` still stops the Daemon. Closing twice does nothing.
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const context = yield* Layer.buildWithScope(
      layerDaemon(options, { host: "127.0.0.1", port: 0 }),
      scope
    ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));

    const { address } = Context.get(context, HttpServer.HttpServer);

    const base =
      address._tag === "UnixPathAddress" ? "http://invalid" : `http://127.0.0.1:${address.port}`;

    const api = yield* HttpApiClient.make(DaemonApi, { baseUrl: base }).pipe(
      Effect.provide(Layer.merge(presenting(key), FetchHttpClient.layer))
    );

    const running: Running = { api, base, stop: Scope.close(scope, Exit.void) };

    return running;
  });

/** An answer that is not yet the one waited for. */
class NotYet extends Data.TaggedError("NotYet") {}

/**
 * Asks again until the answer satisfies, or fails after `within`.
 * @param ask - What to ask.
 * @param satisfied - Whether the answer is the one waited for.
 * @param within - How long to wait.
 * @returns The answer.
 */
export const eventually = <A, E>(
  ask: Effect.Effect<A, E>,
  satisfied: (answer: A) => boolean,
  within: Duration.Input = "20 seconds"
) =>
  ask.pipe(
    Effect.filterOrFail(satisfied, () => new NotYet()),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeout(within)
  );
