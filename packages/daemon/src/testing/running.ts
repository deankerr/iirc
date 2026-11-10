/**
 * A real Daemon for an end-to-end run, in this process, on an ephemeral loopback port, and
 * a typed client of its API. Everything a run does to the Daemon goes through that client.
 *
 * @packageDocumentation
 */
import { DaemonApi } from "@iirc/api";
import type { Happened, Resume, TimelineChangesEvent } from "@iirc/api";
import { Context, Data, Effect, Exit, Layer, Schedule, Scope, Stream } from "effect";
import type { Duration } from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { layerDaemon } from "../daemon.ts";
import type { DaemonOptions } from "../daemon.ts";
import { presenting } from "./world.ts";

/** The API's typed client. */
export type Api = HttpApiClient.ForApi<typeof DaemonApi>;

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

/**
 * Follows the News from after a sequence until `until` says to stop.
 * @param api - The client.
 * @param after - Where to start.
 * @param until - When to stop, given everything that happened so far.
 * @returns What happened, in order.
 */
export const followNews = (
  api: Api,
  after: number,
  until: (happened: readonly Happened[]) => boolean
) =>
  Effect.gen(function* () {
    const stream = yield* api.news.follow({ headers: {}, query: { after } });
    const happened: Happened[] = [];

    yield* stream.pipe(
      Stream.takeUntil((event) => {
        if (event.event === "happened") {
          happened.push(event.data);
        }

        return until(happened);
      }),
      Stream.runDrain,
      Effect.timeout("30 seconds")
    );

    return happened;
  });

/** One `changed` event of the Timelines' changes, with its id. */
type Changed = Extract<TimelineChangesEvent, { readonly event: "changed" }>;

/**
 * Follows the Timelines' changes from where a read left off until `until` says to stop.
 * @param api - The client.
 * @param after - Where to resume: the version and `through` a read gave.
 * @param until - When to stop, given every `changed` event so far.
 * @returns The `changed` events, in order.
 */
export const followChanges = (
  api: Api,
  after: Resume,
  until: (changed: readonly Changed[]) => boolean
) =>
  Effect.gen(function* () {
    const stream = yield* api.timelines.changes({ headers: {}, query: { after } });
    const changed: Changed[] = [];

    yield* stream.pipe(
      Stream.takeUntil((event) => {
        if (event.event === "changed") {
          changed.push(event);
        }

        return until(changed);
      }),
      Stream.runDrain,
      Effect.timeout("30 seconds")
    );

    return changed;
  });
